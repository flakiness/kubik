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
  /**
   * The build is set if:
   * 1. It's been scheduled with buildCallback
   * 2. The version of the node hasn't changed since the build was started.
   * 
   * If the version of the node changes while the build is in-progress,
   * it'll be aborted and the value here is cleared.
   */
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
  jobs: number,
}

export class CycleError extends Error {
  constructor(public cycle: string[]) {
    super('Dependency cycle detected');
  }
}

export type BuildStatus = 'n/a'|'pending'|'running'|'ok'|'fail';

export type BuildInfo = {
  status: BuildStatus,
  durationMs: number,
  output: string,
}

type BuildTreeEvents = {
  'completed': [],
  'node_build_started': [string],
  'node_build_finished': [string],
  'node_build_aborted': [string],
  'node_build_stdout': [string, string],
  'node_build_stderr': [string, string],
}

export class BuildTree extends EventEmitter<BuildTreeEvents> {
  private _nodes = new Map<string, Node>();
  private _roots: Node[] = [];
  private _lastCompleteTreeVersion: string = '';
  
  constructor(private _options: BuildTreeOptions) {
    super();
  }

  buildInfo(nodeId: string): BuildInfo {
    const node = this._nodes.get(nodeId);
    assert(node, `Cannot get status for non-existing node with id "${nodeId}"`);
    return {
      status: !node.build && this._computeTreeVersion() === this._lastCompleteTreeVersion ? 'n/a' :
              !node.build ? 'pending' :
              node.build && node.build.success === undefined ? 'running' :
              node.build && node.build.success ? 'ok' : 'fail',
      durationMs: node.build?.success ? node.build.durationMs : 0,
      output: node.build?.output.join('') ?? '',
    };
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

  resetAllBuilds() {
    for (const node of this._nodes.values())
      this._resetBuild(node);
  }

  /**
   * Set build tree. This will synchronously abort builds for those nodes
   * that were either removed or changed their dependencies.
   * @param tree 
   */
  setBuildTree(tree: Multimap<string, string>) {
    this._checkNoCycles(tree);

    // Remove nodes that were dropped, cancelling their build in the meantime.
    const nodeIds = new Set([...tree.values(), ...tree.keys()]);
    for (const [nodeId, node] of this._nodes) {
      if (!nodeIds.has(nodeId)) {
        this._resetBuild(node);
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
        this._resetBuild(node);
      }
    }
    this._roots.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1);
    for (const root of this._roots)
      dfs(root);
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

  /**
   * This will synchronously abort builds for the `nodeId` and all its parents.
   * @param nodeId
   */
  markChanged(nodeId: string) {
    const node = this._nodes.get(nodeId);
    assert(node, `cannot mark changed a node ${nodeId} that does not exist`);
    const visited = new Set<Node>();
    const dfs = (node: Node) => {
      if (visited.has(node))
        return;
      visited.add(node);
      ++node.generation;
      this._resetBuild(node);
      for (const parent of node.parents)
        dfs(parent);
    }
    dfs(node);
  }

  private _buildableNodes(): Node[] {
    return [...this._nodes.values()].filter(node => !node.build && node.children.every(isSuccessfulCurrentBuild));
  }

  private _nodesBeingBuilt(): Node[] {
    return [...this._nodes.values()].filter(node => node.build && node.build.success === undefined);
  }

  private _computeTreeVersion() {
    return sha256(this._roots.map(nodeVersion));
  }

  /**
   * This method will traverse the tree and start building nodes that are buildable.
   * Note that once these nodes complete to build, other node will be started.
   * To stop the process, run the `resetAllBuilds()` method.
   * @returns 
   */
  build() {
    const nodesBeingBuilt = this._nodesBeingBuilt();
    const buildableNodes = this._buildableNodes();

    if (nodesBeingBuilt.length === 0 && buildableNodes.length === 0) {
      const treeVersion = this._computeTreeVersion();
      if (treeVersion !== this._lastCompleteTreeVersion) {
        this._lastCompleteTreeVersion = treeVersion;
        this.emit('completed');
      }
      return;
    }

    const capacity = this._options.jobs - nodesBeingBuilt.length;
    if (capacity <= 0)
      return;

    for (const node of buildableNodes.slice(0, capacity)) {
      node.build = {
        abortController: new AbortController(),
        buildVersion: nodeVersion(node),
        output: [],
        startTimestampMs: Date.now(),
        durationMs: 0,
      };
      const buildOptions: BuildOptions = {
        nodeId: node.nodeId,
        onComplete: this._onBuildComplete.bind(this, node, node.build.buildVersion),
        onStdErr: this._onStdErr.bind(this, node, node.build.buildVersion),
        onStdOut: this._onStdOut.bind(this, node, node.build.buildVersion),
        signal: node.build.abortController.signal,
      };
      // Request building in a microtask to avoid reenterability.
      Promise.resolve().then(() => {
        this._options.buildCallback.call(null, buildOptions)
        this.emit('node_build_started', node.nodeId);
      });
    }
  }

  private _resetBuild(node: Node) {
    if (!node.build)
      return;
    const build = node.build;
    node.build = undefined;
    // Make sure to emit event as the very last thing.
    if (build.success === undefined) {
      build.abortController.abort();
      this.emit('node_build_aborted', node.nodeId);
    }
  }

  private _onBuildComplete(node: Node, buildVersion: string, success: boolean) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.success = success;
    node.build.durationMs = Date.now() - node.build.startTimestampMs;
    this.emit('node_build_finished', node.nodeId);
    this.build();
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
