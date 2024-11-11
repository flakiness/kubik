import { spawn } from "child_process";
import chokidar, { FSWatcher } from "chokidar";
import EventEmitter from "events";
import path from "path";
import { BuildOptions, BuildTree, CycleError } from "./buildTree.js";
import { AbsolutePath, ReadConfigResult, readConfigTree, toAbsolutePath } from "./configLoader.js";
import { Multimap } from "./multimap.js";
import { killProcessTree } from "./process_utils.js";

type UpdateData = {
  timeout: NodeJS.Timeout,
  needsRereadConfigFiles: boolean,
  changedConfigs: Set<AbsolutePath>,
}

function renderCycleError(error: CycleError) {
  const cycleMessage = error.cycle.map((nodeId, index): string => {
    if (index === 0)
      return '┌ ' + nodeId;
    if (index !== error.cycle.length - 1)
      return '│' + ' '.repeat(index + 1) + '└ ' + nodeId;
    return '└' + '─'.repeat(index + 1) + '┴ ' + nodeId;
  });
  return ['Dependency cycle detected', ...cycleMessage].join('\n');
}

type ProjectBuilderOptions = {
  watchMode: boolean,
  buildMode: 'parallel'|'sequential',
};


type ProjectBuilderEvents = {
  'changed': [ReadConfigResult],
  'completed': [],
  'project_build_will_start': [ReadConfigResult],
  'project_build_finished': [ReadConfigResult],
  'project_build_aborted': [ReadConfigResult],
  'project_build_stdout': [ReadConfigResult, string],
  'project_build_stderr': [ReadConfigResult, string],
}

export class ProjectBuilder extends EventEmitter<ProjectBuilderEvents> {
  private _buildTree: BuildTree;
  private _configs = new Map<AbsolutePath, ReadConfigResult>();
  private _fileWatchers = new Map<AbsolutePath, FSWatcher>();

  private _updateData?: UpdateData;
  private _roots: AbsolutePath[] = [];

  private _watchMode: boolean;

  constructor(options: ProjectBuilderOptions) {
    super();
    this._watchMode = options.watchMode;
    this._buildTree = new BuildTree({
      buildCallback: this._build.bind(this),
      mode: options.buildMode,
    });

    this._buildTree.on('changed', (nodeId) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('changed', result);
    });
    this._buildTree.on('completed', () => {
      this.emit('completed');
    });
    this._buildTree.on('node_build_will_start', (nodeId) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('project_build_will_start', result);
    });
    this._buildTree.on('node_build_aborted', (nodeId) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('project_build_aborted', result);
    });
    this._buildTree.on('node_build_finished', (nodeId) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('project_build_finished', result);
    });
    this._buildTree.on('node_build_stderr', (nodeId, line) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('project_build_stderr', result, line);
    });
    this._buildTree.on('node_build_stdout', (nodeId, line) => {
      const result = this._configs.get(nodeId as AbsolutePath)!;
      this.emit('project_build_stdout', result, line);
    });
  }

  setRoots(roots: AbsolutePath[]) {
    this._roots = roots;
    this._scheduleUpdate({ needsRereadConfigFiles: true });
  }

  private async _reinitializeFileWatcher() {
    if (!this._watchMode)
      return false;

    for (const [nodeId, fileWatcher] of this._fileWatchers)
      fileWatcher.removeAllListeners();
    await Promise.all([...this._fileWatchers.values()].map(fsWatcher => fsWatcher.close()));
    this._fileWatchers.clear();

    // list of all paths to watch and ignore
    for (const [configPath, result] of this._configs) {
      const toWatch: AbsolutePath[] = [];
      const toIgnore: AbsolutePath[] = [];
      toWatch.push(configPath);
      if (result.config) {
        toWatch.push(...result.config.watch);
        toIgnore.push(...result.config.ignore);
      }
      // Also, start watching for tsconfig.json, package.json, package-lock.json by default.
      const configDir = path.dirname(configPath) as AbsolutePath;
      toWatch.push(...[
        toAbsolutePath(configDir, 'tsconfig.json'),
        toAbsolutePath(configDir, 'package.json'),
        toAbsolutePath(configDir, 'package-lock.json'),
      ]);
      const fileWatcher = chokidar.watch(toWatch, {
        ignored: toIgnore,
        persistent: true,
        ignoreInitial: true,
      });
      fileWatcher.on('all', (eventType: string, filePath?: string) => {
        this._scheduleUpdate({ changedConfig: configPath, needsRereadConfigFiles: configPath === filePath });
      });
    }
  }

  private _scheduleUpdate(options: { changedConfig?: AbsolutePath, needsRereadConfigFiles?: boolean }) {
    if (!options.changedConfig && !options.needsRereadConfigFiles)
      return;
    if (!this._updateData) {
      this._updateData = {
        changedConfigs: new Set(),
        needsRereadConfigFiles: false,
        timeout: setTimeout(this._doUpdate.bind(this), 150),
      }
    }
    if (options.changedConfig)
      this._updateData.changedConfigs.add(options.changedConfig);
    if (options.needsRereadConfigFiles)
      this._updateData.needsRereadConfigFiles = true;
  }

  private async _doUpdate() {
    if (!this._updateData)
      return;
    // Pull data scheduled for update at this point of time and reset the update state.
    // If update state will change during this method execution, we will re-schedule the build.
    const { changedConfigs, needsRereadConfigFiles } = this._updateData;
    this._updateData = {
      changedConfigs: new Set(),
      needsRereadConfigFiles: false,
      timeout: this._updateData.timeout,
    };

    // First, propogate changes to the build tree.
    for (const changedConfig of changedConfigs)
      this._buildTree.markChanged(changedConfig);

    // Next, if some of the configuration files changed, than we have to re-read the configs
    // and update the build tree.
    if (needsRereadConfigFiles)
      await this._readConfiguration();

    // If while processing update, we got new incoming changes, than schedule processing
    // them as well. Otherwise, kick off build with new incorporated changes.
    if (this._updateData.changedConfigs.size || this._updateData.needsRereadConfigFiles) {
      this._updateData.timeout = setTimeout(this._doUpdate.bind(this), 150);
    } else {
      this._updateData = undefined;
      this._buildTree.startBuilding();
    }
  }

  private async _readConfiguration() {
    this._configs = await readConfigTree(this._roots);
    const projectTree = new Multimap<AbsolutePath, AbsolutePath>();
    for (const [key, value] of this._configs) {
      const children = value.config?.deps ?? [];
      projectTree.setAll(key, children);
    }
    this._buildTree.setBuildTree(projectTree);
    this._reinitializeFileWatcher();
  }

  private _build(options: BuildOptions) {
    const readConfigResult = this._configs.get(options.nodeId as AbsolutePath);
    if (readConfigResult?.error) {
      options.onStdErr(readConfigResult.error);
      options.onComplete(false);
      return;
    }
    const configPath = options.nodeId;
    const subprocess = spawn(process.execPath, [configPath], {
      cwd: path.dirname(configPath),
      stdio: 'pipe',
      env: {
        ...process.env,
        KUBIK_WATCH_MODE: '1',
        KUBIK_RUNNER: '1',
      },
      windowsHide: true,
    });
    subprocess.stdout.on('data', data => options.onStdOut(data.toString('utf8')));
    subprocess.stderr.on('data', data => options.onStdErr(data.toString('utf8')));
    subprocess.on('close', code => options.onComplete(code === 0));
    subprocess.on('error', error => options.onComplete(false));

    options.signal.addEventListener('abort', () => {
      killProcessTree(subprocess, 'SIGKILL');
    });
  }
}
