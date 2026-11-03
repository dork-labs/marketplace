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
 * - {@link refuseSessions}: the second guard, for a caller that names a
 *   session (`--session`, `FLOW_SESSION_ID`) without any agent's markers.
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
import { callerSessions } from './caller.ts';
import type { VerbContext } from './context.ts';

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
  if (callerSessions(ctx).some((id) => barred.has(id))) throw new PreconditionError(refusal);
}
