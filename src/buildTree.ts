import assert from "assert";
import EventEmitter from "events";

import { Multimap } from "./multimap.js";
import { sha256 } from "./utils.js";

type Build = {
  output: string[],
  success?: boolean,
  abortController: AbortController,
  startTimestampMs: number,
  durationMs: number,
  buildVersion: string,
}

type Node = {
  nodeId: string,
  parents: Node[],
  children: Node[],
  generation: number,
  subtreeSha: string,
  build?: Build,
}

export type BuildOptions = {
  nodeId: string,
  signal: AbortSignal,
  onComplete: (success: boolean) => void,
  onStdOut: (line: string) => void,
  onStdErr: (line: string) => void,
}

export type BuildTreeOptions = {
  buildCallback: (options: BuildOptions) => void,
  parallelization: number,
}

export class CycleError extends Error {
  constructor(public cycle: string[]) {
    super('Dependency cycle detected');
  }
}

export type BuildStatus = {
  status: 'pending'|'running'|'ok'|'fail',
  durationMs: number,
  output: string,
}

type BuildTreeEvents = {
  'changed': [string],
  'completed': [],
  'node_build_will_start': [string],
  'node_build_finished': [string],
  'node_build_aborted': [string],
  'node_build_stdout': [string, string],
  'node_build_stderr': [string, string],
}

export class BuildTree extends EventEmitter<BuildTreeEvents> {
  private _nodes = new Map<string, Node>();
  private _roots: Node[] = [];
  private _buildBuildableTimeout?: NodeJS.Timeout;
  private _lastCompleteTreeVersion: string = '';
  
  constructor(private _options: BuildTreeOptions) {
    super();
  }

  /**
   * The tree is "complete" if there's nothing to be built.
   * However, every time tree is modified, the build has to be kicked off manually
   * with the "startBuilding()" method.
   * @returns 
   */
  treeBuildStatus(): 'complete'|'incomplete' {
    const nodes = [...this._nodes.values()];
    // We say that the tree is "complete", if there's nothing to be built: all built results are in.
    // We consider the tree to be complete, if:
    // All nodes that 
    const isComplete = nodes.every(node => node.build && node.build.success !== undefined);
    return isComplete ? 'complete' : 'incomplete';
  }

  buildStatus(nodeId: string): BuildStatus {
    const node = this._nodes.get(nodeId);
    assert(node, `Cannot get status for non-existing node with id "${nodeId}"`);
    return {
      status: !node.build ? 'pending' :
              node.build && node.build.success === undefined ? 'running' :
              node.build && node.build.success ? 'ok' : 'fail',
      durationMs: node.build?.success ? node.build.durationMs : 0,
      output: node.build?.output.join('') ?? '',
    }
  }

  private _checkNoCycles(tree: Multimap<string, string>) {
    const stackIndexes = new Map<string, number>();
    const visited = new Set<string>();
    const dfs = (nodeId: string, stack: string[] = []) => {
      const stackIndex = stackIndexes.get(nodeId);
      if (stackIndex !== undefined)
        throw new CycleError(stack.slice(stackIndex));

      if (visited.has(nodeId))
        return;
      visited.add(nodeId);

      stackIndexes.set(nodeId, stack.push(nodeId) - 1);
      for (const child of tree.getAll(nodeId))
        dfs(child, stack);
      stack.pop();
      stackIndexes.delete(nodeId);
    }
    for (const key of tree.keys())
      dfs(key);
  }

  abort() {
    for (const node of this._nodes.values())
      this.markChanged(node.nodeId);
  }

  /**
   * Set build tree. This will synchronously abort builds for those nodes
   * that were either removed or changed.
   * @param tree 
   */
  setBuildTree(tree: Multimap<string, string>) {
    this._checkNoCycles(tree);

    // Remove nodes that were dropped, cancelling their build in the meantime.
    const nodeIds = new Set([...tree.values(), ...tree.keys()]);
    for (const [nodeId, node] of this._nodes) {
      if (!nodeIds.has(nodeId)) {
        this._abortBuild(node);
        this._nodes.delete(nodeId);
      }
    }
    this._roots = [];

    // Create all new nodes.
    for (const nodeId of nodeIds) {
      if (!this._nodes.has(nodeId)) {
        this._nodes.set(nodeId, {
          nodeId,
          children: [],
          parents: [],
          generation: 0,
          subtreeSha: '',
        });  
      }
      const node = this._nodes.get(nodeId)!;
      node.children = [];
      node.parents = [];
    }

    // Build a graph.
    for (const [nodeId, children] of tree) {
      const node = this._nodes.get(nodeId)!;
      for (const childId of children) {
        const child = this._nodes.get(childId)!;
        node.children.push(child);
        child.parents.push(node);
      }
    }

    // Figure out roots
    this._roots = [...this._nodes.values()].filter(node => !node.parents.length);

    this._computeSubtreeSha();
  }

