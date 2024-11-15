import { expect, test } from '@playwright/test';
import { Multimap } from '../src/multimap.js';
import { CycleError, TaskOptions, TaskTree } from '../src/taskTree.js';

class Logger {
  public log: string[] = [];

  constructor(tree: TaskTree) {
    tree.on('task_started', this._log.bind(this, 'started'));
    tree.on('task_finished', this._log.bind(this, 'finished'));
    tree.on('task_reset', this._log.bind(this, 'reset'));
  }

  private _log(prefix: string, taskId: string) {
    this.log.push(`${prefix}: ${taskId}`);
  }

  reset() {
    this.log = [];
  }

  pull() {
    const result = this.log;
    this.log = [];
    return result;
  }
}

async function asyncBuild(options: TaskOptions) {
  await Promise.resolve();
  options.onComplete(true);
}

async function onCompleted(tree: TaskTree, taskIds?: string[]) {
  if (!taskIds) {
    await new Promise<void>(x => tree.once('completed', x));
    return;
  }
  const pending = new Set(taskIds);
  await new Promise<void>(resolve => {
    const listener = (taskId: string) => {
      pending.delete(taskId);
      if (!pending.size) {
        tree.off('task_finished', listener);
        resolve();
      }
    }
    tree.on('task_finished', listener);
  });
}

async function onStarted(tree: TaskTree, taskIds: string[]) {
  const pending = new Set(taskIds);
  await new Promise<void>(resolve => {
    const listener = (taskId: string) => {
      pending.delete(taskId);
      if (!pending.size) {
        tree.off('task_started', listener);
        resolve();
      }
    }  
    tree.on('task_started', listener);
  });
}

async function onAborted(tree: TaskTree, taskIds: string[]) {
  const pending = new Set(taskIds);
  await new Promise<void>(resolve => {
    const listener = (taskId: string) => {
      pending.delete(taskId);
      if (!pending.size) {
        tree.off('task_reset', listener);
        resolve();
      }
    }  
    tree.on('task_reset', listener);
  });
}

test('should build simple dependency', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['middle'],
    'middle': ['leaf'],
    'leaf': [],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: leaf',
    'finished: leaf',
    'started: middle',
    'finished: middle',
    'started: root',
    'finished: root',
  ]);

  tree.markChanged('middle');
  tree.run();

  await onCompleted(tree);
  expect(logger.log).toEqual([
    'reset: middle',
    'reset: root',
    'started: middle',
    'finished: middle',
    'started: root',
    'finished: root',
  ]);
});

test('make sure that when tree partially changes, only changed parts are re-built', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
    'dep-1': [],
    'dep-2': [],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'started: dep-2',
    'finished: dep-1',
    'finished: dep-2',
    'started: root',
    'finished: root',
  ]);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
    'dep-1': [],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'reset: dep-2',
    'reset: root',
    'started: root',
    'finished: root',
  ]);
});

test('that pending build is stopped if the task was dropped during change.', async () => {
  const tree = new TaskTree(async opt => {
    await Promise.resolve();
    if (opt.taskId === 'root' || opt.taskId === 'dep-1')
      opt.onComplete(true);
  }, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.run();

  await onCompleted(tree, ['dep-1']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'started: dep-2',
    'finished: dep-1',
  ]);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.run();
  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'reset: dep-2', // <-- this is the pending build that was aborted due to setBuildTree operation.
    'started: root',
    'finished: root',
  ]);
});

test('that pending build is stopped if the task deps changed.', async () => {
  const tree = new TaskTree(async opt => {
    await Promise.resolve();
    if (opt.taskId.startsWith('dep-'))
      opt.onComplete(true);
  }, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.run();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'finished: dep-1',
    'started: root',
  ]);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-2'],
  })));
  tree.run();
  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'reset: dep-1',
    'reset: root', // <-- this is the pending build that was aborted due to setBuildTree operation.
    'started: dep-2',
    'finished: dep-2',
    'started: root',
  ]);
});

test('test that pending build is stopped if the task inputs are changed', async () => {
  const tree = new TaskTree(async opt => {
    await Promise.resolve();
    if (opt.taskId === 'dep')
      opt.onComplete(true);
  }, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep'],
  })));
  tree.run();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep',
    'finished: dep',
    'started: root',
  ]);

  tree.markChanged('dep');
  tree.run();
  await onStarted(tree, ['root']);

  expect(logger.pull()).toEqual([
    'reset: dep', // <-- this was reset since it was changed
    'reset: root', // <-- the root building was aborted since markChanged was called.
    'started: dep',
    'finished: dep',
    'started: root',
  ]);
});

