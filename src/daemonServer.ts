import fs from "fs";
import net from "net";
import { AbsolutePath } from "./configLoader.js";
import { ClientRequest, KUBIK_VERSION, ServerMessage, readMessages, writeMessage } from "./daemonProtocol.js";
import { daemonSocketDir, daemonSocketPath } from "./daemonRegistry.js";
import { Project, Workspace } from "./workspace.js";

export async function startDaemonServer(workspace: Workspace): Promise<void> {
  const socketPath = daemonSocketPath(process.pid);
  await fs.promises.mkdir(daemonSocketDir(), { recursive: true });
  // A previous process with a recycled pid might have left a socket behind.
  await fs.promises.unlink(socketPath).catch(() => {});

  const server = net.createServer(socket => new ClientConnection(workspace, socket));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  process.on('exit', () => {
    try { fs.unlinkSync(socketPath); } catch {}
  });
  const terminate = () => {
    workspace.stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
}

class ClientConnection {
  private _workspace: Workspace;
  private _socket: net.Socket;
  private _run?: RunSession;

  constructor(workspace: Workspace, socket: net.Socket) {
    this._workspace = workspace;
    this._socket = socket;
    socket.on('error', () => this._dispose());
    socket.on('close', () => this._dispose());
    readMessages(socket, message => this._onMessage(message as ClientRequest), () => socket.destroy());
  }

  private _send(message: ServerMessage) {
    writeMessage(this._socket, message);
  }

  private _onMessage(message: ClientRequest) {
    if (message.method === 'handshake') {
      this._send({
        type: 'hello',
        version: KUBIK_VERSION,
        pid: process.pid,
        configPaths: this._workspace.bfsProjects().map(project => project.configPath()),
      });
    } else if (message.method === 'run') {
      if (this._run) {
        this._send({ type: 'error', message: 'a run is already in progress on this connection' });
        return;
      }
      const requested: Project[] = [];
      for (const configPath of message.configPaths) {
        const project = this._workspace.projectForPath(configPath as AbsolutePath);
        if (!project || !this._workspace.subtreeProjects(project).length) {
          this._send({ type: 'error', message: `task ${configPath} is not part of this watchdog's task tree` });
          this._socket.end();
          return;
        }
        requested.push(project);
      }
      this._run = new RunSession(this._workspace, requested, !!message.fresh, this._send.bind(this), () => this._socket.end());
    }
  }

  private _dispose() {
    this._run?.dispose();
    this._run = undefined;
  }
}

class RunSession {
  private _workspace: Workspace;
  private _requested: Project[];
  private _send: (message: ServerMessage) => void;
  private _onDone: () => void;

  private _subscriptions = new Map<Project, () => void>();
  private _pollTimer: NodeJS.Timeout;
  private _onProjectsChanged: () => void;
  private _done = false;

  constructor(workspace: Workspace, requested: Project[], fresh: boolean, send: (message: ServerMessage) => void, onDone: () => void) {
    this._workspace = workspace;
    this._requested = requested;
    this._send = send;
    this._onDone = onDone;

    const subtree = this._subtree();
    const restartSet = new Set<Project>(requested);
    for (const project of subtree) {
      if (fresh || project.status() === 'fail')
        restartSet.add(project);
    }

    // Subscribe before restarting, so that no status transition is lost.
    for (const project of subtree)
      this._subscribe(project);

    // Report tasks that will be reused as-is; replay output of builds that are
    // already in flight, so that the client sees them from the start.
    for (const project of subtree) {
      if (restartSet.has(project))
        continue;
      const status = project.status();
      if (status === 'ok') {
        this._send(taskStatusMessage(project, true));
      } else if (status === 'running') {
        this._send(taskStatusMessage(project));
        if (project.output())
          this._send({ type: 'output', stream: 'stdout', taskId: project.id(), name: project.name(), data: project.output() });
      }
    }

    // Restarts are debounced by the workspace; this also synchronously marks
    // an update as pending, so the settle check below cannot fire early.
    for (const project of restartSet)
      this._workspace.scheduleUpdate(project);

    this._onProjectsChanged = () => {
      // Configs might have changed mid-run: subscribe to subtree newcomers,
      // and fail the run if a requested task disappeared from the tree.
      for (const project of this._requested) {
        if (!this._workspace.subtreeProjects(project).length) {
          this._finishWithError(`task ${project.configPath()} was removed from the task tree`);
          return;
        }
      }
      for (const project of this._subtree())
        this._subscribe(project);
      this._checkSettled();
    };
    this._workspace.on('projects_changed', this._onProjectsChanged);

    // The workspace has no event for "pending update was incorporated", so
    // poll as a backstop in addition to the event-driven checks.
    this._pollTimer = setInterval(() => this._checkSettled(), 100);
  }

  private _subtree(): Project[] {
    const result = new Set<Project>();
    for (const project of this._requested) {
      for (const dep of this._workspace.subtreeProjects(project))
        result.add(dep);
    }
    return [...result];
  }

  private _subscribe(project: Project) {
    if (this._subscriptions.has(project))
      return;
    const onStatusChanged = () => {
      this._send(taskStatusMessage(project));
      this._checkSettled();
    };
    const onStdout = (data: string) => this._send({ type: 'output', stream: 'stdout', taskId: project.id(), name: project.name(), data });
    const onStderr = (data: string) => this._send({ type: 'output', stream: 'stderr', taskId: project.id(), name: project.name(), data });
    project.on('build_status_changed', onStatusChanged);
    project.on('build_stdout', onStdout);
    project.on('build_stderr', onStderr);
    this._subscriptions.set(project, () => {
      project.off('build_status_changed', onStatusChanged);
      project.off('build_stdout', onStdout);
      project.off('build_stderr', onStderr);
    });
  }

  private _checkSettled() {
    if (this._done)
      return;
    if (this._workspace.workspaceStatus() === 'error') {
      this._finishWithError(this._workspace.workspaceError() ?? 'workspace error');
      return;
    }
    if (this._workspace.hasPendingUpdate())
      return;
    const subtree = this._subtree();
    if (subtree.some(project => project.status() === 'running'))
      return;
    const pending = subtree.filter(project => project.status() === 'pending');
    if (pending.length) {
      // Pending tasks will still run, unless they transitively depend on a
      // failed task. Settle only when all of them are blocked this way.
      const memo = new Map<Project, boolean>();
      const blockedByFailure = (project: Project): boolean => {
        if (memo.has(project))
          return memo.get(project)!;
        memo.set(project, false);
        const result = this._workspace.directDependencies(project).some(dep => dep.status() === 'fail' || blockedByFailure(dep));
        memo.set(project, result);
        return result;
      };
      if (!pending.every(blockedByFailure))
        return;
    }
    const hasFailures = subtree.some(project => project.status() === 'fail');
    this._finish({ type: 'done', status: hasFailures ? 'fail' : 'ok' });
  }

  private _finishWithError(message: string) {
    this._send({ type: 'error', message });
    this._finish({ type: 'done', status: 'fail' });
  }

  private _finish(message: ServerMessage) {
    if (this._done)
      return;
    this._done = true;
    this._send(message);
    this.dispose();
    this._onDone();
  }

  dispose() {
    this._done = true;
    clearInterval(this._pollTimer);
    this._workspace.off('projects_changed', this._onProjectsChanged);
    for (const unsubscribe of this._subscriptions.values())
      unsubscribe();
    this._subscriptions.clear();
  }
}

function taskStatusMessage(project: Project, upToDate?: boolean): ServerMessage {
  return {
    type: 'task_status',
    taskId: project.id(),
    name: project.name(),
    status: project.status(),
    durationMs: project.durationMs(),
    upToDate,
  };
}
