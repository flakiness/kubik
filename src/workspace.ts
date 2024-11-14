import { spawn } from "child_process";
import chokidar, { FSWatcher } from "chokidar";
import EventEmitter from "events";
import path from "path";
import { BuildOptions, BuildStatus, BuildTree, CycleError } from "./buildTree.js";
import { AbsolutePath, ReadConfigResult, readConfigTree, toAbsolutePath } from "./configLoader.js";
import { Multimap } from "./multimap.js";
import { killProcessTree } from "./process_utils.js";

type UpdateData = {
  timeout: NodeJS.Timeout,
  needsRereadConfigFiles: boolean,
  changedProjects: Set<InternalProject>,
}

function renderCycleError(cycle: string[]) {
  const cycleMessage =cycle.map((projectName, index): string => {
    if (index === 0)
      return '┌─▶' + projectName;
    return '│' + ' '.repeat(2 + 3*(index - 1)) + '└─▶' + projectName;
  });
  cycleMessage.push('└' + '─'.repeat(3 * (cycle.length - 1) + 2) + '┘')
  return ['Dependency cycle detected', ...cycleMessage].join('\n');
}

type WorkspaceOptions = {
  watchMode: boolean,
  jobs: number,
};

export type Project = {
  name: string;
  status: BuildStatus,
  durationMs: number,
  output: string,
}

class InternalProject {
  private _configPath: AbsolutePath;
  private _buildTree: BuildTree;
  private _config?: ReadConfigResult;
  private _watchMode: boolean = false;
  private _fsWatch?: FSWatcher;

  private _output: string = '';
  private _startTimestampMs?: number;
  private _stopTimestampMs?: number;

  constructor(buildTree: BuildTree, configPath: AbsolutePath) {
    this._buildTree = buildTree;
    this._configPath = configPath;
  }

  async startFileWatch(onFilesChanged?: (project: InternalProject, filePath: AbsolutePath) => void) {
    this._watchMode = true;
    await this._reinitializeFileWatcher(onFilesChanged);
  }

  async stopFileWatch() {
    this._watchMode = false;
    await this._reinitializeFileWatcher();
  }

