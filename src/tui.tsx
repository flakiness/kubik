import chalk from 'chalk'; // For easily generating ANSI sequences in the mock data
import fs from 'fs';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import path from 'path';
import React, { JSX, useEffect, useState } from 'react';
import { ansi2ink } from './ansi2ink.js';
import { TaskStatus } from './taskTree.js';
import { Project, Workspace } from './workspace.js';

const getStatusColor = (status: TaskStatus) => {
  switch (status) {
    case 'running': return 'yellow';
    case 'ok': return 'green';
    case 'fail': return 'red';
    default: return 'gray';
  }
};

const getStatusIndicator = (status: TaskStatus) => {
  switch (status) {
    case 'running': return chalk.yellow('●'); // Or use spinners if you add ink-spinner
    case 'ok': return chalk.green('✓');
    case 'fail': return chalk.red('x');
    default: return chalk.gray('○');
  }
};

const packageJSON = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8'));

const HELP = `
${chalk.bold('TUI Shortcuts')}
  ${chalk.yellow('n / p')}       select next / previous task
  ${chalk.yellow('N / P')}       select last / first task
  ${chalk.yellow('j / k')}       scroll up / down 1 line
  ${chalk.yellow('C-u / C-d')}   scroll up / down half a screen
  ${chalk.yellow('g / G')}       scroll to top / bottom
  ${chalk.yellow('r')}           restart a task and all its dependencies
  ${chalk.yellow('s')}           save current task output to ./kubikstdoutstderr
  ${chalk.yellow('z')}           toggle tasks sidebar pane
  ${chalk.yellow('c')}           toggle project configuration introspection
  ${chalk.yellow('?')}           toggle help

Kubik's version is ${chalk.yellow(`v${packageJSON.version}`)}
Kubik's home is at ${chalk.bold(chalk.underline('https://github.com/flakiness/kubik'))} - come visit!
`;

function renderScrollBar(options: {
  scrollTop: number,
  scrollHeight: number,
  height: number,
  fgColor: string,
  bgColor: string,
}): JSX.Element|undefined {
  const BORDER = '│';
  const height = options.height;
  if (options.scrollHeight <= height)
    return undefined;

  const thumbHeight = Math.max(Math.floor((height / options.scrollHeight) * height), 1);
  let prefix = Math.floor(options.scrollTop / options.scrollHeight * height);
  let suffix = height - thumbHeight - prefix;
  if (options.scrollHeight <= options.scrollTop + height) {
    suffix = 0;
    prefix = height - thumbHeight;
  } else if (prefix + thumbHeight >= height) {
    suffix = 0;
    prefix = height - thumbHeight;
  }

  const prefixText = prefix > 0 ? BORDER.repeat(prefix) : '';
  const suffixText = suffix > 0 ? BORDER.repeat(suffix) : '';

  return <Text>
    <Text color={options.bgColor}>{prefixText.split('').join('\n')}</Text>
    <Text color={options.fgColor}>{'▐'.repeat(thumbHeight).split('').join('\n')}</Text>
    <Text color={options.bgColor}>{suffixText.split('').join('\n')}</Text>
  </Text>;
}

const Header: React.FC<{ text: string, width: number, color: string, }> = ({ width, text, color }) => {
  return <Box flexShrink={0}>
    <Text inverse={true} color={color}>{text.padEnd(width, ' ')}</Text>
  </Box>
}

