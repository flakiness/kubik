import { expect, test } from '@playwright/test';
import { BuildTree } from '../src/buildTree.js';
import { Multimap } from '../src/multimap.js';

test('should build simple dependency', async () => {
  const buildlog: string[] = [];
  const tree = new BuildTree((options) => {
    buildlog.push(options.nodeId);
    options.onComplete(true);
  });

  tree.setTree(Multimap.fromEntries(Object.entries({
    'foo': ['bar'],
    'bar': ['baz'],
    'baz': [],
  })));

  await new Promise<void>(x => tree.once('stale', x));
  expect(buildlog).toEqual(['baz', 'bar', 'foo']);
});
