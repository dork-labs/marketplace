/**
 * `flow triage <identifier> (--ready --stage <stage> | --park <question> |
 * --question-file <path>)`: the
 * one tracker write that ends a triage. The triaging-work skill makes the
 * judgment (accept or ask, simple or complex); this verb writes the outcome.
 *
 * - `--ready --stage <stage>` makes the item claimable: unstarted,
 *   `agent/ready`, and the stage's `stage/*` label, which is the release-to-ready
 *   projection with an explicit stage (`work-state.ts`).
 * - `--park <question>` (or `--question-file`, for a question a shell
 *   argument would break) posts the question as a signed comment asking for a
 *   reply, then applies the needs-input projection: `agent/needs-input`
 *   replaces any other `agent/*` label. A retry whose question is still the
 *   item's latest comment does not post it twice. A question file under
 *   `.dork/flow/tmp/` is removed once the item is parked (`scratch-file.ts`).
 *
 * Journal: besides the `verb` line `main` writes, an item that was not
 * already ready gets `item.readied` (`by: triage`), and an item that was not
 * already parked gets `operator.wait` `start`, so a retry writes neither twice.
 * The line is written only after the read-back confirms the label, so when the
 * label lands but the read-back fails (exit 4), the retry finds the label
 * already there and that item's line is never written.
 *
 * Refuses before any tracker write: not exactly one of `--ready` and a question,
 * `--stage` without `--ready` (or `--ready` without it), an empty question, a
 * stage that is not in config or has no label, a closed item, and an item an
 * agent is on (started, or `agent/claimed`). Setting the type, priority or
 * size is not this verb's job: no adapter capability writes them.
 *
 * `--dry-run` prints the change and writes nothing.
 *
 * @module @dorkos/flow/cli/triage
 */

import { PreconditionError, UsageError } from '../errors.ts';
import {
  AGENT_CLAIMED,
  AGENT_NEEDS_INPUT,
  AGENT_READY,
  projectionFor,
  type WorkStateChange,
} from '../work-state.ts';
import { recordEvent } from './auto-journal.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { flagText, removeScratch } from './scratch-file.ts';
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
  const asks = typeof ctx.args.flags.park === 'string';
  const asksFromFile = typeof ctx.args.flags['question-file'] === 'string';
  const rawStage = ctx.args.flags.stage;
  const stage = typeof rawStage === 'string' ? rawStage : undefined;
  if (ready === (asks || asksFromFile)) {
    throw new UsageError(
      'pass exactly one of --ready, --park <question> or --question-file <path>'
    );
  }
  if (ready && stage === undefined) {
    throw new UsageError('--ready needs --stage <stage>: a ready item says where to resume');
  }
  if (!ready && stage !== undefined) throw new UsageError('--stage goes with --ready only');
  // Read the question only once the flags agree: reading a scratch file adds
  // the git-exclude line, and a refused combination must touch nothing.
  const question = flagText(ctx, { inline: 'park', file: 'question-file', what: 'question' });
  const park = question?.text.trim();
  if (park === '') throw new UsageError('the question to park on is empty');

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
  if (!ctx.dryRun) {
    await applyAndVerify(adapter, item, change);
    removeScratch(ctx, question?.scratch);
    if (ready && !item.labels.includes(AGENT_READY)) {
      recordEvent(ctx, { kind: 'item.readied', by: 'triage', item: identifier });
    }
    if (!ready && !item.labels.includes(AGENT_NEEDS_INPUT)) {
      recordEvent(ctx, { kind: 'operator.wait', phase: 'start', item: identifier });
    }
  }

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
