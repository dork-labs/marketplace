/**
 * `flow inbox [--since <time>] [--dry-run]` (DOR-3669): the one way a model
 * session reads the tracker inbox.
 *
 * Code does every step that decides who may be heard:
 *
 * 1. The adapter's code reads the team's new comments (`getInbox`) and parses
 *    each author's membership from the tracker's own API response. A model
 *    never relays it, so a comment cannot talk anyone into "member".
 * 2. {@link PollingTransport} drops malformed entries, applies the watermark
 *    and warns about each comment from outside the team.
 * 3. {@link shouldRespondToComment} decides respond, resume or ignore.
 * 4. {@link settleRecordedAnswers} drops a recorded answer that may not resume
 *    its question and hands over the rest, so the spend rule is not left to a
 *    model reading `flow-state.json` (DOR-3718).
 *
 * Then the output carries a comment's text only when the comment calls for
 * action, which the trust check already limits to members. Every other
 * comment is listed by item, author and time, with no text, so a guest's
 * words never reach the model reading this.
 *
 * An adapter whose code cannot read the inbox (a prose-only adapter, or the
 * in-session `mcp` transport, which the CLI refuses) exits 3: nothing it
 * reads starts or resumes a turn.
 *
 * @module @dorkos/flow/cli/inbox
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { shouldRespondToComment, type CommentDecision } from '../comment-response.ts';
import { withHeldLock } from '../atomic-json.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import { droppedAnswerWarning, recordedAnswerPointer, recordedAnswerStands } from '../question.ts';
import { AGENT_NEEDS_INPUT } from '../work-state.ts';
import { dropEndedQuestion, markAnswerHandedOver, releaseAnswer } from './question-write.ts';
import { isOpenItem } from './work-write.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile, type FlowStateFile } from '../flow-state-file.ts';
import { classifyOwnership } from '../identity.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { CodeAdapter, InboxRead } from '../tracker/types.ts';
import type { CommentsConfig } from '../comment-response.ts';
import type { Identity, OwnershipScope } from '../identity.ts';
import { PollingTransport, type InboxEntry } from '../transport.ts';
import { loadProjectConfig, resolveAgentId } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** The watermark file, beside `flow-state.json`. */
export const INBOX_WATERMARK_FILE = 'inbox-watermark.json';

/** One comment as `flow inbox` hands it over. */
export interface InboxLine {
  /** The item's human key. */
  itemId: string;
  /** The item's title; left out of an `ignore` entry, since an outsider may have written it. */
  title?: string;
  /** The tracker's comment id. */
  commentId: string;
  /** When the comment was made. */
  occurredAt: string;
  /** The author's account id (`''` when the tracker gave none). */
  author: string;
  /** What the comment calls for. */
  action: CommentDecision['action'];
  /** The rule that decided it. */
  rule: CommentDecision['rule'];
  /** Set when only the author's trust stopped it from acting. */
  untrusted?: true;
  /** Set with `untrusted` when the author is the shared account flow posts as. */
  sharedAccount?: true;
  /** The text: present only when `action` is `respond` or `resume`. */
  body?: string;
  /** The parked run's session, for a resume. */
  sessionId?: string;
  /** Set when `flow drain` owns the run, so the inbox pass leaves it alone. */
  drain?: true;
}

/** A recorded answer the pass may resume its item on. */
export interface InboxAnswer {
  /** The item's human key. */
  itemId: string;
  /** Who the record says answered. */
  by: string;
  /** When it was recorded. */
  at: string;
  /** What to tell the resumed session, with the answer's words. */
  answer: string;
  /** The parked run's session, for the resume. */
  sessionId?: string;
}

/** An ISO-8601 date-time with an explicit zone: the only watermark flow keeps or sends. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Whether a value is a time flow may hand the tracker. */
function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Read the saved watermark, or `undefined` when there is none or it is not a time. */
function readWatermark(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; since?: unknown };
    return parsed.v === 1 && isTime(parsed.since) ? parsed.since : undefined;
  } catch {
    return undefined;
  }
}

