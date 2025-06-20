import { expect, test } from '@playwright/test';
import fs, { cpSync } from 'fs';
import path from 'path';
import url from 'url';
import { TaskStatus } from '../src/taskTree.js';
import { Project, Workspace, WorkspaceOptions, WorkspaceStatus } from '../src/workspace.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function asset(aPath: string) {
  return test.info().outputPath(aPath);
}

async function bootstrapAssets(assetsFolder: string) {
  await fs.promises.cp(path.join(__dirname, assetsFolder), test.info().outputDir, {recursive: true});
}

function cpAsset(from: string, to: string) {
  cpSync(test.info().outputPath(from), test.info().outputPath(to));  
}

function touchAsset(asset: string) {
  const fd = fs.openSync(test.info().outputPath(asset), 'w');
  const now = new Date();
  fs.futimesSync(fd, now, now)
  fs.closeSync(fd);
}

async function onProjectAdded(workspace: Workspace, configSuffix?: string): Promise<Project> {
  return new Promise<Project>(resolve => {
    workspace.on('project_added', function listener(project: Project) {
      if (!configSuffix || project.configPath().endsWith(configSuffix)) {
        workspace.removeListener('project_added', listener)
        resolve(project);
      }
    })
  });
}

async function onProjectRemoved(workspace: Workspace, toBeRemoved: Project): Promise<void> {
  return new Promise<void>(resolve => {
    workspace.on('project_removed', function listener(project: Project) {
      if (project === toBeRemoved) {
        workspace.removeListener('project_removed', listener)
        resolve();
      }
    })
  });
}

async function onProjectOutput(project: Project, substring: string) {
  if (project.output().includes(substring))
    return;
  return new Promise<void>(resolve => {
    const listener = () => {
      if (project.output().includes(substring)) {
        project.off('build_stdout', listener);
        project.off('build_stderr', listener);
        resolve();
      }
    }
    project.on('build_stdout', listener);
    project.on('build_stderr', listener);
  });
}

async function onWorkspaceStatus(workspace: Workspace, expected: WorkspaceStatus): Promise<void> {
  if (workspace.workspaceStatus() === expected)
    return;
  return new Promise<void>(resolve => {
    workspace.on('workspace_status_changed', function listener() {
      if (workspace.workspaceStatus() === expected) {
        workspace.removeListener('workspace_status_changed', listener)
        resolve();
      }
    })
  });
}

async function onProjectStatus(project: Project, expected: TaskStatus): Promise<void> {
  if (project.status() === expected)
    return;
  return new Promise<void>(resolve => {
    project.on('build_status_changed', function listener() {
      if (project.status() === expected) {
        project.removeListener('build_status_changed', listener)
        resolve();
      }
    })
  });
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
  await bootstrapAssets('simple');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: false,
    roots: [test.info().outputPath('a.mjs')],
  });
  const project = await onProjectAdded(workspace, 'a.mjs');
  await onProjectStatus(project, 'ok');
  const projects = workspace.bfsProjects();
  expect(projects[0].output().trim()).toBe('done - b.mjs')
  expect(projects[1].output().trim()).toBe('done - c.mjs')
  expect(projects[2].output().trim()).toBe('done - a.mjs')
});

workspaceTest('should detect cycle', async ({ createWorkspace }) => {
  await bootstrapAssets('cycle');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: false,
    roots: [asset('a.mjs')],
  });
  await onWorkspaceStatus(workspace, 'error');
  expect(workspace.workspaceError()).toContain('cycle');
});

workspaceTest('in watch mode, should detect cycle and clear the error once cycle is fixed', async ({ createWorkspace }) => {
  await bootstrapAssets('cycle');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: true,
    roots: [asset('a.mjs')],
  });
  await onWorkspaceStatus(workspace, 'error');
  expect(workspace.workspaceError()).toContain('cycle');

  cpAsset('d_fixed.mjs', 'd.mjs');
  await onWorkspaceStatus(workspace, 'ok');
  expect(workspace.workspaceError()).toBe(undefined);
});

workspaceTest('should report error when created with a root that does not exist', async ({ createWorkspace }) => {
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: true,
    roots: [asset('foo')],
  });
  const foo = await onProjectAdded(workspace, 'foo');
  await onWorkspaceStatus(workspace, 'fail');
  await onProjectStatus(foo, 'fail');
  expect(foo.output()).toContain('Failed to load configuration');
});

workspaceTest('should report process exit code for services', async ({ createWorkspace }) => {
  await bootstrapAssets('no-deps');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: false,
    roots: [asset('service-that-fails.mjs')],
  });
  const service = await onProjectAdded(workspace, 'service-that-fails.mjs');
  await onProjectOutput(service, 'process exited with code=7');
});

workspaceTest('should not have old output when event of status changed received', async ({ createWorkspace }) => {
  await bootstrapAssets('no-deps');
  const workspace = createWorkspace({
    jobs: Infinity,
    watchMode: true,
    roots: [asset('fail.mjs')],
  });
  const project = await onProjectAdded(workspace);
  await onProjectStatus(project, 'fail');
  expect(project.output()).toContain('I am failing');

  let output = project.output();
  project.on('build_status_changed', () => output = project.output());

  cpAsset('hang.mjs', 'fail.mjs');
  await onProjectStatus(project, 'running');

  expect(output).not.toContain('I am failing');
});
