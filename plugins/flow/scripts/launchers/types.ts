/**
 * The launcher types (spec `flow-handoff-dispatch` §2.1): how flow names the
 * host a session runs under, what it asks a host for, the handle it keeps for
 * the session, and the {@link Launcher} interface every host implements.
 *
 * The run record stores a {@link SessionHandle} in `FlowRun.drain.worker` and
 * `.reviewer`, so a later pass or a restarted supervisor can adopt the session.
 *
 * Dependency-free: types and one error class only.
 *
 * @module @dorkos/flow/launchers/types
 */

/** A host flow can start sessions under: the plain CLI, cmux, or DorkOS. */
export type HostName = 'cli' | 'cmux' | 'dorkos';

/** Every {@link HostName}, in the order `auto` resolution tries them. */
export const HOST_NAMES: readonly HostName[] = ['cmux', 'dorkos', 'cli'];

/** The permission mode a session starts (and resumes) in. */
export type LaunchPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** A registered account a session bills. */
export interface LaunchAccount {
  /** The registry id (`flow-cli-core` §1.1a). */
  id: string;
  /** The account's absolute `CLAUDE_CONFIG_DIR`. */
  path: string;
}

/** What the runner asks a launcher to start. */
export interface LaunchRequest {
  /** Whether the session writes the change or reviews it. */
  role: 'worker' | 'reviewer';
  /** The tracker item, for titles and logs. */
  identifier: string;
  /** The account to bill, or `null` for the ambient account (spec §3.4). */
  account: LaunchAccount | null;
  /** The session's working folder; absolute and existing. */
  cwd: string;
  /** The first message's content; absolute and existing. */
  promptFile: string;
  /** A fresh UUID the caller minted. A host may replace it (spec §2.6). */
  sessionId: string;
  /** A `models.bindings` value, when the role binds one. */
  model?: string;
  /** The permission mode the session runs in. */
  permissionMode: LaunchPermissionMode;
  /** A short title, e.g. "ACME-12 worker". */
  title: string;
}

/**
 * A session flow started, and everything needed to reach it again.
 *
 * On disk `host` is checked only as a string, like `FlowRun.host`, so a record
 * written by a future launcher still reads; code that meets a host it does not
 * know leaves that session alone.
 */
export interface SessionHandle {
  /** The host the session runs under. */
  host: HostName;
  /** The harness session id. */
  sessionId: string;
  /** The registry id of the account the session bills, or `null` for the ambient account. */
  account: string | null;
  /** The session's working folder (absolute). */
  cwd: string;
  /** cli, cmux: the `claude` process flow started. */
  pid?: number;
  /** cmux: the surface the session runs in. */
  surface?: string;
  /** cmux: the workspace that holds the surface. */
  workspace?: string;
  /** cmux: the workspace's title, so `stop` can rename it "<title> (stopped)". */
  title?: string;
  /** cli: the stream-json log the session writes. */
  logFile?: string;
  /** cli: bytes of {@link logFile} already read. */
  logOffset?: number;
  /**
   * cli, cmux: the `CLAUDE_CONFIG_DIR` the session runs in (the account's path,
   * or the supervisor's resolved ambient dir), so a resume lands on the same
   * account and the transcript can be found again.
   */
  configDir?: string;
  /** cli, cmux: the permission mode, passed again on resume (it is not restored). */
  permissionMode?: LaunchPermissionMode;
  /** cli, cmux: the model the session was started with, passed again on resume. */
  model?: string;
  /**
   * dorkos: how the session was started, so recovery can tell whether DorkOS
   * minted its id (`mcp`, the `session_start` tool) or flow did (`route`, the
   * messages route; DorkOS may still have rebound it).
   */
  launchPath?: 'mcp' | 'route';
}

/**
 * What a session is doing, as its host reports it.
 *
 * - `busy`: a turn is running.
 * - `idle`: alive and waiting for input.
 * - `exited`: the process is gone; `code` is its exit code when known.
 * - `limited`: the session hit a rate limit; `window` and `resetsAt` when known.
 * - `unknown`: the host cannot say; `reason` is a plain sentence.
 */
export type SessionState =
  | { kind: 'busy' }
  | { kind: 'idle' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'limited'; window: string | null; resetsAt: string | null }
  | { kind: 'unknown'; reason: string };

/** A probe's answer: the host can start a session now, or why not. */
export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** What {@link Launcher.send} did: handed it over now, or left it for the runner. */
export interface SendResult {
  /** `delivered` when the session has the message; `queued` when the runner delivers it later. */
  result: 'delivered' | 'queued';
  /** The handle, updated when a resume started a new process. */
  handle: SessionHandle;
}

/** What {@link Launcher.stop} did. */
export type StopResult = 'stopped' | 'left-idle' | 'not-running';

/** One host flow can start sessions under. */
export interface Launcher {
  /** Which host this is. */
  readonly host: HostName;
  /** Can this host start a session right now? Never throws. */
  probe(): Promise<ProbeResult>;
  /** Start a session and deliver the first message. Throws {@link LaunchError}. */
  start(req: LaunchRequest): Promise<SessionHandle>;
  /** Deliver a message file to a session, resuming it if it has exited. */
  send(h: SessionHandle, messageFile: string): Promise<SendResult>;
  /** What the session is doing now. */
  state(h: SessionHandle): Promise<SessionState>;
  /** Stop a session flow started. Never kills anything flow did not start. */
  stop(h: SessionHandle): Promise<StopResult>;
}

/**
 * Why a launch failed.
 *
 * - `unavailable`: the host is not there (the probe's reason).
 * - `bad-request`: the request failed validation; nothing was started.
 * - `wrong-account`: the session bills an account other than the one asked for.
 * - `not-started`: the session never confirmed within the start timeout.
 * - `auth`: the host refused the credentials flow has.
 * - `refused`: the host's own guard said no; never retried another way.
 */
export type LaunchErrorCode =
  'unavailable' | 'bad-request' | 'wrong-account' | 'not-started' | 'auth' | 'refused';

/** A launch that failed, with a {@link LaunchErrorCode} the runner branches on. */
export class LaunchError extends Error {
  /** Why it failed. */
  readonly code: LaunchErrorCode;

  /**
   * Create a launch error.
   *
   * @param code - Why it failed.
   * @param message - A plain sentence for the person reading the report.
   */
  constructor(code: LaunchErrorCode, message: string) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
  }
}
