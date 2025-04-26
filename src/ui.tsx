import chalk from 'chalk'; // For easily generating ANSI sequences in the mock data
import { withFullScreen } from 'fullscreen-ink';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { Workspace } from './workspace.js';

// --- Types ---
type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  output: string;
}

// --- Mock Data and Simulation ---
const initialTasks: Task[] = [
  { id: 'task-1', name: 'Build Project', status: 'pending', output: '' },
  { id: 'task-2', name: 'Run Linter', status: 'pending', output: '' },
  { id: 'task-3', name: 'Run Tests', status: 'pending', output: '' },
  { id: 'task-4', name: 'Deploy Staging', status: 'pending', output: '' },
  { id: 'task-5', name: 'Deploy Prod', status: 'pending', output: '' },
];

const simulateTaskRunner = (
    tasks: Task[],
    setTasks: React.Dispatch<React.SetStateAction<Task[]>>
) => {
  let currentTaskIndex = 0;
  let intervalCount = 0;

  const intervalId = setInterval(() => {
    setTasks(prevTasks => {
      // Don't modify if we are done
      if (currentTaskIndex >= prevTasks.length && intervalCount > 5) {
         clearInterval(intervalId);
         return prevTasks;
      }

      // If we finished the last task, wait a bit then stop
      if (currentTaskIndex >= prevTasks.length) {
          intervalCount++;
          return prevTasks;
      }

      const taskId = prevTasks[currentTaskIndex].id;
      const taskName = prevTasks[currentTaskIndex].name;

      // Make a mutable copy
      const updatedTasks = [...prevTasks];
      const taskIndex = updatedTasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) return prevTasks; // Should not happen

      const currentTask = updatedTasks[taskIndex];

      // Start task if pending
      if (currentTask.status === 'pending') {
        currentTask.status = 'running';
        currentTask.output += `[${new Date().toLocaleTimeString()}] Starting ${taskName}...\n`;
        intervalCount = 0; // Reset counter for this task
      } else if (currentTask.status === 'running') {
        // Add some output
        const randomOutput = [
            `Processing item ${Math.floor(Math.random() * 100)}...`,
            chalk.yellow(`Warning: Deprecated feature used in module X.`),
            `Log entry ${Math.random().toString(16).substring(2, 8)}`,
            chalk.blue(`Info: Cache hit for dependency Y.`),
            chalk.cyan(`[DEBUG] Value set to ${Math.random()}`),
        ];
        currentTask.output += randomOutput[Math.floor(Math.random() * randomOutput.length)] + '\n';
        intervalCount++;

        // Finish task after some time/output
        if (intervalCount > 5 + Math.random() * 5) {
          const success = Math.random() > 0.2; // 80% chance of success
          if (success) {
            currentTask.status = 'success';
            currentTask.output += chalk.green(`✔ Task ${taskName} completed successfully.\n`);
            currentTaskIndex++; // Move to next task
          } else {
            currentTask.status = 'failed';
            currentTask.output += chalk.red(`✖ Task ${taskName} failed.\n`);
            // Stop processing further tasks on failure (optional)
            clearInterval(intervalId);
          }
          intervalCount = 0;
        }
      }
      return updatedTasks;
    });
  }, 500); // Add output/change status roughly every 500ms

  return () => clearInterval(intervalId); // Cleanup function
};

// --- UI Components ---

interface TaskListProps {
  tasks: Task[];
  selectedTaskIndex: number;
  isFocused: boolean;
}

const getStatusColor = (status: TaskStatus) => {
  switch (status) {
    case 'running': return 'yellow';
    case 'success': return 'green';
    case 'failed': return 'red';
    case 'pending': return 'gray';
    default: return 'white';
  }
};

const getStatusIndicator = (status: TaskStatus) => {
  switch (status) {
    case 'running': return chalk.yellow('●'); // Or use spinners if you add ink-spinner
    case 'success': return chalk.green('✔');
    case 'failed': return chalk.red('✖');
    case 'pending': return chalk.gray('○');
    default: return '?';
  }
};

const TaskList: React.FC<TaskListProps> = ({ tasks, selectedTaskIndex, isFocused }) => {
  return (
    <Box
      borderStyle="single"
      borderColor={isFocused ? 'lightgray' : 'gray'}
      flexDirection="column"
      paddingX={1}
      width="30%"
    >
      <Text bold underline>Tasks</Text>
      {tasks.map((task, index) => (
        <Text
          key={task.id}
          color={getStatusColor(task.status)}
          backgroundColor={index === selectedTaskIndex ? 'gray' : undefined} // Highlight selected
        >
          {getStatusIndicator(task.status)} {task.name}
        </Text>
      ))}
    </Box>
  );
};

interface TaskOutputProps {
  task: Task | undefined;
  isFocused: boolean;
  scrollOffset: number;
  containerHeight: number; // Available height for the output
}

