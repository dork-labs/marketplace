/**
 * `flow done <identifier>` (spec `flow-cli-core` §6): an agent finished an item.
 *
 * Posts the summary as a signed comment (identity marker plus provenance line),
 * unless one of the item's last 10 comments already has the same body up to
 * its provenance line, so a retried `done` never posts twice. Then it writes
 * the `done` projection (completed, `agent/completed`, no `stage/*` label) even
 * when the tracker already closed the item (a merged `Closes <id>`), confirms
 * it on read-back, and marks the run record complete.
 *
 * Follow-ups, the project pulse and worktree cleanup stay in the `closing-work`
 * skill: they are judgment, not mechanics.
 *
 * @module @dorkos/flow/cli/done
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from '../errors.ts';
import { projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody, unsignedBody } from './provenance.ts';
import {
  applyAndVerify,
  requireStored,
  runFor,
  sessionProvenance,
  setupWrite,
} from './work-write.ts';

/** How many of the latest comments are checked for an earlier post of the summary. */
const RECENT_COMMENTS = 10;

/** The summary text from `--summary` or `--summary-file`, exactly one of them. */
function summaryText(ctx: VerbContext): string {
  const inline = ctx.args.flags.summary;
  const file = ctx.args.flags['summary-file'];
  if ((typeof inline === 'string') === (typeof file === 'string')) {
    throw new UsageError('pass exactly one of --summary <text> or --summary-file <path>');
  }
  if (typeof inline === 'string') return inline;
  const resolved = path.resolve(ctx.projectDir, file as string);
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    throw new UsageError(`could not read the summary file ${resolved}`);
  }
}

/**
 * Run `flow done`.
 *
 * @param ctx - The verb's context.
 * @returns The change written, whether the summary was posted, and the run.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  let summary = summaryText(ctx).trimEnd();
  if (summary.trim() === '') throw new UsageError('the summary is empty');
  const pr = ctx.args.flags.pr;
  if (typeof pr === 'string') summary = `${summary}\n\nPR: ${pr}`;

  const { loaded, stages, adapter, store } = await setupWrite(ctx, [
    'getItem',
    'applyWorkState',
    'comment',
  ]);
  const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
  const existing = runFor(store, item);
  const body = signBody(
    summary,
    loaded.config.identity.marker,
    sessionProvenance(ctx, existing?.host)
  );
  const unsigned = unsignedBody(body);
  const alreadyPosted = (item.comments ?? [])
    .slice(-RECENT_COMMENTS)
    .some((comment) => unsignedBody(comment.body) === unsigned);
  const change = projectionFor({ type: 'done' }, { stages });
  const completedAt = ctx.now().toISOString();

  if (!ctx.dryRun) {
    if (!alreadyPosted) await adapter.comment(item, body);
    await applyAndVerify(adapter, item, change);
    if (existing !== undefined) {
      const written = await store.setRunStatus(item.id, 'complete', { completedAt });
      requireStored(written.status, store.path, `run "flow done ${identifier}" again`);
    }
  }
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      change,
      commented: !alreadyPosted,
      run: existing === undefined ? null : { ...existing, status: 'complete', completedAt },
    },
    text: `${ctx.dryRun ? 'Would close' : 'Closed'} ${identifier}${alreadyPosted ? ' (summary already posted)' : ''}.`,
  };
}
