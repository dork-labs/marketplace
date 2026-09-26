/**
 * The cmux launcher (spec `flow-handoff-dispatch` §2.4): each session is an
 * interactive `claude` in a new cmux workspace, driven by the sequence proven
 * by hand in cmux-control.
 *
 * - **probe:** `cmux identify --json` exits 0.
 * - **start:** `cmux workspace create --name <title> --cwd <cwd> --focus false
 *   --json --command "<line>"`, where the line strips every credential variable
 *   and sets `CLAUDE_CONFIG_DIR` explicitly (a cmux shell does not inherit the
 *   supervisor's environment, and may export credentials of its own). Then the
 *   session's pid from `<config dir>/sessions/<pid>.json`, its surface from
 *   `cmux top`, and the first message as a one-line pointer sent to that
 *   surface. Confirmed when the transcript appears under the config dir.
 * - **send:** re-resolve the surface from the pid (surface numbers change across
 *   a cmux restart) and send the pointer; Claude Code queues input typed while
 *   busy. An exited session is resumed in a new workspace with `--resume`.
 * - **state:** the session file's status, a limit in the transcript, or exited.
 * - **stop:** SIGTERM the recorded pid (after the `ps` check), then rename the
 *   workspace "<title> (stopped)". The workspace stays for the operator.
 *
 * Every outside effect comes in through {@link CmuxLauncherDeps}, so the
 * contract suite runs it against a fake `cmux` on a temp PATH.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/launchers/cmux
 */

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realProcessRunner, type ProcessRunner } from '../cli/context.ts';
import { transcriptLimit } from '../drain/stream-log.ts';
import { pidExists } from '../fleet/sessions.ts';
import {
  CREDENTIAL_ENV_VARS,
  DEFAULT_START_TIMEOUT_MS,
  pointerLine,
  sessionConfigDir,
  stopRecordedPid,
  validateLaunchRequest,
  validateMessageFile,
} from './common.ts';
import { findTranscript, proveAccount } from './prove-account.ts';
import { shellQuote } from './shell-quote.ts';
import {
  LaunchError,
  type LaunchPermissionMode,
  type LaunchRequest,
  type Launcher,
  type ProbeResult,
  type SendResult,
  type SessionHandle,
  type SessionState,
  type StopResult,
} from './types.ts';

/** How long `start` waits for the session file that names the pid, unless told otherwise. */
export const DEFAULT_PID_TIMEOUT_MS = 30_000;

/** Everything the cmux launcher touches outside its own memory. */
export interface CmuxLauncherDeps {
  /** Runs `cmux` and `ps` (no shell). */
  run: ProcessRunner;
  /** Whether a pid exists. */
  isAlive: (pid: number) => boolean;
  /** Sends a signal to a pid. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The supervisor's environment (for `CMUX_BUNDLED_CLI_PATH` and the ambient config dir). */
  env: Readonly<Record<string, string | undefined>>;
  /** The OS home folder, for the ambient `~/.claude`. */
  osHome: string;
  /** The clock, in epoch milliseconds. */
  now: () => number;
  /** Waits. */
  sleep: (ms: number) => Promise<void>;
  /** How long `start` waits for confirmation. Default 90 s. */
  startTimeoutMs?: number;
  /** How long `start` and a resume wait for the session file naming the pid. Default 30 s. */
  pidTimeoutMs?: number;
  /** How often they look. Default 500 ms. */
  pollMs?: number;
}

/**
 * The real dependencies: `execFile`, `process.kill`, the process environment
 * and clock.
 *
 * @returns Deps for {@link createCmuxLauncher}.
 */
