import path from "path";
import { spawnAsync } from "./process_utils.js";
import { Brand } from "./utils.js";

export type AbsolutePath = Brand<string, 'AbsolutePath'>;
export const CWD = process.cwd() as AbsolutePath;

export function toAbsolutePath(base: AbsolutePath, relative: string): AbsolutePath {
  return path.resolve(base, relative) as AbsolutePath;
}

type RawConfigOptions = {
  name?: string,
  watch?: string | string[],
  avoid?: string | string[],
  deps?: string | string[],
}

type Config = {
  name?: string,
  watch: AbsolutePath[],
  ignore: AbsolutePath[],
  deps: AbsolutePath[],
}

export type ReadConfigResult = {
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
  // We have to load config in a sub-process to bust require cache.
  const { code, output } = await spawnAsync(process.execPath, [configPath], {
    env: {
      ...process.env,
      KUBIK_DUMP_CONFIGURATION: '1',
    }
  });
  if (code !== 0)
    return { error: 'failed to load configuration '};
  try {
    let { name, watch = [], avoid = [], deps = [] } = JSON.parse(output) as RawConfigOptions;
    if (!Array.isArray(watch))
      watch = [watch];
    if (!Array.isArray(avoid))
      avoid = [avoid];
    if (!Array.isArray(deps))
      deps = [deps];
    const configDir = path.dirname(configPath) as AbsolutePath;
    const resolveWRTConfig = toAbsolutePath.bind(null, configDir)
    return {config: {
      name,
      watch: watch.map(resolveWRTConfig),
      ignore: avoid.map(resolveWRTConfig),
      deps: deps.map(resolveWRTConfig),
    }}
  } catch (e) {
    const message = ['Failed to load config: ' + configPath];
    if (e instanceof Error)
      message.push(e.message);
    return { error: message.join('\n') };
  }
}
