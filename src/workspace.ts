import { ChildProcess, fork } from "child_process";
import chokidar, { FSWatcher } from "chokidar";
import EventEmitter from "events";
import path from "path";
import { AbsolutePath, ReadConfigResult, readConfigTree, toAbsolutePath } from "./configLoader.js";
import { Multimap } from "./multimap.js";
import { killProcessTree } from "./process_utils.js";
import { TaskOptions, TaskTree, TaskTreeStatus } from "./taskTree.js";

type UpdateData = {
  timeout: NodeJS.Timeout,
  needsRereadConfigFiles: boolean,
  changedProjects: Set<Project>,
}

function renderCycleError(cycle: string[]) {
  const cycleMessage = cycle.map((taskId, index): string => {
    const name = path.relative(process.cwd(), taskId);
    return (index === 0) ?
      '┌─▶' + name :
      '│' + ' '.repeat(2 + 3 * (index - 1)) + '└─▶' + name;
  });
  cycleMessage.push('└' + '─'.repeat(3 * (cycle.length - 1) + 2) + '┘')
  return ['Dependency cycle detected:', ...cycleMessage].join('\n');
}

export type WorkspaceOptions = {
  roots: string[],
  nodeOptions?: NodeForkOptions,
  watchMode: boolean,
  jobs: number,
};

type NodeForkOptions = {
  envFile?: AbsolutePath,
  forceColors?: boolean,
}

export const MSG_TASK_DONE = 'service started';

type ProjectEvents = {
  'build_status_changed': [],
  'build_stdout': [string],
  'build_stderr': [string],
}

export class Project extends EventEmitter<ProjectEvents> {

  private _configPath: AbsolutePath;
  private _taskTree: TaskTree<AbsolutePath>;

  private _fsWatch?: FSWatcher;
  
  private _customName?: string;
  private _configurationError?: any;

  private _nodeForkOptions?: NodeForkOptions;

  private _output: string = '';
  private _startTimestampMs: number = Date.now();
  private _stopTimestampMs?: number = Date.now();
  private _subprocess?: ChildProcess;

  constructor(taskTree: TaskTree<AbsolutePath>, configPath: AbsolutePath, nodeForkOptions?: NodeForkOptions) {
    super();
    this.setMaxListeners(Infinity);
    this._taskTree = taskTree;
    this._configPath = configPath;
    this._nodeForkOptions = nodeForkOptions;

    this._taskTree.on('task_started', (taskId) => {
      if (taskId !== this._configPath)
        return;
      this.emit('build_status_changed');
    });
    this._taskTree.on('task_finished', (taskId) => {
      if (taskId !== this._configPath)
        return;
      this.emit('build_status_changed');
    });
    this._taskTree.on('task_reset', (taskId) => {
      if (taskId !== this._configPath)
        return;
      this._output = '';
      this.emit('build_status_changed');
    });
  }

  async startFileWatch(toWatch: AbsolutePath[], toIgnore: AbsolutePath[], onFilesChanged?: (project: Project, filePath: AbsolutePath) => void) {
    await this.stopFileWatch();

    // Also, start watching for tsconfig.json, package.json, package-lock.json by default.
    const configDir = path.dirname(this._configPath) as AbsolutePath;
    toWatch.push(...[
      this._configPath,
      toAbsolutePath(configDir, 'tsconfig.json'),
      toAbsolutePath(configDir, 'package.json'),
      toAbsolutePath(configDir, 'package-lock.json'),
    ]);
    this._fsWatch = chokidar.watch(toWatch, {
      ignored: toIgnore,
      persistent: true,
      ignoreInitial: true,
    });
    this._fsWatch.on('all', (eventType: string, filePath?: string) => {
      if (filePath)
        onFilesChanged?.call(null, this, filePath as AbsolutePath);
    });
  }

  async stopFileWatch() {
    const fsWatch = this._fsWatch;
    this._fsWatch = undefined;

    fsWatch?.removeAllListeners();
    await fsWatch?.close();
  }

  configPath() { return this._configPath; }

  setConfiguration(result: ReadConfigResult) {
    this._customName = result.config?.name;

    if (this._configurationError !== result.error) {
      this._configurationError = result.error;
      if (this._configurationError) {
        this._output = this._configurationError;
        this.emit('build_stderr', this._output);
      }
    }
  }

  durationMs() {
    return (this._stopTimestampMs ?? Date.now()) - this._startTimestampMs;
  }

