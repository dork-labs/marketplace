/**
 * The plain CLI launcher (spec `flow-handoff-dispatch` §2.3): each session is a
 * detached `claude -p` process writing stream-json to a log under the worktree.
 *
 * - **probe:** `claude --version` exits 0.
 * - **start:** spawn `claude -p "<pointer>" --output-format stream-json --verbose
 *   --session-id <id> --permission-mode <mode> [--model <m>]` in `cwd`, with the
 *   account's `CLAUDE_CONFIG_DIR` and no credential variables. Confirmed when the
 *   log's `system`/`init` line reports `apiKeySource: "none"` and the transcript
 *   appears under the account's dir.
 * - **send:** a live process gets the message queued in the worktree's inbox (a
 *   `-p` session reads no more input); an exited one is resumed with
 *   `--resume <id>` on the same account, cwd, mode and log.
 * - **state:** a live pid is `busy`; otherwise the log (then the transcript)
 *   decides between `limited` and `exited`.
 * - **stop:** SIGTERM the recorded pid, only after `ps` shows it is `claude`.
 *
 * Every outside effect comes in through {@link CliLauncherDeps}, so the contract
 * suite runs it against fakes.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/launchers/cli
 */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realProcessRunner, type ProcessRunner } from '../cli/context.ts';
import { parseJsonLines, streamLimit, transcriptLimit } from '../drain/stream-log.ts';
import { pidExists } from '../fleet/sessions.ts';
import {
  DEFAULT_START_TIMEOUT_MS,
  childEnv,
  pointerLine,
  sessionConfigDir,
  stopRecordedPid,
  validateLaunchRequest,
  validateMessageFile,
} from './common.ts';
import { findTranscript, proveAccount } from './prove-account.ts';
import {
  LaunchError,
  type LaunchRequest,
  type Launcher,
  type ProbeResult,
  type SendResult,
  type SessionHandle,
  type SessionState,
  type StopResult,
} from './types.ts';

/** The probe's reason when `claude --version` does not answer. */
export const CLI_UNAVAILABLE_REASON = 'the `claude` binary is not on PATH';

/** Options for one detached child. */
export interface DetachedSpawnOptions {
  /** The working folder. */
  cwd: string;
  /** The complete environment (nothing is inherited beyond it). */
  env: Record<string, string>;
  /** The file stdout is appended to. */
  stdoutFile: string;
  /** The file stderr is appended to. */
  stderrFile: string;
}

/** A detached child: its pid, and its exit code once it exits while this process lives. */
export interface DetachedChild {
  /** The child's pid. */
  pid: number;
  /** Resolves with the exit code (`null` when killed by a signal). */
  exit: Promise<number | null>;
}

/**
 * Start a detached child with no shell, stdout and stderr appended to files,
 * and not keep this process alive for it.
 */
export type DetachedSpawn = (
  cmd: string,
  args: readonly string[],
  opts: DetachedSpawnOptions
) => DetachedChild;

/** Everything the cli launcher touches outside its own memory. */
export interface CliLauncherDeps {
  /** Runs `claude --version` and `ps` (no shell). */
  run: ProcessRunner;
  /** Starts the `claude` child. */
  spawn: DetachedSpawn;
  /** Whether a pid exists. */
  isAlive: (pid: number) => boolean;
  /** Sends a signal to a pid. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The supervisor's environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The OS home folder, for the ambient `~/.claude`. */
  osHome: string;
  /** The clock, in epoch milliseconds. */
  now: () => number;
  /** Waits. */
  sleep: (ms: number) => Promise<void>;
  /** How long `start` waits for confirmation. Default 90 s. */
  startTimeoutMs?: number;
  /** How often `start` looks. Default 500 ms. */
  pollMs?: number;
  /** The Claude Code executable. Default `claude` (found on PATH). */
  claudeBin?: string;
}

/**
 * The real {@link DetachedSpawn}: `spawn(..., { detached: true, shell: false })`
 * with stdout and stderr opened for append, then `unref()`.
 *
 * @param cmd - The executable.
 * @param args - Its arguments.
 * @param opts - Folder, environment and output files.
 * @returns The pid and the exit promise.
 * @throws {Error} When the child cannot be started (for example, no such binary).
 */