/** Write the watermark atomically. */
function writeWatermark(file: string, since: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, since })}\n`);
  renameSync(temp, file);
}

/** The runs on record, by tracker id; `{}` when the store cannot be read. */
function readRuns(projectDir: string): Record<string, FlowRun> {
  try {
    return openFlowStateFile(projectDir).read();
  } catch {
    return {};
  }
}

/** What deciding one comment needs. */
interface Judge {
  identity: Identity;
  scope: OwnershipScope;
  comments: CommentsConfig;
  runs: Record<string, FlowRun>;
}

/**
 * One comment as handed over: its decision, and its text and title only when
 * it calls for action, which the trust check limits to members.
 */
function lineFor(read: InboxRead, judge: Judge): InboxLine {
  const decision = shouldRespondToComment(
    read.comment,
    {
      item: read.item,
      ownership: classifyOwnership(read.item, judge.identity, judge.scope),
      identity: judge.identity,
    },
    judge.comments
  );
  const line: InboxLine = {
    itemId: read.itemId,
    commentId: read.comment.id,
    occurredAt: read.occurredAt,
    author: read.comment.author,
    action: decision.action,
    rule: decision.rule,
  };
  if (decision.untrusted === true) line.untrusted = true;
  if (decision.sharedAccount === true) line.sharedAccount = true;
  if (decision.action === 'ignore') return line;
  const run = Object.hasOwn(judge.runs, read.item.id) ? judge.runs[read.item.id] : undefined;
  line.title = read.item.title;
  line.body = read.comment.body;
  if (run !== undefined && run.sessionId !== '') line.sessionId = run.sessionId;
  if (run?.drain !== undefined) line.drain = true;
  return line;
}

/**
 * The recorded answers on runs the drain does not own. One that may not resume
 * its question is dropped here, and said so once. One that may is handed over
 * at most once, marked on the run as it goes, while the run is live and its
 * item open and waiting. One whose item stopped waiting belongs to no park now,
 * so it goes with its question: that is how this pass ties an answer to its park,
 * as the drain does with `belongsToPark`. Only a pass that sees the item not
 * waiting can tell: no tracker read gives a label's time, so two passes that
 * both see it waiting see one park. The answer stays on the run, so `flow answer` still
 * refuses a second one; if the resume then fails, a member's reply or a new
 * `flow ask` moves the item. A run the drain owns is the drain's (`drain.ts`), and it applies
 * the same rule. A read that fails costs that run this pass, never the team's
 * comments.
 *
 * @param ctx - The verb's context.
 * @param adapter - The tracker adapter.
 * @param store - The run store.
 * @param runs - The runs on record.
 * @returns The answers the pass may resume on.
 */
async function settleRecordedAnswers(
  ctx: VerbContext,
  adapter: Pick<CodeAdapter, 'getItem'>,
  store: FlowStateFile,
  runs: Record<string, FlowRun>
): Promise<InboxAnswer[]> {
  const answers: InboxAnswer[] = [];
  for (const run of Object.values(runs)) {
    const question = run.question;
    const answer = question?.answer;
    if (question === undefined || answer === undefined || run.drain !== undefined) continue;
    if (!recordedAnswerStands(question)) {
      if (ctx.dryRun) continue;
      await releaseAnswer(store, run.issueId, question.askedAt, answer);
      ctx.warn(droppedAnswerWarning(run.identifier, answer.by));
      continue;
    }
    if (question.answerHandedOverAt !== undefined) continue;
    if (run.status === 'complete' || run.status === 'failed') continue;
    // Written by hand if so: `flow answer` always records a real time.
    if (!(Date.parse(answer.at) >= Date.parse(question.askedAt))) continue;
    let waiting: boolean;
    try {
      const item = await adapter.getItem(run.identifier);
      waiting = isOpenItem(item) && item.labels.includes(AGENT_NEEDS_INPUT);
    } catch {
      ctx.warn(
        `flow inbox: could not read ${run.identifier}, so its recorded answer waits for the next pass.`
      );
      continue;
    }
    if (!waiting) {
      // Every answer is recorded while the item waits, so its park is over:
      // something else moved the item. Drop it now, or a later agent/needs-input
      // would resume on these old words. A busy lock tries again next pass.
      if (ctx.dryRun) continue;
      try {
        if (await dropEndedQuestion(store, run.issueId, question.askedAt)) {
          ctx.warn(
            `flow inbox: ${run.identifier}'s recorded answer was not used: the item stopped waiting on it, so it was dropped.`
          );
        }
      } catch {
        ctx.warn(`flow inbox: could not update ${run.identifier}; the next pass tries again.`);
      }
      continue;
    }
    if (!ctx.dryRun) {
      // A busy lock costs this run this pass: throwing here would lose the
      // answers already marked, since their list is never returned.
      try {
        const marked = await markAnswerHandedOver(
          store,
          run.issueId,
          question.askedAt,
          ctx.now().toISOString()
        );
        if (!marked) continue;
      } catch {
        ctx.warn(`flow inbox: ${run.identifier}'s recorded answer waits for the next pass.`);
        continue;
      }
    }
    answers.push({
      itemId: run.identifier,
      by: answer.by,
      at: answer.at,
      answer: recordedAnswerPointer(question, run.identifier),
      ...(run.sessionId === '' ? {} : { sessionId: run.sessionId }),
    });
  }
  return answers;
}

/** The human summary: one line per comment, text only where the entry carries it. */
function renderText(entries: readonly InboxLine[], answers: readonly InboxAnswer[]): string {
  const acting = entries.filter((entry) => entry.action !== 'ignore').length;
  return [
    entries.length === 0
      ? 'No new comments.'
      : `${entries.length} new comment${entries.length === 1 ? '' : 's'}, ${acting} calling for action.`,
    ...entries.map((entry) => {
      const who = entry.author === '' ? 'no author' : entry.author;
      const head = `${entry.itemId} ${entry.occurredAt} ${who}: ${entry.action} (rule ${entry.rule}${entry.sharedAccount ? ', the shared account flow posts as' : entry.untrusted ? ', not a member' : ''})`;
      return entry.body === undefined ? head : `${head}\n  ${entry.body.replaceAll('\n', '\n  ')}`;
    }),
    ...answers.map((entry) => `${entry.itemId} ${entry.at}: resume on ${entry.answer}`),
  ].join('\n');
}

