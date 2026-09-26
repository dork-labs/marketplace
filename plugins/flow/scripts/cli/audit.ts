/**
 * `flow audit [--snapshot <file>]` (spec `flow-cli-core` §6): the groom
 * invariant oracle (`audit-backlog.ts`) over one backlog pull.
 *
 * - The pull is the tracker's (closed titles included) or the `--snapshot` file.
 * - GRM-8's agent identity is `identity.agent`, or the tracker's current user
 *   when that is `auto`.
 * - Human output: one block per failing invariant, titled from the oracle's
 *   own invariant list, one line per offending item.
 * - `--json`: the oracle's `{ ok, failures }`.
 * - Exit 1 when any invariant fails.
 *
 * @module @dorkos/flow/cli/audit
 */

import { INVARIANTS, runInvariants, verdictOf } from '../audit-backlog.ts';
import type { InvariantResult } from '../audit-backlog.ts';
import { loadProjectConfig, readBacklog, resolveAgentId } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';

/**
 * Render the human report.
 *
 * @param results - Every invariant's result, in the oracle's order.
 * @param openCount - How many open items were audited.
 * @returns The text.
 */
export function renderAudit(results: readonly InvariantResult[], openCount: number): string {
  const failing = results.filter((result) => result.details.length > 0);
  const first = INVARIANTS[0]?.id;
  const last = INVARIANTS[INVARIANTS.length - 1]?.id;
  if (failing.length === 0) {
    return `Backlog audit: ${openCount} open items, every invariant holds (${first} to ${last}).`;
  }
  const blocks = failing.map((result) =>
    [
      `${result.invariant.id}  ${result.invariant.summary} (${result.details.length})`,
      ...result.details.map((detail) => `  - ${detail}`),
    ].join('\n')
  );
  return [
    `Backlog audit: ${openCount} open items, ${failing.length} of ${results.length} invariants fail.`,
    ...blocks,
  ].join('\n\n');
}

/**
 * Run `flow audit`.
 *
 * @param ctx - The verb's context.
 * @returns The verdict; exit code 1 when any invariant fails.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const project = loadProjectConfig(ctx);
  const snapshot = await readBacklog(ctx, project.adapter, { includeClosed: true });
  const agentIdentity = await resolveAgentId(project);
  project.flushWarnings();

  const results = runInvariants([...snapshot.items, ...snapshot.closed], { agentIdentity });
  const verdict = verdictOf(results);
  return {
    exitCode: verdict.ok ? 0 : 1,
    json: { ok: verdict.ok, failures: verdict.failures },
    text: renderAudit(results, snapshot.items.length),
  };
}