const ScrollableBox: React.FC<{ text: string, width: number, height: number }> = ({ width, height, text }) => {
  const [scrollTop, setScrollTop] = useState<number|undefined>(undefined);
  const allLines = ansi2ink(text, width - 1);

  const normalizeScrollLine = (firstLineNumber: number) => {
    if (firstLineNumber < 0)
      firstLineNumber = 0;
    if (allLines.length <= height)
      return undefined;
    if (firstLineNumber + height >= allLines.length)
      return undefined;
    return firstLineNumber;
  }

  const firstVisibleLineIndex = scrollTop ?? Math.max(allLines.length - height, 0);
  const lines = allLines.slice(firstVisibleLineIndex, firstVisibleLineIndex + height);

  // --- Input Handling ---
  useInput((input, key) => {
    if (input === 'g') {
      setScrollTop(normalizeScrollLine(0));
    } else if (input === 'G') {
      setScrollTop(normalizeScrollLine(allLines.length));
    } else if ((input === 'u' && key.ctrl) || (key.shift && input === ' ')) {
      setScrollTop(normalizeScrollLine(firstVisibleLineIndex - (height >> 1)));
    } else if ((input === 'd' && key.ctrl) || (!key.shift && input === ' ')) {
      setScrollTop(normalizeScrollLine(firstVisibleLineIndex + (height >> 1)));
    } else if (input === 'k' || key.upArrow) {
      setScrollTop(normalizeScrollLine(firstVisibleLineIndex - 1));
    } else if (input === 'j' || key.downArrow) {
      setScrollTop(normalizeScrollLine(firstVisibleLineIndex + 1));
    }
  });

  return <Box flexDirection="row">
    <Box flexGrow={1}>
      <Text>{lines}</Text>
    </Box>
    <Box overflow="hidden" height="100%" width={1}>
      {renderScrollBar({
        height,
        scrollHeight: allLines.length,
        scrollTop: firstVisibleLineIndex,
        bgColor: 'gray',
        fgColor: 'gray',
      })}
    </Box>
  </Box>
}

const App: React.FC<{ workspace: Workspace }> = ({ workspace }) => {
  // Force re-render
  const [,setTick] = useState<number>(0);
  const [showTasks, setShowTasks] = useState<boolean>(true);
  const [mode, setMode] = useState<'stdio'|'help'|'config'>('stdio');
  const [projects, setProjects] = useState<Project[]>(workspace.bfsProjects());
  const [selectedTaskIndex, setSelectedTaskIndex] = useState<number>(0);

  const { exit } = useApp();
  const { stdout } = useStdout();

  const [terminalHeight, setTerminalHeight] = useState<number>(stdout.rows);
  const [terminalWidth, setTerminalWidth] = useState<number>(stdout.columns);

  const selectedProject = projects.at(selectedTaskIndex);

  useEffect(() => {
    stdout.on('resize', () => {
      setTerminalHeight(stdout.rows);
      setTerminalWidth(stdout.columns);
    });
    workspace.on('project_added', project => {
      project.on('build_status_changed', () => setProjects(workspace.bfsProjects()));
      project.on('build_stdout', () => {
        setTick(Date.now());
      });
      project.on('build_stderr', () => {
        setTick(Date.now());
      });
    });
    workspace.on('projects_changed', () => setProjects(workspace.bfsProjects()));
    workspace.on('workspace_status_changed', () => {});
  }, []);

  // A bit of layout computation
  const maxProjectWidth = Math.max(...projects.map(p => p.name().length), 0);
  const maxWidth = Math.round(terminalWidth * 0.5);
  const taskListWidth = showTasks ? Math.max(Math.min(maxProjectWidth + 5, maxWidth), 10) : 0;
  const outputWidth = terminalWidth - taskListWidth;

  // --- Input Handling ---
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (input === 'z') {
      setShowTasks(!showTasks);
    } else if (input === '?') {
      setMode(mode === 'help' ? 'stdio' : 'help');
    } else if (input === 'c') {
      setMode(mode === 'config' ? 'stdio' : 'config');
    } else if (input === 's') {
      fs.writeFileSync('./kubikstdoutstderr', selectedProject?.output() ?? '', 'utf8');
    } else if (input === 'r' && selectedProject) {
      workspace.scheduleUpdate(selectedProject);
    } else if (input === 'p' || (key.tab && key.shift)) {
      setSelectedTaskIndex((selectedTaskIndex - 1 + projects.length) % projects.length);
      mode === 'help' && setMode('stdio');
    } else if (input === 'P') {
      setSelectedTaskIndex(0);
      mode === 'help' && setMode('stdio');
    } else if (input === 'n' || key.tab) {
      setSelectedTaskIndex((selectedTaskIndex + 1 + projects.length) % projects.length);
      mode === 'help' && setMode('stdio');
    } else if (input === 'N') {
      setSelectedTaskIndex(projects.length - 1);
      mode === 'help' && setMode('stdio');
    }
  });

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight}>
      {showTasks ?
        <Box
          flexDirection="column"
          flexShrink={0}
          width={taskListWidth}
          height="100%"
          borderStyle="single"
          borderRight={true}
          borderTop={false}
          borderColor={'gray'}
          borderBottom={false}
          borderLeft={false}
        >
          <Text bold underline>Tasks</Text>
          {projects.map((project, index) => (
            <Text key={project.id()} color={getStatusColor(project.status())} inverse={selectedTaskIndex === index && mode !== 'help'}>
              <Text> {getStatusIndicator(project.status())} </Text>
              <Text wrap={'truncate-start'}>{project.name()} </Text>
            </Text>
          ))}
          <Box flexGrow={1}></Box>
          <Text inverse={mode === 'help'}> ? Help </Text>
        </Box>
      : undefined}

      <Box
        flexDirection="column"
        flexShrink={0}
        height='100%'
        width={outputWidth}
        overflow="hidden"
      >
        {mode === 'stdio' && selectedProject ? 
          <Header
            color={getStatusColor(selectedProject.status())}
            width={outputWidth}
            text={`${selectedProject.name()}${selectedProject.durationMs() > 0 ? ' - ' + humanReadableMs(selectedProject.durationMs()) : ''}`}
          ></Header>
        : mode === 'help' ? <Header
            color='white'
            width={outputWidth}
            text='Kubik Help'
          ></Header>
        : mode === 'config' && selectedProject ? <Header
            color='white'
            width={outputWidth}
            text={`Active Configuration`}
          ></Header> : undefined
        }
        <ScrollableBox
          key={selectedProject?.id()}
          width={outputWidth - 1}
          height={terminalHeight - 1}
          text={
            mode === 'help' ? HELP :
            mode === 'stdio' ? selectedProject?.output() ?? '' :
            mode === 'config' ? renderProjectConfig(workspace, selectedProject) : ''
          }
        ></ScrollableBox>
      </Box>
    </Box>
  );
};

