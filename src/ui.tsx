import chalk from 'chalk'; // For easily generating ANSI sequences in the mock data
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import React, { JSX, useEffect, useState } from 'react';
import { ansi2ink } from './ansi2ink.js';
import { TaskStatus } from './taskTree.js';
import { Project, Workspace } from './workspace.js';
import fs from 'fs';

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
    case 'fail': return chalk.red('-');
    default: return chalk.gray('○');
  }
};

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

const App: React.FC<{ workspace: Workspace }> = ({ workspace }) => {
  // Force re-render
  const [,setTick] = useState<number>(0);

  const [showTasks, setShowTasks] = useState<boolean>(true);

  const [projects, setProjects] = useState<Project[]>(workspace.topsortProjects());
  const [projectScroll, setProjectScroll] = useState<number|undefined>(undefined);

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
      project.on('build_status_changed', () => setProjects(workspace.topsortProjects()));
      project.on('build_stdout', () => {
        setTick(Date.now());
      });
      project.on('build_stderr', () => {
        setTick(Date.now());
      });
    });
    workspace.on('projects_changed', () => setProjects(workspace.topsortProjects()));
    workspace.on('workspace_status_changed', () => {});
  }, []);

  // A bit of layout computation
  const maxProjectWidth = Math.max(...projects.map(p => p.name().length), 0);
  const maxWidth = Math.round(terminalWidth * 0.5);
  const taskListWidth = showTasks ? Math.max(Math.min(maxProjectWidth + 5, maxWidth), 10) : 0;
  const outputWidth = terminalWidth - taskListWidth;

  // -1 for title
  const projectOutputHeight = terminalHeight - 1;
  // -2 for left border + scrollbar
  const allLines = ansi2ink(selectedProject?.output() ?? '', outputWidth - 2);

  const firstVisibleLineIndex = projectScroll ?? Math.max(allLines.length - projectOutputHeight, 0);
  const lines = allLines.slice(firstVisibleLineIndex, firstVisibleLineIndex + projectOutputHeight);

  const normalizeScrollLine = (firstLineNumber: number) => {
    if (firstLineNumber < 0)
      firstLineNumber = 0;
    if (allLines.length <= projectOutputHeight)
      return undefined;
    if (firstLineNumber + projectOutputHeight >= allLines.length)
      return undefined;
    return firstLineNumber;
  }

  // --- Input Handling ---
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (input === 'z') {
      setShowTasks(!showTasks);
    } else if (input === 's') {
      fs.writeFileSync('./kubikstdoutstderr', selectedProject?.output() ?? '', 'utf8');
    } else if (input === 'r' && selectedProject) {
      workspace.scheduleUpdate(selectedProject);
    } else if (input === 'p' || (key.tab && key.shift)) {
      setSelectedTaskIndex((selectedTaskIndex - 1 + projects.length) % projects.length);
      setProjectScroll(undefined);
    } else if (input === 'P') {
      setSelectedTaskIndex(0);
      setProjectScroll(undefined);
    } else if (input === 'n' || key.tab) {
      setSelectedTaskIndex((selectedTaskIndex + 1 + projects.length) % projects.length);
      setProjectScroll(undefined);
    } else if (input === 'N') {
      setSelectedTaskIndex(projects.length - 1);
      setProjectScroll(undefined);
    } else if (input === 'g') {
      setProjectScroll(normalizeScrollLine(0));
    } else if (input === 'G') {
      setProjectScroll(normalizeScrollLine(allLines.length));
    } else if ((input === 'u' && key.ctrl) || (key.shift && input === ' ')) {
      setProjectScroll(normalizeScrollLine(firstVisibleLineIndex - (projectOutputHeight >> 1)));
    } else if ((input === 'd' && key.ctrl) || (!key.shift && input === ' ')) {
      setProjectScroll(normalizeScrollLine(firstVisibleLineIndex + (projectOutputHeight >> 1)));
    } else if (input === 'k' || key.upArrow) {
      setProjectScroll(normalizeScrollLine(firstVisibleLineIndex - 1));
      // Scroll up
    } else if (input === 'j' || key.downArrow) {
      // Scroll down
      setProjectScroll(normalizeScrollLine(firstVisibleLineIndex + 1));
    }
  });

  let selectedTitle = '';
  if (selectedProject) {
    selectedTitle = `${selectedProject.name()}${selectedProject.durationMs() > 0 ? ' – ' + humanReadableMs(selectedProject.durationMs()) : ''}`;
    selectedTitle = selectedTitle.padEnd(outputWidth, ' ');
  }

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight}>
      {showTasks ?  <Box
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
          <Text> <Text bold underline>Tasks</Text></Text>
          {projects.map((project, index) => (
            <Text key={project.id()} color={getStatusColor(project.status())} inverse={selectedTaskIndex === index}>
              <Text> {getStatusIndicator(project.status())} </Text>
              <Text wrap={'truncate-start'}>{project.name()} </Text>
            </Text>
          ))}
        </Box>
      : undefined}

      <Box
        flexDirection="column"
        flexShrink={0}
        height='100%'
        width={outputWidth}
        overflow="hidden"
      >
        {selectedProject ? 
          <Box flexShrink={0}>
            <Text inverse={true} color={getStatusColor(selectedProject.status())}>{selectedTitle}</Text>
          </Box>
        : undefined}
        <Box
          flexDirection="row"
        >
          <Box flexGrow={1}>
            <Text>{lines}</Text>
          </Box>
          <Box overflow="hidden" height="100%" width={1}>
            {renderScrollBar({
              height: terminalHeight - 1,
              scrollHeight: allLines.length,
              scrollTop: firstVisibleLineIndex,
              bgColor: 'gray',
              fgColor: 'gray',
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

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
