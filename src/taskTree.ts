import assert from "assert";
import EventEmitter from "events";

import { Multimap } from "./multimap.js";
import { sha256 } from "./utils.js";

type Execution = {
  success?: boolean,
  abortController: AbortController,
  buildVersion: string,
}

type Task = {
  taskId: string,
  parents: Task[],
  children: Task[],
  generation: number,
  subtreeSha: string,
  /**
   * The execution is set if:
   * 1. It's been scheduled with buildCallback
   * 2. The version of the node hasn't changed since the build was started.
   * 
   * If the version of the node changes while the build is in-progress,
   * it'll be aborted and the value here is cleared.
   */
  execution?: Execution,
}

export type TaskOptions = {
  taskId: string,
  signal: AbortSignal,
  onComplete: (success: boolean) => boolean,
}

export type TaskTreeOptions = {
  runCallback: (options: TaskOptions) => void,
  jobs: number,
}

export class CycleError extends Error {
  constructor(public cycle: string[]) {
    super('Dependency cycle detected');
  }
}

export type TaskStatus = 'n/a'|'pending'|'running'|'ok'|'fail';

type TaskTreeEvents = {
  'completed': [],
  'task_started': [string],
  'task_finished': [string],
  'task_reset': [string],
}

export class TaskTree extends EventEmitter<TaskTreeEvents> {

  static findDependencyCycle(tree: Multimap<string, string>) {
    const stackIndexes = new Map<string, number>();
    const visited = new Set<string>();
    const findCycle = (nodeId: string, stack: string[] = []): (string[]|undefined) => {
      const stackIndex = stackIndexes.get(nodeId);
      if (stackIndex !== undefined)
        return stack.slice(stackIndex);

      if (visited.has(nodeId))
        return;
      visited.add(nodeId);

      stackIndexes.set(nodeId, stack.push(nodeId) - 1);
      for (const child of tree.getAll(nodeId)) {
        const cycle = findCycle(child, stack);
        if (cycle)
          return cycle;
      }
      stack.pop();
      stackIndexes.delete(nodeId);
    }
    for (const key of tree.keys()) {
      const cycle = findCycle(key);
      if (cycle)
        return cycle;
    }
    return undefined;
  }

  private _tasks = new Map<string, Task>();
  private _roots: Task[] = [];
  private _lastCompleteTreeVersion: string = '';
  
  constructor(private _options: TaskTreeOptions) {
    super();
  }

  taskStatus(taskId: string): TaskStatus {
    const task = this._tasks.get(taskId);
    assert(task, `Cannot get status for non-existing node with id "${taskId}"`);
    return !task.execution && this._computeTreeVersion() === this._lastCompleteTreeVersion ? 'n/a' :
              !task.execution ? 'pending' :
              task.execution && task.execution.success === undefined ? 'running' :
              task.execution && task.execution.success ? 'ok' : 'fail';
  }

  resetAllTasks() {
    for (const node of this._tasks.values())
      this._resetTask(node);
  }

  clear() {
    this.setTasks(new Multimap([]));
  }

  /**
   * Set build tree. This will synchronously abort builds for those nodes
   * that were either removed or changed their dependencies.
   * NOTE: to actually kick off build, call `buildTree.build()` after setting the tree.
   * @param tree 
   */
  setTasks(tree: Multimap<string, string>) {
    const cycle = TaskTree.findDependencyCycle(tree);
    if (cycle)
      throw new CycleError(cycle);

    // Remove nodes that were dropped, cancelling their build in the meantime.
    const taskIds = new Set([...tree.values(), ...tree.keys()]);
    for (const [taskId, task] of this._tasks) {
      if (!taskIds.has(taskId)) {
        this._resetTask(task);
        this._tasks.delete(taskId);
      }
    }
    this._roots = [];

    // Create all new nodes.
    for (const taskId of taskIds) {
      if (!this._tasks.has(taskId)) {
        this._tasks.set(taskId, {
          taskId: taskId,
          children: [],
          parents: [],
          generation: 0,
          subtreeSha: '',
        });
      }
      const task = this._tasks.get(taskId)!;
      task.children = [];
      task.parents = [];
    }

    // Build a graph.
    for (const [taskId, children] of tree) {
      const task = this._tasks.get(taskId)!;
      for (const childId of children) {
        const child = this._tasks.get(childId)!;
        task.children.push(child);
        child.parents.push(task);
      }
    }

    // Figure out roots
    this._roots = [...this._tasks.values()].filter(task => !task.parents.length);

    // We have to sort roots, since treeVersion relies on their order.
    this._roots.sort((a, b) => a.taskId < b.taskId ? -1 : 1);

    // Comppute subtree sha's. if some node's sha changed, than we have
    // to reset build, if any.
    const dfs = (task: Task) => {
      task.children.sort((a, b) => a.taskId < b.taskId ? -1 : 1);
      for (const child of task.children)
        dfs(child);
      const subtreeSha = sha256([task.taskId, ...task.children.map(child => child.subtreeSha)]);
      if (task.subtreeSha !== subtreeSha) {
        task.subtreeSha = subtreeSha;
        this._resetTask(task);
      }
    }
    
    for (const root of this._roots)
      dfs(root);
  }