function renderProjectConfig(workspace: Workspace, project?: Project) {
  if (!project)
    return '';
  const deps = workspace.directDependencies(project);
  const isADepOf = workspace.directDependants(project);
  return `
name: ${chalk.yellow(project.name())}
path: ${chalk.yellow(path.relative(process.cwd(), project.configPath()))}

${chalk.bold(`Direct Dependencies: ${deps.length}`)}
${deps.map(dep => `* ${dep.name()}`).join('\n')}

${chalk.bold(`Direct Dependants: ${isADepOf.length}`)}
${isADepOf.map(dep => `* ${dep.name()}`).join('\n')}

${chalk.bold(`watched paths: ${project.introspectWatchPaths().length}`)}
${project.introspectWatchPaths().map(p => `+ ${path.relative(process.cwd(), p)}`).join('\n')}

${chalk.bold(`ignored paths: ${project.introspectIgnorePaths().length}`)}
${project.introspectIgnorePaths().map(p => `- ${path.relative(process.cwd(), p)}`).join('\n')}

`;

}

export function startWatchApp(workspace: Workspace) {
  // Enter alternative buffer.
  process.stdout.write('\x1b[?1049h');
  const instance = render(<App workspace={workspace}/>, {
    exitOnCtrlC: true,
  });
  instance.waitUntilExit().then(() => {
    process.stdout.write('\x1b[?1049l');
    workspace.stop();
  });
}

export function humanReadableMs(ms: number | { valueOf(): number }): string {
  let seconds = ((+ms) / 1000)|0;
  if (seconds < 1)
    return `${ms}ms`;
  let minutes = (seconds / 60)|0;
  seconds = seconds % 60;
  if (minutes < 1)
    return `${seconds}s`;
  const hours = (minutes / 60)|0;
  minutes = minutes % 60;
  if (hours < 1)
    return seconds !== 0 ? `${minutes}min ${seconds}s` : `${minutes}min`;
  return `${hours}h ${minutes}min`;
}