export const realDetachedSpawn: DetachedSpawn = (cmd, args, opts) => {
  const out = openSync(opts.stdoutFile, 'a');
  const err = openSync(opts.stderrFile, 'a');
  try {
    const child = nodeSpawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      shell: false,
      stdio: ['ignore', out, err],
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`${cmd} could not be started.`);
    return { pid: child.pid, exit };
  } finally {
    closeSync(out);
    closeSync(err);
  }
};

/**
 * The real dependencies: `execFile`, a detached `spawn`, `process.kill`, the
 * process environment and clock.
 *
 * @returns Deps for {@link createCliLauncher}.
 */
export function realCliLauncherDeps(): CliLauncherDeps {
  return {
    run: realProcessRunner,
    spawn: realDetachedSpawn,
    isAlive: pidExists,
    kill: (pid, signal) => process.kill(pid, signal),
    env: process.env,
    osHome: os.homedir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The drain's per-worktree folders. */
function drainDir(cwd: string, ...parts: string[]): string {
  return path.join(cwd, '.dork', 'flow', 'drain', ...parts);
}

/** The file the runner's exit code lands in, beside the log. */
function exitFile(logFile: string): string {
  return logFile.replace(/\.jsonl$/, '') + '.exit.json';
}

/** The first line of the stderr log, for a start that failed. */
function stderrHead(logFile: string): string | null {
  try {
    const text = readFileSync(logFile.replace(/\.jsonl$/, '.err.log'), 'utf8').trim();
    return text === '' ? null : (text.split('\n')[0] ?? null);
  } catch {
    return null;
  }
}

/** The first `system`/`init` message in a log, if it has one yet. */
function firstInit(logFile: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return null;
  }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return (
    parseJsonLines(complete).find((line) => line.type === 'system' && line.subtype === 'init') ??
    null
  );
}

/** The common tail of every `claude -p` argv. */
function streamArgs(mode: string, model: string | undefined): string[] {
  const args = ['--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
  if (model !== undefined) args.push('--model', model);
  return args;
}

/**
 * Create the plain CLI launcher.
 *
 * @param deps - Process, clock and environment access (see {@link realCliLauncherDeps}).
 * @returns The launcher.
 */
export function createCliLauncher(deps: CliLauncherDeps): Launcher {
  const bin = deps.claudeBin ?? 'claude';
  const timeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 500;

  /** Record the exit code beside the log when the child exits while we live. */
  function watchExit(child: DetachedChild, logFile: string): void {
    void child.exit.then(
      (code) => {
        try {
          writeFileSync(exitFile(logFile), `${JSON.stringify({ pid: child.pid, code })}\n`);
        } catch {
          // The worktree went away; state() then reports code null.
        }
      },
      () => undefined
    );
  }

  /** Spawn one `claude` child, translating a spawn failure into `unavailable`. */
  function spawnClaude(
    args: string[],
    cwd: string,
    configDir: string,
    logFile: string
  ): DetachedChild {
    mkdirSync(path.dirname(logFile), { recursive: true });
    rmSync(exitFile(logFile), { force: true });
    let child: DetachedChild;
    try {
      child = deps.spawn(bin, args, {
        cwd,
        env: childEnv(deps.env, configDir),
        stdoutFile: logFile,
        stderrFile: logFile.replace(/\.jsonl$/, '.err.log'),
      });
    } catch (error) {
      throw new LaunchError(
        'unavailable',
        `claude could not be started: ${(error as Error).message}`
      );
    }
    watchExit(child, logFile);
    return child;
  }

  async function probe(): Promise<ProbeResult> {
    try {
      const result = await deps.run(bin, ['--version'], { timeoutMs: 15_000 });
      return result.code === 0 ? { ok: true } : { ok: false, reason: CLI_UNAVAILABLE_REASON };
    } catch {
      return { ok: false, reason: CLI_UNAVAILABLE_REASON };
    }
  }

  const stopDeps = { run: deps.run, isAlive: deps.isAlive, kill: deps.kill };

  async function start(req: LaunchRequest): Promise<SessionHandle> {
    validateLaunchRequest(req);
    const probed = await probe();
    if (!probed.ok) throw new LaunchError('unavailable', probed.reason);

    const configDir = sessionConfigDir(req.account, deps.env, deps.osHome);
    const logFile = drainDir(req.cwd, 'logs', `${req.sessionId}.jsonl`);
    const args = [
      '-p',
      pointerLine(req.promptFile),
      '--session-id',
      req.sessionId,
      ...streamArgs(req.permissionMode, req.model),
    ];
    const child = spawnClaude(args, req.cwd, configDir, logFile);

    const handle: SessionHandle = {
      host: 'cli',
      sessionId: req.sessionId,
      account: req.account?.id ?? null,
      cwd: req.cwd,
      pid: child.pid,
      logFile,
      logOffset: 0,
      configDir,
      permissionMode: req.permissionMode,
      ...(req.model === undefined ? {} : { model: req.model }),
    };

    const deadline = deps.now() + timeoutMs;
    let init: Record<string, unknown> | null = null;
    for (;;) {
      init ??= firstInit(logFile);
      if (init !== null && init.apiKeySource !== 'none') {
        await stopRecordedPid(child.pid, stopDeps);
        throw new LaunchError(
          'wrong-account',
          `The session signed in with ${String(init.apiKeySource ?? 'an unreported credential')} instead of the account's own login (apiKeySource must be "none"); flow stopped it.`
        );
      }
      if (init !== null && proveAccount(configDir, req.sessionId)) return handle;
      if (!deps.isAlive(child.pid)) {
        const why = stderrHead(logFile);
        throw new LaunchError(
          'not-started',
          `claude exited before the session was confirmed${why === null ? '' : `: ${why}`}.`
        );
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(pollMs);
    }

    await stopRecordedPid(child.pid, stopDeps);
    if (init !== null) {
      throw new LaunchError(
        'wrong-account',
        `The session started, but its transcript never appeared under ${configDir}, so it is not running on that account; flow stopped it.`
      );
    }
    throw new LaunchError(
      'not-started',
      `The session did not confirm within ${Math.round(timeoutMs / 1000)} s; flow stopped it.`
    );
  }

  async function send(h: SessionHandle, messageFile: string): Promise<SendResult> {
    validateMessageFile(messageFile);
    if (h.logFile === undefined || h.configDir === undefined || h.permissionMode === undefined) {
      throw new LaunchError(
        'bad-request',
        'This handle has no log file, config dir or permission mode, so it is not a cli session flow started.'
      );
    }
    if (h.pid !== undefined && deps.isAlive(h.pid)) {
      const inbox = drainDir(h.cwd, 'inbox', h.sessionId);
      mkdirSync(inbox, { recursive: true });
      const seq = readdirSync(inbox).filter((name) => /^\d+\.md$/.test(name)).length + 1;
      writeFileSync(
        path.join(inbox, `${String(seq).padStart(4, '0')}.md`),
        `${pointerLine(messageFile)}\n`
      );
      return { result: 'queued', handle: h };
    }
    const args = [
      '-p',
      pointerLine(messageFile),
      '--resume',
      h.sessionId,
      ...streamArgs(h.permissionMode, h.model),
    ];
    const child = spawnClaude(args, h.cwd, h.configDir, h.logFile);
    return { result: 'delivered', handle: { ...h, pid: child.pid } };
  }

  async function state(h: SessionHandle): Promise<SessionState> {
    if (h.pid !== undefined && deps.isAlive(h.pid)) return { kind: 'busy' };
    if (h.logFile === undefined) {
      return { kind: 'unknown', reason: 'this handle has no stream log to read' };
    }
    // The stream first; the transcript when the stream names no window (a
    // Claude Code version whose stream carries no rate_limit_event).
    let limit = streamLimit(h.logFile);
    if ((limit === null || limit.window === null) && h.configDir !== undefined) {
      const transcript = findTranscript(h.configDir, h.sessionId);
      const fromTranscript = transcript === null ? null : transcriptLimit(transcript);
      if (fromTranscript !== null) limit = fromTranscript;
    }
    if (limit !== null) return { kind: 'limited', window: limit.window, resetsAt: limit.resetsAt };
    let code: number | null = null;
    try {
      const recorded: unknown = JSON.parse(readFileSync(exitFile(h.logFile), 'utf8'));
      if (
        typeof recorded === 'object' &&
        recorded !== null &&
        (recorded as { pid?: unknown }).pid === h.pid &&
        typeof (recorded as { code?: unknown }).code === 'number'
      ) {
        code = (recorded as { code: number }).code;
      }
    } catch {
      // The supervisor was not running when the child exited.
    }
    return { kind: 'exited', code };
  }

  async function stop(h: SessionHandle): Promise<StopResult> {
    if (h.pid === undefined) return 'not-running';
    return stopRecordedPid(h.pid, stopDeps);
  }

  return { host: 'cli', probe, start, send, state, stop };
}
