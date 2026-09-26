/**
 * `flow stage <identifier> <stage> [--checkpoint-file <f>]` (spec `flow-cli-core`
 * §6, `flow-handoff-dispatch` §1): an item moves to another stage.
 *
 * `<stage>` is a key of config `stages`. A stage whose category is `started` or
 * `completed` moves the item there and removes every `stage/*` label (the run
 * record carries the stage while the item is worked); any other stage sets its
 * `stage/*` label, and its category when it has one. The run record's `stage`
 * follows when a record exists.
 *
 * With `--checkpoint-file`, the verb first writes the item's `HANDOFF.md`
 * (trigger `stage`, header stage = the new stage) from that body, then moves
 * the item. A drain run must pass it (exit 5 otherwise): every stage boundary
 * of a drain leaves a checkpoint the next session can resume from. Outside a
 * drain, a move without one warns.
 *
 * @module @dorkos/flow/cli/stage
 */

import { PreconditionError } from '../errors.ts';
import type { FlowStage } from '../flow-run.ts';
import { projectionFor } from '../work-state.ts';
import { checkpointLine, writeCheckpoint, type WrittenCheckpoint } from './checkpoint.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { applyAndVerify, requireStored, runFor, setupWrite } from './work-write.ts';

/**
 * Run `flow stage`.
 *
 * @param ctx - The verb's context.
 * @returns The change written, the checkpoint when one was written, and the run's new stage.
 * @throws {PreconditionError} For a drain run without `--checkpoint-file` (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier, stage] = ctx.args.positionals;
  const checkpointFile = ctx.args.flags['checkpoint-file'];
  const bodyFile = typeof checkpointFile === 'string' ? checkpointFile : undefined;
  const { stages, adapter, store } = await setupWrite(ctx, ['getItem', 'applyWorkState']);
  const change = projectionFor({ type: 'stage', stage }, { stages });
  const item = await adapter.getItem(identifier);
  const existing = runFor(store, item);

  if (bodyFile === undefined) {
    if (existing?.drain !== undefined) {
      throw new PreconditionError(
        'a drain run writes a checkpoint at every stage boundary: pass --checkpoint-file'
      );
    }
    ctx.warn(
      `no checkpoint written for ${identifier}: pass --checkpoint-file <f> so the next session can resume from HANDOFF.md`
    );
  }

  let checkpoint: WrittenCheckpoint | null = null;
  if (!ctx.dryRun) {
    if (bodyFile !== undefined) {
      checkpoint = await writeCheckpoint(ctx, {
        identifier,
        trigger: 'stage',
        bodyFile,
        task: null,
        spec: null,
        stage,
        bodyFlag: '--checkpoint-file',
      });
    }
    await applyAndVerify(adapter, item, change);
    if (existing !== undefined) {
      const written = await store.setRunStage(item.id, stage as FlowStage);
      requireStored(written.status, store.path, `run "flow stage ${identifier} ${stage}" again`);
    }
  }
  const moved = `${ctx.dryRun ? 'Would move' : 'Moved'} ${identifier} to ${stage}.`;
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      stage,
      change,
      checkpoint: checkpoint === null ? null : { path: checkpoint.path, header: checkpoint.header },
      run: existing === undefined ? null : { ...existing, stage },
    },
    text: checkpoint === null ? moved : `${checkpointLine(checkpoint)}\n${moved}`,
  };
}
