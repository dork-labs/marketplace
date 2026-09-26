/**
 * The agent runtime a `flow` command runs under, and that runtime's own session
 * id, read from the environment the runtime gives every shell command it runs.
 * The runtime itself comes from the shared `../runtime-detect.ts`; this module
 * adds only the session id, which the flow CLI needs for `FlowRun.sessionId`.
 *
 * | Runtime       | Session id                                                                                          |
 * | ------------- | --------------------------------------------------------------------------------------------------- |
 * | `claude-code` | `CLAUDE_CODE_SESSION_ID`                                                                            |
 * | `codex`       | `CODEX_THREAD_ID`                                                                                   |
 * | `opencode`    | none: OpenCode puts no session id in a command's environment, so a caller passes `--session`        |
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/cli/session-id
 */

import { detectRuntime, type Runtime } from '../runtime-detect.ts';

/** What {@link runtimeSession} found. */
export interface RuntimeSession {
  /** The runtime, or `null` when no known runtime launched this process. */
  runtime: Exclude<Runtime, 'unknown'> | null;
  /** The runtime's own session id, or `null` when it gives none. */
  sessionId: string | null;
}

/** A non-empty value, else `null`. */
function present(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/**
 * The runtime and that runtime's own session id. The runtime is `named` when the
 * caller knows it (`flow claim --runtime`), else what `detectRuntime` finds, so
 * a named runtime also decides which variable the session id comes from.
 *
 * @param env - The environment.
 * @param named - The runtime the caller named, if any.
 * @returns The runtime and session id, each `null` when unknown.
 */
export function runtimeSession(
  env: Readonly<Record<string, string | undefined>>,
  named?: Exclude<Runtime, 'unknown'>
): RuntimeSession {
  const runtime = named ?? detectRuntime(env).runtime;
  if (runtime === 'claude-code') {
    return { runtime, sessionId: present(env.CLAUDE_CODE_SESSION_ID) };
  }
  if (runtime === 'codex') return { runtime, sessionId: present(env.CODEX_THREAD_ID) };
  if (runtime === 'opencode') return { runtime, sessionId: null };
  return { runtime: null, sessionId: null };
}