  name() {
    return this._customName ?? path.relative(process.cwd(), this._configPath);
  }

  status() {
    return this._taskTree.taskStatus(this._configPath);
  }

  id() {
    return this._configPath;
  }

  output(): string {
    return this._configurationError ?? this._output;
  }

  requestBuild(options: TaskOptions<AbsolutePath>) {
    // Fail build right away if there's some configuration error.
    if (this._configurationError) {
      this._startTimestampMs = Date.now();
      this._stopTimestampMs = Date.now();
      options.onComplete(false);
      return;
    }

    // Kill process if it is still running.
    this._killProcess();

    try {
      this._startTimestampMs = Date.now();
      this._stopTimestampMs = undefined;
      const execArgv: string[] = [
        '--enable-source-maps',
      ];
      if (this._configPath.endsWith('.ts') || this._configPath.endsWith('.mts'))
        execArgv.push(`--import=tsx`);
      if (this._nodeForkOptions?.envFile)
        execArgv.push(`--env-file=${this._nodeForkOptions.envFile}`);
      const env: Record<string, string|undefined> = {
        ...process.env,
        KUBIK_WATCH_MODE: this._fsWatch ? '1' : undefined,
        KUBIK_RUNNER: '1',
      };
      if (this._nodeForkOptions?.forceColors)
        env.FORCE_COLOR = '1';
      this._subprocess = fork(this._configPath, {
        cwd: path.dirname(this._configPath),
        stdio: 'pipe',
        execArgv,
        env,
        // Start process detached, so that we can effectively kill the whole process group
        // (the process and any child processes it might've spawned)
        detached: true,
      });
      options.signal.addEventListener('abort', () => {
        if (this._subprocess)
          this._onStdOut(`(process terminated by Kubik)`);
        this._killProcess();
      });
      this._subprocess.stdout?.on('data', data => this._onStdOut(data.toString('utf8')));
      this._subprocess.stderr?.on('data', data => this._onStdErr(data.toString('utf8')));

      this._subprocess.on('message', msg => {
        if (msg !== MSG_TASK_DONE)
          return;
        this._stopTimestampMs = Date.now();
        options.onComplete(true);
      });
      this._subprocess.on('close', code => {
        // The process might've reported its status with `Task.done()`, and then
        // terminate. In this case, we need to log its output code.
        if (this._taskTree.taskStatus(this._configPath) === 'running') {
          this._stopTimestampMs = Date.now();
          options.onComplete(code === 0);
        } else {
          this._onStdOut(`(process exited with code=${code})`);
        }
        this._killProcess();
      });
      this._subprocess.on('error', error => {
        options.onComplete(false);
        this._onStdErr(error.message);
        this._stopTimestampMs = Date.now();
        this._killProcess();
      });
    } catch (e) {
      this._output = `Failed to launch ${path.relative(process.cwd(), this._configPath)}\n`;
      if (e instanceof Error)
        this._output += e.message;
      options.onComplete(false);
    }
  }

  private _killProcess() {
    if (!this._subprocess)
      return;
    this._subprocess.stdout?.removeAllListeners();
    this._subprocess.stderr?.removeAllListeners();
    this._subprocess.removeAllListeners();
    killProcessTree(this._subprocess, 'SIGKILL');
    this._subprocess = undefined;
  }

  private _onStdOut(text: string) {
    this._output += text;
    this.emit('build_stdout', text);
  }

  private _onStdErr(text: string) {
    this._output += text;
    this.emit('build_stderr', text);
  }

  async dispose() {
    await this.stopFileWatch();
    this._killProcess();
  }
}

type WorkspaceEvents = {
  'workspace_status_changed': [],
  'project_added': [Project],
  'project_removed': [Project],
  'projects_changed': [],
}

export type WorkspaceStatus = TaskTreeStatus | 'error';

export class Workspace extends EventEmitter<WorkspaceEvents> {
  private _taskTree: TaskTree<AbsolutePath>;
  private _projects = new Map<AbsolutePath, Project>();

  private _updateData?: UpdateData;

  private _workspaceError?: string;

  constructor(private _options: WorkspaceOptions) {
    super();
    this.setMaxListeners(Infinity);

    this._taskTree = new TaskTree<AbsolutePath>(options => {
      const project = this._projects.get(options.taskId);
      project?.requestBuild(options);    
    }, { jobs: this._options.jobs, });

    this._taskTree.on('tree_status_changed', (status) => {
      if (!this._workspaceError)
        this.emit('workspace_status_changed');
    });

    this._scheduleUpdate({ needsRereadConfigFiles: true });
  }

