/**
 * The launcher types (spec `flow-handoff-dispatch` §2.1): how flow names the
 * host a session runs under and the handle it keeps for that session.
 *
 * The run record stores a {@link SessionHandle} in `FlowRun.drain.worker` and
 * `.reviewer`, so a later pass or a restarted supervisor can adopt the session.
 * The `Launcher` interface itself (probe, start, send, state, stop) joins this
 * file with the launchers.
 *
 * Dependency-free: types only.
 *
 * @module @dorkos/flow/launchers/types
 */

/** A host flow can start sessions under: the plain CLI, cmux, or DorkOS. */
export type HostName = 'cli' | 'cmux' | 'dorkos';

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
  /** cli: the stream-json log the session writes. */
  logFile?: string;
  /** cli: bytes of {@link logFile} already read. */
  logOffset?: number;
}
