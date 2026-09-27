/**
 * `flow triage <identifier> (--ready --stage <stage> | --park <question>)`: the
 * one tracker write that ends a triage. The triaging-work skill makes the
 * judgment (accept or ask, simple or complex); this verb writes the outcome.
 *
 * - `--ready --stage <stage>` makes the item claimable: unstarted,
 *   `agent/ready`, and the stage's `stage/*` label, which is the release-to-ready
 *   projection with an explicit stage (`work-state.ts`).
 * - `--park <question>` posts the question as a signed comment (asking for a
 *   reply), then applies
 *   the needs-input projection: `agent/needs-input` replaces any other
 *   `agent/*` label. A retry whose question is still the item's latest comment
 *   does not post it twice.
 *
 * Refuses before any tracker write: not exactly one of `--ready` and `--park`,
 * `--stage` without `--ready` (or `--ready` without it), an empty question, a
 * stage that is not in config or has no label, a closed item, and an item an
 * agent is on (started, or `agent/claimed`). Setting the type, priority or
 * size is not this verb's job: no adapter capability writes them.
 *
 * `--dry-run` prints the change and writes nothing. Its journal line is the
 * `verb` line `main` writes for every run.
 *
 * @module @dorkos/flow/cli/triage
 */

import { PreconditionError, UsageError } from '../errors.ts';
import { AGENT_CLAIMED, projectionFor, type WorkStateChange } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { applyAndVerify, requireOpen, sessionProvenance, setupWrite } from './work-write.ts';

/** How many of the latest comments are read to spot a retried question. */
const RECENT_COMMENTS = 10;

/**
 * Run `flow triage`.
 *
 * @param ctx - The verb's context.
 * @returns The decision, the change written, and whether a question was posted.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  // Every usage refusal comes before the config, the adapter or any tracker call.
  const [identifier] = ctx.args.positionals;
  const ready = ctx.args.flags.ready === true;
  const rawPark = ctx.args.flags.park;
  const park = typeof rawPark === 'string' ? rawPark.trim() : undefined;
  const rawStage = ctx.args.flags.stage;
  const stage = typeof rawStage === 'string' ? rawStage : undefined;
  if (ready === (park !== undefined)) {
    throw new UsageError('pass exactly one of --ready or --park <question>');
  }
  if (park === '') throw new UsageError('--park needs the question to ask');
  if (ready && stage === undefined) {
    throw new UsageError('--ready needs --stage <stage>: a ready item says where to resume');
  }
  if (!ready && stage !== undefined) throw new UsageError('--stage goes with --ready only');

  const { loaded, stages, adapter } = await setupWrite(
    ctx,
    ready ? ['getItem', 'applyWorkState'] : ['getItem', 'applyWorkState', 'comment']
  );
  const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
  requireOpen(item, 'triage');
  if (item.stateCategory === 'started' || item.labels.includes(AGENT_CLAIMED)) {
    throw new PreconditionError(
      `${identifier} is being worked (${item.stateCategory === 'started' ? 'started' : AGENT_CLAIMED}), so "flow triage" leaves it alone`
    );
  }
  const change: WorkStateChange = ready
    ? projectionFor({ type: 'release', to: 'ready', stage }, { stages })
    : projectionFor({ type: 'needs-input' }, { stages });

  let commented = false;
  if (park !== undefined) {
    const body = signBody(
      `${park}\n\nReply to this comment to go on.`,
      loaded.config.identity.marker,
      sessionProvenance(ctx)
    );
    const last = (item.comments ?? []).at(-1);
    commented = last === undefined || unsignedBody(last.body) !== unsignedBody(body);
    if (!ctx.dryRun && commented) await adapter.comment(item, body);
  }
  if (!ctx.dryRun) await applyAndVerify(adapter, item, change);

  const verb = ctx.dryRun ? 'Would mark' : 'Marked';
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      decision: ready ? 'ready' : 'park',
      change,
      commented,
    },
    text: ready
      ? `${verb} ${identifier} ready at ${String(change.stageLabel)}.`
      : `${verb} ${identifier} as waiting on a person${commented ? ', with the question posted' : ''}.`,
  };
}
