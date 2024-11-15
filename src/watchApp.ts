#!/usr/bin/env node

import chalk from 'chalk';
import blessed from 'neo-blessed';
import { stripAnsi, timeInSeconds } from './utils.js';
import { Project, Workspace } from './workspace.js';

function renderProjectTitle(project: Project, isFocused: boolean = false) {
  const buildingTime = chalk.yellow(timeInSeconds(project.durationMs()));

  let status = '';
  let fillStyle = chalk.grey;
  let projectName = isFocused ? `[ ${project.name()} ]` : project.name();
  if (project.status() === 'fail') {
    status = chalk.red('FAIL') + ' ' + buildingTime;
    projectName = chalk.red(projectName);
    fillStyle = chalk.red;
  } else if (project.status() === 'ok') {
    status = chalk.green('OK') + ' ' + buildingTime;
    fillStyle = chalk.green;
  } else if (project.status() === 'n/a') {
    status = chalk.grey('N/A');
    fillStyle = chalk.grey;
  } else if (project.status() === 'pending') {
    status = chalk.yellow(`⏱ `);
    fillStyle = chalk.yellow;
  } else if (project.status() === 'running') {
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

  const middle = ' ' + projectName + ' ';
  const headerLength = stripAnsi(middle).length;
  const fillLeftLength = ((process.stdout.columns - headerLength) >> 1) - stripAnsi(left).length;
  const fillRightLength = ((process.stdout.columns - headerLength + 1) >> 1) - stripAnsi(right).length;
  return left + fillStyle(filler.repeat(fillLeftLength)) + middle + fillStyle(filler.repeat(fillRightLength)) + right;
}

class ErrorView {
  private _screen: blessed.Widgets.Screen;
  private _contentBox: blessed.Widgets.BoxElement;

  constructor(screen: blessed.Widgets.Screen) {
    this._screen = screen;
    this._contentBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
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
      mouse: true, // Enable mouse support for scrolling
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
    screen.append(this._contentBox);
  }

  setMessage(text: string) {
    this._contentBox.setContent(text);
  }

  focus() {
    this._contentBox.focus();
  }

  dispose() {
    this._screen.remove(this._contentBox);
  }
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
      width: '100%',
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
      mouse: true, // Enable mouse support for scrolling
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

  isStickToBottom() {
    return this._contentBox.getScrollHeight() <= this._height || this._contentBox.getScrollPerc() === 100;
  }

  scrollToBottom() {
    this._contentBox.setScrollPerc(100);
  }

  setScroll(line: number) {
    this._contentBox.setScroll(line);
  }

  setProject(project: Project) {
    this._project = project;
    this._titleBox.setContent(renderProjectTitle(project, this.isFocused()));
    this._contentBox.setContent(project.output().trim());
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

let gDebug: ((...msg: string[]) => void)|undefined;
export function dbgWatchApp(...msg: string[]) {
  gDebug?.call(null, ...msg);
}

class Layout {
  private _screen: blessed.Widgets.Screen;
  private _views: ProjectView[] = [];
  private _errorView?: ErrorView;
  private _projects: Project[] = [];
  private _workspace: Workspace;

  private _renderTimeout?: NodeJS.Timeout;

  constructor(workspace: Workspace) {
    this._workspace = workspace;
    this._screen = blessed.screen({
      smartCSR: false,
      terminal: 'tmux-256color',
      debug: true,
    });
    gDebug = this._screen.debug.bind(this._screen);

    workspace.on('changed', () => this.render());
    workspace.on('project_finished', project => {
      if (project.status() !== 'fail')
        return;
      const index = this._projects.indexOf(project);
      const view = this._views[index];
      view.setScroll(0);
    });

    this._screen.key(['tab'], (ch, key) => {
      const focusedIndex = this._views.findIndex(view => view.isFocused());
      const newFocused = (focusedIndex + 1) % (this._views.length);
      if (focusedIndex !== -1)
        this._views[focusedIndex].blur();
      this._views[newFocused].focus();
      this.render();
    });

    this._screen.key(['S-tab'], (ch, key) => {
      const focusedIndex = this._views.findIndex(view => view.isFocused());
      const newFocused = (focusedIndex - 1 + this._views.length) % (this._views.length);
      if (focusedIndex !== -1)
        this._views[focusedIndex].blur();
      this._views[newFocused].focus();
      this.render();
    });

    // Quit on Escape, q, or Control-C.
    this._screen.key(['escape', 'q', 'C-c'], (ch, key) => {
      this._workspace.stop();
      this._screen.destroy();
    });

    this.render();
  }

  render() {
    if (this._renderTimeout)
      return;
    this._renderTimeout = setTimeout(this._doRender.bind(this), 0);
  }

  private _doRender() {
    this._renderTimeout = undefined;
    const workspaceError = this._workspace.workspaceError();
    if (workspaceError) {
      // Dispose all project views.
      while (this._views.length > 0)
        this._views.pop()?.dispose();
      if (!this._errorView)
        this._errorView = new ErrorView(this._screen);
      this._errorView.setMessage(workspaceError);
      this._screen.render();
      return;
    }
    this._errorView?.dispose();
    this._errorView = undefined;

    this._projects = this._workspace.topsortProjects();
    // Make sure we have enough views to cover the projects and associate them.
    while (this._views.length > this._projects.length)
      this._views.pop()?.dispose();
    while (this._views.length < this._projects.length)
      this._views.push(new ProjectView(this._screen));

    const stickedToBottom = new Set<ProjectView>(this._views.filter(view => view.isStickToBottom()));

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
      const scrollingFailingViews = scrollingViews.filter(view => view.project()?.status() === 'fail');
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

    for (const view of stickedToBottom) {
      if (view.project()?.status() !== 'fail')
        view.scrollToBottom();
    }

    this._screen.render();
  }
}

export function startWatchApp(workspace: Workspace) {
  const layout = new Layout(workspace);
  process.stdout.on('resize', () => layout.render());
}
