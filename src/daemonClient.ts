import chalk from "chalk";
import net from "net";
import { AbsolutePath } from "./configLoader.js";
import { ClientRequest, KUBIK_VERSION, ServerMessage, readMessages, writeMessage } from "./daemonProtocol.js";
import { listDaemonSocketPaths, removeStaleSocket } from "./daemonRegistry.js";
import { TaskStatus } from "./taskTree.js";
import { timeInSeconds } from "./utils.js";

const CONNECT_TIMEOUT_MS = 1000;

type DaemonConnection = {
  socket: net.Socket,
  pid: number,
  version: string,
  configPaths: Set<string>,
  onMessage?: (message: ServerMessage) => void,
  onClose?: () => void,
};

export type DelegateOptions = {
  fresh: boolean,
  ignoredFlags: string[],
};

/**
 * Tries to find a running watchdog that owns all the requested tasks and run
 * them there. Returns the exit code, or `undefined` when there's no suitable
 * watchdog and the caller should run the build locally.
 */
export async function tryDelegateRun(roots: AbsolutePath[], options: DelegateOptions): Promise<number|undefined> {
  let daemon: DaemonConnection|undefined;
  for (const socketPath of listDaemonSocketPaths()) {
    const candidate = await connectToDaemon(socketPath);
    if (!candidate)
      continue;
    if (candidate.version !== KUBIK_VERSION) {
      console.log(chalk.dim(`[kubik] note: found watchdog (pid ${candidate.pid}) running kubik v${candidate.version}, but this is v${KUBIK_VERSION}; running locally.`));
      candidate.socket.destroy();
      continue;
    }
    if (!roots.every(root => candidate.configPaths.has(root))) {
      candidate.socket.destroy();
      continue;
    }
    daemon = candidate;
    break;
  }
  if (!daemon)
    return undefined;

  console.log(chalk.cyan(`[kubik] Using watchdog (pid ${chalk.bold(daemon.pid)}); pass --no-daemon to opt out.`));
  for (const flag of options.ignoredFlags)
    console.log(chalk.dim(`[kubik] note: ${flag} is ignored when running via the watchdog.`));
  return await runOnDaemon(daemon, roots, options.fresh);
}

async function connectToDaemon(socketPath: string): Promise<DaemonConnection|undefined> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const connection: DaemonConnection = { socket, pid: 0, version: '', configPaths: new Set() };
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, CONNECT_TIMEOUT_MS);
    socket.on('error', () => {
      // Nobody listens on this socket - the watchdog is gone.
      clearTimeout(timeout);
      removeStaleSocket(socketPath);
      resolve(undefined);
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      connection.onClose?.call(null);
      resolve(undefined);
    });
    socket.on('connect', () => writeMessage(socket, { method: 'handshake' } satisfies ClientRequest));
    readMessages(socket, (message: ServerMessage) => {
      if (connection.onMessage) {
        connection.onMessage(message);
        return;
      }
      if (message.type !== 'hello')
        return;
      clearTimeout(timeout);
      connection.pid = message.pid;
      connection.version = message.version;
      connection.configPaths = new Set(message.configPaths);
      resolve(connection);
    }, () => socket.destroy());
  });
}

async function runOnDaemon(daemon: DaemonConnection, roots: AbsolutePath[], fresh: boolean): Promise<number> {
  return new Promise<number>(resolve => {
    let exitCode: number|undefined;
    const finish = (code: number) => {
      if (exitCode === undefined) {
        exitCode = code;
        daemon.socket.destroy();
        resolve(code);
      }
    };
    daemon.onClose = () => {
      if (exitCode === undefined) {
        console.error(chalk.red(`[kubik] Lost connection to the watchdog; re-run with --no-daemon to build locally.`));
        finish(1);
      }
    };
    // The watchdog may have dropped between the handshake and now. If so, the
    // `run` write below would silently no-op on the destroyed socket and we'd
    // wait forever; settle straight away instead.
    if (daemon.socket.destroyed) {
      daemon.onClose();
      return;
    }
    daemon.onMessage = message => {
      if (message.type === 'task_status') {
        logTaskStatus(message.name, message.status, message.durationMs, message.upToDate);
      } else if (message.type === 'output') {
        const write = message.stream === 'stdout' ? process.stdout : process.stderr;
        for (const line of message.data.trim().split('\n'))
          write.write(`[${message.name}] ${line}\n`);
      } else if (message.type === 'error') {
        console.error(chalk.red(`[kubik] ${message.message}`));
      } else if (message.type === 'done') {
        finish(message.status === 'ok' ? 0 : 1);
      }
    };
    writeMessage(daemon.socket, { method: 'run', configPaths: roots, fresh } satisfies ClientRequest);
  });
}

function logTaskStatus(name: string, status: TaskStatus, durationMs: number, upToDate?: boolean) {
  if (status === 'ok' && upToDate)
    console.log(chalk.green(`[kubik] Up-to-date ${chalk.bold(name)}`));
  else if (status === 'ok')
    console.log(chalk.green(`[kubik] Succeeded ${chalk.bold(name)} in ${chalk.bold(timeInSeconds(durationMs))}`));
  else if (status === 'fail')
    console.log(chalk.red(`[kubik] Failed ${chalk.bold(name)} in ${chalk.bold(timeInSeconds(durationMs))}`));
  else if (status === 'running')
    console.log(chalk.yellow(`[kubik] Starting ${chalk.bold(name)}...`));
}
