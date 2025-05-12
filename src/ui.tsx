import chalk from 'chalk'; // For easily generating ANSI sequences in the mock data
import { withFullScreen } from 'fullscreen-ink';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { ansi2ink } from './ansi2ink.js';
import { TaskStatus } from './taskTree.js';
import { Project, Workspace } from './workspace.js';

interface TaskListProps {
  projects: Project[];
  selectedTaskIndex: number;
  isFocused: boolean;
  width: number,
}

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

const TaskList: React.FC<TaskListProps> = ({ projects, selectedTaskIndex, isFocused, width }) => {
  return (
    <Box
      borderStyle="single"
      borderColor={isFocused ? 'lightgray' : 'gray'}
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      width={width}
    >
      <Text bold underline>Tasks</Text>
      {projects.map((project, index) => (
        <Box flexDirection='row' gap={1}>
          <Text>{getStatusIndicator(project.status())}</Text>
          <Text
            key={project.id()}
            color={getStatusColor(project.status())}
            backgroundColor={index === selectedTaskIndex ? 'gray' : undefined}
            wrap={'truncate-start'}
          >{project.name()}</Text>
        </Box>
      ))}
    </Box>
  );
};

interface TaskOutputProps {
  project: Project | undefined;
  isFocused: boolean;
  scrollOffset: number;
  containerHeight: number; // Available height for the output
}

const TaskOutput: React.FC<TaskOutputProps> = ({ project, isFocused, scrollOffset, containerHeight }) => {
  return (
    <Box
      borderStyle="single"
      borderColor={isFocused ? 'lightgray' : 'gray'}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
      height="100%"
      overflow="hidden"
    >
      {ansi2ink(project?.output() ?? '')}
    </Box>
  );
};

const App: React.FC<{ workspace: Workspace }> = ({ workspace }) => {
  const [projects, setProjects] = useState<Project[]>(workspace.topsortProjects());
  const [selectedTaskIndex, setSelectedTaskIndex] = useState<number>(0);
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');
  const [outputScrollOffset, setOutputScrollOffset] = useState<number>(0);
  const [isUserScrolling, setIsUserScrolling] = useState<boolean>(false);

  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalHeight, setTerminalHeight] = useState<number>(stdout.rows);

  useEffect(() => {
    stdout.on('resize', () => {
      setTerminalHeight(stdout.rows);
    });
    workspace.on('project_added', project => {
      project.on('build_status_changed', () => setProjects(workspace.topsortProjects()));
    });
    workspace.on('projects_changed', () => setProjects(workspace.topsortProjects()));
    workspace.on('workspace_status_changed', () => {});
  }, []);

  const selectedProject = projects[selectedTaskIndex];

  // Calculate available height for output pane (adjust for borders, padding, titles etc.)
  // This is an approximation, you might need to fine-tune it.
  const outputContainerHeight = Math.max(1, terminalHeight - 4);

  // Ref to store previous output length for stick-to-bottom logic
  const prevOutputLength = useRef(0);

  // Stick-to-bottom logic
  useEffect(() => {
    const currentTask = projects[selectedTaskIndex];
    if (!currentTask) return;

    const currentOutputLength = currentTask.output().length;
    const currentLines = currentTask.output().split('\n').length;

    // Check if new output was added and we are not manually scrolled up
    if (currentOutputLength > prevOutputLength.current && !isUserScrolling) {
      const maxScroll = Math.max(0, currentLines - outputContainerHeight);
      setOutputScrollOffset(maxScroll); // Jump to bottom
    }

    // Update previous length for next comparison
    prevOutputLength.current = currentOutputLength;

    // Reset user scrolling flag if selection changes
    setIsUserScrolling(false);
  }, [projects, selectedTaskIndex, isUserScrolling, outputContainerHeight]);

  // Reset scroll offset and stickiness when task selection changes
  useEffect(() => {
    const currentTask = projects[selectedTaskIndex];
    const currentLines = currentTask?.output().split('\n').length ?? 0;
    const maxScroll = Math.max(0, currentLines - outputContainerHeight);
    setOutputScrollOffset(maxScroll); // Go to bottom of new task
    setIsUserScrolling(false); // New task, default to sticky
    prevOutputLength.current = currentTask?.output.length ?? 0; // Update ref
  }, [selectedTaskIndex, outputContainerHeight]); // Dependency on selectedTaskIndex

  // --- Input Handling ---
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      workspace.stop();
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

    // Navigation / Scrolling
    if (input === 'k' || key.upArrow) {
      if (focusedPane === 'left') {
        setSelectedTaskIndex((prev) => Math.max(0, prev - 1));
      } else if (focusedPane === 'right') {
        setOutputScrollOffset((prev) => {
            const newOffset = Math.max(0, prev - 1);
            // If scrolling up, set the user scrolling flag
            if (newOffset < prev) setIsUserScrolling(true);
            return newOffset;
        });
      }
    } else if (input === 'j' || key.downArrow) {
      if (focusedPane === 'left') {
        setSelectedTaskIndex((prev) => Math.min(projects.length - 1, prev + 1));
      } else if (focusedPane === 'right') {
         const currentTask = projects[selectedTaskIndex];
         const totalLines = currentTask?.output().split('\n').length ?? 0;
         const maxScroll = Math.max(0, totalLines - outputContainerHeight);

         setOutputScrollOffset((prev) => {
            const newOffset = Math.min(maxScroll, prev + 1);
             // Check if we've reached the bottom by scrolling down
            if (newOffset === maxScroll) {
                setIsUserScrolling(false); // Re-enable stick-to-bottom if we scroll to the very end
            } else if (newOffset > prev) {
                 setIsUserScrolling(true); // Scrolling down (but not to the end), disable stickiness
            }
            return newOffset;
         });
      }
    }
  });

  const maxProjectWidth = Math.max(...projects.map(p => p.name().length), 0);
  const minWidth = Math.min(Math.round(stdout.columns * 0.3), 25);
  const maxWidth = Math.round(stdout.columns * 0.5);
  const width = Math.min(Math.max(minWidth, maxProjectWidth + 6), maxWidth);

  return (
    <Box flexDirection="row" width="100%" height={terminalHeight}>
      <TaskList
        projects={projects}
        selectedTaskIndex={selectedTaskIndex}
        isFocused={focusedPane === 'left'}
        width={width}
      />
      <TaskOutput
        project={selectedProject}
        isFocused={focusedPane === 'right'}
        scrollOffset={outputScrollOffset}
        containerHeight={outputContainerHeight}
      />
    </Box>
  );
};

export function startWatchApp(workspace: Workspace) {
  withFullScreen(<App workspace={workspace}/>, {
    exitOnCtrlC: true,
  }).start();  
}


