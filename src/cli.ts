#!/usr/bin/env node

import path from "path";
import { AbsolutePath, ReadConfigResult } from "./configLoader.js";
import { ProjectBuilder } from "./projectBuilder.js";

const projectBuider = new ProjectBuilder({
  watchMode: false,
  buildMode: 'parallel',
});

const roots = process.argv.slice(2);

function configName(config: ReadConfigResult) {
  if (config.config?.name)
    return config.config.name;
  return path.relative(process.cwd(), config.configPath);
}

projectBuider.setRoots(roots.map(root => path.resolve(process.cwd(), root) as AbsolutePath));

projectBuider.on('project_build_stderr', (config, text) => {
  for (const line of text.split('\n'))
    console.error(`[${configName(config)}] ${line}`)
});

projectBuider.on('project_build_stdout', (config, text) => {
  for (const line of text.split('\n'))
    console.log(`[${configName(config)}] ${line}`)
});
