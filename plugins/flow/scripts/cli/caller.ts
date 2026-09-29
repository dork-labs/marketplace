/**
 * Which session is running a verb, as far as flow can tell: the session id
 * the verb was given (`--session`, `FLOW_SESSION_ID`) and the runtime's own
 * (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`). A check that must come from
 * someone other than the agent it checks refuses a caller whose ids include
 * that agent's session.
 *
 * This is a guard against an agent answering its own question by accident or
 * by habit, not a boundary: any process on the machine can claim any session
 * id, and `flow-state.json` is a file an agent can write. The spec records the
 * residual (`flow-multiproject` §7.5).
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/cli/caller
 */

import { PreconditionError } from '../errors.ts';
import type { VerbContext } from './context.ts';
import { runtimeSession } from './session-id.ts';

/**
 * Every session id the caller goes by.
 *
 * @param ctx - The verb's context.
 * @returns The ids, without duplicates; empty when none is known.
 */
export function callerSessions(ctx: VerbContext): string[] {
  const ids = [ctx.sessionId, runtimeSession(ctx.env).sessionId ?? undefined];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/**
 * Refuse a caller that is, or may be, one of `sessions`.
 *
 * @param ctx - The verb's context.
 * @param sessions - The sessions that may not do this (empty strings ignored).
 * @param what - What is refused, for the message.
 * @throws {PreconditionError} When the caller names no session, or is one of them.
 */
export function requireOtherSession(
  ctx: VerbContext,
  sessions: readonly (string | undefined)[],
  what: string
): void {
  const mine = callerSessions(ctx);
  if (mine.length === 0) {
    throw new PreconditionError(
      `flow could not tell which session is asking to ${what}; run it from the checking session, or pass --session <its id>`
    );
  }
  const barred = new Set(
    sessions.filter((id): id is string => typeof id === 'string' && id !== '')
  );
  if (mine.some((id) => barred.has(id))) {
    throw new PreconditionError(
      `the session that did the work cannot ${what}; an independent session has to`
    );
  }
}
