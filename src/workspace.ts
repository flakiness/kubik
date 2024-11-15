import { ChildProcess, fork } from "child_process";
import chokidar, { FSWatcher } from "chokidar";
import EventEmitter from "events";
import path from "path";
import { AbsolutePath, ReadConfigResult, readConfigTree, toAbsolutePath } from "./configLoader.js";
import { Multimap } from "./multimap.js";
import { killProcessTree } from "./process_utils.js";
import { TaskOptions, TaskTree } from "./taskTree.js";
import { dbgWatchApp } from "./watchApp.js";

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

type WorkspaceOptions = {
  watchMode: boolean,
  jobs: number,
};

export const NOTIFY_STARTED_MESSAGE = 'service started';

export class Project {
  private _workspace: Workspace;
  private _configPath: AbsolutePath;
  private _taskTree: TaskTree;

  private _fsWatch?: FSWatcher;
  
  private _customName?: string;
  private _configurationError?: any;

  private _output: string = '';
  private _startTimestampMs: number = Date.now();
  private _stopTimestampMs: number = Date.now();
  private _subprocess?: ChildProcess;

  constructor(workspace: Workspace, taskTree: TaskTree, configPath: AbsolutePath) {
    this._workspace = workspace;
    this._taskTree = taskTree;
    this._configPath = configPath;
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
        this._workspace.emit('project_stderr', this, this._output);
      }
    }
    this._workspace.emit('changed');
  }

  durationMs() {
    const status = this.status();
    return (status === 'fail' || status === 'ok') ? this._stopTimestampMs - this._startTimestampMs : 0;
  }

  name() {
    return this._customName ?? path.relative(process.cwd(), this._configPath);
  }

  status() {
    return this._taskTree.taskStatus(this._configPath);
  }

  output() {
    return this._output;
  }

  requestBuild(options: TaskOptions) {
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
      this._output = '';
      this._startTimestampMs = Date.now();
      this._subprocess = fork(this._configPath, {
        cwd: path.dirname(this._configPath),
        stdio: 'pipe',
        env: {
          ...process.env,
          KUBIK_WATCH_MODE: this._fsWatch ? '1' : undefined,
          KUBIK_RUNNER: '1',
        },
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
        if (msg !== NOTIFY_STARTED_MESSAGE)
          return;
        this._stopTimestampMs = Date.now();
        options.onComplete(true);
      });
      this._subprocess.on('close', code => {
        if (options.onComplete(code === 0)) {
          this._stopTimestampMs = Date.now();  
        } else {
          this._onStdOut(`(process exited with code=${code})`);
        }
        this._killProcess();
      });
      this._subprocess.on('error', error => {
        if (options.onComplete(false)) {
          this._onStdErr(error.message);
          this._stopTimestampMs = Date.now();
        }
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
    // this._output = '';
    killProcessTree(this._subprocess, 'SIGKILL');
    this._subprocess = undefined;
  }

  private _onStdOut(text: string) {
    this._output += text;
    this._workspace.emit('project_stdout', this, text);
    this._workspace.emit('changed');
  }

  private _onStdErr(text: string) {
    this._output += text;
    this._workspace.emit('project_stderr', this, text);
    this._workspace.emit('changed');
  }

  dispose() {
    this.stopFileWatch();
    this._killProcess();
  }
}

type WorkspaceEvents = {
  'changed': [],
  'workspace_error': [string],
  'project_started': [Project],
  'project_finished': [Project],
  'project_stdout': [Project, string],
  'project_stderr': [Project, string],
}

export class Workspace extends EventEmitter<WorkspaceEvents> {
  private _taskTree: TaskTree;
  private _projects = new Map<AbsolutePath, Project>();

  private _updateData?: UpdateData;
  private _roots: AbsolutePath[] = [];

  private _watchMode: boolean;

  private _workspaceError?: string;

  constructor(options: WorkspaceOptions) {
    super();
    this._watchMode = options.watchMode;
    this._taskTree = new TaskTree({
      runCallback: (options) => {
        const project = this._projects.get(options.taskId as AbsolutePath);
        project?.requestBuild(options);    
      },
      jobs: options.jobs,
    });
    
    this._taskTree.on('task_started', (taskId) => {
      this.emit('project_started', this._projects.get(taskId as AbsolutePath)!);
      this.emit('changed');
    });
    this._taskTree.on('task_finished', (taskId) => {
      this.emit('project_finished', this._projects.get(taskId as AbsolutePath)!)
      this.emit('changed');
    });
    this._taskTree.on('task_reset', () => this.emit('changed'));
  }

  workspaceError() {
    return this._workspaceError;
  }

  projects(): Project[] {
    const taskIds = this._taskTree.topsort();
    return taskIds.map(taskId => this._projects.get(taskId as AbsolutePath)!);
  }

  setRoots(roots: AbsolutePath[]) {
    this._roots = roots;
    this._scheduleUpdate({ needsRereadConfigFiles: true });
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
    this._watchMode = false;
    this._taskTree.resetAllTasks();
    for (const project of this._projects.values())
      project.dispose();
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
      this._taskTree.build();
    }
  }

  private async _readConfiguration() {
    let time = Date.now();
    const configs = await readConfigTree(this._roots);
    dbgWatchApp(`reading configs:`, (Date.now() - time) + 'ms');
    const projectTree = new Multimap<AbsolutePath, AbsolutePath>();
    for (const [key, value] of configs) {
      const children = value.config?.deps ?? [];
      projectTree.setAll(key, children);
    }

    const cycle = TaskTree.findDependencyCycle(projectTree);
    if (cycle) {
      this._workspaceError = renderCycleError(cycle);
      this._taskTree.clear();
      this.emit('workspace_error', this._workspaceError);
      this.emit('changed');
    } else {
      this._workspaceError = undefined;
      this._taskTree.setTasks(projectTree);
    }

    // Delete all projects that were removed.
    for (const [projectId, project] of this._projects) {
      if (!configs.has(projectId)) {
        project.dispose();
        this._projects.delete(projectId);
      }
    }

    // Create new projects and update configuration for existing projects.
    for (const config of configs.values()) {
      let project = this._projects.get(config.configPath);
      if (!project) {
        project = new Project(this, this._taskTree, config.configPath);
        this._projects.set(config.configPath, project);
      }
      project.setConfiguration(config);
      if (this._watchMode) {
        project.startFileWatch(config.config?.watch ?? [], config.config?.ignore ?? [], (project, filePath) => this._scheduleUpdate({
          changedProject: project,
          needsRereadConfigFiles: filePath === project.configPath(),
        }));
      }
    }

    this.emit('changed');
  }
}
