import assert from "assert";
import EventEmitter from "events";

import { Multimap } from "./multimap.js";
import { sha256 } from "./utils.js";

type Build = {
  stdout: string[],
  stderr: string[],
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

export type BuildStatus = {
  status: 'pending'|'running'|'ok'|'fail',
  durationMs: number,
  stdout: string,
  stderr: string,
}

export class BuildTree extends EventEmitter<{ changed: [string], stale: [] }> {
  private _nodes = new Map<string, Node>();
  private _roots: Node[] = [];
  private _staledVersion: string = '';
  private _buildBuildableTimeout?: NodeJS.Timeout;

  constructor(private _buildCallback: (options: BuildOptions) => void) {
    super();
  }

  buildStatus(nodeId: string): BuildStatus {
    const node = this._nodes.get(nodeId);
    assert(node, `Cannot get status for non-existing node with id "${nodeId}"`);
    return {
      status: !node.build ? 'pending' :
              node.build && node.build.success === undefined ? 'running' :
              node.build && node.build.success ? 'ok' : 'fail',
      durationMs: node.build?.success ? node.build.durationMs : 0,
      stderr: node.build?.stderr.join('\n') ?? '',
      stdout: node.build?.stdout.join('\n') ?? '',
    }
  }

  setTree(tree: Multimap<string, string>) {
    // Remove nodes that were dropped.
    const nodeIds = new Set([...tree.values(), ...tree.keys()]);
    for (const nodeId of this._nodes.keys()) {
      if (!nodeIds.has(nodeId))
        this._nodes.delete(nodeId);
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
    assert(this._roots.length, 'Build tree does not have roots');

    this._computeSubtreeSha();
    
    // Finally, initiate build
    this._scheduleBuildBuildable();
  }

  private _computeSubtreeSha() {
    const visited = new Set<Node>();
    const dfs = (node: Node) => {
      assert(!visited.has(node), 'Cycle detected');
      visited.add(node);
      node.children.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1);
      for (const child of node.children)
        dfs(child);
      node.subtreeSha = sha256([node.nodeId, ...node.children.map(child => child.subtreeSha)]);
      visited.delete(node);
    }
    this._roots.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1);
    for (const root of this._roots)
      dfs(root);
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
      for (const parent of node.parents)
        dfs(parent);
    }
    dfs(node);

    this._scheduleBuildBuildable();
  }

  private _scheduleBuildBuildable() {
    if (!this._buildBuildableTimeout)
      this._buildBuildableTimeout = setTimeout(this._buildBuildable.bind(this), 10);
  }

  private _buildBuildable() {
    this._buildBuildableTimeout = undefined;

    const visited = new Set<Node>();
    const startStopBuilds = (node: Node) => {
      if (visited.has(node))
        return;
      visited.add(node);
      if (currentBuildVersion(node) === node.build?.buildVersion)
        return;

      node.build?.abortController.abort();
      if (node.build)
        console.log(node)
      // by default, reset build if there's none.
      // This is a "pending" state.
      node.build = undefined;

      for (const child of node.children)
        startStopBuilds(child);
      
      // If some children don't have successful up-to-date build, then do nothing.
      if (!node.children.every(isSuccessfulCurrentBuild))
        return;

      // Otherwise, start building this node.
      node.build = {
        abortController: new AbortController(),
        buildVersion: currentBuildVersion(node),
        stdout: [],
        stderr: [],
        startTimestampMs: Date.now(),
        durationMs: 0,
      };
      this._buildCallback.call(null, {
        nodeId: node.nodeId,
        onComplete: this._onBuildComplete.bind(this, node, node.build.buildVersion),
        onStdErr: this._onStdErr.bind(this, node, node.build.buildVersion),
        onStdOut: this._onStdOut.bind(this, node, node.build.buildVersion),
        signal: node.build.abortController.signal,
      });
      this.emit('changed', node.nodeId);
    }
    for (const root of this._roots)
      startStopBuilds(root);

    const isStale = [...this._nodes.values()].every(node => !node.build || node.build.success !== undefined);
    const treeBuildVersion = sha256(this._roots.map(currentBuildVersion));
    if (isStale && this._staledVersion !== treeBuildVersion) {
      this._staledVersion = treeBuildVersion;
      this.emit('stale');
    }
  }

  private _onBuildComplete(node: Node, buildVersion: string, success: boolean) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.success = success;
    node.build.durationMs = Date.now() - node.build.startTimestampMs;
    this.emit('changed', node.nodeId);
    this._scheduleBuildBuildable();
  }

  private _onStdErr(node: Node, buildVersion: string, line: string) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.stderr.push(line);
  }

  private _onStdOut(node: Node, buildVersion: string, line: string) {
    if (node.build?.buildVersion !== buildVersion)
      return;
    node.build.stdout.push(line);
  }
}

function isSuccessfulCurrentBuild(node: Node) {
  return currentBuildVersion(node) === node.build?.buildVersion && node.build.success;
}

function currentBuildVersion(node: Node): string {
  return sha256([node.generation + '', node.subtreeSha]);
}
