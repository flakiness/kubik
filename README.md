# Kubik

> ⚠️ **Warning:** Kubik is currently in pre-1.0.0 release. Expect potential changes and experimental features that may not be fully stable yet.

**Kubik** is a simple task runner for Node.js with first-class TypeScript support.

Kubik tasks are defined by TypeScript/Node.js scripts, with dependencies to other tasks.
Kubik supports running tasks with different parallelization modes and has a built-in watch mode.

* [Quick Start](#quick-start)
* [Getting Started](#getting-started)
* [Task Dependencies](#task-dependencies)
* [Multiple Roots](#multiple-roots)
* [Long-running processes](#long-running-processes)
* [TypeScript Support](#typescript-support)
* [Kubik TUI](#kubik-tui)
* [Colors in Kubik TUI](#colors-in-kubik-tui)
* [Parallelization](#parallelization)
* [Environment Files](#environment-files)
* [Shebang](#shebang)
* [API](#api)
* [Limitations](#limitations)
* [Debugging](#debugging)

## Quick Start

Any `build.(m)js` script can be converted to a task by importing `Task` and running `Task.init` at the
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

## Getting Started

To start using Kubik in your project:

1. Install Kubik:
   ```sh
   npm install --save-dev kubik
   ```

2. Create a build script (e.g., `build.mjs`):
   ```js
   import { Task } from 'kubik';
   
   const { $ } = Task.init(import.meta);
   
   // Your build logic here
   await $`echo "Hello, Kubik!"`;
   ```

3. Run your task:
   ```sh
   npx kubik ./build.mjs
   ```

## Task Dependencies

Kubik allows defining dependencies between tasks using the `deps` option in the `Task.init` method:

```js
// build-main.mjs
import { Task } from 'kubik';

Task.init(import.meta, {
  deps: ['./other-task.mjs'], // these are relative to script folder
});

// ... run some tasks
```

When you run a task with dependencies:
1. Kubik first executes all dependency tasks in parallel (unless limited by the `-j` flag)
2. Only after all dependencies complete successfully will the main task start
3. If any dependency fails, the main task won't execute

To run tasks with their dependencies to completion:

```bash
npx kubik ./build-main.mjs
```

## Multiple Roots

In complicated projects, it might be necessary to build a project from multiple entry points.
In this case, you can pass multiple entry points to Kubik:

```bash
npx kubik ./build-main.mjs ./build-other.mjs
```

When using multiple roots:
- Kubik builds a unified dependency graph across all entry points
- If multiple tasks depend on the same task (e.g., both `build-main.mjs` and `build-other.mjs` depend on `shared.mjs`), the shared task will be executed only once
- Tasks are identified by their absolute file paths, so tasks with the same filename but in different directories are treated as separate tasks

## Long-running processes

By default, a task is considered successful if its process completes with a 0 exit code, and
unsuccessful if it fails with a non-zero code.

However, Kubik can be used to organize efficient local development workflow, launching and re-launching
devservers and other long-running developer processes. This usually makes sense with the `-w/--watch` flag, that
kicks in Kubik TUI.

You can use `Task.done()` to notify Kubik that the task completed and its dependents
can start executing. In this case, Kubik will mark this task with `@` in the TUI.

```ts
import { Task } from 'kubik';

Task.init(import.meta);

// Start an HTTP server
const server = http.createServer(/*...*/);
server.listen(3000, () => {
  console.log('Server running on port 3000');
  // Report the task as complete so dependents can start
  Task.done();
});
```

This allows long-running services to coexist with build tasks in your dependency graph.

## TypeScript support

Kubik supports running tasks defined in `.ts`/`.mts` files using [tsx](https://github.com/privatenumber/tsx). To use TypeScript, simply install `tsx` alongside Kubik, 
and use `.ts`/`.mts` extensions to write your scripts:

1. Install `tsx`:

    ```sh
    npm i --save-dev tsx
    ```

2. Write your scripts in `.ts` or `.mts` files:

    ```ts
    // hello.ts

    import { Task } from 'kubik';

    Task.init(import.meta);
    const foo: String = 'Hello, typescript!';
    console.log(foo);
    ```

3. Run your tasks as usual:

    ```sh
    npx kubik ./hello.ts
    ```


## Kubik TUI

Kubik supports watch mode where it listens for changes on the file system and reruns tasks and
their dependencies. In this mode, Kubik shows a slick terminal application to observe & control task
execution.

To run watch mode, use the `-w` or `--watch` flag:

```sh
npx kubik -w ./build.mjs
```

In watch mode, Kubik launches a terminal app that shows progress, duration and logs from all the tasks:

<img width="600" alt="Kubik terminal app" src="https://github.com/user-attachments/assets/d97e00ca-069f-4ee8-b92b-f085d1a1e368">

There are several shortcuts available to navigate inside the watch mode app:

* `n / p`       select next / previous task
* `N / P`       select last / first task
* `j / k`       scroll up / down 1 line
* `C-u / C-d`   scroll up / down half a screen
* `g / G`       scroll to top / bottom
* `r`           restart a task and all its dependencies
* `s`           save current task output to ./kubikstdoutstderr
* `S`           save current task output **without ANSI codes** to ./kubikstdoutstderr
* `z`           toggle tasks sidebar pane
* `i`           toggle task information
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
> then Kubik will re-run the build one more time, causing "infinite" builds. You'll observe this
> with tasks never completing.
> Common scenarios that cause this issue:
> - Watching output directories that your build writes to
> - Watching temporary files that are modified during the build
> - Not properly ignoring generated files
>
> Use the `ignore` option to mitigate this behavior.

## Colors in Kubik TUI

Kubik TUI **does not** use terminal emulator to run task processes, so the processes don't have
an interactive terminal attached and might not render colors.

Clients can manually override this behavior of their tools using the `process.env.KUBIK_TUI` env
variable to force tools to output colors. For example:

```js
// In your build script
import { Task } from 'kubik';

const { $, isTUI } = Task.init(import.meta);

// Force colors in tools that check for TTY
if (isTUI) {
  await $`jest --colors`;
} else {
  await $`jest`;
}
```

Many tools like Jest, ESLint, and TypeScript have flags to force color output that you can use when `isTUI` is true.

## Parallelization

Kubik supports the `-j, --jobs <number>` flag to customize the number of parallel jobs. By default, Kubik allows an unlimited number of parallel jobs.

Examples:
```sh
# Run with at most 2 parallel tasks
npx kubik -j 2 ./build.mjs

# Run tasks sequentially (one at a time)
npx kubik -j 1 ./build.mjs
```

This is particularly useful for resource-intensive tasks or when debugging complex build processes.

## Environment Files

Kubik supports the `-e, --env-file <env file>` flag to load environment variables from a file.

```bash
npx kubik -e .env ./build.mjs
```

This will load all the environment variables from the `.env` file and pass them to all scripts.

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

This allows you to run the script directly as an executable (after making it executable with `chmod +x`):

```sh
./build.mjs
```

## API

Kubik provides a simple API centered around the `Task` class, which helps set up and manage your build tasks.

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
  isTUI, // whether the script is being run with a non-interactive terminal under kubik's TUI.
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
  yield surprising behavior if interactive input is assumed.
* Dependency cycles between tasks are not allowed and will cause an error.
* All tasks must be accessible via the filesystem (no remote tasks).

## Debugging

You can run build scripts as regular node.js scripts; in this case, these are executed
directly by node.js, with no Kubik in the way.

```bash
node ./build-main.mjs
```

This is useful for:
- Debugging script logic issues
- Testing scripts in isolation without dependencies
- Using Node.js debugging tools like `--inspect`


