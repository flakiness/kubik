import fs from "fs";
import os from "os";
import path from "path";

/**
 * Running watchdogs are discovered through unix domain sockets in a well-known
 * directory; each watchdog listens on `<pid>.sock`. A socket file whose server
 * is gone is stale: clients detect this on connection failure and unlink it.
 */
export function daemonSocketDir(): string {
  return process.env.KUBIK_DAEMON_DIR ?? path.join(os.homedir(), '.kubik', 'daemons');
}

export function daemonSocketPath(pid: number): string {
  return path.join(daemonSocketDir(), `${pid}.sock`);
}

export function listDaemonSocketPaths(): string[] {
  try {
    return fs.readdirSync(daemonSocketDir())
        .filter(entry => entry.endsWith('.sock'))
        .map(entry => path.join(daemonSocketDir(), entry));
  } catch {
    return [];
  }
}

export function removeStaleSocket(socketPath: string) {
  try { fs.unlinkSync(socketPath); } catch {}
}