  private async _reinitializeFileWatcher(onFilesChanged?: (project: InternalProject, filePath: AbsolutePath) => void) {
    this._fsWatch?.removeAllListeners();
    await this._fsWatch?.close();
    this._fsWatch = undefined;

    if (!this._watchMode)
      return;

    const toWatch: AbsolutePath[] = [];
    const toIgnore: AbsolutePath[] = [];
    toWatch.push(this._configPath);
    if (this._config?.config) {
      toWatch.push(...this._config.config.watch);
      toIgnore.push(...this._config.config.ignore);
    }

    // Also, start watching for tsconfig.json, package.json, package-lock.json by default.
    const configDir = path.dirname(this._configPath) as AbsolutePath;
    toWatch.push(...[
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

  configPath() { return this._configPath; }

  name() {
    return this._config?.config?.name ? this._config.config.name : path.relative(process.cwd(), this._configPath);
  }

  setConfigResult(config: ReadConfigResult) {
    this._config = config;
  }

  toProject() {
    const status = this._buildTree.nodeBuildStatus(this._configPath);
    return {
      name: this.name(),
      durationMs: this._startTimestampMs && this._stopTimestampMs ? this._stopTimestampMs - this._startTimestampMs : 0,
      output: this._output,
      status: status,
    } as Project;
  }

  requestBuild(options: BuildOptions) {
    if (this._config?.error) {
      this._output = this._config.error;
      options.onComplete(false);
      return;
    }

    try {
      this._output = '';
      this._startTimestampMs = Date.now();
      const subprocess = spawn(process.execPath, [this._configPath], {
        cwd: path.dirname(this._configPath),
        stdio: 'pipe',
        env: {
          ...process.env,
          KUBIK_WATCH_MODE: this._watchMode ? '1' : undefined,
          KUBIK_RUNNER: '1',
        },
        windowsHide: true,
        detached: true,
      });
      subprocess.stdout.on('data', data => this._onStdOut(data.toString('utf8')));
      subprocess.stderr.on('data', data => this._onStdErr(data.toString('utf8')));

      subprocess.on('close', code => {
        this._stopTimestampMs = Date.now();
        options.onComplete(code === 0);
      });
      subprocess.on('error', error => {
        this._stopTimestampMs = Date.now();
        options.onComplete(false);
      });

      options.signal.addEventListener('abort', () => {
        subprocess.stdout?.removeAllListeners();
        subprocess.stderr?.removeAllListeners();
        subprocess.removeAllListeners();
        this._output = '';
        killProcessTree(subprocess, 'SIGKILL');
      });
    } catch (e) {
      this._output = `Failed to launch ${path.relative(process.cwd(), this._configPath)}\n`;
      if (e instanceof Error)
        this._output += e.message;
      options.onComplete(false);
    }
  }

  private _onStdOut(text: string) {
    this._output += text;
  }

  private _onStdErr(text: string) {
    this._output += text;
  }

}

type WorkspaceEvents = {
  'changed': [],
  'project_started': [Project],
  'project_finished': [Project],
  'project_stdout': [Project, string],
  'project_stderr': [Project, string],
}

export class Workspace extends EventEmitter<WorkspaceEvents> {
  private _buildTree: BuildTree;
  private _projects = new Map<AbsolutePath, InternalProject>();

  private _updateData?: UpdateData;
  private _roots: AbsolutePath[] = [];

  private _watchMode: boolean;

  constructor(options: WorkspaceOptions) {
    super();
    this._watchMode = options.watchMode;
    this._buildTree = new BuildTree({
      buildCallback: (options) => {
        const project = this._projects.get(options.nodeId as AbsolutePath);
        project?.requestBuild(options);    
      },
      jobs: options.jobs,
    });
    
    this._buildTree.on('node_build_started', (nodeId) => {
      this.emit('project_started', this._projects.get(nodeId as AbsolutePath)!.toProject());
      this.emit('changed');
    });
    this._buildTree.on('node_build_finished', (nodeId) => {
      this.emit('project_finished', this._projects.get(nodeId as AbsolutePath)!.toProject())
      this.emit('changed');
    });
    this._buildTree.on('node_build_aborted', () => this.emit('changed'));

    this._buildTree.on('node_build_stderr', (nodeId, line) => {
      this.emit('project_stderr', this._projects.get(nodeId as AbsolutePath)!.toProject(), line);
      this.emit('changed');
    });
    this._buildTree.on('node_build_stdout', (nodeId, line) => {
      this.emit('project_stdout', this._projects.get(nodeId as AbsolutePath)!.toProject(), line);
      this.emit('changed');
    });
  }

  projects(): Project[] {
    const nodeIds = this._buildTree.topsort();
    return nodeIds.map(nodeId => this._projects.get(nodeId as AbsolutePath)!.toProject());
  }

  setRoots(roots: AbsolutePath[]) {
    this._roots = roots;
    this._scheduleUpdate({ needsRereadConfigFiles: true });
  }

  private _scheduleUpdate(options: { changedProject?: InternalProject, needsRereadConfigFiles?: boolean }) {
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
    this._buildTree.resetAllBuilds();
    for (const project of this._projects.values())
      project.stopFileWatch();
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
      this._buildTree.markChanged(changedProject.configPath());

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
      this._buildTree.build();
    }
  }

  private async _readConfiguration() {
    const configs = await readConfigTree(this._roots);
    const projectTree = new Multimap<AbsolutePath, AbsolutePath>();
    for (const [key, value] of configs) {
      const children = value.config?.deps ?? [];
      projectTree.setAll(key, children);
    }

    try {
      const { addedNodes, removedNodes } = this._buildTree.setBuildTree(projectTree);
      for (const nodeId of removedNodes) {
        const project = this._projects.get(nodeId as AbsolutePath);
        project?.stopFileWatch();
        this._projects.delete(nodeId as AbsolutePath);
      }
      for (const nodeId of addedNodes) {
        const project = new InternalProject(this._buildTree, nodeId as AbsolutePath);
        this._projects.set(nodeId as AbsolutePath, project);
      }
      // For all existing projects, update configuration, and re-initialize watches.
      for (const project of this._projects.values()) {
        project.setConfigResult(configs.get(project.configPath())!);
        if (this._watchMode) {
          project.startFileWatch((project, filePath) => this._scheduleUpdate({
            changedProject: project,
            needsRereadConfigFiles: filePath === project.configPath(),
          }));
        }
      }
    } catch (e) {
      if (e instanceof CycleError) {
        const error = new Error(renderCycleError(e.cycle.map(nodeId => path.relative(process.cwd(), nodeId))));
        error.stack = '';
        throw error;
      }
      throw e;
    }
    this.emit('changed');
  }
}
