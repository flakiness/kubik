import { expect, test } from '@playwright/test';
import { $, ExecaScriptMethod } from 'execa';
import fs, { cpSync } from 'fs';
import path from 'path';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Invoke the built CLI directly by path. On a clean machine there is no
// globally-linked `kubik` bin (pnpm does not self-link the root package's own
// bin), so `npx kubik` / `pnpm exec kubik` cannot resolve it. The asset's
// `import 'kubik'` still resolves via Node's package self-reference, since the
// test output dir lives inside this repo.
const kubikCli = path.join(__dirname, '..', 'lib', 'cli.js');

function asset(aPath: string) {
  return test.info().outputPath(aPath);
}

async function bootstrapAssets(assetsFolder: string) {
  await fs.promises.cp(path.join(__dirname, assetsFolder), test.info().outputDir, {recursive: true});
}

function cpAsset(from: string, to: string) {
  cpSync(test.info().outputPath(from), test.info().outputPath(to));  
}

const e2e = test.extend<{
  $: ExecaScriptMethod,
}, {}>({
  $: async ({}, use, info) => {
    await use($({
      cwd: info.outputDir,
    }));
  }
});

e2e('should return zero exit code for passing builds', async ({ $ }) => {
  await bootstrapAssets('simple');
  const { exitCode } = await $({ reject: false })`${process.execPath} ${kubikCli} ./a.mjs`;
  expect(exitCode).toBe(0);
});

e2e('should return non-zero code for failing builds', async ({ $ }) => {
  await bootstrapAssets('no-deps');
  const { exitCode } = await $({ reject: false })`${process.execPath} ${kubikCli} ./fail.mjs`;
  expect(exitCode).toBe(1);
});
