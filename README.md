# Kubik

> ⚠️ **Warning:** Kubik is currently in pre-1.0.0 release. Expect potential changes and experimental features that may not be fully stable yet.

**Kubik** is a simple task runner for node.js with first-class TypeScript support.

Kubik tasks are defined by TypeScript / Node.js scripts, with dependencies to other tasks.
Kubik supports running tasks with different parallelization modes and has a built-in watch mode.

* [Quick Start](#quick-start)
* [Getting Started](#getting-started)
* [Tasks vs Services](#tasks-vs-services)
* [Typescript Support](#typescript-support)
* [Kubik TUI](#kubik-tui)
* [Colors in Kubik TUI](#colors-in-kubik-tui)
* [Parallelization](#Parallelization)
* [Environment Files](#environment-files)
* [Shebang](#shebang-usage)
* [API](#api)
* [Limitations](#limitations)
* [Debugging](#debugging)

## Quick Start

Any `build.(m)js` script can be converted to a task by importing `Task` and running `Task.init` in the
very beginning of the script:

```ts
import { Task } from 'kubik';

Task.init(import.meta);

/* ... build script ...  */
```

The `Task.init` method accepts configuration (dependencies & watch mode configuration), see 
[API](#api) section.

Use the following commands to run tasks:
* Build: `npx kubik ./build.mjs`
* Watch mode: `npx kubik -w ./build.mjs`
* Debug (run without Kubik): `node build.mjs` or `tsx build.mjs`
* Run sequential build: `npx kubik -j 1 ./build.mjs`

A real-life example is [available here](https://github.com/flakiness/kubik/blob/main/bootstrap/build.mjs).

## Task dependencies

Kubik allows defining dependencies between tasks using `deps` option in the `Task.init` method:

```js
// build-main.mjs
import { Task } from 'kubik';

Task.init(import.meta, {
  deps: ['./other-task.mjs'], // these are relative to script folder
});

// ... run some tasks
```

To run tasks with their dependencies to completion, run:

```bash
npx kubik ./build-main.mjs
```

## Multiple roots

In a complicated projects, it might be necessary to build a project from multiple entry points.
In this case, you can pass multiple entry points to Kubik:

```bash
npx kubik ./build-main.mjs ./build-other.mjs
```

In this case, if both `build-main.mjs` and `build-other.mjs` depend on `shared.mjs` task, then
the task will be executed only once.

## Running services

By default, task is considered successful if its process completes with 0 exit code, and
unsuccessful if it fails with non-zero code.

However, certain tasks require a running process; for example, launching development server.
In this case, you can use `Task.done()` to notify Kubik that the task completed and it's dependants
can start executing:

```ts
import { Task } from 'kubik';

Task.init(import.meta);

// ...launch HTTP server... 
// Report the task as complete.
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


## Kubik TUI

Kubik supports watch mode where it listens for changes on the file system and reruns tasks and
their dependencies. In this mode, Kubik shows a slick terminal application to observe & control task
execution.

To run watch mode, use `-w` or `--watch` flag:

```sh
npx kubik -w ./build.mjs
```

In watch mode, Kubik launches a terminal app that shows progress, duration and logs from all the tasks:

<img width="600" alt="Screenshot 2024-11-13 at 11 24 57 AM" src="https://github.com/user-attachments/assets/3cf03c48-0081-42f1-9f29-a79c905f9afb">

There are a few shortcuts available to navigate inside the watch mode app:

* `n / p`       select next / previous task
* `N / P`       select last / first task
* `j / k`       scroll up / down 1 line
* `C-u / C-d`   scroll up / down half a screen
* `g / G`       scroll to top / bottom
* `r`           restart a task and all its dependencies
* `s`           save current task output to ./kubikstdoutstderr
* `z`           toggle tasks sidebar pane
* `c`           toggle project configuration introspection
* `?`           toggle help

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

## Colors in Kubik TUI

Kubik TUI **does not** use terminal emulator to run task processes, so the processes don't have
interactive terminal attached and might not render colors.

Clients can manually override this behavior of their tools, using the `process.env.KUBIK_TUI` env
variable to force tools to output colors.

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
  isTUI, // wether the script is being run with a non-interactive terminal under kubik's TUI.
         // this is the same as `process.env.KUBIK_TUI`.
} = Task.init(import.meta, {
  name: 'my library',
  watch: ['./src'], // all the paths are resolved relative to **this** script
  ignore: ['./src/generated'], // relative to **this** script
  deps: ['../third-party/build.mjs'], // relative to **this** script
});

// Use $ to run commands, e.g. typescript.
// Note that $ uses __dirname as CWD.
await $`tsc --pretty -p .`;

// If node.js process does not exit (i.e. it runs a server),
// then we can notify Kubik explicitly that the task has succeeded.
Task.done();
```

## Limitations

* Kubik's TUI executes all tasks with a non-interactive terminal attached, which might
  yield surprising behavior if an interactive input is assumed.

## Debugging

You can run build scripts as regular node.js scripts; in this case, these are executed
directly by node.js, with no Kubik in the way.

```bash
node ./build-main.mjs
```