  private _computeSubtreeSha() {
    const dfs = (node: Node) => {
      node.children.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1);
      for (const child of node.children)
        dfs(child);
      const subtreeSha = sha256([node.nodeId, ...node.children.map(child => child.subtreeSha)]);
      if (node.subtreeSha !== subtreeSha) {
        node.subtreeSha = subtreeSha;
        this._abortBuild(node);
      }
    }
    this._roots.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1);
    for (const root of this._roots)
      dfs(root);
  }

  private _treeVersion(): string {
    return sha256(this._roots.map(nodeVersion));
  }

  buildOrder(): string[] {
    const result: string[] = [];
    const visited = new Set<Node>();
    const dfs = (node: Node) => {
      if (visited.has(node))
        return;
      visited.add(node);
      for (const child of node.children)
        dfs(child);
      result.push(node.nodeId);
    }
    for (const root of this._roots)
      dfs(root);
    return result;
  }

  markChanged(nodeId: string) {
    const node = this._nodes.get(nodeId);
    assert(node, `cannot mark changed a node ${nodeId} that does not exist`);
    const visited = new Set<Node>();
    const dfs = (node: Node) => {
      if (visited.has(node))
        return;
      visited.add(node);
      ++node.generation;
      this._abortBuild(node);
      for (const parent of node.parents)
        dfs(parent);
    }
    dfs(node);
  }

  startBuilding() {
    this._scheduleBuildBuildable();
  }

  private _scheduleBuildBuildable() {
    if (!this._buildBuildableTimeout)
      this._buildBuildableTimeout = setTimeout(this._buildBuildable.bind(this), 10);
  }

  // This method will change node.build accordingly:
  // - for those projects that were running builds, but the node's version have changed,
  //   the builds will be canceled.
  // - for those projcets that can start running builds, these builds will be initiated.
  private _buildBuildable() {
    this._buildBuildableTimeout = undefined;

    const visited = new Set<Node>();
    const allNodesToBeBuilt: Node[] = [];
    const startStopBuilds = (node: Node) => {
      if (visited.has(node))
        return;
      visited.add(node);
      if (nodeVersion(node) === node.build?.buildVersion)
        return;

      // By default, cancel build if any and RESET BUILD. The "node.build = undefined"
      // means that the build for this node is pending.
      this._abortBuild(node);

      for (const child of node.children)
        startStopBuilds(child);
      
      // If some children don't have successful up-to-date build, then do nothing.
      if (!node.children.every(isSuccessfulCurrentBuild))
        return;

      allNodesToBeBuilt.push(node);
    }
    for (const root of this._roots)
      startStopBuilds(root);

    const runningBuildsCount = [...this._nodes.values()].filter(node => this.buildStatus(node.nodeId).status === 'running').length;
    const nodesToBuildCount = Math.min(allNodesToBeBuilt.length, this._options.parallelization - runningBuildsCount);
    for (const node of allNodesToBeBuilt.slice(0, Math.max(0, nodesToBuildCount)))
      this._startBuild(node);  

    const treeVersion = this._treeVersion();
    if (this.treeBuildStatus() === 'complete' && this._lastCompleteTreeVersion !== treeVersion) {
      this._lastCompleteTreeVersion = treeVersion;
      this.emit('completed');
    }
  }

  private _abortBuild(node: Node) {
    // For the up-to-date build, we record its result.
    // Otherwise, we mark the node's build as pending.
    // NOTE: we have to emit events only if we do changes to node's status.
    if (nodeVersion(node) === node.build?.buildVersion) {
      if (node.build.success === undefined) {
        node.build.abortController.abort();
        node.build.success = false;
        node.build.durationMs = Date.now() - node.build.startTimestampMs;
        this.emit('changed', node.nodeId);
        this.emit('node_build_aborted', node.nodeId);
      }
    } else {
      if (node.build !== undefined) {
        // Abort only running builds.
        if (node.build.success === undefined) {
          node.build.abortController.abort();
          this.emit('node_build_aborted', node.nodeId);
        }
        node.build = undefined;
        this.emit('changed', node.nodeId);
      }
    }
  }

  private _startBuild(node: Node) {
    assert(!node.build);
    this.emit('node_build_will_start', node.nodeId);
    node.build = {
      abortController: new AbortController(),
      buildVersion: nodeVersion(node),
      output: [],
      startTimestampMs: Date.now(),
      durationMs: 0,
    };
    this._options.buildCallback.call(null, {
      nodeId: node.nodeId,
      onComplete: this._onBuildComplete.bind(this, node, node.build.buildVersion),
      onStdErr: this._onStdErr.bind(this, node, node.build.buildVersion),
      onStdOut: this._onStdOut.bind(this, node, node.build.buildVersion),
      signal: node.build.abortController.signal,
    });
    this.emit('changed', node.nodeId);
  }

  private _onBuildComplete(node: Node, buildVersion: string, success: boolean) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.success = success;
    node.build.durationMs = Date.now() - node.build.startTimestampMs;
    this.emit('changed', node.nodeId);
    this.emit('node_build_finished', node.nodeId);
    this._scheduleBuildBuildable();
  }

  private _onStdErr(node: Node, buildVersion: string, line: string) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.output.push(line);
    this.emit('node_build_stderr', node.nodeId, line);
  }

  private _onStdOut(node: Node, buildVersion: string, line: string) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.output.push(line);
    this.emit('node_build_stdout', node.nodeId, line);
  }
}

function isSuccessfulCurrentBuild(node: Node) {
  return nodeVersion(node) === node.build?.buildVersion && node.build.success;
}

function nodeVersion(node: Node): string {
  return sha256([node.generation + '', node.subtreeSha]);
}