test('tests parallel compilation', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'started: dep-2',
    'finished: dep-1',
    'finished: dep-2',
    'started: root',
    'finished: root',
  ]);
});

test('tests sequential compilation', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: 1 });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'finished: dep-1',
    'started: dep-2',
    'finished: dep-2',
    'started: root',
    'finished: root',
  ]);
});

test('tests jobs = 2', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: 2 });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'leaf-1': [],
    'leaf-2': [],
    'leaf-3': [],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: leaf-1',
    'started: leaf-2',
    'finished: leaf-1',
    'finished: leaf-2',
    'started: leaf-3',
    'finished: leaf-3',
  ]);
});

test('test multiple roots with single deps', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root-1': ['dep'],
    'root-2': ['dep'],
  })));
  tree.run();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: dep',
    'finished: dep',
    'started: root-1',
    'started: root-2',
    'finished: root-1',
    'finished: root-2',
  ]);

  // Change common dep and start rebuilding.
  tree.markChanged('dep');
  tree.run();
  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'reset: dep',
    'reset: root-1',
    'reset: root-2',
    'started: dep',
    'finished: dep',
    'started: root-1',
    'started: root-2',
    'finished: root-1',
    'finished: root-2',
  ]);
});

test('test deps cycle detection', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  expect(() => tree.setTasks(Multimap.fromEntries(Object.entries({
    'task-0': ['task-1'],
    'task-1': ['task-2'],
    'task-2': ['task-3'],
    'task-3': ['task-1'],
  })))).toThrowError(CycleError);
});

test('no roots are throws as dependency cycle error', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  expect(() => tree.setTasks(Multimap.fromEntries(Object.entries({
    'task-1': ['task-2'],
    'task-2': ['task-3'],
    'task-3': ['task-1'],
  })))).toThrowError(CycleError);
});

test('empty tree should not throw any errors', async () => {
  const tree = new TaskTree(() => {}, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'task-1': [],
    'task-2': [],
  })));
  tree.run();
  await onStarted(tree, ['task-1', 'task-2']);
  expect(logger.pull()).toEqual([
    'started: task-1',
    'started: task-2',
  ]);

  tree.setTasks(new Multimap());
  expect(logger.pull()).toEqual([
    'reset: task-1',
    'reset: task-2',
  ]);
});

test('make sure that task build is reset when deps are changed', async () => {
  const tree = new TaskTree(async opt => {
    await Promise.resolve();
    if (opt.taskId === 'dep-1')
      opt.onComplete(true);
  }, { jobs: Infinity });
  const logger = new Logger(tree);

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.run();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'finished: dep-1',
    'started: root',
  ]);
  expect(tree.taskStatus('root')).toBe('running');

  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-2'],
  })));
  expect(logger.pull()).toEqual([
    'reset: dep-1',
    'reset: root',
  ]);
  expect(tree.taskStatus('root')).toBe('pending');
});

test('check build order', async () => {
  const tree = new TaskTree(asyncBuild, { jobs: Infinity });
  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
    'dep-1': ['leaf-1', 'leaf-2', 'leaf-3'],
  })));
  expect(tree.topsort()).toEqual([
    'leaf-1',
    'leaf-2',
    'leaf-3',
    'dep-1',
    'dep-2',
    'root',
  ]);
});

test('should abort only once', async () => {
  const tree = new TaskTree(() => {}, { jobs: Infinity });
  const logger = new Logger(tree);
  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': [],
  })));
  tree.run();
  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: root',
  ]);

  tree.resetAllTasks();
  tree.resetAllTasks();
  expect(logger.pull()).toEqual([
    'reset: root',
  ]);
});

test('cannot report status twice', async () => {
  let resolve: () => void;
  const promise = new Promise<void>(x => resolve = x);
  const tree = new TaskTree(async (options) => {
    await Promise.resolve();
    options.onComplete(true);
    await Promise.resolve();
    options.onComplete(false);
    resolve();
  }, { jobs: Infinity });
  const logger = new Logger(tree);
  tree.setTasks(Multimap.fromEntries(Object.entries({
    'root': [],
  })));
  tree.run();
  await promise;
  expect(logger.pull()).toEqual([
    'started: root',
    'finished: root',
  ]);
  expect(tree.taskStatus('root')).toBe('ok');
});
