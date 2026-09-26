/**
 * `flow release <identifier>` (spec `flow-cli-core` §6): an agent lets go of an
 * item.
 *
 * `--to ready` (the default) hands it back to the queue: unstarted,
 * `agent/ready`, and a `stage/*` label saying where to resume (from `--stage`,
 * else the run record's stage, else the label it carries), exiting 5 when no
 * resume stage is known. `--to none` leaves it unowned. The run record is
 * deleted. A signed comment is posted only with `--reason`.
 *
 * @module @dorkos/flow/cli/release
 */

import { UsageError } from '../errors.ts';
import { projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody } from './provenance.ts';
import {
  applyAndVerify,
  currentStageLabel,
  requireOpen,
  requireStored,
  runFor,
  sessionProvenance,
  setupWrite,
} from './work-write.ts';

/**
 * Run `flow release`.
 *
 * @param ctx - The verb's context.
 * @returns The change written and whether a run record and a comment were touched.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const to = ctx.args.flags.to ?? 'ready';
  if (to !== 'ready' && to !== 'none') {
    throw new UsageError(`--to must be ready or none, not "${String(to)}"`);
  }
  const stageFlag = ctx.args.flags.stage;
  const reason = ctx.args.flags.reason;
  const needed =
    typeof reason === 'string'
      ? (['getItem', 'applyWorkState', 'comment'] as const)
      : (['getItem', 'applyWorkState'] as const);

  const { loaded, stages, adapter, store } = await setupWrite(ctx, needed);
  const item = await adapter.getItem(identifier);
  requireOpen(item, 'release');
  const existing = runFor(store, item);
  const change = projectionFor(
    { type: 'release', to, stage: typeof stageFlag === 'string' ? stageFlag : undefined },
    { stages, runStage: existing?.stage, removedStageLabel: currentStageLabel(item) }
  );
  const body =
    typeof reason === 'string'
      ? signBody(reason, loaded.config.identity.marker, sessionProvenance(ctx, existing?.host))
      : undefined;

  if (!ctx.dryRun) {
    await applyAndVerify(adapter, item, change);
    if (existing !== undefined) {
      const removed = await store.removeRun(item.id);
      requireStored(removed.status, store.path, `run "flow release ${identifier}" again`);
    }
    if (body !== undefined) await adapter.comment(item, body);
  }
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      change,
      runRemoved: existing !== undefined,
      commented: body !== undefined,
    },
    text: `${ctx.dryRun ? 'Would release' : 'Released'} ${identifier} ${to === 'ready' ? `to the ready queue at ${change.stageLabel}` : 'with no owner'}.`,
  };
}
