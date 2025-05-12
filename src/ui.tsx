import chalk from 'chalk'; // For easily generating ANSI sequences in the mock data
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
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
    case 'fail': return chalk.red('-');
    default: return chalk.gray('○');
  }
};

function renderScrollBar(options: {
  height: number,
  offset: number,
  fgColor: string,
  bgColor: string,
}): JSX.Element {
  const height = options.height - 2;
  const prefix = Math.max(Math.ceil(height * options.offset) - 1, 0);
  const suffix = height - prefix - 1; // -1 for thumb

  let prefixText = '┐';
  if (prefix > 0)
    prefixText += '│'.repeat(prefix);
  let suffixText = '';
  if (suffix > 0)
    suffixText += '│'.repeat(suffix);
  suffixText += '┘';
  return <Text>
    <Text color={options.bgColor}>{prefixText.split('').join('\n')}</Text>
    <Text color={options.fgColor}>█</Text>
    <Text color={options.bgColor}>{suffixText.split('').join('\n')}</Text>
  </Text>;
}

const App: React.FC<{ workspace: Workspace }> = ({ workspace }) => {
  // Force re-render
  const [,setTick] = useState<number>(0);

  const [projects, setProjects] = useState<Project[]>(workspace.topsortProjects());
  const [projectScroll, setProjectScroll] = useState<number|undefined>(undefined);

  const [selectedTaskIndex, setSelectedTaskIndex] = useState<number>(0);
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');

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
  const minWidth = Math.min(Math.round(terminalWidth * 0.3), 25);
  const maxWidth = Math.round(terminalWidth * 0.5);
  const taskListWidth = Math.min(Math.max(minWidth, maxProjectWidth + 6), maxWidth);
  const outputWidth = terminalWidth - taskListWidth;

  // -2 for top/bottom borders
  const projectOutputHeight = terminalHeight - 2;
  // -2 for left border + scrollbar
  const allLines = ansi2ink(selectedProject?.output() ?? '', outputWidth - 2);

  const firstVisibleLineIndex = projectScroll ?? Math.max(allLines.length - projectOutputHeight, 0);
  const lines = allLines.slice(firstVisibleLineIndex, firstVisibleLineIndex + projectOutputHeight);

  const offset = allLines.length < projectOutputHeight ? 0 : (firstVisibleLineIndex / (allLines.length - projectOutputHeight));

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
      return;
    }

    // Pane Switching
    if (input === 'h' || key.leftArrow) {
      setFocusedPane('left');
      return;
    }
    if (input === 'l' || key.rightArrow) {
      setFocusedPane('right');
      return;
    }
    if (key.tab) {
      setFocusedPane(focusedPane === 'right' ? 'left' : 'right');
      return;
    }

    // Task Selection
    if (focusedPane === 'left') {
      if (input === 'k' || key.upArrow) {
        setSelectedTaskIndex((prev) => Math.max(0, prev - 1));
        setProjectScroll(undefined);
      } else if (input === 'j' || key.downArrow) {
        setSelectedTaskIndex((prev) => Math.min(projects.length - 1, prev + 1));
        setProjectScroll(undefined);
      }
    } else if (focusedPane === 'right') { // Output scrolling
      if (input === 'g') {
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
    }
  });

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight}>
      <Box
        borderStyle="single"
        borderColor={focusedPane === 'left' ? 'lightgray' : 'gray'}
        flexDirection="column"
        flexShrink={0}
        paddingX={1}
        width={taskListWidth}
        height="100%"
      >
        <Text bold underline>Tasks</Text>
        {projects.map((project, index) => (
          <Box flexDirection='row' gap={1} key={index}>
            <Text>{getStatusIndicator(project.status())}</Text>
            <Text
              color={getStatusColor(project.status())}
              backgroundColor={index === selectedTaskIndex ? 'gray' : undefined}
              wrap={'truncate-start'}
            >{project.name()}</Text>
          </Box>
        ))}
      </Box>

      <Box
        borderStyle="single"
        borderRight={false}
        borderColor={focusedPane === 'right' ? 'lightgray' : 'gray'}
        flexDirection="row"
        height='100%'
        width={outputWidth}
        overflow="hidden"
      >
        <Text>{lines}</Text>
      </Box>

      <Box overflow="hidden" height="100%" width={1}>
        {renderScrollBar({
          height: terminalHeight,
          offset,
          bgColor: focusedPane === 'right' ? 'lightgray' : 'gray',
          fgColor: focusedPane === 'right' ? 'lightgray' : 'gray',
        })}
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
  /*
  withFullScreen(<App workspace={workspace}/>, {
    exitOnCtrlC: true,
  }).start();  
  */
}


