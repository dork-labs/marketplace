/**
 * `flow stage <identifier> <stage>` (spec `flow-cli-core` §6): an item moves to
 * another stage.
 *
 * `<stage>` is a key of config `stages`. A stage whose category is `started` or
 * `completed` moves the item there and removes every `stage/*` label (the run
 * record carries the stage while the item is worked); any other stage sets its
 * `stage/*` label, and its category when it has one. The run record's `stage`
 * follows when a record exists.
 *
 * @module @dorkos/flow/cli/stage
 */

import type { FlowStage } from '../flow-run.ts';
import { projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { recordEvent } from './auto-journal.ts';
import { applyAndVerify, requireStored, runFor, setupWrite } from './work-write.ts';

/**
 * Run `flow stage`.
 *
 * @param ctx - The verb's context.
 * @returns The change written and the run's new stage, when it has a run.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier, stage] = ctx.args.positionals;
  const { stages, adapter, store } = await setupWrite(ctx, ['getItem', 'applyWorkState']);
  const change = projectionFor({ type: 'stage', stage }, { stages });
  const item = await adapter.getItem(identifier);
  const existing = runFor(store, item);

  if (!ctx.dryRun) {
    await applyAndVerify(adapter, item, change);
    if (existing !== undefined) {
      const written = await store.setRunStage(item.id, stage as FlowStage);
      requireStored(written.status, store.path, `run "flow stage ${identifier} ${stage}" again`);
    }
    recordEvent(ctx, { kind: 'stage', stage, phase: 'start', item: identifier });
  }
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      stage,
      change,
      run: existing === undefined ? null : { ...existing, stage },
    },
    text: `${ctx.dryRun ? 'Would move' : 'Moved'} ${identifier} to ${stage}.`,
  };
}