export function realCmuxLauncherDeps(): CmuxLauncherDeps {
  return {
    run: realProcessRunner,
    isAlive: pidExists,
    kill: (pid, signal) => process.kill(pid, signal),
    env: process.env,
    osHome: os.homedir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * The surface a process runs in, from `cmux top --all --processes --format tsv`
 * (columns: cpu, memory, process count, kind, ref, parent ref, title).
 *
 * A process row's parent is a surface, another process (a login shell), or a
 * status tag that lists the same process again; the walk follows process
 * parents up to the first surface and never treats a tag as one.
 *
 * @param tsv - The command's output.
 * @param pid - The process to place.
 * @returns The surface ref (`surface:N`), or `null` when no surface hosts it.
 */
export function surfaceForPid(tsv: string, pid: number): string | null {
  const parents = new Map<string, string[]>();
  for (const line of tsv.split('\n')) {
    const cols = line.split('\t');
    if (cols[3] !== 'process' || cols[4] === undefined || cols[5] === undefined) continue;
    const list = parents.get(cols[4]) ?? [];
    list.push(cols[5]);
    parents.set(cols[4], list);
  }
  const seen = new Set<string>();
  let frontier = [String(pid)];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const ref of frontier) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      for (const parent of parents.get(ref) ?? []) {
        if (parent.startsWith('surface:')) return parent;
        if (/^\d+$/.test(parent)) next.push(parent);
      }
    }
    frontier = next;
  }
  return null;
}

/** The first non-empty line of a text, or `null`. */
function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? null;
}

/** What a session file says, when it is readable. */
interface SessionFile {
  sessionId: string | null;
  status: string | null;
}

/** Read `<configDir>/sessions/<pid>.json`. */
function readSessionFile(configDir: string, pid: number): SessionFile | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')
    );
    if (typeof raw !== 'object' || raw === null) return null;
    const { sessionId, status } = raw as { sessionId?: unknown; status?: unknown };
    return {
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      status: typeof status === 'string' ? status : null,
    };
  } catch {
    return null;
  }
}

/** Refuse a file path cmux `send` would read escapes in (`\n`, `\t`, ...). */
function refuseBackslash(name: string, file: string): void {
  if (file.includes('\\')) {
    throw new LaunchError(
      'bad-request',
      `${name} ${file} holds a backslash, which cmux would read as an escape.`
    );
  }
}

/**
 * The one shell line: strip every credential variable, name the config dir,
 * run claude. Session ids and permission modes are validated to shell-safe
 * words; the config dir and the model are quoted.
 */
function commandLine(configDir: string, claudeArgs: readonly string[], model?: string): string {
  const strip = CREDENTIAL_ENV_VARS.map((name) => `-u ${name}`).join(' ');
  const words = [...claudeArgs];
  if (model !== undefined) words.push('--model', shellQuote(model));
  return `env ${strip} CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude ${words.join(' ')}`;
}

/**
 * Create the cmux launcher.
 *
 * @param deps - Process, clock and environment access (see {@link realCmuxLauncherDeps}).
 * @returns The launcher.
 */
