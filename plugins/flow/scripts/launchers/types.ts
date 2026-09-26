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

/** An agent runtime flow can run a session on (the DorkOS runtime slugs). */
export type RuntimeName = 'claude-code' | 'codex' | 'opencode';

/** Every {@link RuntimeName}. */
export const RUNTIME_NAMES: readonly RuntimeName[] = ['claude-code', 'codex', 'opencode'];

/**
 * The runtime of a stored handle: its own, or `claude-code` for a handle
 * written before launchers were runtime-aware (every such session was Claude
 * Code). Lives here, not beside the on-disk schema, so zero-dependency modules
 * can read a stored handle without loading zod.
 *
 * @param handle - A handle read from the run store.
 * @returns Its runtime.
 */
export function handleRuntime(handle: { runtime?: RuntimeName }): RuntimeName {
  return handle.runtime ?? 'claude-code';
}

/**
 * The id of a runtime's implicit account: the ambient environment. A runtime
 * with no registered accounts has exactly this one (RUNTIMES.md R1).
 */
export const DEFAULT_ACCOUNT_ID = 'default';

/** The permission mode a session starts (and resumes) in. */
export type LaunchPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * An account a session bills: one billing identity of ONE runtime.
 *
 * `path` is the runtime's own home for that identity:
 *
 * - `claude-code`: the account's absolute `CLAUDE_CONFIG_DIR`.
 * - `codex`: the account's absolute `CODEX_HOME`.
 * - `opencode`: always `null` today. An OpenCode account is a provider
 *   credential, named by {@link LaunchAccount.provider}, not a folder.
 *
 * A `path` of `null` means the ambient environment: the runtime's own home as
 * the supervisor resolves it. The implicit {@link DEFAULT_ACCOUNT_ID} account is
 * `{ runtime, id: 'default', path: null }`.
 */
export interface LaunchAccount {
  /** The runtime this account belongs to; must match the request's runtime. */
  runtime: RuntimeName;
  /** The registry id (`flow-cli-core` §1.1a), or {@link DEFAULT_ACCOUNT_ID}. */
  id: string;
  /** The runtime's home for this account (absolute), or `null` for the ambient one. */
  path: string | null;
  /**
   * opencode: the provider id this account bills (`openrouter`, `anthropic`, ...).
   * When set, the session's model must come from this provider.
   */
  provider?: string;
}

/** What the runner asks a launcher to start. */
export interface LaunchRequest {
  /** Whether the session writes the change or reviews it. */
  role: 'worker' | 'reviewer';
  /** The runtime the session runs on. A host that cannot run it throws `unsupported`. */
  runtime: RuntimeName;
  /** The tracker item, for titles and logs. */
  identifier: string;
  /** The account to bill (of {@link LaunchRequest.runtime}), or `null` for the ambient account (spec §3.4). */
  account: LaunchAccount | null;
  /** The session's working folder; absolute and existing. */
  cwd: string;
  /** The first message's content; absolute and existing. */
  promptFile: string;
  /**
   * A fresh UUID the caller minted. A host may replace it (spec §2.6); the cli
   * host's codex and opencode sessions always do, since both mint their own id.
   */
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
  /**
   * The runtime the session runs on. A record written before runtimes existed
   * has none and reads as `claude-code` (the on-disk schema defaults it).
   */
  runtime: RuntimeName;
  /** The harness session id (for codex, the thread id; for opencode, `ses_...`). */
  sessionId: string;
  /** The registry id of the account the session bills, or `null` for the ambient account. */
  account: string | null;
  /** The session's working folder (absolute). */
  cwd: string;
  /** cli, cmux: the runtime process flow started (`claude`, `codex` or `opencode`). */
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
   * cli, cmux: the runtime home the session runs in, so a resume lands on the
   * same account and the transcript can be found again: the `CLAUDE_CONFIG_DIR`
   * for claude-code, the `CODEX_HOME` for codex (the account's path, or the
   * supervisor's resolved ambient one). opencode sessions have none.
   */
  configDir?: string;
  /** cli codex: the plan the session's rollout reported (`plan_type`), once it reported one. */
  plan?: string;
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

/** Whether a host can run a runtime at all, and why not. Static: no probe involved. */
export type SupportResult = { ok: true } | { ok: false; reason: string };

/** One host flow can start sessions under. */
export interface Launcher {
  /** Which host this is. */
  readonly host: HostName;
  /** Whether this host can run `runtime` at all (see `supportFor` in `support.ts`). Pure. */
  supports(runtime: RuntimeName): SupportResult;
  /**
   * Can this host start a session right now? Never throws. `runtime` (default
   * `claude-code`) matters only where the host runs the runtime's own binary
   * (cli: `<binary> --version`); cmux and DorkOS ignore it.
   */
  probe(runtime?: RuntimeName): Promise<ProbeResult>;
  /**
   * Start a session and deliver the first message. Throws {@link LaunchError};
   * `unsupported` for a runtime {@link Launcher.supports} refuses, before
   * anything starts, and never another host or runtime in its place.
   */
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
 * - `unsupported`: this host cannot run the requested runtime; nothing was started.
 * - `wrong-account`: the session bills an account other than the one asked for.
 * - `wrong-runtime`: the host started the session on another runtime than the one asked for.
 * - `not-started`: the session never confirmed within the start timeout.
 * - `auth`: the host refused the credentials flow has.
 * - `refused`: the host's own guard said no; never retried another way.
 */
export type LaunchErrorCode =
  | 'unavailable'
  | 'bad-request'
  | 'unsupported'
  | 'wrong-account'
  | 'wrong-runtime'
  | 'not-started'
  | 'auth'
  | 'refused';

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
