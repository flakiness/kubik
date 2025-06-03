import { $, ExecaScriptMethod } from 'execa';
import path from "path";
import url from 'url';
import { MSG_TASK_DONE } from './workspace.js';

export type TaskOptions = {
  /**
   * Optional script name. It will be used for output logs and watch mode.
   */
  name?: string,
  /**
   * Watch mode configuration: paths to watch, relative to the script's directory.
   */
  watch?: string | string[],
  /**
   * Watch mode configuration: paths to ignore, relative to the script's directory.
   */
  ignore?: string | string[],
  /**
   * Script's dependencies, that should be executed before running this script.
   */
  deps?: string | string[],
}

export type TaskUtils = {
  /**
   * Absolute path of the script directory
   */
  __dirname: string,
  /**
   * Absolute file path of the build script itself
   */
  __filename: string,
  /**
   * An execa instance, with current working directory bound to script's directory.
   */
  $: ExecaScriptMethod,
  /**
   * Set to true if the script is being run under the Kubik's TUI.
   * This is usually used to conditionally force colors in build scripts.
   */
  isTUI: boolean,
}

export class Task {
  /**
   * Initialize a Task so that Kubik knows how to run it.
   * 
   * @param meta pass your scripts `import.meta` as the first parameter
   * @param options 
   * @returns 
   */
  static init(meta: { url: string }, options: TaskOptions = {}): TaskUtils {
    if (process.env.KUBIK_DUMP_CONFIGURATION) {
      console.log(JSON.stringify(options));
      process.exit(0);
    }
    if (!process.env.KUBIK_RUNNER) {
      console.warn(`[kubik] NOTE: Building without dependencies; run 'npx kubik ${path.basename(process.argv[1])}' to build tree.`);
    }
    const filename = url.fileURLToPath(meta.url);
    const dirname = path.dirname(filename);
    return {
      __dirname: dirname,
      __filename: filename,
      isTUI: !!process.env.KUBIK_TUI,
      $: $({ cwd: dirname, stdio: 'inherit' }),
    };
  }

  /**
   * By default, tasks are considered failed when they exis with non-zero code,
   * and succeeded when they exit with zero code.
   * 
   * Certain tasks, for example, start a server, and succeed when the server is running.
   * This process doesn't end, and these tasks can be marked as completed manually.
   */
  static done() {
    if (process.env.KUBIK_RUNNER)
      process.send?.call(process, MSG_TASK_DONE);
  }
}
