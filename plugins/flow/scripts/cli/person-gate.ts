/**
 * The checks a verb that acts as the person makes first (DOR-3712,
 * DOR-3716): `flow answer --text`, `flow review --approve --by person` and
 * `flow review --changes`.
 *
 * - {@link requirePersonShell}: refuse a shell inside an agent. An agent's
 *   shell carries its runtime's markers (Claude Code, Codex, OpenCode); any
 *   `FLOW_RUNTIME`, known or not, and DorkOS's agent token
 *   (`DORKOS_AGENT_TOKEN`) count as an agent too. DorkOS runs these verbs
 *   with all of them removed (`withoutAgent`), since the person who clicked
 *   is the one acting.
 * - {@link refuseSessions}: the second guard, for a caller with no agent's
 *   markers that still carries a session id. Every session variable present
 *   counts ({@link callerSessionIds}), not only the one whose runtime marker
 *   is set, so an agent that dropped its markers but kept its session id is
 *   still refused (Security's probe on DOR-3716). OpenCode puts no session id
 *   in a command's environment, so it is caught by its marker or `--session`.
 * - {@link sessionsThatWorked}: the sessions refused, the same for every verb.
 *
 * Their refusals are read by the agent they stop, so they say to stop and
 * hand the decision to the person, never how to get past the check (Security
 * M1 on DOR-3712). How a person acts from their own terminal is in the docs
 * and `--help` only. A guard, not a boundary: any process can unset these
 * variables (see `caller.ts`).
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/cli/person-gate
 */

import { PreconditionError } from '../errors.ts';
import { detectRuntime } from '../runtime-detect.ts';
import type { FlowRun } from '../flow-run.ts';
import type { VerbContext } from './context.ts';

/** The variables a runtime or flow puts a session id in. */
const SESSION_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'FLOW_SESSION_ID'] as const;

/**
 * Every session id the caller carries: the verb's own (`--session`, else
 * `FLOW_SESSION_ID`) and every session variable present, whichever runtime's
 * marker is set or not.
 *
 * @param ctx - The verb's context.
 * @returns The ids, without duplicates.
 */
export function callerSessionIds(ctx: VerbContext): string[] {
  const ids = [ctx.sessionId, ...SESSION_VARS.map((name) => ctx.env[name])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/**
 * Every session that worked an item: the run's own, its drain worker and
 * reviewer, its VERIFY reviewer, the session that asked its question and that
 * question's checker. None of them may act as the person on it.
 *
 * @param run - The item's run.
 * @returns Their ids, possibly with gaps.
 */
export function sessionsThatWorked(run: FlowRun | undefined): (string | undefined)[] {
  return [
    run?.sessionId,
    run?.drain?.worker?.sessionId,
    run?.drain?.reviewer?.sessionId,
    run?.review?.reviewer?.sessionId,
    run?.question?.askedBy,
    run?.question?.checker?.sessionId,
  ];
}

/**
 * The agent this environment runs inside, or `null` for a person's shell.
 *
 * @param env - The environment.
 * @returns A name for the agent (`claude-code`, `a DorkOS agent`, …), or `null`.
 */
export function agentIn(env: Readonly<Record<string, string | undefined>>): string | null {
  const detected = detectRuntime(env);
  const named = (env.FLOW_RUNTIME ?? '').trim() !== '';
  const dorkosTurn = (env.DORKOS_AGENT_TOKEN ?? '') !== '';
  if (detected.runtime === 'unknown' && detected.markers.length === 0 && !named && !dorkosTurn) {
    return null;
  }
  // A FLOW_RUNTIME flow does not know (a launcher naming itself) still says an
  // agent runs here, and so does DorkOS's agent token.
  if (detected.runtime !== 'unknown') return detected.runtime;
  return detected.markers[0] ?? (dorkosTurn ? 'a DorkOS agent' : 'an agent runtime');
}

/**
 * Refuse a shell inside an agent.
 *
 * @param ctx - The verb's context.
 * @param refusal - The message, given the agent's name.
 * @throws {PreconditionError} When the shell is an agent's.
 */
export function requirePersonShell(ctx: VerbContext, refusal: (agent: string) => string): void {
  const agent = agentIn(ctx.env);
  if (agent !== null) throw new PreconditionError(refusal(agent));
}

/**
 * Refuse a caller whose session is one of `sessions` (empty and missing ids
 * ignored).
 *
 * @param ctx - The verb's context.
 * @param sessions - The sessions that may not act as the person here.
 * @param refusal - The message.
 * @throws {PreconditionError} When the caller is one of them.
 */
export function refuseSessions(
  ctx: VerbContext,
  sessions: readonly (string | null | undefined)[],
  refusal: string
): void {
  const barred = new Set(
    sessions.filter((id): id is string => typeof id === 'string' && id !== '')
  );
  if (callerSessionIds(ctx).some((id) => barred.has(id))) throw new PreconditionError(refusal);
}
