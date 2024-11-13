# Kubik

> ⚠️ **Warning:** Kubik is currently in pre-1.0.0 release. Expect potential changes and experimental features that may not be fully stable yet.

**Kubik** is a simple builder / task runner for node.js.

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
  deps: ['./build-third-party.mjs'],
});

console.log('Building main library...');
await new Promise(x => setTimeout(x, 1000));
console.log('Done.')
```

```js
// build-third-party.mjs
BuildScript.initialize(import.meta);

console.log('Copied third-party!');
```

Now to build dependencies, you can simply execute the first script with Kubik:

```bash
npx kubik ./build-main.mjs
```

## Watch Mode

Kubik supports watch mode. You can supply `watch` and `ignore` options to the `BuildScript.initialize` to
customize the watch mode behavior, and launch it later with `-w, --watch` flag.

By default, Kubik watches for changes in files commonly involved in build tasks, such as:

* `package.json`
* `package-lock.json`
* `tsconfig.json`
* `node_modules/`

```js
import { BuildScript } from 'kubik';

BuildScript.initialize(import.meta, {
  deps: ['./build-third-party.mjs'],
  watch: ['./src'],
  ignore: ['./src/generated'],
});
```

## Parallelization

Kubik supports `-j, --jobs <number>` flag to customize number of parallel jobs. By default, Kubik allows an unlimited number of parallel jobs.

## Shebang usage

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

const { $, __dirname, __filename } = BuildScript.initialize(import.meta, {
  name: 'my library',
  watch: ['./src'], // all the paths are resolved relative to this script
  ignore: ['./src/generated'], // relative to this script
  deps: ['../third-party/build.mjs'], // relative to this script
});

// $ uses __dirname as CWD by default
await $`tsc --pretty -p .`;
```
