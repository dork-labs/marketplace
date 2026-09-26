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
import { projectionFor, type WorkStateChange } from '../work-state.ts';
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
  type WriteSetup,
} from './work-write.ts';

/** What {@link releaseItem} lets go of, and how. */
export interface ReleaseInput {
  /** The item, e.g. `ACME-12`. */
  identifier: string;
  /** `ready` hands it back to the queue; `none` leaves it unowned. */
  to: 'ready' | 'none';
  /** The stage to resume at, when not the run's. */
  stage?: string;
  /** A signed comment to post, when given. */
  reason?: string;
}

/**
 * Release an item: apply the release projection, delete its run record, and
 * post the reason when one is given. Shared by `flow release` and `flow drain`,
 * which releases a queued claim whose worker never started (spec
 * `flow-handoff-dispatch` §2.6). Honors `--dry-run` on `ctx`.
 *
 * @param ctx - The verb's context.
 * @param setup - The loaded config, adapter (with `comment` when a reason is given) and run store.
 * @param input - The item, where it goes, and why.
 * @returns The change, whether a run record was removed, and whether a comment was posted.
 */
export async function releaseItem(
  ctx: VerbContext,
  setup: WriteSetup,
  input: ReleaseInput
): Promise<{ change: WorkStateChange; runRemoved: boolean; commented: boolean }> {
  const { loaded, stages, adapter, store } = setup;
  const item = await adapter.getItem(input.identifier);
  requireOpen(item, 'release');
  const existing = runFor(store, item);
  const change = projectionFor(
    { type: 'release', to: input.to, stage: input.stage },
    { stages, runStage: existing?.stage, removedStageLabel: currentStageLabel(item) }
  );
  const body =
    input.reason === undefined
      ? undefined
      : signBody(
          input.reason,
          loaded.config.identity.marker,
          sessionProvenance(ctx, existing?.host)
        );

  if (!ctx.dryRun) {
    await applyAndVerify(adapter, item, change);
    if (existing !== undefined) {
      const removed = await store.removeRun(item.id);
      requireStored(removed.status, store.path, `run "flow release ${input.identifier}" again`);
    }
    if (body !== undefined) await adapter.comment(item, body);
  }
  return { change, runRemoved: existing !== undefined, commented: body !== undefined };
}

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

  const setup = await setupWrite(ctx, needed);
  const { change, runRemoved, commented } = await releaseItem(ctx, setup, {
    identifier,
    to,
    stage: typeof stageFlag === 'string' ? stageFlag : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
  });
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      change,
      runRemoved,
      commented,
    },
    text: `${ctx.dryRun ? 'Would release' : 'Released'} ${identifier} ${to === 'ready' ? `to the ready queue at ${change.stageLabel}` : 'with no owner'}.`,
  };
}
