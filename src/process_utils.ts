/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';
import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';

type ProcessData = {
  pid: number, // process ID
  pgrp: number, // process group ID
  children: Set<ProcessData>, // direct children of the process
};

function readAllProcessesLinux(): { pid: number, ppid: number, pgrp: number }[] {
  const result: {pid: number, ppid: number, pgrp: number}[] = [];
  for (const dir of fs.readdirSync('/proc')) {
    const pid = +dir;
    if (isNaN(pid))
      continue;
    try {
      const statFile = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Format of /proc/*/stat is described https://man7.org/linux/man-pages/man5/proc.5.html
      const match = statFile.match(/^(?<pid>\d+)\s+\((?<comm>.*)\)\s+(?<state>R|S|D|Z|T|t|W|X|x|K|W|P)\s+(?<ppid>\d+)\s+(?<pgrp>\d+)/);
      if (match && match.groups) {
        result.push({
          pid: +match.groups.pid,
          ppid: +match.groups.ppid,
          pgrp: +match.groups.pgrp,
        });
      }
    } catch (e) {
      // We don't have access to some /proc/<pid>/stat file.
    }
  }
  return result;
}

function readAllProcessesMacOS(): { pid: number, ppid: number, pgrp: number }[] {
  const result: {pid: number, ppid: number, pgrp: number}[] = [];
  const processTree = spawnSync('ps', ['-eo', 'pid,pgid,ppid']);
  const lines = processTree.stdout.toString().trim().split('\n');
  for (const line of lines) {
    const [pid, pgrp, ppid] = line.trim().split(/\s+/).map(token => +token);
    // On linux, the very first line of `ps` is the header with "PID PGID PPID".
    if (isNaN(pid) || isNaN(pgrp) || isNaN(ppid))
      continue;
    result.push({ pid, ppid, pgrp });
  }
  return result;
}

function buildProcessTreePosix(pid: number): ProcessData {
  // Certain Linux distributions might not have `ps` installed.
  const allProcesses = process.platform === 'darwin' ? readAllProcessesMacOS() : readAllProcessesLinux();
  const pidToProcess = new Map<number, ProcessData>();
  for (const { pid, pgrp } of allProcesses)
    pidToProcess.set(pid, { pid, pgrp, children: new Set() });
  for (const { pid, ppid } of allProcesses) {
    const parent = pidToProcess.get(ppid);
    const child = pidToProcess.get(pid);
    // On POSIX, certain processes might not have parent (e.g. PID=1 and occasionally PID=2)
    // or we might not have access to it proc info.
    if (parent && child)
      parent.children.add(child);
  }
  return pidToProcess.get(pid)!;
}

export function killProcessTree(childProcess: ChildProcess, signal: 'SIGINT' | 'SIGKILL') {
  if (!childProcess.pid || !childProcess.kill(0))
    return;

  // On Windows, we always call `taskkill` no matter signal.
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${childProcess.pid} /T /F /FI "MEMUSAGE gt 0"`, { stdio: 'ignore' });
    } catch (e) {
      // the process might have already stopped
    }
    return;
  }

  // In case of POSIX and `SIGINT` signal, send it to the main process group only.
  if (signal === 'SIGINT') {
    try {
      process.kill(-childProcess.pid, 'SIGINT');
    } catch (e) {
      // the process might have already stopped
    }
    return;
  }

  // In case of POSIX and `SIGKILL` signal, we should send it to all descendant process groups.
  const rootProcess = buildProcessTreePosix(childProcess.pid);
  const descendantProcessGroups = (function flatten(processData: ProcessData, result: Set<number> = new Set()) {
    // Process can nullify its own process group with `setpgid`. Use its PID instead.
    result.add(processData.pgrp || processData.pid);
    processData.children.forEach(child => flatten(child, result));
    return result;
  })(rootProcess);
  for (const pgrp of descendantProcessGroups) {
    try {
      process.kill(-pgrp, 'SIGKILL');
    } catch (e) {
      // the process might have already stopped
    }
  }
}

export async function spawnAsync(cmd: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<{ code: number, stdio: string, stdout: string, stderr: string }> {
  return await new Promise((resolve, reject) => {
    const subprocess = spawn(cmd, args, {
      ...options,
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '', stderr = '', stdio = '';
    subprocess.stdout.on('data', data => { stdout += data; stdio += data; });
    subprocess.stderr.on('data', data => { stderr += data; stdio += data; });
    subprocess.on('close', code => resolve({ code: code as number, stdout, stderr, stdio }));
    subprocess.on('error', error => reject(error));
  });
}
