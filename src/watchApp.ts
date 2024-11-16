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
    right = '';
  }

  const middle = ' ' + projectName + ' ';
  const headerLength = stripAnsi(middle).length;
  const fillLeftLength = ((process.stdout.columns - headerLength) >> 1) - stripAnsi(left).length;
  const fillRightLength = ((process.stdout.columns - headerLength + 1) >> 1) - stripAnsi(right).length;
  return left + fillStyle(filler.repeat(fillLeftLength)) + middle + fillStyle(filler.repeat(fillRightLength)) + right;
}

class ProjectView {
  private _titleBox: blessed.Widgets.BoxElement;
  private _contentBox: blessed.Widgets.BoxElement;
  private _height = 0;
  private _project: Project;
  private _layout: Layout;

  constructor(layout: Layout, parent: blessed.Widgets.BoxElement, project: Project) {
    this._layout = layout;
    this._project = project;
    this._titleBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: false,
    });

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
      scrollable: true,
      alwaysScroll: true,
    });
    this._contentBox.on('click', () => this.focus());

    parent.append(this._titleBox);
    parent.append(this._contentBox);

    project.on('build_status_changed', this._onStatusChanged.bind(this));
    project.on('build_stdout', this._onStdIO.bind(this));
    project.on('build_stderr', this._onStdIO.bind(this));
  }

  private _onStdIO() {
    const scroll = this.getScrollPosition();
    this._contentBox.setContent(this._project.output().trim());
    this.setScrollPosition(scroll);
    this._layout.render();
  }

  private _onStatusChanged() {
    // Scroll failed project output to top.
    if (this._project.status() === 'fail') {
      this._contentBox.setScroll(0);
      // If current focus is not a "failing" project, then focus the failing project.
      if (this._layout.focusedProjectView()?.project().status() !== 'fail')
        this.focus();
    }

    // When project changes status, it might refresh its output.
    this._onStdIO();
  }

  // This is called from layout's render.
  public renderTitle() {
    this._titleBox.setContent(renderProjectTitle(this._project, this.isFocused()));
  }

  setHeight(height: number) {
    this._height = height;
    this._contentBox.height = height - 1;
  }

  getScrollPosition() {
    const isStickToBottom = this._project.status() !== 'fail' && (this._contentBox.getScrollHeight() <= this._height || this._contentBox.getScrollPerc() >= 100);
    return isStickToBottom ? -1 : this._contentBox.getScroll();
  }

  setScrollPosition(position: number) {
    this._contentBox.setScroll(0);
    if (position === -1) {
      this._contentBox.setScrollPerc(100);  
    } else {
      this._contentBox.setScroll(position);  
    }
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

  project() {
    return this._project;
  }

  isFocused() {
    return this._layout.screen().focused === this._contentBox;
  }

  focus() {
    this._contentBox.focus();
    this._layout.render();
  }

  dispose() {
    this._contentBox.detach();
    this._titleBox.detach();
  }
}

let gDebug: ((...msg: string[]) => void)|undefined;
export function dbgWatchApp(...msg: any[]) {
  gDebug?.call(null, ...(msg.map(msg => String(msg))));
}

class Layout {
  private _screen: blessed.Widgets.Screen;
  private _projectToView = new Map<Project, ProjectView>();
  private _errorView: blessed.Widgets.BoxElement;
  private _workspace: Workspace;
  private _projectsContainer: blessed.Widgets.BoxElement; 

  private _renderTimeout?: NodeJS.Timeout;

  constructor(workspace: Workspace) {
    this._workspace = workspace;
    this._screen = blessed.screen({
      smartCSR: false,
      terminal: 'tmux-256color',
      debug: true,
      title: 'Tab Navigation Example',
    });
    this._projectsContainer = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
    });
    this._screen.append(this._projectsContainer);
    this._errorView = blessed.box({
      top: '25%',
      left: '25%',
      width: '50%',
      height: '50%',
      content: '',
      border: {
        type: 'line',
      },
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
      scrollable: true,
      alwaysScroll: true,
      tags: false,
    });
    this._screen.append(this._errorView);

    gDebug = this._screen.debug.bind(this._screen);

    workspace.on('project_added', project => {
      const view = new ProjectView(this, this._projectsContainer, project);
      this._projectToView.set(project, view);
      this.render();
    });

    workspace.on('project_removed', project => {
      const view = this._projectToView.get(project);
      view?.dispose();
      this._projectToView.delete(project);
      this.render();
    });

    workspace.on('workspace_status_changed', () => this.render());

    this._screen.key(['tab'], (ch, key) => this._moveFocus(1));
    this._screen.key(['S-tab'], (ch, key) => this._moveFocus(-1));
    this._screen.key(['escape', 'q', 'C-c'], (ch, key) => this.stop());
    this.render();
  }

  focusedProjectView(): ProjectView|undefined {
    return [...this._projectToView.values()].find(view => view.isFocused());
  }

  private _moveFocus(direction: 1|-1) {
    const views = this._sortedProjectsViews();
    const focusedIndex = views.findIndex(view => view.isFocused());
    const newFocused = (focusedIndex + direction + views.length) % (views.length);
    views[newFocused].focus();
    this.render();
  }

  stop() {
    this._workspace.stop();
    this._screen.destroy();
  }

  debugAndExit(...args: any) {
    this.stop();
    console.log(...args);
  }

  screen() { return this._screen; }

  render() {
    if (this._renderTimeout)
      return;
    this._renderTimeout = setTimeout(this._doRender.bind(this), 0);
  }

  private _sortedProjectsViews() {
    const projects = this._workspace.topsortProjects();
    return projects.map(project => this._projectToView.get(project)!);
  }

  private _doRender() {
    this._renderTimeout = undefined;

    const workspaceError = this._workspace.workspaceError();
    if (workspaceError) {
      this._errorView.setContent(workspaceError);
      this._errorView.show();
    } else {
      this._errorView.hide();
    }

    const projectViews = this._sortedProjectsViews();
    
    for (const projectView of projectViews)
      projectView.renderTitle();

    const positions = projectViews.map(view => view.getScrollPosition());

    // do layout
    const height = process.stdout.rows;
    const N = projectViews.length;
    const eachHeight = (height / N)|0;

    let heightLeftover = height;
    for (const view of projectViews) {
      const actualHeight = Math.min(view.requiredHeight(), eachHeight);
      view.setHeight(actualHeight);
      heightLeftover -= actualHeight;
    }

    while (heightLeftover > 0) {
      const scrollingViews = projectViews.filter(view => view.requiredHeight() > view.getHeight());
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
    for (const projectView of projectViews) {
      projectView.setTop(y);
      y += projectView.getHeight();
    }

    positions.map((position, index) => {
      const view = projectViews[index];
      view.setScrollPosition(position);
    });

    this._screen.render();
  }
}

export function startWatchApp(workspace: Workspace) {
  const layout = new Layout(workspace);
  process.stdout.on('resize', () => layout.render());
}
