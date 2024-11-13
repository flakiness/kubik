# Kubik

> ⚠️ **Warning:** Kubik is currently in pre-1.0.0 release. Expect potential changes and experimental features that may not be fully stable yet.

**Kubik** is a simple builder / task runner for node.js, designed specifically to build typescript monorepos.

* [Quick Start](#quick-start)
* [Getting Started](#getting-started)
* [Watch Mode](#watch-mode)
* [Parallelization](#watch-mode)
* [Shebang](#shebang-usage)
* [API](#api)
* [Debugging](#debugging)

## Quick Start

A template script `build.mjs` to build typescript with esbuild and lint its types with `tsc`: 

```ts
#!/usr/bin/env npx kubik

import path from 'path';
import esbuild from 'esbuild';
import fs from 'fs';
import { BuildScript } from 'kubik';

const { __dirname, $ } = BuildScript.initialize(import.meta, {
  name: 'build & lint',
  watch: [ './src' ],
});

const outDir = path.join(__dirname, 'lib');
const srcDir = path.join(__dirname, 'src');
const typesDir = path.join(__dirname, 'types');
await fs.promises.rm(outDir, { recursive: true }).catch(e => void e);
await fs.promises.rm(typesDir, { recursive: true }).catch(e => void e);

const { errors } = await esbuild.build({
  color: true,
  entryPoints: [
    path.join(srcDir, '**/*.ts'),
  ],
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: false,
  bundle: false,
  minify: false,
});

if (!errors.length)
  await $`tsc --pretty -p .`;
```

Commands:
* Build: `./build.mjs` or `npx kubik ./build.mjs`
* Watch mode: `./build.mjs -w` or `npx kubik -w ./build.mjs`
* Debug (run without Kubik): `node build.mjs`
* Run sequential build: `./build.mjs -j 1` or `npx kubik -j 1 ./build.mjs`

## Getting Started

Let's say you have a simple build script:

```js
// build-main.mjs

console.log('Building main library...');
await new Promise(x => setTimeout(x, 1000));
console.log('Done.')
```

And you want to run this script after building some dependency, which has its own script:

```js
// build-third-party.mjs
console.log('Copied third-party!');
```

You can use Kubik to declare dependencies in both scripts, using `BuildScript.initialize` method
at the **very beginning** of your script:

```js
// build-main.mjs
import { BuildScript } from 'kubik';

BuildScript.initialize(import.meta, {
  deps: ['./build-third-party.mjs'], // these are relative to script folder
});

console.log('Building main library...');
await new Promise(x => setTimeout(x, 1000));
console.log('Done.')
```

```js
// build-third-party.mjs
import { BuildScript } from 'kubik';

BuildScript.initialize(import.meta);

console.log('Copied third-party!');
```

Now to build dependencies, you can simply execute the first script with Kubik:

```bash
npx kubik ./build-main.mjs
```

## Watch Mode

<img width="600" alt="Screenshot 2024-11-13 at 11 24 57 AM" src="https://github.com/user-attachments/assets/3cf03c48-0081-42f1-9f29-a79c905f9afb">


Kubik supports watch mode. You can supply `watch` and `ignore` options to the `BuildScript.initialize` to
customize the watch mode behavior, and launch it later with `-w, --watch` flag.

By default, Kubik watches for changes in files commonly involved in build tasks, such as:

* `package.json`
* `package-lock.json`
* `tsconfig.json`

However, you can customize files and directories to watch and to ignore during BuildScript initialization:

```js
import { BuildScript } from 'kubik';

BuildScript.initialize(import.meta, {
  deps: ['./build-third-party.mjs'],
  watch: ['./src'],  // these are relative to script folder
  ignore: ['./src/generated'],  // these are relative to script folder too
});
```

Once launched, the watch mode shows progress, duration and logs from all the tasks.
* To focus panel with task output, use `Tab` and `Shift-Tab` shortcuts
* To scroll logs, use arrows, `j`, `k`, `Ctrl-U`, `Ctrl-D`, `gg` and `Shift-G`.

## Parallelization

Kubik supports `-j, --jobs <number>` flag to customize number of parallel jobs. By default, Kubik allows an unlimited number of parallel jobs.

## Shebang

You can use kubik shebang in scripts, like this:

```js
#!/usr/bin/env npx kubik

import { BuildScript } from 'kubik';

BuildScript.initialize(import.meta, {
  watch: ['./src'],
  ignore: ['./src/generated'],
});
```

## API

The `BuildScript.initialize` function prepares the build environment, offering utilities like `$` for shell commands (powered by [execa](https://github.com/sindresorhus/execa)), `__dirname`, and `__filename` based on the current script's context. 

The whole API boils down to the following:

```ts
#!/usr/bin/env npx kubik

import { BuildScript } from 'kubik';
import fs from 'fs';

const {
  $, // execa shell runner, that uses __dirname as CWD
  __dirname, // **this** script directory absolute path
  __filename, // **this** script file absolute path
  isWatchMode, // wether the script is run under kubik's watch mode
} = BuildScript.initialize(import.meta, {
  name: 'my library',
  watch: ['./src'], // all the paths are resolved relative to this script
  ignore: ['./src/generated'], // relative to this script
  deps: ['../third-party/build.mjs'], // relative to this script
});

// Use $ to run commands, e.g. typescript.
// Note that $ uses __dirname as CWD.
await $`tsc --pretty -p .`;
```

## Debugging

You can run build scripts as regular node.js scripts; in this case, these are executed
directly by node.js, with no Kubik in the way.

```bash
node ./build-main.mjs
```

