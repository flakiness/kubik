import { $ } from 'execa';
import path from "path";
import url from 'url';

export type BuildScriptOptions = {
  name?: string,
  watch?: string | string[],
  ignore?: string | string[],
  deps?: string | string[],
}

export class BuildScript {
  static initialize(meta: { url: string }, options: BuildScriptOptions = {}) {
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
      $: $({ cwd: dirname, stdio: 'inherit' }),
    };
  }
}