export function createCmuxLauncher(deps: CmuxLauncherDeps): Launcher {
  const bundled = deps.env.CMUX_BUNDLED_CLI_PATH;
  const bin = bundled !== undefined && bundled !== '' ? bundled : 'cmux';
  const timeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pidTimeoutMs = deps.pidTimeoutMs ?? DEFAULT_PID_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 500;
  const stopDeps = { run: deps.run, isAlive: deps.isAlive, kill: deps.kill };

  /** Run one cmux subcommand; a failure to run or a non-zero exit is `unavailable`. */
  async function cmux(args: string[], what: string): Promise<string> {
    let result;
    try {
      result = await deps.run(bin, args, { timeoutMs: 30_000 });
    } catch (error) {
      throw new LaunchError('unavailable', `cmux could not ${what}: ${(error as Error).message}`);
    }
    if (result.code !== 0) {
      const why = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;
      throw new LaunchError('unavailable', `cmux could not ${what}: ${why}`);
    }
    return result.stdout;
  }

  async function probe(): Promise<ProbeResult> {
    let why: string;
    try {
      const result = await deps.run(bin, ['identify', '--json'], { timeoutMs: 10_000 });
      if (result.code === 0) return { ok: true };
      why = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;
    } catch (error) {
      why = firstLine((error as Error).message) ?? 'it could not be run';
    }
    return { ok: false, reason: `cmux is not running (${why})` };
  }

  /** Create a workspace running `line`, and return its ref. */
  async function createWorkspace(title: string, cwd: string, line: string): Promise<string> {
    const stdout = await cmux(
      [
        'workspace',
        'create',
        '--name',
        title,
        '--cwd',
        cwd,
        '--focus',
        'false',
        '--json',
        '--command',
        line,
      ],
      'create a workspace'
    );
    let ref: unknown;
    try {
      ref = (JSON.parse(stdout) as { workspace_ref?: unknown }).workspace_ref;
    } catch {
      ref = undefined;
    }
    if (typeof ref !== 'string' || ref === '') {
      throw new LaunchError('unavailable', 'cmux created a workspace but did not name it.');
    }
    return ref;
  }

  /** Wait for a live pid whose session file names `sessionId` (other than `exclude`). */
  async function waitForPid(
    configDir: string,
    sessionId: string,
    exclude: number | undefined
  ): Promise<number | null> {
    const deadline = deps.now() + pidTimeoutMs;
    const dir = path.join(configDir, 'sessions');
    for (;;) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        // Not written yet.
      }
      for (const name of names) {
        const match = /^(\d+)\.json$/.exec(name);
        if (match === null) continue;
        const pid = Number(match[1]);
        if (pid === exclude || !deps.isAlive(pid)) continue;
        if (readSessionFile(configDir, pid)?.sessionId === sessionId) return pid;
      }
      if (deps.now() >= deadline) return null;
      await deps.sleep(pollMs);
    }
  }

  /** The surface hosting `pid` now, or `null`. */
  async function resolveSurface(pid: number): Promise<string | null> {
    const stdout = await cmux(
      ['top', '--all', '--processes', '--format', 'tsv'],
      'list its processes'
    );
    return surfaceForPid(stdout, pid);
  }

  /** Wait for a surface to host `pid`. */
  async function waitForSurface(pid: number): Promise<string | null> {
    const deadline = deps.now() + pidTimeoutMs;
    for (;;) {
      const surface = await resolveSurface(pid);
      if (surface !== null) return surface;
      if (deps.now() >= deadline) return null;
      await deps.sleep(pollMs);
    }
  }

  /** Type the pointer into a surface, with cmux's `\n` escape so it submits. */
  async function sendPointer(surface: string, file: string): Promise<void> {
    await cmux(
      ['send', '--surface', surface, '--', `${pointerLine(file)}\\n`],
      `send to ${surface}`
    );
  }

  /** Whether the handle's pid is alive and still our session. */
  function ours(h: SessionHandle): boolean {
    if (h.pid === undefined || h.configDir === undefined || !deps.isAlive(h.pid)) return false;
    return readSessionFile(h.configDir, h.pid)?.sessionId === h.sessionId;
  }

  /** Rename the workspace "<title> (stopped)"; the session is already stopped, so a failure is ignored. */
  async function markStopped(h: SessionHandle): Promise<void> {
    if (h.workspace === undefined) return;
    try {
      await deps.run(
        bin,
        ['workspace', 'rename', h.workspace, '--title', `${h.title ?? h.sessionId} (stopped)`],
        { timeoutMs: 30_000 }
      );
    } catch {
      // The workspace is gone or cmux quit; nothing left to label.
    }
  }

  /** Stop a session flow started, after the checks, and label its workspace. */
  async function stopHandle(h: SessionHandle): Promise<StopResult> {
    if (h.pid === undefined) return 'not-running';
    if (h.configDir !== undefined) {
      const file = readSessionFile(h.configDir, h.pid);
      if (file !== null && file.sessionId !== h.sessionId) return 'not-running';
    }
    const result = await stopRecordedPid(h.pid, stopDeps);
    if (result === 'stopped') await markStopped(h);
    return result;
  }

  /**
   * Open a workspace running `claude` with `claudeArgs`, find its pid and
   * surface, and send the pointer at `file`.
   */
  async function launch(
    h: SessionHandle,
    claudeArgs: string[],
    file: string,
    exclude: number | undefined
  ): Promise<SessionHandle> {
    const configDir = h.configDir as string;
    const line = commandLine(configDir, claudeArgs, h.model);
    const workspace = await createWorkspace(h.title ?? h.sessionId, h.cwd, line);
    const withWorkspace: SessionHandle = { ...h, workspace };
    const pid = await waitForPid(configDir, h.sessionId, exclude);
    if (pid === null) {
      await markStopped(withWorkspace);
      throw new LaunchError(
        'not-started',
        `claude never wrote a session file for ${h.sessionId} under ${path.join(configDir, 'sessions')} within ${Math.round(pidTimeoutMs / 1000)} s.`
      );
    }
    const withPid: SessionHandle = { ...withWorkspace, pid };
    const surface = await waitForSurface(pid);
    if (surface === null) {
      await stopHandle(withPid);
      throw new LaunchError(
        'not-started',
        `No cmux surface hosts the session's process (${pid}); flow stopped it.`
      );
    }
    const handle: SessionHandle = { ...withPid, surface };
    await sendPointer(surface, file);
    return handle;
  }

  async function start(req: LaunchRequest): Promise<SessionHandle> {
    validateLaunchRequest(req);
    refuseBackslash('promptFile', req.promptFile);
    const configDir = sessionConfigDir(req.account, deps.env, deps.osHome);
    // Build (and so validate) the shell line before anything starts.
    commandLine(configDir, [], req.model);
    const probed = await probe();
    if (!probed.ok) throw new LaunchError('unavailable', probed.reason);

    const base: SessionHandle = {
      host: 'cmux',
      sessionId: req.sessionId,
      account: req.account?.id ?? null,
      cwd: req.cwd,
      configDir,
      permissionMode: req.permissionMode,
      title: req.title,
      ...(req.model === undefined ? {} : { model: req.model }),
    };
    const deadline = deps.now() + timeoutMs;
    const handle = await launch(
      base,
      ['--session-id', req.sessionId, '--permission-mode', req.permissionMode],
      req.promptFile,
      undefined
    );
    const pid = handle.pid as number;

    let sawBusy = false;
    for (;;) {
      if (proveAccount(configDir, req.sessionId)) return handle;
      if (!deps.isAlive(pid)) {
        await markStopped(handle);
        throw new LaunchError('not-started', 'claude exited before the session was confirmed.');
      }
      if (readSessionFile(configDir, pid)?.status === 'busy') sawBusy = true;
      if (deps.now() >= deadline) break;
      await deps.sleep(pollMs);
    }

    await stopHandle(handle);
    if (sawBusy) {
      throw new LaunchError(
        'wrong-account',
        `The session went busy, but its transcript never appeared under ${configDir}, so it is not running on that account; flow stopped it.`
      );
    }
    throw new LaunchError(
      'not-started',
      `The session stayed idle with no transcript for ${Math.round(timeoutMs / 1000)} s, so the first message never arrived; flow stopped it.`
    );
  }

  async function send(h: SessionHandle, messageFile: string): Promise<SendResult> {
    validateMessageFile(messageFile);
    refuseBackslash('The message file', messageFile);
    if (h.configDir === undefined || h.permissionMode === undefined) {
      throw new LaunchError(
        'bad-request',
        'This handle has no config dir or permission mode, so it is not a cmux session flow started.'
      );
    }
    if (ours(h)) {
      const surface = await resolveSurface(h.pid as number);
      if (surface === null) {
        throw new LaunchError(
          'unavailable',
          `The session's process (${h.pid}) is running, but no cmux surface hosts it.`
        );
      }
      await sendPointer(surface, messageFile);
      return { result: 'delivered', handle: { ...h, surface } };
    }
    const mode: LaunchPermissionMode = h.permissionMode;
    const handle = await launch(
      h,
      ['--resume', h.sessionId, '--permission-mode', mode],
      messageFile,
      h.pid
    );
    return { result: 'delivered', handle };
  }

  async function state(h: SessionHandle): Promise<SessionState> {
    const alive = ours(h);
    const status =
      alive && h.configDir !== undefined ? readSessionFile(h.configDir, h.pid as number) : null;
    if (status?.status === 'busy') return { kind: 'busy' };
    const transcript = h.configDir === undefined ? null : findTranscript(h.configDir, h.sessionId);
    const limit = transcript === null ? null : transcriptLimit(transcript);
    if (limit !== null) return { kind: 'limited', window: limit.window, resetsAt: limit.resetsAt };
    if (alive) return { kind: 'idle' };
    return { kind: 'exited', code: null };
  }

  return { host: 'cmux', probe, start, send, state, stop: stopHandle };
}
