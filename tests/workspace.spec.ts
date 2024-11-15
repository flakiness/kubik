import { expect, test } from '@playwright/test';
import fs, { cpSync } from 'fs';
import path from 'path';
import url from 'url';
import { Project, Workspace, WorkspaceOptions } from '../src/workspace.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function asset(aPath: string) {
  return test.info().outputPath(aPath);
}

async function bootstrapFiles(assetsFolder: string) {
  await fs.promises.cp(path.join(__dirname, assetsFolder), test.info().outputDir, {recursive: true});
}

function copyFile(from: string, to: string) {
  cpSync(test.info().outputPath(from), test.info().outputPath(to));  
}

function onEvent(workspace: Workspace, event: 'project_finished'|'project_started', configPathSuffix: string) {
  return new Promise<void>(resolve => {
    const listener = (project: Project) => {
      if (project.configPath().endsWith(configPathSuffix)) {
        workspace.removeListener(event, listener);
        resolve();
      }
    }
    workspace.addListener(event, listener);
  })
}


const workspaceTest = test.extend<{
  createWorkspace: (options: WorkspaceOptions) => Workspace,
}, {}>({
  createWorkspace: async ({}, use) => {
    const workspaces: Workspace[] = [];
    await use((options: WorkspaceOptions) => {
      const w = new Workspace(options);
      workspaces.push(w);
      return w;
    });
    for (const workspace of workspaces)
      await workspace.stop();
  }
});

workspaceTest('should work', async ({ createWorkspace }) => {
  await bootstrapFiles('simple');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: false,
    roots: [test.info().outputPath('a.mjs')],
  });
  await onEvent(workspace, 'project_finished', 'a.mjs');
  const projects = workspace.topsortProjects();
  expect(projects[0].output().trim()).toBe('done - b.mjs')
  expect(projects[1].output().trim()).toBe('done - a.mjs')
});

workspaceTest('should detect cycle', async ({ createWorkspace }) => {
  await bootstrapFiles('cycle');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: false,
    roots: [asset('a.mjs')],
  });
  await new Promise(x => workspace.once('workspace_error', x));
  expect(workspace.workspaceError()).toContain('cycle');
});

workspaceTest('in watch mode, should detect cycle and clear the error once cycle is fixed', async ({ createWorkspace }) => {
  await bootstrapFiles('cycle');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: true,
    roots: [asset('a.mjs')],
  });
  await new Promise(x => workspace.once('workspace_error', x));
  expect(workspace.workspaceError()).toContain('cycle');

  copyFile('d_fixed.mjs', 'd.mjs');
  await onEvent(workspace, 'project_finished', 'a.mjs');
  expect(workspace.workspaceError()).toBe(undefined);
});


workspaceTest('should not complain when created with a root that does not exist', async ({ createWorkspace }) => {
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: true,
    roots: [asset('foo')],
  });
  await expect.poll(() => workspace.topsortProjects().length).toBe(1);
  const foo = workspace.topsortProjects()[0];
  expect(foo.output()).toContain('Failed to load configuration');
});

