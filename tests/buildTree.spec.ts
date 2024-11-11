import { expect, test } from '@playwright/test';
import { BuildOptions, BuildTree } from '../src/buildTree.js';
import { Multimap } from '../src/multimap.js';

class LogBuilder {
  public log: string[] = [];

  constructor() {
    this.build = this.build.bind(this);
  }

  build(options: BuildOptions) {
    this.log.push(options.nodeId);
    options.onComplete(true);
  }

  reset() {
    this.log = [];
  }
}

async function onStale(tree) {
  await new Promise<void>(x => tree.once('stale', x));
}

test('should build simple dependency', async () => {
  const logBuilder = new LogBuilder();
  const tree = new BuildTree(logBuilder.build);

  tree.setTree(Multimap.fromEntries(Object.entries({
    'baz': [],
    'bar': ['baz'],
    'foo': ['bar'],
  })));

  await onStale(tree);
  expect(logBuilder.log).toEqual(['baz', 'bar', 'foo']);
  
  logBuilder.reset();
  tree.markChanged('bar')

  await onStale(tree);
  expect(logBuilder.log).toEqual(['bar', 'foo']);
});