/**
 * Run `flow inbox`. The read and the watermark move happen under one lock, so
 * two passes never hand over the same comment. Delivery is at most once: the
 * watermark moves when the comments are handed over, before anyone acts.
 *
 * @param ctx - The verb's context.
 * @returns Every new comment with its decision; text only for trusted, acting ones.
 * @throws {UsageError} On a `--since` that is not an ISO-8601 time with a zone.
 * @throws {ConfigError} When the adapter has no code that reads the inbox (exit 3).
 * @throws {PreconditionError} When another inbox pass holds the lock (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const sinceFlag = ctx.args.flags.since;
  const skipTo = ctx.args.flags['skip-to'];
  if (skipTo !== undefined) {
    if (sinceFlag !== undefined) throw new UsageError('give --skip-to or --since, not both');
    if (!isTime(skipTo)) {
      throw new UsageError(
        '--skip-to needs an ISO-8601 time with a zone, for example 2026-09-26T12:00:00Z'
      );
    }
    // A time past now would silence the inbox until someone skipped back.
    if (Date.parse(skipTo) > ctx.now().getTime() + 60 * 60 * 1000) {
      throw new UsageError('--skip-to cannot be in the future');
    }
  }
  if (sinceFlag !== undefined && !isTime(sinceFlag)) {
    throw new UsageError(
      '--since needs an ISO-8601 time with a zone, for example 2026-09-26T12:00:00Z'
    );
  }
  const project = loadProjectConfig(ctx);
  const { config } = project.loaded;
  const adapter = await project.adapter();
  requireCapabilities(adapter, ['getInbox']);

  const store = openFlowStateFile(ctx.projectDir, { now: ctx.now });
  const watermarkFile = path.join(path.dirname(store.path), INBOX_WATERMARK_FILE);
  if (typeof skipTo === 'string') {
    // Move the saved place on purpose and read nothing: the way past a window
    // the adapter refused as too large to read without dropping comments.
    const skipped = await withHeldLock(`${watermarkFile}.lock`, async () => {
      if (!ctx.dryRun) writeWatermark(watermarkFile, skipTo);
    });
    if (!skipped.held) {
      throw new PreconditionError(
        'another flow inbox pass is reading the inbox now; try again on the next tick'
      );
    }
    ctx.warn(
      `flow inbox: skipped every comment up to ${skipTo}; none of them will be handed over.`
    );
    return {
      json: { ok: true, dryRun: ctx.dryRun, skippedTo: skipTo, entries: [], answers: [] },
      text: `${ctx.dryRun ? 'Would skip' : 'Skipped'} every comment up to ${skipTo}.`,
    };
  }
  requireCapabilities(adapter, ['getItem']);
  const locked = await withHeldLock(`${watermarkFile}.lock`, async () => {
    const since = typeof sinceFlag === 'string' ? sinceFlag : readWatermark(watermarkFile);
    const reads = await adapter.getInbox!(since === undefined ? {} : { since });
    const transport = new PollingTransport(
      async () =>
        reads.map((read): InboxEntry => ({
          itemId: read.itemId,
          occurredAt: read.occurredAt,
          comment: read.comment,
          actor: read.comment.author,
          raw: read,
        })),
      { warn: (message) => ctx.warn(message), now: () => ctx.now().getTime() }
    );
    const polled = await transport.poll(since);
    const judge: Judge = {
      identity: {
        agent: await resolveAgentId(project),
        reviewer: config.identity.reviewer,
        marker: config.identity.marker,
      },
      scope: config.ownership.scope.includes('issues') ? 'issues' : 'projects',
      comments: config.comments,
      runs: readRuns(ctx.projectDir),
    };
    const entries = polled.events.map((event) => lineFor(event.raw as InboxRead, judge));
    // A --since pass looks back: it hands over no answers, as it moves no watermark.
    const answers =
      sinceFlag === undefined ? await settleRecordedAnswers(ctx, adapter, store, judge.runs) : [];
    // A --since pass looks back without moving the saved place.
    if (
      !ctx.dryRun &&
      sinceFlag === undefined &&
      isTime(polled.watermark) &&
      polled.watermark !== since
    ) {
      writeWatermark(watermarkFile, polled.watermark);
    }
    return { since, watermark: polled.watermark, entries, answers };
  });
  if (!locked.held) {
    throw new PreconditionError(
      'another flow inbox pass is reading the inbox now; try again on the next tick'
    );
  }
  const { since, watermark, entries, answers } = locked.value;
  return {
    json: { ok: true, dryRun: ctx.dryRun, since: since ?? null, watermark, entries, answers },
    text: renderText(entries, answers),
  };
}
