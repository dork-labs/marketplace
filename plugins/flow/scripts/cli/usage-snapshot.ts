/**
 * `flow usage snapshot` (spec `flow-usage` Amendment 1 A7): journal a sampled
 * `usage.snapshot` line for every account whose ledger is due one. A drain
 * supervisor runs it each pass, so the journal keeps a usage history for
 * `flow retro` without the status line ever touching the journal.
 *
 * @module @dorkos/flow/cli/usage-snapshot
 */

import { loadAccounts, resolveDorkHome } from '../fleet/accounts.ts';
import { listLedgerIds } from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { journalUsage } from './usage-journal.ts';

/**
 * Run `flow usage snapshot`.
 *
 * @param ctx - The verb context.
 * @returns How many accounts got a line, and the journal path.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const { accounts } = loadAccounts(dorkHome);
  const targets = accounts
    .filter((account) => account.routable)
    .filter((account) => listLedgerIds(dorkHome, account.runtime).includes(account.id))
    .map((account) => ({ runtime: account.runtime, id: account.id }));
  const outcome = journalUsage(ctx, dorkHome, targets);
  const text =
    outcome.journal === null
      ? 'No journal here (not a flow project, or the journal is off); nothing written.'
      : `Journaled usage for ${outcome.written.length} of ${targets.length} accounts in ${outcome.journal}.`;
  return { json: { ok: true, ...outcome }, text };
}
