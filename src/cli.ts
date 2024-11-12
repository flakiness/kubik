#!/usr/bin/env node

import { program } from "commander";
import path from "path";
import { AbsolutePath, ReadConfigResult } from "./configLoader.js";
import { ProjectBuilder } from "./projectBuilder.js";

program
  .description('Start build')
  .option('-j, --jobs <number>', 'Allow N jobs at once; infinite jobs with no arg.')
  .option('-w, --watch', 'Watch files for changes')
  .arguments('<files...>')
  .action((files: string[], options: { jobs?: number, watch?: boolean }) => {
    if (options.watch) {
      console.log('Watch mode is enabled');
    }
    cliBuild(files, options.jobs ?? Infinity);
  });

program.parse();

function cliBuild(roots: string[], parallelization: number) {
  function configName(config: ReadConfigResult) {
    if (config.config?.name)
      return config.config.name;
    return path.relative(process.cwd(), config.configPath);
  }
  const projectBuilder = new ProjectBuilder({
    parallelization,
    watchMode: false,
  });

  projectBuilder.setRoots(roots.map(root => path.resolve(process.cwd(), root) as AbsolutePath));
  
  projectBuilder.on('project_build_stderr', (config, text) => {
    for (const line of text.split('\n'))
      console.error(`[${configName(config)}] ${line}`)
  });
  
  projectBuilder.on('project_build_stdout', (config, text) => {
    for (const line of text.split('\n'))
      console.log(`[${configName(config)}] ${line}`)
  });
}
