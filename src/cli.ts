#!/usr/bin/env node

import chalk, { supportsColor } from "chalk";
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
  .option('--env-file <env file>', 'Use environment file for all tasks')
  .arguments('<files...>')
  .action((files: string[], options: { jobs?: number, envFile?: string, watch?: boolean }) => {
    const roots = files.map(file => path.resolve(process.cwd(), file)) as AbsolutePath[];
    const workspace = new Workspace({
      roots,
      jobs: options.jobs ?? Infinity,
      nodeOptions: {
        envFile: options.envFile ? path.resolve(process.cwd(), options.envFile) as AbsolutePath : undefined,
        forceColors: !!supportsColor,
      },
      watchMode: options.watch ?? false,
    });
    if (options.watch)
      startWatchApp(workspace)
    else
      cliLogger(workspace);
  });

program.parse();

function cliLogger(workspace: Workspace) {
  workspace.on('project_started', project => {
    console.log(chalk.yellow(`[kubik] Starting ${chalk.bold(project.name())}...`));
  });
  workspace.on('project_finished', project => {
    if (project.status() === 'fail')
      console.log(chalk.red(`[kubik] Failed ${chalk.bold(project.name())} in ${chalk.bold(timeInSeconds(project.durationMs()))}`));
    else if (project.status() === 'ok')
      console.log(chalk.green(`[kubik] Succeeded ${chalk.bold(project.name())} in ${chalk.bold(timeInSeconds(project.durationMs()))}`));
  });
  workspace.on('workspace_error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });

  // For a sequential build, pipe stdout.
  if (workspace.options().jobs === 1) {
    workspace.on('project_stdout', (project, text) => process.stdout.write(text));
    workspace.on('project_stderr', (project, text) => process.stderr.write(text));
  } else {
    const logLine = (project: Project, line: string) => console.log(`[${project.name()}] ${line}`);
    workspace.on('project_stderr', (project, text) => {
      for (const line of text.trim().split('\n'))
        logLine(project, line);
    });

    workspace.on('project_stdout', (project, text) => {
      for (const line of text.trim().split('\n'))
        logLine(project, line);
    });
  }
}
