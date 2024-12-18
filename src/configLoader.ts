import { existsSync } from "fs";
import path from "path";
import { TaskOptions } from "./import.js";
import { spawnAsync } from "./process_utils.js";
import { Brand } from "./utils.js";

export type AbsolutePath = Brand<string, 'AbsolutePath'>;
export const CWD = process.cwd() as AbsolutePath;

export function toAbsolutePath(base: AbsolutePath, relative: string): AbsolutePath {
  return path.resolve(base, relative) as AbsolutePath;
}

export type Config = {
  name?: string,
  watch: AbsolutePath[],
  ignore: AbsolutePath[],
  deps: AbsolutePath[],
}

export type ReadConfigResult = {
  configPath: AbsolutePath,
  error?: string,
  config?: Config,
};

export async function readConfigTree(roots: AbsolutePath[]): Promise<Map<AbsolutePath, ReadConfigResult>> {
  const results = new Map<AbsolutePath, ReadConfigResult>();

  const queue = [...roots];
  while (queue.length) {
    const configPath = queue.pop()!;
    const result = await readSingleConfig(configPath);
    results.set(configPath, result);
    if (result.config) {
      for (const child of result.config.deps) {
        if (!results.has(child))
          queue.push(child);
      }
    }
  }
  return results;
}

async function readSingleConfig(configPath: AbsolutePath): Promise<ReadConfigResult> {
  if (!existsSync(configPath)) {
    return { configPath, error: `Failed to load configuration - path ${path.relative(process.cwd(), configPath)} does not exist`};
  }
  // We have to load config in a sub-process to bust require cache.
  const args: string[] = [];
  if (configPath.endsWith('.ts') || configPath.endsWith('.mts'))
    args.push(`--import=tsx`);

  const { code, stdout, stderr, stdio } = await spawnAsync(process.execPath, [...args, configPath], {
    env: {
      ...process.env,
      KUBIK_DUMP_CONFIGURATION: '1',
    }
  });
  if (code !== 0) {
    if (stderr.includes('ERR_MODULE_NOT_FOUND') && stderr.includes('tsx'))
      return { configPath, error: 'failed to load configuration: please install TSX to run .ts/.mts scripts: \n    npm i -D tsx'};  
    return { configPath, error: 'failed to load configuration\n' + stdio};
  }
  try {
    let { name, watch = [], ignore = [], deps = [] } = JSON.parse(stdout) as TaskOptions;
    if (!Array.isArray(watch))
      watch = [watch];
    if (!Array.isArray(ignore))
      ignore = [ignore];
    if (!Array.isArray(deps))
      deps = [deps];
    const configDir = path.dirname(configPath) as AbsolutePath;
    const resolveWRTConfig = toAbsolutePath.bind(null, configDir)
    return {
      configPath,
      config: {
        name,
        watch: watch.map(resolveWRTConfig),
        ignore: ignore.map(resolveWRTConfig),
        deps: deps.map(resolveWRTConfig),
      }
    };
  } catch (e) {
    const message = ['Failed to load config: ' + configPath];
    if (e instanceof Error)
      message.push(e.message);
    return { configPath, error: message.join('\n') };
  }
}
