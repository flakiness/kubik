import { expect, test } from '@playwright/test';
import { BuildOptions, BuildTree, CycleError } from '../src/buildTree.js';
import { Multimap } from '../src/multimap.js';

class Logger {
  public log: string[] = [];

  constructor(tree: BuildTree) {
    tree.on('node_build_started', this._log.bind(this, 'started'));
    tree.on('node_build_finished', this._log.bind(this, 'finished'));
    tree.on('node_build_reset', this._log.bind(this, 'reset'));
  }

  private _log(prefix: string, nodeId: string) {
    this.log.push(`${prefix}: ${nodeId}`);
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

async function asyncBuild(options: BuildOptions) {
  await Promise.resolve();
  options.onComplete(true);
}

async function onCompleted(tree: BuildTree, nodeIds?: string[]) {
  if (!nodeIds) {
    await new Promise<void>(x => tree.once('completed', x));
    return;
  }
  const pending = new Set(nodeIds);
  await new Promise<void>(resolve => {
    const listener = (nodeId: string) => {
      pending.delete(nodeId);
      if (!pending.size) {
        tree.off('node_build_finished', listener);
        resolve();
      }
    }
    tree.on('node_build_finished', listener);
  });
}

async function onStarted(tree: BuildTree, nodeIds: string[]) {
  const pending = new Set(nodeIds);
  await new Promise<void>(resolve => {
    const listener = (nodeId: string) => {
      pending.delete(nodeId);
      if (!pending.size) {
        tree.off('node_build_started', listener);
        resolve();
      }
    }  
    tree.on('node_build_started', listener);
  });
}

async function onAborted(tree: BuildTree, nodeIds: string[]) {
  const pending = new Set(nodeIds);
  await new Promise<void>(resolve => {
    const listener = (nodeId: string) => {
      pending.delete(nodeId);
      if (!pending.size) {
        tree.off('node_build_reset', listener);
        resolve();
      }
    }  
    tree.on('node_build_reset', listener);
  });
}

test('should build simple dependency', async () => {
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['middle'],
    'middle': ['leaf'],
    'leaf': [],
  })));
  tree.build();

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
  tree.build();

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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
    'dep-1': [],
    'dep-2': [],
  })));
  tree.build();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'started: dep-2',
    'finished: dep-1',
    'finished: dep-2',
    'started: root',
    'finished: root',
  ]);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
    'dep-1': [],
  })));
  tree.build();

  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'reset: dep-2',
    'reset: root',
    'started: root',
    'finished: root',
  ]);
});

test('that pending build is stopped if the node was dropped during change.', async () => {
  const tree = new BuildTree({ buildCallback: async opt => {
    await Promise.resolve();
    if (opt.nodeId === 'root' || opt.nodeId === 'dep-1')
      opt.onComplete(true);
  }, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.build();

  await onCompleted(tree, ['dep-1']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'started: dep-2',
    'finished: dep-1',
  ]);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.build();
  await onCompleted(tree);
  expect(logger.pull()).toEqual([
    'reset: dep-2', // <-- this is the pending build that was aborted due to setBuildTree operation.
    'started: root',
    'finished: root',
  ]);
});

test('that pending build is stopped if the node deps changed.', async () => {
  const tree = new BuildTree({ buildCallback: async opt => {
    await Promise.resolve();
    if (opt.nodeId.startsWith('dep-'))
      opt.onComplete(true);
  }, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.build();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'finished: dep-1',
    'started: root',
  ]);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-2'],
  })));
  tree.build();
  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'reset: dep-1',
    'reset: root', // <-- this is the pending build that was aborted due to setBuildTree operation.
    'started: dep-2',
    'finished: dep-2',
    'started: root',
  ]);
});

test('test that pending build is stopped if the node inputs are changed', async () => {
  const tree = new BuildTree({ buildCallback: async opt => {
    await Promise.resolve();
    if (opt.nodeId === 'dep')
      opt.onComplete(true);
  }, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep'],
  })));
  tree.build();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep',
    'finished: dep',
    'started: root',
  ]);

  tree.markChanged('dep');
  tree.build();
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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.build();

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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: 1 });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1', 'dep-2'],
  })));
  tree.build();

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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: 2 });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'leaf-1': [],
    'leaf-2': [],
    'leaf-3': [],
  })));
  tree.build();

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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root-1': ['dep'],
    'root-2': ['dep'],
  })));
  tree.build();

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
  tree.build();
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
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  expect(() => tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'node-0': ['node-1'],
    'node-1': ['node-2'],
    'node-2': ['node-3'],
    'node-3': ['node-1'],
  })))).toThrowError(CycleError);
});

test('no roots are throws as dependency cycle error', async () => {
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  expect(() => tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'node-1': ['node-2'],
    'node-2': ['node-3'],
    'node-3': ['node-1'],
  })))).toThrowError(CycleError);
});

test('empty tree should not throw any errors', async () => {
  const tree = new BuildTree({ buildCallback: () => {}, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'node-1': [],
    'node-2': [],
  })));
  tree.build();
  await onStarted(tree, ['node-1', 'node-2']);
  expect(logger.pull()).toEqual([
    'started: node-1',
    'started: node-2',
  ]);

  tree.setBuildTree(new Multimap());
  expect(logger.pull()).toEqual([
    'reset: node-1',
    'reset: node-2',
  ]);
});

test('make sure that node build is reset when deps are changed', async () => {
  const tree = new BuildTree({ buildCallback: async opt => {
    await Promise.resolve();
    if (opt.nodeId === 'dep-1')
      opt.onComplete(true);
  }, jobs: Infinity });
  const logger = new Logger(tree);

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-1'],
  })));
  tree.build();

  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: dep-1',
    'finished: dep-1',
    'started: root',
  ]);
  expect(tree.nodeBuildStatus('root')).toBe('running');

  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': ['dep-2'],
  })));
  expect(logger.pull()).toEqual([
    'reset: dep-1',
    'reset: root',
  ]);
  expect(tree.nodeBuildStatus('root')).toBe('pending');
});

test('check build order', async () => {
  const tree = new BuildTree({ buildCallback: asyncBuild, jobs: Infinity });
  tree.setBuildTree(Multimap.fromEntries(Object.entries({
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
  const tree = new BuildTree({ buildCallback: () => {}, jobs: Infinity });
  const logger = new Logger(tree);
  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': [],
  })));
  tree.build();
  await onStarted(tree, ['root']);
  expect(logger.pull()).toEqual([
    'started: root',
  ]);

  tree.resetAllBuilds();
  tree.resetAllBuilds();
  expect(logger.pull()).toEqual([
    'reset: root',
  ]);
});

test('cannot report status twice', async () => {
  let resolve: () => void;
  const promise = new Promise<void>(x => resolve = x);
  const tree = new BuildTree({ buildCallback: async (options) => {
    await Promise.resolve();
    options.onComplete(true);
    await Promise.resolve();
    options.onComplete(false);
    resolve();
  }, jobs: Infinity });
  const logger = new Logger(tree);
  tree.setBuildTree(Multimap.fromEntries(Object.entries({
    'root': [],
  })));
  tree.build();
  await promise;
  expect(logger.pull()).toEqual([
    'started: root',
    'finished: root',
  ]);
  expect(tree.nodeBuildStatus('root')).toBe('ok');
});