const TaskOutput: React.FC<TaskOutputProps> = ({ task, isFocused, scrollOffset, containerHeight }) => {
  const outputLines = task?.output.split('\n') ?? [];
  const totalLines = outputLines.length;

  // Calculate visible lines based on scroll offset and container height
  // Ensure start index is non-negative
  const startLine = Math.max(0, scrollOffset);
  // Ensure end index doesn't exceed total lines
  const endLine = Math.min(totalLines, startLine + containerHeight);
  const visibleLines = outputLines.slice(startLine, endLine);

  // Scrollbar calculation (simple indicator)
  const scrollbarHeight = Math.max(1, Math.floor((containerHeight / totalLines) * containerHeight));
  const scrollbarPos = totalLines <= containerHeight ? 0 : Math.floor((scrollOffset / (totalLines - containerHeight)) * (containerHeight - scrollbarHeight));

  return (
    <Box
      borderStyle="single"
      borderColor={isFocused ? 'lightgray' : 'gray'}
      flexDirection="column" // Changed to column for text and scrollbar
      paddingX={1}
      flexGrow={1}
      height="100%"
      overflow="hidden"
    >
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold underline>{task?.name ?? 'Output'}</Text>
            {task ? (
              visibleLines.map((line, index) => (
                // We rely on Ink's <Text> to handle ANSI sequences within the line
                <Text key={`${task.id}-${startLine + index}`}>{line}</Text>
              ))
            ) : (
              <Text color="gray">No task selected or no output yet.</Text>
            )}
        </Box>

        {totalLines > containerHeight && (
          <Box flexDirection="column" width={1} height={containerHeight} marginLeft={1}>
            {Array.from({ length: scrollbarPos }).map((_, i) => <Text key={`scrollpad-top-${i}`}> </Text>)}
            <Box width={1} height={scrollbarHeight}><Text>█</Text></Box>
            {Array.from({ length: containerHeight - scrollbarHeight - scrollbarPos }).map((_, i) => <Text key={`scrollpad-bottom-${i}`}> </Text>)}
          </Box>
        )}
      </Box>
    </Box>
  );
};

// --- Main App Component ---
const App: React.FC<{ workspace: Workspace }> = ({ workspace }) => {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [selectedTaskIndex, setSelectedTaskIndex] = useState<number>(0);
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');
  const [outputScrollOffset, setOutputScrollOffset] = useState<number>(0);
  const [isUserScrolling, setIsUserScrolling] = useState<boolean>(false);

  const { exit } = useApp();
  const { stdout } = useStdout(); // Get terminal height
  const [terminalHeight, setTerminalHeight] = useState<number>(stdout.rows);

  useEffect(() => {
    stdout.on('resize', () => {
      setTerminalHeight(stdout.rows);
    });
  }, [])

  const selectedTask = tasks[selectedTaskIndex];

  // Calculate available height for output pane (adjust for borders, padding, titles etc.)
  // This is an approximation, you might need to fine-tune it.
  const outputContainerHeight = Math.max(1, terminalHeight - 4);

  // Ref to store previous output length for stick-to-bottom logic
  const prevOutputLength = useRef(0);

  // --- Effects ---

  // Start task simulation on mount
  useEffect(() => {
    const cleanup = simulateTaskRunner(tasks, setTasks);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Stick-to-bottom logic
  useEffect(() => {
    const currentTask = tasks[selectedTaskIndex];
    if (!currentTask) return;

    const currentOutputLength = currentTask.output.length;
    const currentLines = currentTask.output.split('\n').length;

    // Check if new output was added and we are not manually scrolled up
    if (currentOutputLength > prevOutputLength.current && !isUserScrolling) {
        const maxScroll = Math.max(0, currentLines - outputContainerHeight);
        setOutputScrollOffset(maxScroll); // Jump to bottom
    }

    // Update previous length for next comparison
    prevOutputLength.current = currentOutputLength;

    // Reset user scrolling flag if selection changes
    setIsUserScrolling(false);
  }, [tasks, selectedTaskIndex, isUserScrolling, outputContainerHeight]);

  // Reset scroll offset and stickiness when task selection changes
  useEffect(() => {
    const currentTask = tasks[selectedTaskIndex];
    const currentLines = currentTask?.output.split('\n').length ?? 0;
    const maxScroll = Math.max(0, currentLines - outputContainerHeight);
    setOutputScrollOffset(maxScroll); // Go to bottom of new task
    setIsUserScrolling(false); // New task, default to sticky
    prevOutputLength.current = currentTask?.output.length ?? 0; // Update ref
  }, [selectedTaskIndex, outputContainerHeight]); // Dependency on selectedTaskIndex

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
        setSelectedTaskIndex((prev) => Math.min(tasks.length - 1, prev + 1));
      } else if (focusedPane === 'right') {
         const currentTask = tasks[selectedTaskIndex];
         const totalLines = currentTask?.output.split('\n').length ?? 0;
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

  return (
    <Box flexDirection="row" width="100%" height={terminalHeight}>
      <TaskList
        tasks={tasks}
        selectedTaskIndex={selectedTaskIndex}
        isFocused={focusedPane === 'left'}
      />
      <TaskOutput
        task={selectedTask}
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