  topsort(): string[] {
    const result: string[] = [];
    const visited = new Set<Task>();
    const dfs = (task: Task) => {
      if (visited.has(task))
        return;
      visited.add(task);
      for (const child of task.children)
        dfs(child);
      result.push(task.taskId);
    }
    for (const root of this._roots)
      dfs(root);
    return result;
  }

  taskVersion(taskId: string): string {
    const task = this._tasks.get(taskId);
    assert(task);
    return taskVersion(task);
  }

  /**
   * This will synchronously abort builds for the `nodeId` and all its parents.
   * @param taskId
   */
  markChanged(taskId: string) {
    const task = this._tasks.get(taskId);
    if (!task)
      return;
    const visited = new Set<Task>();
    const dfs = (task: Task) => {
      if (visited.has(task))
        return;
      visited.add(task);
      ++task.generation;
      this._resetTask(task);
      for (const parent of task.parents)
        dfs(parent);
    }
    dfs(task);
  }

  private _runnableTasks(): Task[] {
    return [...this._tasks.values()].filter(task => !task.execution && task.children.every(isSuccessfulCurrentTask));
  }

  private _tasksBeingRun(): Task[] {
    return [...this._tasks.values()].filter(task => task.execution && task.execution.success === undefined);
  }

  private _computeTreeVersion() {
    return sha256(this._roots.map(taskVersion));
  }

  /**
   * This method will traverse the tree and start building nodes that are buildable.
   * Note that once these nodes complete to build, other node will be started.
   * To stop the process, run the `resetAllBuilds()` method.
   * @returns 
   */
  build() {
    const tasksBeingRun = this._tasksBeingRun();
    const runnableTasks = this._runnableTasks();

    if (tasksBeingRun.length === 0 && runnableTasks.length === 0) {
      const treeVersion = this._computeTreeVersion();
      if (treeVersion !== this._lastCompleteTreeVersion) {
        this._lastCompleteTreeVersion = treeVersion;
        this.emit('completed');
      }
      return;
    }

    const capacity = this._options.jobs - tasksBeingRun.length;
    if (capacity <= 0)
      return;

    for (const task of runnableTasks.slice(0, capacity)) {
      task.execution = {
        abortController: new AbortController(),
        buildVersion: taskVersion(task),
      };
      const taskOptions: TaskOptions = {
        taskId: task.taskId,
        onComplete: this._onTaskComplete.bind(this, task, task.execution.buildVersion),
        signal: task.execution.abortController.signal,
      };
      // Request building in a microtask to avoid reenterability.
      Promise.resolve().then(() => {
        this._options.runCallback.call(null, taskOptions)
        this.emit('task_started', task.taskId);
      });
    }
  }

  private _resetTask(task: Task) {
    if (!task.execution)
      return;
    const execution = task.execution;
    task.execution = undefined;
    execution.abortController.abort();
    this.emit('task_reset', task.taskId);
  }

  private _onTaskComplete(task: Task, taskVersion: string, success: boolean) {
    if (task.execution?.buildVersion !== taskVersion || task.execution.success !== undefined)
      return false;
    task.execution.success = success;
    this.emit('task_finished', task.taskId);
    this.build();
    return true;
  }
}

function isSuccessfulCurrentTask(task: Task) {
  return taskVersion(task) === task.execution?.buildVersion && task.execution.success;
}

function taskVersion(task: Task): string {
  return sha256([task.generation + '', task.subtreeSha]);
}
