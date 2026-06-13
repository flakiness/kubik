import fs from "fs";
import net from "net";
import path from "path";
import { TaskStatus } from "./taskTree.js";

export const KUBIK_VERSION: string = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8')).version;

export type ClientRequest = {
  method: 'handshake',
} | {
  method: 'run',
  configPaths: string[],
  fresh: boolean,
};

export type ServerMessage = {
  type: 'hello',
  version: string,
  pid: number,
  configPaths: string[],
} | {
  type: 'task_status',
  taskId: string,
  name: string,
  status: TaskStatus,
  durationMs: number,
  upToDate?: boolean,
} | {
  type: 'output',
  stream: 'stdout'|'stderr',
  taskId: string,
  name: string,
  data: string,
} | {
  type: 'done',
  status: 'ok'|'fail',
} | {
  type: 'error',
  message: string,
};

/**
 * Messages are sent as newline-delimited JSON. Calls `onMessage` for every
 * complete line; calls `onProtocolError` and stops reading on malformed JSON.
 */
export function readMessages(socket: net.Socket, onMessage: (message: any) => void, onProtocolError: () => void) {
  let buffer = '';
  let failed = false;
  socket.on('data', chunk => {
    if (failed)
      return;
    buffer += chunk.toString('utf8');
    let lineBreak;
    while (!failed && (lineBreak = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, lineBreak).trim();
      buffer = buffer.substring(lineBreak + 1);
      if (!line)
        continue;
      try {
        onMessage(JSON.parse(line));
      } catch (e) {
        failed = true;
        onProtocolError();
      }
    }
  });
}

export function writeMessage(socket: net.Socket, message: ClientRequest|ServerMessage) {
  if (!socket.destroyed)
    socket.write(JSON.stringify(message) + '\n');
}
