import { $, ExecaScriptMethod } from 'execa';
import path from "path";
import url from 'url';

export type BuildScriptOptions = {
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

export type ScriptUtils = {
  /**
   * Absolute path of the script directory
   */
  __dirname: string,
  /**
   * Absolute file path of the build script itself
   */
  __filename: string,
  /**
   * Wether the script is run under Kubik's watch mode
   */
  isWatchMode: boolean,
  /**
   * An execa instance, with current working directory bound to script's directory.
   */
  $: ExecaScriptMethod,
}

export class BuildScript {
  /**
   * Initialize a BuildScript so that Kubik knows how to run it.
   * 
   * @param meta pass your scripts `import.meta` as the first parameter
   * @param options 
   * @returns 
   */
  static initialize(meta: { url: string }, options: BuildScriptOptions = {}): ScriptUtils {
    if (process.env.KUBIK_DUMP_CONFIGURATION) {
      console.log(JSON.stringify(options));
      process.exit(0);
    }
    if (!process.env.KUBIK_RUNNER)
      console.warn(`[kubik] NOTE: Building without dependencies; run 'npx kubik ${path.basename(process.argv[1])}' to build tree.`);
    const filename = url.fileURLToPath(meta.url);
    const dirname = path.dirname(filename);
    return {
      __dirname: dirname,
      __filename: filename,
      isWatchMode: !!process.env.KUBIK_WATCH_MODE,
      $: $({ cwd: dirname, stdio: 'inherit' }),
    };
  }
}
