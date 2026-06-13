#!/usr/bin/env node

import chalk, { supportsColor } from "chalk";
import { Option, program } from "commander";
import path from "path";
import { AbsolutePath } from "./configLoader.js";
import { tryDelegateRun } from "./daemonClient.js";
import { startDaemonServer } from "./daemonServer.js";
import { startWatchApp } from "./tui.js";
import { timeInSeconds } from "./utils.js";
import { Project, Workspace } from "./workspace.js";

program
  .description('Start build')
  .addOption(new Option(`-j, --jobs <number>`, `Allow N jobs at once; infinite jobs with no arg.`).argParser(parseInt))
  .option('-w, --watch', 'Watch files for changes')
  .option('-e, --env-file <env file>', 'Use environment file for all tasks')
  .option('--fresh', 'When running via a watchdog, restart the tasks and all their dependencies')
  .option('--no-daemon', 'Do not delegate the build to a running watchdog')
  .arguments('<files...>')
  .action(async (files: string[], options: { jobs?: number, envFile?: string, watch?: boolean, fresh?: boolean, daemon?: boolean }) => {
    const roots = files.map(file => path.resolve(process.cwd(), file)) as AbsolutePath[];

    // When a watchdog already watches these tasks, force-restart them there
    // and stream the results instead of building a second time.
    if (!options.watch && options.daemon !== false) {
      const ignoredFlags: string[] = [];
      if (options.jobs !== undefined)
        ignoredFlags.push('--jobs');
      if (options.envFile)
        ignoredFlags.push('--env-file');
      const exitCode = await tryDelegateRun(roots, { fresh: !!options.fresh, ignoredFlags });
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
        return;
      }
    }

    const workspace = new Workspace({
      roots,
      jobs: options.jobs ?? Infinity,
      nodeOptions: {
        envFile: options.envFile ? path.resolve(process.cwd(), options.envFile) as AbsolutePath : undefined,
        forceColors: !!supportsColor,
      },
      watchMode: options.watch ?? false,
    });
    if (options.watch) {
      if (options.daemon !== false) {
        await startDaemonServer(workspace).catch(e => {
          console.error(chalk.red(`[kubik] Failed to start watchdog server: ${e instanceof Error ? e.message : e}`));
        });
      }
      if (process.stdout.isTTY)
        startWatchApp(workspace);
      else
        cliLogger(workspace);
    } else {
      cliLogger(workspace);
    }
  });

await program.parseAsync();

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