  options() { return this._options; }

  workspaceStatus(): WorkspaceStatus {
    if (this._workspaceError)
      return 'error';
    return this._taskTree.status();
  }

  workspaceError() {
    return this._workspaceError;
  }

  bfsProjects(): Project[] {
    const taskIds = this._taskTree.bfs();
    return taskIds.map(taskId => this._projects.get(taskId)!);
  }

  scheduleUpdate(project: Project) {
    this._scheduleUpdate({ changedProject: project });
  }

  private _scheduleUpdate(options: { changedProject?: Project, needsRereadConfigFiles?: boolean }) {
    if (!options.changedProject && !options.needsRereadConfigFiles)
      return;
    if (!this._updateData) {
      this._updateData = {
        changedProjects: new Set(),
        needsRereadConfigFiles: false,
        timeout: setTimeout(this._doUpdate.bind(this), 150),
      }
    }
    if (options.changedProject)
      this._updateData.changedProjects.add(options.changedProject);
    if (options.needsRereadConfigFiles)
      this._updateData.needsRereadConfigFiles = true;
  }

  async stop() {
    clearTimeout(this._updateData?.timeout);
    this._taskTree.resetAllTasks();
    for (const project of this._projects.values())
      await project.dispose();
  }

  private async _doUpdate() {
    if (!this._updateData)
      return;
    // Pull data scheduled for update at this point of time and reset the update state.
    // If update state will change during this method execution, we will re-schedule the build.
    const { changedProjects, needsRereadConfigFiles } = this._updateData;
    this._updateData = {
      changedProjects: new Set(),
      needsRereadConfigFiles: false,
      timeout: this._updateData.timeout,
    };

    // First, propogate changes to the build tree.
    for (const changedProject of changedProjects)
      this._taskTree.markChanged(changedProject.configPath());  

    // Next, if some of the configuration files changed, than we have to re-read the configs
    // and update the build tree.
    if (needsRereadConfigFiles)
      await this._readConfiguration();

    // If while processing update, we got new incoming changes, than schedule processing
    // them as well. Otherwise, kick off build with new incorporated changes.
    if (this._updateData.changedProjects.size || this._updateData.needsRereadConfigFiles) {
      this._updateData.timeout = setTimeout(this._doUpdate.bind(this), 150);
    } else {
      this._updateData = undefined;
      this._taskTree.run();
    }
  }

  private _setWorkspaceError(error?: string) {
    if (error === this._workspaceError)
      return;
    this._workspaceError = error;
    this.emit('workspace_status_changed');
  }

  private async _readConfiguration() {
    let time = Date.now();
    const roots = this._options.roots.map(root => path.resolve(process.cwd(), root) as AbsolutePath);
    const configs = await readConfigTree(roots);
    const projectTree = new Multimap<AbsolutePath, AbsolutePath>();
    for (const [key, value] of configs) {
      const children = value.config?.deps ?? [];
      projectTree.setAll(key, children);
    }

    const cycle = TaskTree.findDependencyCycle(projectTree);
    if (cycle) {
      this._setWorkspaceError(renderCycleError(cycle));
      this._taskTree.clear();
    } else {
      this._setWorkspaceError(undefined);
      this._taskTree.setTasks(projectTree);
    }

    let hasProjectChanges = false;

    // Delete all projects that were removed.
    for (const [projectId, project] of this._projects) {
      if (!configs.has(projectId)) {
        await project.dispose();
        this._projects.delete(projectId);
        hasProjectChanges = true;
        this.emit('project_removed', project);
      }
    }

    // Create new projects and update configuration for existing projects.
    for (const config of configs.values()) {
      let project = this._projects.get(config.configPath);
      if (!project) {
        project = new Project(this._taskTree, config.configPath, this._options.nodeOptions);
        this._projects.set(config.configPath, project);
        hasProjectChanges = true;
        this.emit('project_added', project);
      }
      project.setConfiguration(config);
      if (this._options.watchMode) {
        await project.startFileWatch(config.config?.watch ?? [], config.config?.ignore ?? [], (project, filePath) => this._scheduleUpdate({
          changedProject: project,
          needsRereadConfigFiles: filePath === project.configPath(),
        }));
      }
    }

    if (hasProjectChanges)
      this.emit('projects_changed');
  }
}
