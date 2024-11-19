# Kubik

> ⚠️ **Warning:** Kubik is currently in pre-1.0.0 release. Expect potential changes and experimental features that may not be fully stable yet.

**Kubik** is a simple task runner for node.js with first-class TypeScript support.

Kubik tasks are defined by TypeScript / Node.js scripts, with dependencies to other tasks.
Kubik supports running tasks with different parallelization modes and has a built-in watch mode.

* [Quick Start](#quick-start)
* [Getting Started](#getting-started)
* [Tasks vs Services](#tasks-vs-services)
* [Typescript Support](#typescript-support)
* [Watch Mode](#watch-mode)
* [Parallelization](#watch-mode)
* [Environment Files](#environment-files)
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
import { Task } from 'kubik';

const { __dirname, $ } = Task.init(import.meta, {
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

You can use Kubik to declare dependencies in both scripts, using `Task.init` method
at the **very beginning** of your script:

```js
// build-main.mjs
import { Task } from 'kubik';

Task.init(import.meta, {
  deps: ['./build-third-party.mjs'], // these are relative to script folder
});

console.log('Building main library...');
await new Promise(x => setTimeout(x, 1000));
console.log('Done.')
```

```js
// build-third-party.mjs
import { Task } from 'kubik';

Task.init(import.meta);

console.log('Copied third-party!');
```

Now to build dependencies, you can simply execute the first script with Kubik:

```bash
npx kubik ./build-main.mjs
```

## Tasks vs Services

By default, task is considered successful if its process completes with 0 exit code, and
unsuccessful if it fails with non-zero code.

However, certain tasks require a running process; for example, launching development server.
In this case, you can use `Task.done()` to notify Kubik that the task completed and it's dependants
can start executing:

```ts
import { Task } from 'kubik';

Task.init(import.meta);

// setInterval will keep node.js process from exiting.
setInterval(() => console.log(Date.now()), 150);
// This is how Kubik will know that this task is "done".
Task.done();
```

## TypeScript support

Kubik supports running tasks defined in a `.ts` / `.mts` files using [tsx](https://github.com/privatenumber/tsx). To use typescript, simply install `tsx` along side with kubik, 
and use `.ts`/`.tsx` extension to write your scripts:

1. Install `tsx`:

    ```sh
    npm i --save-dev tsx
    ```

1. Write your scripts in a `.ts` or `.mts` files:

    ```ts
    // hello.ts

    import { Task } from 'kubik';

    Task.init(import.meta);
    const foo: String = 'Hello, typescript!';
    console.log(foo);
    ```

1. Run your tasks as usual:

    ```sh
    npx kubik ./hello.ts
    ```


## Watch Mode

Kubik supports watch mode where it listens for changes on the file system and reruns tasks and
their dependencies. 

To run watch mode, use `-w` or `--watch` flag:

```sh
npx kubik -w ./build.mjs
```

In watch mode, Kubik launches a terminal app that shows progress, duration and logs from all the tasks:

<img width="600" alt="Screenshot 2024-11-13 at 11 24 57 AM" src="https://github.com/user-attachments/assets/3cf03c48-0081-42f1-9f29-a79c905f9afb">

There are a few shortcuts available to navigate inside the watch mode app:

* To cycle focus through panels, use `Tab` and `Shift-Tab`
* To scroll logs of the focused pane, use arrows, `j`, `k`, `Ctrl-U`, `Ctrl-D`, `gg` and `Shift-G`.
* You can also use mouse to scroll logs

By default, Kubik watches for changes in files commonly involved in build tasks, such as:

* `package.json`
* `package-lock.json`
* `tsconfig.json`

However, you can customize files and directories to watch and to ignore during Task initialization:

```js
import { Task } from 'kubik';

Task.init(import.meta, {
  deps: ['./build-third-party.mjs'],
  watch: ['./src'],  // these are relative to script folder
  ignore: ['./src/generated'],  // these are relative to script folder too
});
```

> NOTE: Be careful with watch mode: if the build procedure changes some of the watched files,
> then Kubik will re-run the build one time, causing "infinite" builds. You'll observe this
> with tasks never completing.
> Use `ignore` option to mitigate this behavior.

## Parallelization

Kubik supports `-j, --jobs <number>` flag to customize number of parallel jobs. By default, Kubik allows an unlimited number of parallel jobs.

## Environment Files

Kubik supports `-e, --env-file <env file>` flag to load environment variables from a file.

```bash
npx kubik -e .env ./build.mjs
```

This will load all the environment variables from `.env` file, and pass them to all scripts.

## Shebang

You can use kubik shebang in scripts, like this:

```js
#!/usr/bin/env npx kubik

import { Task } from 'kubik';

Task.init(import.meta, {
  watch: ['./src'],
  ignore: ['./src/generated'],
});
```

## API

The `Task.init` function prepares the build environment, offering utilities like `$` for shell commands (powered by [execa](https://github.com/sindresorhus/execa)), `__dirname`, and `__filename` based on the current script's context. 

The whole API boils down to the following:

```ts
#!/usr/bin/env npx kubik

import { Task } from 'kubik';
import fs from 'fs';

const {
  $, // execa shell runner, that uses __dirname as CWD
  __dirname, // **this** script directory absolute path
  __filename, // **this** script file absolute path
} = Task.init(import.meta, {
  name: 'my library',
  watch: ['./src'], // all the paths are resolved relative to this script
  ignore: ['./src/generated'], // relative to this script
  deps: ['../third-party/build.mjs'], // relative to this script
});

console.log(Task.isWatchMode()); // wether the script is being run under watch mode.

// Use $ to run commands, e.g. typescript.
// Note that $ uses __dirname as CWD.
await $`tsc --pretty -p .`;

// If node.js process does not exit (i.e. it runs a server),
// then we can notify Kubik explicitly that the task is done.
Task.done(); 
```

## Debugging

You can run build scripts as regular node.js scripts; in this case, these are executed
directly by node.js, with no Kubik in the way.

```bash
node ./build-main.mjs
```

