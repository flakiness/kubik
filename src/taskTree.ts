import assert from "assert";
import EventEmitter from "events";

import { Multimap } from "./multimap.js";
import { sha256 } from "./utils.js";

type Task<TASK_ID extends string> = {
  taskId: TASK_ID,
  parents: Task<TASK_ID>[],
  children: Task<TASK_ID>[],
  /**
   * Since we want to know when the tree changes its shape, we compute a SHA of the subtree which
   * is a unique signature of the tree structure. This is similar to git's tree sha.
   */
  subtreeSha: string,
  /**
   * Each task has a "generation" - an ever-increasing number that is bumped every time either task inputs
   * or some of its descendant task inputs change.
   * A combination of tasks's subtree SHA and generation yields a "task version".
   */
  generation: number,
  /**
   * Each task might have an execution object. If there's no execution, then the task is either in a "n/a" or "pending" status.
   * Otherwise, the execution might be on-going (if the object exists, but the result hasn't been reported yet), or completed.
   */
  execution?: Execution,
}

/**
 * Each execution object contains an execution result, which might be undefined for on-going executions.
 * The abort controller is used to reset task executions, and the "taskVersion" marks the version for which
 * this execution was created.
 */
type Execution = {
  success?: boolean,
  abortController: AbortController,
  taskVersion: string,
}

export type TaskOptions<TASK_ID extends string = string> = {
  taskId: TASK_ID,
  signal: AbortSignal,
  onComplete: (success: boolean) => void,
}

export type TaskTreeOptions = {
  jobs: number,
}

export class CycleError<TASK_ID extends string> extends Error {
  constructor(public cycle: TASK_ID[]) {
    super('Dependency cycle detected');
  }
}

export type TaskStatus = 'n/a'|'pending'|'running'|'ok'|'fail';
export type TaskTreeStatus = 'ok'|'fail'|'pending'|'running';

type TaskTreeEvents<TASK_ID extends string> = {
  'tree_status_changed': [TaskTreeStatus],
  'task_started': [TASK_ID],
  'task_finished': [TASK_ID],
  'task_reset': [TASK_ID],
}

