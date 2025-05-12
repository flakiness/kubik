#!/usr/bin/env node

import chalk, { supportsColor } from "chalk";
import { Option, program } from "commander";
import path from "path";
import { AbsolutePath } from "./configLoader.js";
import { startWatchApp } from "./ui.js";
import { timeInSeconds } from "./utils.js";
import { Project, Workspace } from "./workspace.js";

program
  .description('Start build')
  .addOption(new Option(`-j, --jobs <number>`, `Allow N jobs at once; infinite jobs with no arg.`).argParser(parseInt))
  .option('-w, --watch', 'Watch files for changes')
  .option('-e, --env-file <env file>', 'Use environment file for all tasks')
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
  workspace.on('project_added', project => {
    project.on('build_status_changed', () => {
      if (project.status() === 'fail')
        console.log(chalk.red(`[kubik] Failed ${chalk.bold(project.name())} in ${chalk.bold(timeInSeconds(project.durationMs()))}`));
      else if (project.status() === 'ok')
        console.log(chalk.green(`[kubik] Succeeded ${chalk.bold(project.name())} in ${chalk.bold(timeInSeconds(project.durationMs()))}`));
      else if (project.status() === 'running')
        console.log(chalk.yellow(`[kubik] Starting ${chalk.bold(project.name())}...`));
    });
    // For a sequential build, pipe stdout.
    if (workspace.options().jobs === 1) {
      project.on('build_stdout', (text) => process.stdout.write(text));
      project.on('build_stderr', (text) => process.stderr.write(text));
    } else {
      const logLine = (project: Project, line: string) => console.log(`[${project.name()}] ${line}`);
      project.on('build_stderr', (text) => {
        for (const line of text.trim().split('\n'))
          logLine(project, line);
      });

      project.on('build_stdout', (text) => {
        for (const line of text.trim().split('\n'))
          logLine(project, line);
      });
    }
  })
  workspace.on('workspace_status_changed', () => {
    if (workspace.workspaceStatus() === 'error') {
      console.error(workspace.workspaceError());
      process.exitCode = 1;
    } else if (workspace.workspaceStatus() === 'fail') {
      process.exitCode = 1;
    }
  });
}
