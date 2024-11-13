#!/usr/bin/env node

import { program } from "commander";
import path from "path";
import { AbsolutePath } from "./configLoader.js";
import { startWatchApp } from "./watchApp.js";
import { Workspace } from "./workspace.js";

program
  .description('Start build')
  .option('-j, --jobs <number>', 'Allow N jobs at once; infinite jobs with no arg.')
  .option('-w, --watch', 'Watch files for changes')
  .arguments('<files...>')
  .action((files: string[], options: { jobs?: number, watch?: boolean }) => {
    if (options.watch)
      startWatchApp(files, options.jobs ?? Infinity)
    else 
      cliBuild(files, options.jobs ?? Infinity);
  });

program.parse();

function cliBuild(roots: string[], jobs: number) {
  const projectBuilder = new Workspace({
    jobs,
    watchMode: false,
  });

  projectBuilder.setRoots(roots.map(root => path.resolve(process.cwd(), root) as AbsolutePath));
  
  projectBuilder.on('project_stderr', (project, text) => {
    for (const line of text.trim().split('\n'))
      console.error(`[${project.name}] ${line}`)
  });

  projectBuilder.on('project_stdout', (project, text) => {
    for (const line of text.trim().split('\n'))
      console.log(`[${project.name}] ${line}`)
  });
}
