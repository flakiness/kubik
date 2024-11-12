import { withFullScreen } from 'fullscreen-ink';
import { Box, Text, useInput } from 'ink';
import path from 'path';
import { useEffect, useState } from 'react';
import { BuildStatus } from './buildTree.js';
import { AbsolutePath, ReadConfigResult } from './configLoader.js';
import { ProjectBuilder } from './projectBuilder.js';

const ScrollableText = ({ lines }: { lines: string[]}) => {
  const [scrollPosition, setScrollPosition] = useState(0);
  const viewportHeight = 10; // Number of lines to display at once

  // Total and visible height
  const totalHeight = lines.length;
  const visibleHeight = viewportHeight;

  // Calculate scrollbar position
  const scrollBarHeight = Math.max(1, Math.floor((visibleHeight / totalHeight) * viewportHeight));
  const maxScrollPosition = totalHeight - viewportHeight;
  const scrollBarPosition = Math.floor((scrollPosition / maxScrollPosition) * (viewportHeight - scrollBarHeight));

  // Handle input for scrolling
  useInput((input, key) => {
    if (key.upArrow) {
      setScrollPosition((prev) => Math.max(prev - 1, 0));
    } else if (key.downArrow) {
      setScrollPosition((prev) => Math.min(prev + 1, maxScrollPosition));
    }
  });

  // Slice the lines to show based on the scroll position
  const displayedLines = lines.slice(scrollPosition, scrollPosition + viewportHeight);

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width="90%">
        {displayedLines.map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column" width="10%" alignItems="flex-end">
        {Array.from({ length: viewportHeight }).map((_, index) => (
          <Text key={index}>
            {index >= scrollBarPosition && index < scrollBarPosition + scrollBarHeight ? '█' : '░'}
          </Text>
        ))}
      </Box>
    </Box>
  );
};

function projectName(project: ReadConfigResult) {
  if (project.config?.name)
    return project.config.name;
  return path.relative(process.cwd(), project.configPath);
}


const ProjectView = ({ projectBuilder, project }: { projectBuilder: ProjectBuilder, project: ReadConfigResult }) => {
  const status = projectBuilder.projectStatus(project);

  const [buildStatus, setBuildStatus] = useState(status.status);
  const [output, setOutput] = useState(status.output);
  const [duration, setDuration] = useState(status.durationMs);

  useEffect(() => {
    const listener = (changedPoject: ReadConfigResult, status: BuildStatus) => {
      if (changedPoject.configPath === project.configPath) {
        setBuildStatus(status.status);
        setOutput(status.output.trim());
        setDuration(status.durationMs);
      }
    };
    projectBuilder.on('changed', listener);

    return () => void projectBuilder.removeListener('changed', listener);
  }, []);

  const name = projectName(project);
  const color = buildStatus === 'fail' ? 'red' :
                buildStatus === 'ok' ? 'green' :
                buildStatus === 'running' ? 'yellow' : 'gray';
  return (
      <Box width='100%' overflow='hidden' flexDirection='row' flexWrap='nowrap' height={1}>
        <Box
          height={1}
          borderColor={color}
          flexGrow={1}
          flexShrink={1}
          borderStyle="single"
          borderBottom={false} borderLeft={false} borderRight={false}></Box>
        <Box flexGrow={0} marginLeft={1} marginRight={1}>
          <Text wrap='truncate-middle'>{projectName(project)}</Text>
        </Box>
        <Box
              flexGrow={1}
              flexShrink={1}
              flexDirection='row'
              justifyContent='flex-end'
        >
          <Text>Hello bitch {buildStatus}</Text> 
        </Box>
      </Box>
  );
}

const WatchApp = ({ projectBuilder }: { projectBuilder: ProjectBuilder }) => {
  const [projects, setProjects] = useState(projectBuilder.projects());

  useEffect(() => {
    projectBuilder.on('projects_changed', () => {
      setProjects(projectBuilder.projects());
    });

    return () => {
      projectBuilder.removeAllListeners();
      projectBuilder.stop();
    };
  }, []);

  return (
    <Box flexGrow={1} flexDirection='column'>
     {projects.map(project => <ProjectView key={project.configPath} project={project} projectBuilder={projectBuilder}></ProjectView>)}
    </Box>
  );
};

export function startWatchApp(roots: string[], parallelization: number) {
  const projectBuilder = new ProjectBuilder({
    parallelization,
    watchMode: true,
  });

  projectBuilder.setRoots(roots.map(root => path.resolve(process.cwd(), root) as AbsolutePath));

  withFullScreen(<WatchApp projectBuilder={projectBuilder}/>, {
    exitOnCtrlC: true,
  }).start();  
}

function timeInSeconds(ms: number) {
  return parseFloat((ms / 1000).toFixed(1)).toFixed(1) + 's';
}

function renderStatus(status: 'ok'|'fail'|'pending'|'running', durationMs: number) {
  if (status === 'ok')
    return <Box flexWrap='nowrap' flexShrink={0}><Text color={'green'}> OK </Text><Text color={'yellow'}>{timeInSeconds(durationMs)}</Text></Box>;
  if (status === 'fail')
    return <Box flexWrap='nowrap' flexShrink={0}><Text color={'red'}> FAIL </Text><Text color={'yellow'}>{timeInSeconds(durationMs)}</Text></Box>;
  if (status === 'pending')
    return <Box flexWrap='nowrap' flexShrink={0}><Text color={'gray'}> Pending </Text></Box>;
  if (status === 'running')
    return <Box flexWrap='nowrap' flexShrink={0}><Text color={'yellow'}> Building... </Text></Box>;
}