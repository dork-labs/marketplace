/**
 * The parts of the machine the `usage` and `fleet` verbs touch beyond env, clock
 * and the buffered process runner (spec `flow-usage` §2): stdin, the OS home
 * folder, a loopback `fetch`, a streaming child process, process existence and
 * a hard-exit watchdog. Each comes in through {@link HostIo} so tests replace
 * it; {@link realHostIo} is what the script wires.
 *
 * Dependency-free: node builtins only.
 *
 * @module @dorkos/flow/cli/host-io
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

/** Standard input as a verb sees it. */
export interface StdinSource {
  /** Whether stdin is a terminal (a person typing, not a pipe). */
  isTTY: boolean;
  /**
   * Read all of stdin as UTF-8, or `null` when it holds more than `limit`
   * bytes (reading then stops).
   */
  read(limit: number): Promise<string | null>;
}

/** Options for {@link StreamRunner}. */
export interface StreamOptions {
  /** Working directory. */
  cwd?: string;
  /** The child's whole environment (not merged with the parent's). */
  env: Record<string, string>;
  /** Stop the child after this many ms: SIGTERM, then SIGKILL 5 s later. */
  timeoutMs: number;
  /** Called with each stdout line; return `'stop'` to end the child early. */
  onLine(line: string): 'continue' | 'stop';
}

/** How a streamed child ended. */
export interface StreamOutcome {
  /** The exit code, or `null` when a signal ended it. */
  code: number | null;
  /** Whether `onLine` asked to stop it. */
  stopped: boolean;
  /** Whether the timeout ended it. */
  timedOut: boolean;
}

/**
 * Run a command with no shell, feeding its stdout to `onLine` line by line.
 * Rejects only when the command cannot be started.
 */
export type StreamRunner = (
  cmd: string,
  args: readonly string[],
  opts: StreamOptions
) => Promise<StreamOutcome>;

/** Everything in {@link HostIo}. */
export interface HostIo {
  /** Standard input. */
  stdin: StdinSource;
  /** The OS home folder. */
  osHome: string;
  /** HTTP, used only for a loopback DorkOS. */
  fetch: typeof fetch;
  /** A streaming child process (the usage probe). */
  spawnStream: StreamRunner;
  /** Whether a process id exists. */
  pidAlive(pid: number): boolean;
  /** End the whole process with exit 0 after `ms`, whatever it is doing. */
  armWatchdog(ms: number): void;
  /** Wait `ms` milliseconds (`flow watch` between rounds). */
  sleep(ms: number): Promise<void>;
}

/** The real stdin. */
const realStdin: StdinSource = {
  get isTTY() {
    return process.stdin.isTTY === true;
  },
  read(limit) {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        process.stdin.removeAllListeners('data');
        resolve(value);
      };
      process.stdin.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          finish(null);
          process.stdin.destroy();
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', () => finish(null));
    });
  },
};

/** The real streaming runner: `spawn` with no shell. */
export const realSpawnStream: StreamRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stopped = false;
    let timedOut = false;
    let buffer = '';
    let killTimer: NodeJS.Timeout | undefined;
    const end = (reason: 'stop' | 'timeout') => {
      if (reason === 'stop') stopped = true;
      else timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => end('timeout'), opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped || timedOut) return;
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (opts.onLine(line) === 'stop') {
          end('stop');
          return;
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!stopped && !timedOut && buffer !== '') opts.onLine(buffer);
      resolve({ code, stopped, timedOut });
    });
  });

/**
 * Whether a process exists: `kill(pid, 0)` succeeds, or fails with `EPERM`.
 *
 * @param pid - A process id.
 * @returns True when the process exists.
 */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The real machine.
 *
 * @returns A {@link HostIo} over process stdin, `os.homedir()`, global `fetch`,
 *   `spawn`, `process.kill(pid, 0)`, a real exit timer and a real sleep.
 */
export function realHostIo(): HostIo {
  return {
    stdin: realStdin,
    osHome: os.homedir(),
    fetch: (...args) => fetch(...args),
    spawnStream: realSpawnStream,
    pidAlive: pidExists,
    armWatchdog(ms) {
      setTimeout(() => process.exit(0), ms).unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
