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
    const roots = files.map(file => path.resolve(process.cwd(), file)) as AbsolutePath[];
    if (options.watch)
      startWatchApp(roots, options.jobs ?? Infinity)
    else 
      cliBuild(roots, options.jobs ?? Infinity);
  });

program.parse();

function cliBuild(roots: AbsolutePath[], jobs: number) {
  const workspace = new Workspace({
    jobs,
    watchMode: false,
  });

  workspace.setRoots(roots);

  workspace.on('project_stderr', (project, text) => {
    for (const line of text.trim().split('\n'))
      console.error(`[${project.name}] ${line}`)
  });

  workspace.on('project_stdout', (project, text) => {
    for (const line of text.trim().split('\n'))
      console.log(`[${project.name}] ${line}`)
  });
}
