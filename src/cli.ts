#!/usr/bin/env node

import chalk from "chalk";
import { Option, program } from "commander";
import path from "path";
import { AbsolutePath } from "./configLoader.js";
import { timeInSeconds } from "./utils.js";
import { startWatchApp } from "./watchApp.js";
import { Project, Workspace } from "./workspace.js";

program
  .description('Start build')
  .addOption(new Option(`-j, --jobs <number>`, `Allow N jobs at once; infinite jobs with no arg.`).argParser(parseInt))
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

  workspace.on('project_started', project => {
    console.log(chalk.yellow(`[kubik] Starting ${chalk.bold(project.name)}...`));
  });
  workspace.on('project_finished', project => {
    if (project.status === 'fail')
      console.log(chalk.red(`[kubik] Failed ${chalk.bold(project.name)} in ${chalk.bold(timeInSeconds(project.durationMs))}`));
    else if (project.status === 'ok')
      console.log(chalk.green(`[kubik] Succeeded ${chalk.bold(project.name)} in ${chalk.bold(timeInSeconds(project.durationMs))}`));
  });

  const logLine = jobs === 1 ? (project: Project, line: string) => console.log(line) : (project: Project, line: string) => console.log(`[${project.name}] ${line}`);
  workspace.on('project_stderr', (project, text) => {
    for (const line of text.trim().split('\n'))
      logLine(project, line);
  });

  workspace.on('project_stdout', (project, text) => {
    for (const line of text.trim().split('\n'))
      logLine(project, line);
  });
}
