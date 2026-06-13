import { expect, test } from '@playwright/test';
import { $, ExecaScriptMethod, ResultPromise } from 'execa';
import fs, { cpSync } from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import { stripAnsi } from '../src/utils.js';

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

function plain(output: unknown): string {
  return stripAnsi(String(output ?? ''));
}

async function waitFor(predicate: () => boolean, context?: () => string, timeoutMs: number = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate())
      return;
    await new Promise(f => setTimeout(f, 100));
  }
  throw new Error('Timed out while waiting for condition' + (context ? `; context:\n${context()}` : ''));
}

const e2e = test.extend<{
  // Each test gets its own daemon socket directory, both to isolate tests from
  // each other and from any watchdog running on the development machine.
  // Note: unix socket paths are limited to ~104 chars on macOS, so this has to
  // live in the (short) tmpdir rather than in playwright's output dir.
  daemonDir: string,
  $: ExecaScriptMethod,
  startWatchdog: (file: string) => Promise<{ output: () => string }>,
}, {}>({
  daemonDir: async ({}, use) => {
    const daemonDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kubik-test-'));
    await use(daemonDir);
    await fs.promises.rm(daemonDir, { recursive: true, force: true }).catch(() => {});
  },
  $: async ({ daemonDir }, use, info) => {
    await use($({
      cwd: info.outputDir,
      env: { KUBIK_DAEMON_DIR: daemonDir },
    }));
  },
  startWatchdog: async ({ $ }, use) => {
    const watchdogs: ResultPromise[] = [];
    await use(async (file: string) => {
      const subprocess = $({ reject: false })`npx --no-install kubik -w ${file}`;
      watchdogs.push(subprocess);
      let output = '';
      subprocess.stdout?.on('data', (data: Buffer) => output += stripAnsi(data.toString('utf8')));
      subprocess.stderr?.on('data', (data: Buffer) => output += stripAnsi(data.toString('utf8')));
      return { output: () => output };
    });
    for (const watchdog of watchdogs) {
      watchdog.kill('SIGTERM');
      await watchdog.catch(() => {});
    }
  },
});

e2e('should return zero exit code for passing builds', async ({ $ }) => {
  await bootstrapAssets('simple');
  const { exitCode } = await $({ reject: false })`npx --no-install kubik ./a.mjs`;
  expect(exitCode).toBe(0);
});

e2e('should return non-zero code for failing builds', async ({ $ }) => {
  await bootstrapAssets('no-deps');
  const { exitCode } = await $({ reject: false })`npx --no-install kubik ./fail.mjs`;
  expect(exitCode).toBe(1);
});

e2e('should delegate to a watchdog, restarting the task but reusing green deps', async ({ $, startWatchdog }) => {
  await bootstrapAssets('simple');
  const watchdog = await startWatchdog('./a.mjs');
  await waitFor(() => watchdog.output().includes('Succeeded a.mjs'), () => watchdog.output());

  const { exitCode, stdout } = await $({ reject: false })`npx --no-install kubik ./a.mjs`;
  expect(exitCode).toBe(0);
  expect(plain(stdout)).toContain('Using watchdog');
  expect(plain(stdout)).toContain('Up-to-date b.mjs');
  expect(plain(stdout)).toContain('Up-to-date c.mjs');
  // The requested task is force-restarted...
  expect(stdout).toContain('done - a.mjs');
  // ...while its green dependencies are not.
  expect(stdout).not.toContain('done - b.mjs');
});

e2e('should restart all dependencies when delegating with --fresh', async ({ $, startWatchdog }) => {
  await bootstrapAssets('simple');
  const watchdog = await startWatchdog('./a.mjs');
  await waitFor(() => watchdog.output().includes('Succeeded a.mjs'), () => watchdog.output());

  const { exitCode, stdout } = await $({ reject: false })`npx --no-install kubik --fresh ./a.mjs`;
  expect(exitCode).toBe(0);
  expect(stdout).toContain('done - a.mjs');
  expect(stdout).toContain('done - b.mjs');
  expect(stdout).toContain('done - c.mjs');
});

e2e('should report failures when delegating to a watchdog', async ({ $, startWatchdog }) => {
  await bootstrapAssets('no-deps');
  const watchdog = await startWatchdog('./fail.mjs');
  await waitFor(() => watchdog.output().includes('Failed fail.mjs'), () => watchdog.output());

  const { exitCode, stdout, stderr } = await $({ reject: false })`npx --no-install kubik ./fail.mjs`;
  expect(exitCode).toBe(1);
  expect(plain(stdout)).toContain('Using watchdog');
  expect(stderr).toContain('I am failing!');
});

e2e('should not delegate with --no-daemon', async ({ $, startWatchdog }) => {
  await bootstrapAssets('simple');
  const watchdog = await startWatchdog('./a.mjs');
  await waitFor(() => watchdog.output().includes('Succeeded a.mjs'), () => watchdog.output());

  const { exitCode, stdout } = await $({ reject: false })`npx --no-install kubik --no-daemon ./a.mjs`;
  expect(exitCode).toBe(0);
  expect(plain(stdout)).not.toContain('Using watchdog');
  // A local build runs everything.
  expect(stdout).toContain('done - b.mjs');
});

e2e('should not delegate to a watchdog that does not own the task', async ({ $, startWatchdog }) => {
  await bootstrapAssets('simple');
  await bootstrapAssets('no-deps');
  const watchdog = await startWatchdog('./pass.mjs');
  await waitFor(() => watchdog.output().includes('Succeeded pass.mjs'), () => watchdog.output());

  const { exitCode, stdout } = await $({ reject: false })`npx --no-install kubik ./a.mjs`;
  expect(exitCode).toBe(0);
  expect(plain(stdout)).not.toContain('Using watchdog');
});

e2e('should clean up stale sockets and build locally', async ({ $, daemonDir }) => {
  await bootstrapAssets('simple');
  const staleSocket = path.join(daemonDir, '99999.sock');
  await fs.promises.writeFile(staleSocket, '');

  const { exitCode, stdout } = await $({ reject: false })`npx --no-install kubik ./a.mjs`;
  expect(exitCode).toBe(0);
  expect(plain(stdout)).not.toContain('Using watchdog');
  expect(fs.existsSync(staleSocket)).toBe(false);
});
