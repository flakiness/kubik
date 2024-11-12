#!/usr/bin/env node

import blessed from 'neo-blessed';
import { AbsolutePath } from './configLoader.js';

import chalk from 'chalk';
import { stripAnsi } from './utils.js';
import { Project, Workspace } from './workspace.js';

export const FILLER = '░';
export const FILLER_2 = '█';

export function renderSectionTitle({ left = '', middle = '', right = '', filler = FILLER, width = process.stdout.columns, fillStyle = (a: string) => a, }) {
  const headerLength = stripAnsi(middle).length;

  const fillLeftLength = ((process.stdout.columns - headerLength) >> 1) - stripAnsi(left).length;
  const fillRightLength = ((process.stdout.columns - headerLength + 1) >> 1) - stripAnsi(right).length;
  return left + fillStyle(filler.repeat(fillLeftLength)) + middle + fillStyle(filler.repeat(fillRightLength)) + right;
}

function timeInSeconds(ms: number) {
  return parseFloat((ms / 1000).toFixed(1)).toFixed(1) + 's';
}

function renderProjectTitle(project: Project, isFocused: boolean = false) {
  const buildingTime = chalk.yellow(timeInSeconds(project.durationMs));

  let status = '';
  let fillStyle = chalk.grey;
  let projectName = isFocused ? `[ ${project.name} ]` : project.name;
  if (project.status === 'fail') {
    status = chalk.red('FAIL') + ' ' + buildingTime;
    projectName = chalk.red(projectName);
    fillStyle = chalk.red;
  } else if (project.status === 'ok') {
    status = chalk.green('OK') + ' ' + buildingTime;
    fillStyle = chalk.green;
  } else if (project.status === 'n/a') {
    status = chalk.grey('N/A');
    fillStyle = chalk.grey;
  } else if (project.status === 'pending') {
    status = chalk.yellow(`⏱ ${'<unknown>'}`);
    fillStyle = chalk.yellow;
  } else if (project.status === 'running') {
    status = chalk.yellow(`Building...`);
    fillStyle = chalk.yellow;
  }

  let left = '';
  let right = ' ' + status + ' ';
  let filler = '─';
  if (isFocused) {
    filler = '■';
    right = fillStyle(isFocused ? ' j, k, Space ' : '');
  }

  return renderSectionTitle({
    left,
    right,
    middle: ' ' + projectName + ' ',
    fillStyle,
    filler,
  });
}

class ProjectView {
  private _screen: blessed.Widgets.Screen;
  private _titleBox: blessed.Widgets.BoxElement;
  private _contentBox: blessed.Widgets.BoxElement;
  private _height = 0;
  private _project?: Project;

  constructor(screen: blessed.Widgets.Screen) {
    this._screen = screen;
    this._titleBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: false,
      focusable: true,
    });
    this._contentBox = blessed.box({
      top: 0,
      left: 0,
      width: process.stdout.columns,
      height: '50%',
      content: '',
      scrollbar: {
        ch: ' ',
        style: {
          bg: 'white',
        },
        track: {
          bg: 'grey',
        }
      },
      keys: true, // Enable keyboard navigation
      vi: true, // Use vi-style keys for navigation
      mouse: false, // Enable mouse support for scrolling
      _border: {
        type: 'line',
        left: true,
        top: false,
        right: false,
        bottom: false
      },
      scrollable: true,
      alwaysScroll: true,
      tags: false,
      _style: {
        _focus: {
          _border: {
            fg: 'yellow',
            type: 'line'
          },
        },
      },
    });
    screen.append(this._titleBox);
    screen.append(this._contentBox);
  }

  setHeight(height: number) {
    this._height = height;
    this._contentBox.height = height - 1;
  }

  getHeight() { return this._height; }

  requiredHeight() {
    const lines = this._contentBox.getLines();
    if (lines.length === 1 && lines[0].trim() === '')
      return 1;
    return lines.length + 1;
  }

  setTop(y: number) {
    this._titleBox.top = y;
    this._contentBox.top = y + 1;
  }

  setProject(project: Project) {
    this._project = project;
    this._titleBox.setContent(renderProjectTitle(project, this.isFocused()));
    this._contentBox.setContent(project.output.trim());
  }

  project() {
    return this._project;
  }

  focus() {
    this._contentBox.focus();
    if (this._project)
      this._titleBox.setContent(renderProjectTitle(this._project, this.isFocused()));
  }
  
  blur() {
    this._titleBox.focus();
  }

  isFocused() {
    return this._screen.focused === this._contentBox;
  }

  dispose() {
    this._screen.remove(this._contentBox);
    this._screen.remove(this._titleBox);
  }
}

class Layout {
  private _screen: blessed.Widgets.Screen;
  private _views: ProjectView[] = [];
  private _projects: Project[] = [];
  private _workspace: Workspace;

  constructor(workspace: Workspace) {
    this._workspace = workspace;
    this._screen = blessed.screen({
      smartCSR: true,
    });

    workspace.on('changed', () => this.render());

    this._screen.key(['tab'], (ch, key) => {
      const focusedIndex = this._views.findIndex(view => view.isFocused());
      const newFocused = (focusedIndex + 1) % (this._views.length);
      if (focusedIndex !== -1)
        this._views[focusedIndex].blur();
      this._views[newFocused].focus();
      this.render();
      // ????
      // const allFailingViews = this._views.filter(view => view.project().buildResult() === 'FAIL' && view.project().buildStage() === 'DONE');
      // const focusedIndex = allFailingViews.findIndex(view => view.isFocused());
      // if (focusedIndex === -1)
      //   return;
      // allFailingViews[(focusedIndex + 1) % allFailingViews.length].focus();
      // this.render();
    });
    // Quit on Escape, q, or Control-C.
    this._screen.key(['escape', 'q', 'C-c'], (ch, key) => {
      this._workspace.stop();
      this._screen.destroy();
    });

    this.render();
  }

  render() {
    this._projects = this._workspace.projects();
    // Make sure we have enough views to cover the projects and associate them.
    while (this._views.length > this._projects.length)
      this._views.pop()?.dispose();
    while (this._views.length < this._projects.length)
      this._views.push(new ProjectView(this._screen));
    this._projects.forEach((project, index) => this._views[index].setProject(project));

    // do layout
    const height = process.stdout.rows;
    const N = this._views.length;
    const eachHeight = (height / N)|0;

    let heightLeftover = height;
    for (const view of this._views) {
      const actualHeight = Math.min(view.requiredHeight(), eachHeight);
      view.setHeight(actualHeight);
      heightLeftover -= actualHeight;
    }

    while (heightLeftover > 0) {
      const scrollingViews = this._views.filter(view => view.requiredHeight() > view.getHeight());
      const scrollingFailingViews = scrollingViews.filter(view => view.project()?.status === 'fail');
      const views = scrollingFailingViews.length ? scrollingFailingViews : scrollingViews;

      if (views.length === 0)
        break;
      for (const view of views) {
        if (heightLeftover === 0)
          break;
        view.setHeight(view.getHeight() + 1);
        --heightLeftover;
      }
    }

    // stack
    let y = 0;
    for (const view of this._views) {
      view.setTop(y);
      y += view.getHeight();
    }

    this._screen.render();
  }
}

export function startWatchApp(roots: AbsolutePath[], jobs: number) {
  const workspace = new Workspace({
    jobs,
    watchMode: true,
  });

  workspace.setRoots(roots);
  const layout = new Layout(workspace);
  process.stdout.on('resize', () => layout.render());
}