/**
 * Task tree is an orchestration engine. It is given a set of tasks with their IDs and their
 * inter-dependencies, and its goal to run these tasks to a completion.
 * 
 * TaskTree doesn't know how to run tasks and it doesn't know about task inputs. Instead, its client
 * are requested to run tasks (via provided callback) and they should notify TaskTree about task input
 * changes via the `taskTree.markChanged(taskId)` method.
 * 
 * Tasks are organized as a directed acyclic graph; TaskTree makes sure to never accept tasks with cycles
 * and will throw in this case.
 * 
 * Once initialized, TaskTree requires client to call `run()` to start running tasks. TaskTree will
 * advance tasks execution until there will be no more runnable tasks. In this case, it will fire the "completed"
 * event.
 * 
 * TaskTree will also run the following events, signaling about Task lifecycle:
 * - "task_started" - when the execution of a task started
 * - "task_finished" - when the execution completed
 * - "task_reset" - when the execution was started, but it is no longer relevant since task version has changed due to
 *   either `taskTree.setTasks()` or `taskTree.markChanged()` methods.
 */
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

  private _status: TaskTreeStatus = 'ok';
  
  constructor(private _runCallback: (options: TaskOptions<TASK_ID>) => void, private _options: TaskTreeOptions) {
    super();
  }

  private _computeTreeStatus() {
    const tasks = [...this._tasks.values()];
    const runnableTasks = tasks.filter(task => !task.execution && task.children.every(isSuccessfulCurrentTask));
    const tasksBeingRun = tasks.filter(task => task.execution && task.execution.success === undefined);

    if (runnableTasks.length === 0 && tasksBeingRun.length === 0) {
      const hasFailedTasks = tasks.some(task => task.execution?.success === false);
      this._setTreeStatus(hasFailedTasks ? 'fail' : 'ok');
    } else {
      this._setTreeStatus(tasksBeingRun.length > 0 ? 'running' : 'pending');
    }
  }

  private _setTreeStatus(status: TaskTreeStatus) {
    if (status !== this._status) {
      this._status = status;
      this.emit('tree_status_changed', status);
    }
  }

  status(): TaskTreeStatus {
    return this._status;
  }

  taskStatus(taskId: TASK_ID): TaskStatus {
    const task = this._tasks.get(taskId);
    assert(task, `Cannot get status for non-existing node with id "${taskId}"`);
    return !task.execution && (this._status === 'ok' || this._status === 'fail') ? 'n/a' :
              !task.execution ? 'pending' :
              task.execution && task.execution.success === undefined ? 'running' :
              task.execution && task.execution.success ? 'ok' : 'fail';
  }

  resetAllTasks() {
    for (const node of this._tasks.values())
      this._resetTask(node);
    this._computeTreeStatus();
  }

  clear() {
    this.setTasks(new Multimap([]));
  }

  /**
   * Set build tree. This will synchronously abort builds for those nodes
   * that were either removed or changed their dependencies.
   * NOTE: to actually kick off build, call `taskTree.run()` after setting the tree.
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

    this._computeTreeStatus();
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
    this._computeTreeStatus();
  }

  private _resetTask(task: Task<TASK_ID>) {
    if (!task.execution)
      return;
    const execution = task.execution;
    task.execution = undefined;
    execution.abortController.abort();
    this.emit('task_reset', task.taskId);
  }

  private _runnableTasks(): Task<TASK_ID>[] {
    return [...this._tasks.values()].filter(task => !task.execution && task.children.every(isSuccessfulCurrentTask));
  }

  private _tasksBeingRun(): Task<TASK_ID>[] {
    return [...this._tasks.values()].filter(task => task.execution && task.execution.success === undefined);
  }

  /**
   * This method will traverse the tree and start building nodes that are buildable.
   * Note that once these nodes complete to build, other node will be started.
   * To stop the process, run the `resetAllBuilds()` method.
   * @returns 
   */
  run() {
    const tasksBeingRun = this._tasksBeingRun();
    const runnableTasks = this._runnableTasks();

    const capacity = this._options.jobs - tasksBeingRun.length;
    if (capacity <= 0 || !runnableTasks.length) {
      this._computeTreeStatus();
      return;
    }

    // Update tree status pro-actively.
    this._setTreeStatus('running');

    for (const task of runnableTasks.slice(0, capacity)) {
      task.execution = {
        abortController: new AbortController(),
        taskVersion: taskVersion(task),
      };
      const taskOptions: TaskOptions<TASK_ID> = {
        taskId: task.taskId,
        onComplete: this._onTaskComplete.bind(this, task, task.execution!.taskVersion),
        signal: task.execution!.abortController.signal,
      };
      // Emit "task_started" event before calling callback.
      // This way, in case of synchronous callbacks, we will ensure
      // a correct order fo task_started / task_finished events.
      this.emit('task_started', task.taskId);
      this._runCallback.call(null, taskOptions);
    }
  }

  private _onTaskComplete(task: Task<TASK_ID>, taskVersion: string, success: boolean): void {
    if (task.execution?.taskVersion !== taskVersion || task.execution.success !== undefined)
      return;
    task.execution.success = success;
    this.emit('task_finished', task.taskId);
    // We have to schedule "run" in a promise - otherwise, we might re-enter "run" method.
    Promise.resolve().then(() => this.run());
  }
}

function isSuccessfulCurrentTask<TASK_ID extends string>(task: Task<TASK_ID>) {
  return taskVersion(task) === task.execution?.taskVersion && task.execution.success;
}

function taskVersion<TASK_ID extends string>(task: Task<TASK_ID>): string {
  return sha256([task.generation + '', task.subtreeSha]);
}
