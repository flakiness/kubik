import assert from "assert";
import EventEmitter from "events";

import { Multimap } from "./multimap.js";
import { sha256 } from "./utils.js";

type Execution = {
  success?: boolean,
  abortController: AbortController,
  buildVersion: string,
}

type Task<TASK_ID extends string> = {
  taskId: TASK_ID,
  parents: Task<TASK_ID>[],
  children: Task<TASK_ID>[],
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

export type TaskOptions<TASK_ID extends string = string> = {
  taskId: TASK_ID,
  signal: AbortSignal,
  onComplete: (success: boolean) => boolean,
}

export type TaskTreeOptions<TASK_ID extends string> = {
  runCallback: (options: TaskOptions<TASK_ID>) => void,
  jobs: number,
}

export class CycleError<TASK_ID extends string> extends Error {
  constructor(public cycle: TASK_ID[]) {
    super('Dependency cycle detected');
  }
}

export type TaskStatus = 'n/a'|'pending'|'running'|'ok'|'fail';

type TaskTreeEvents<TASK_ID extends string> = {
  'completed': [],
  'task_started': [TASK_ID],
  'task_finished': [TASK_ID],
  'task_reset': [TASK_ID],
}

export class TaskTree<TASK_ID extends string = string> extends EventEmitter<TaskTreeEvents<TASK_ID>> {
  static findDependencyCycle<TASK_ID extends string = string>(tasks: Multimap<TASK_ID, TASK_ID>) {
    const stackIndexes = new Map<TASK_ID, number>();
    const visited = new Set<TASK_ID>();
    const findCycle = (taskId: TASK_ID, stack: TASK_ID[] = []): (TASK_ID[]|undefined) => {
      const stackIndex = stackIndexes.get(taskId);
      if (stackIndex !== undefined)
        return stack.slice(stackIndex);

      if (visited.has(taskId))
        return;
      visited.add(taskId);

      stackIndexes.set(taskId, stack.push(taskId) - 1);
      for (const child of tasks.getAll(taskId)) {
        const cycle = findCycle(child, stack);
        if (cycle)
          return cycle;
      }
      stack.pop();
      stackIndexes.delete(taskId);
    }
    for (const key of tasks.keys()) {
      const cycle = findCycle(key);
      if (cycle)
        return cycle;
    }
    return undefined;
  }

  private _tasks = new Map<TASK_ID, Task<TASK_ID>>();
  private _roots: Task<TASK_ID>[] = [];
  private _lastCompleteTreeVersion: string = '';
  
  constructor(private _options: TaskTreeOptions<TASK_ID>) {
    super();
  }

  taskStatus(taskId: TASK_ID): TaskStatus {
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
   * @param tasks 
   */
  setTasks(tasks: Multimap<TASK_ID, TASK_ID>) {
    const cycle = TaskTree.findDependencyCycle(tasks);
    if (cycle)
      throw new CycleError(cycle);

    // Remove nodes that were dropped, cancelling their build in the meantime.
    const taskIds = new Set([...tasks.values(), ...tasks.keys()]);
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
    for (const [taskId, children] of tasks) {
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
    const dfs = (task: Task<TASK_ID>) => {
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

  topsort(): TASK_ID[] {
    const result: TASK_ID[] = [];
    const visited = new Set<Task<TASK_ID>>();
    const dfs = (task: Task<TASK_ID>) => {
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

  taskVersion(taskId: TASK_ID): string {
    const task = this._tasks.get(taskId);
    assert(task);
    return taskVersion(task);
  }

  /**
   * This will synchronously abort builds for the `nodeId` and all its parents.
   * @param taskId
   */
  markChanged(taskId: TASK_ID) {
    const task = this._tasks.get(taskId);
    if (!task)
      return;
    const visited = new Set<Task<TASK_ID>>();
    const dfs = (task: Task<TASK_ID>) => {
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

  private _runnableTasks(): Task<TASK_ID>[] {
    return [...this._tasks.values()].filter(task => !task.execution && task.children.every(isSuccessfulCurrentTask));
  }

  private _tasksBeingRun(): Task<TASK_ID>[] {
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
      const taskOptions: TaskOptions<TASK_ID> = {
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

  private _resetTask(task: Task<TASK_ID>) {
    if (!task.execution)
      return;
    const execution = task.execution;
    task.execution = undefined;
    execution.abortController.abort();
    this.emit('task_reset', task.taskId);
  }

  private _onTaskComplete(task: Task<TASK_ID>, taskVersion: string, success: boolean) {
    if (task.execution?.buildVersion !== taskVersion || task.execution.success !== undefined)
      return false;
    task.execution.success = success;
    this.emit('task_finished', task.taskId);
    this.build();
    return true;
  }
}

function isSuccessfulCurrentTask<TASK_ID extends string>(task: Task<TASK_ID>) {
  return taskVersion(task) === task.execution?.buildVersion && task.execution.success;
}

function taskVersion<TASK_ID extends string>(task: Task<TASK_ID>): string {
  return sha256([task.generation + '', task.subtreeSha]);
}
