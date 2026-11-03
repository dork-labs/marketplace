/**
 * `flow answer <identifier>` (spec `flow-multiproject` §7.5): answer an agent's
 * parked question.
 *
 * - `--text <text>` or `--text-file <file>`: a person's answer, from DorkOS,
 *   which gives it on standard input (`--text-file -`). It is posted on the item without the agent's marker, as the tracker account
 *   flow uses, with "Answered in DorkOS." as its last line, and recorded on the
 *   run. The recorded answer is what resumes it: the comment is flow's record,
 *   which the comment rules (`shouldRespondToComment`) stay quiet on, as flow's
 *   own on its own account and as a record on a shared one.
 * - `--pick --by agent-default`: the question's deadline passed with no answer,
 *   so the agent's own pick stands. Posted as the agent ("No answer by …, so
 *   going with …"). Refused for a floor question: a deadline alone never
 *   settles one.
 * - `--pick --by reviewer-agent --token <t>`: the reviewer agent checked a floor
 *   question's pick and agrees. The token comes from `flow ask --check-pick`.
 *
 * It refuses (exit 5) an item that no longer carries `agent/needs-input`, or
 * whose question was already answered: whoever got there first wins, and the
 * second does nothing. A busy run store is another refusal (exit 5, kind `busy`):
 * nothing was recorded or posted, so the same answer can be given again. A
 * person's words for a run with no open question are refused too, since nothing
 * would resume on them. It never lifts `agent/needs-input` itself: the drain and
 * the inbox pass see the answer and resume the work, as they do for any reply.
 *
 * @module @dorkos/flow/cli/answer
 */

import { ANSWERED_IN_DORKOS } from '../comment-response.ts';
import { NotWaitingError, PreconditionError, SettledError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import {
  MAX_ANSWER_LENGTH,
  personOnly,
  pickComment,
  pickIsDue,
  type QuestionSettler,
} from '../question.ts';
import { requireOtherSession } from './caller.ts';
import {
  readWords,
  recordPersonAct,
  refuseSessions,
  requirePersonShell,
  sessionsThatWorked,
  type PersonCaller,
} from './person-gate.ts';
import { claimAnswer, releaseAnswer } from './question-write.ts';
import { AGENT_NEEDS_INPUT } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody } from './provenance.ts';
import { tokenHash } from './report.ts';
import { runFor, sessionProvenance, setupWrite } from './work-write.ts';

/** The last line of a person's answer posted from DorkOS (defined beside the comment rules). */
export { ANSWERED_IN_DORKOS };

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The person's answer from `--text` or `--text-file` (`-` is standard input).
 * Called after the gate, so flow never waits on an agent's stream.
 */
async function answerText(ctx: VerbContext): Promise<string> {
  const text = flag(ctx, 'text');
  const file = flag(ctx, 'text-file');
  let value = text;
  if (file !== undefined) {
    try {
      value = await readWords(ctx, file);
    } catch {
      throw new UsageError(`cannot read --text-file ${file}`);
    }
  }
  const trimmed = (value ?? '').trim();
  if (trimmed === '') throw new UsageError('the answer is empty');
  if (trimmed.length > MAX_ANSWER_LENGTH) {
    throw new UsageError(`the answer is longer than ${MAX_ANSWER_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * What the refusals tell whoever hit them: stop and hand the question to the
 * person, never how to get past the check (`person-gate.ts`).
 */
const STOP_AND_ASK =
  "Stop: an agent never answers a person's question. Do not run this again any other way; ask the person to answer it in DorkOS.";

/**
 * Run `flow answer`.
 *
 * @param ctx - The verb's context.
 * @returns What was posted and recorded.
 * @throws {UsageError} On a missing or empty answer, or wrong flags (exit 2).
 * @throws {SettledError} When the question was already answered (exit 5).
 * @throws {NotWaitingError} When the item stopped waiting, or is gone (exit 5).
 * @throws {BusyError} When the run store stayed locked (exit 5).
 * @throws {PreconditionError} When the pick may not stand yet (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const pick = ctx.args.flags.pick === true;
  const byFlag = flag(ctx, 'by');
  if (!pick && byFlag !== undefined) throw new UsageError('--by goes with --pick');
  if (pick && (flag(ctx, 'text') !== undefined || flag(ctx, 'text-file') !== undefined)) {
    throw new UsageError("--pick takes the agent's own pick; leave out --text and --text-file");
  }
  let by: QuestionSettler = 'person';
  if (pick) {
    if (byFlag !== 'agent-default' && byFlag !== 'reviewer-agent') {
      throw new UsageError(
        '--pick needs --by agent-default (at the deadline) or --by reviewer-agent'
      );
    }
    by = byFlag;
  }
  if (flag(ctx, 'token') !== undefined && by !== 'reviewer-agent') {
    throw new UsageError('--token goes with --pick --by reviewer-agent');
  }
  if (!pick && (flag(ctx, 'text') === undefined) === (flag(ctx, 'text-file') === undefined)) {
    throw new UsageError('give the answer with exactly one of --text or --text-file');
  }
  const caller: PersonCaller | null = pick
    ? null
    : await requirePersonShell(
        ctx,
        (agent) =>
          `flow answer --text takes a person's answer, and this runs inside an agent (${agent}), so nothing was posted or recorded. ${STOP_AND_ASK}`
      );
  const text = pick ? null : await answerText(ctx);

  const { loaded, adapter, store } = await setupWrite(ctx, ['getItem', 'comment']);
  // An item that is gone needs no answer. A tracker outage is not this: it stays exit 4.
  const item = await adapter.getItem(identifier).catch((error: unknown) => {
    throw error instanceof PreconditionError ? new NotWaitingError(error.message) : error;
  });
  const existing: FlowRun | undefined = runFor(store, item);
  const question = existing?.question;
  if (question?.answer !== undefined) {
    throw new SettledError(`${identifier}'s question was already answered, so nothing was posted`);
  }
  if (!item.labels.includes(AGENT_NEEDS_INPUT)) {
    throw new NotWaitingError(
      `${identifier} no longer waits for an answer (it no longer carries ${AGENT_NEEDS_INPUT}), so nothing was posted`
    );
  }
  if (text !== null) {
    refuseSessions(
      ctx,
      sessionsThatWorked(existing),
      `a session that worked ${identifier} cannot answer its question, so nothing was posted or recorded. ${STOP_AND_ASK}`
    );
    // A parked drain run's rows send words with no question on record, so it keeps
    // this path. This kind of run only resumes on a recorded answer.
    if (existing !== undefined && question === undefined && existing.drain === undefined) {
      throw new PreconditionError(
        `${identifier} has no open question on its run, so nothing was posted; reply on the item instead`
      );
    }
  }

  let body: string;
  let answer: string;
  if (text !== null) {
    body = `${text}\n\n${ANSWERED_IN_DORKOS}`;
    answer = text;
  } else {
    if (question === undefined || existing === undefined) {
      throw new PreconditionError(
        `${identifier} has no recorded question, so there is no pick to take`
      );
    }
    // Read from the triggers, not the stored who-answers fields, so a record
    // edited by hand cannot let a pick settle a spend.
    if (personOnly(question)) {
      throw new PreconditionError(
        `${identifier}'s question is about secrets or spending, so only a person answers it`
      );
    }
    if (by === 'agent-default' && !pickIsDue(question, ctx.now())) {
      throw new PreconditionError(
        question.floor.length > 0
          ? `${identifier}'s question is on the floor, so the agent's pick never stands on a deadline alone; the reviewer agent or a person checks it`
          : `${identifier}'s question has no deadline that has passed, so its pick cannot stand yet`
      );
    }
    if (by === 'reviewer-agent') {
      requireOtherSession(
        ctx,
        [question.askedBy, existing.sessionId],
        'answer its own question as the reviewer agent'
      );
      const token = flag(ctx, 'token');
      const expected = question.checkTokenHash;
      if (token === undefined || expected === undefined || tokenHash(token) !== expected) {
        throw new PreconditionError(
          `this token does not match the check flow started for ${identifier}; only the brief from "flow ask ${identifier} --check-pick" carries it`
        );
      }
    }
    const comment = pickComment(
      question,
      by === 'reviewer-agent' ? 'reviewer-agent' : 'agent-default'
    );
    body = signBody(comment, loaded.config.identity.marker, sessionProvenance(ctx, existing.host));
    answer = comment;
  }

  if (!ctx.dryRun) {
    const recorded = { text: answer, at: ctx.now().toISOString(), by };
    // Claim the answer under the lock before posting anything: a person, the
    // DorkOS deadline and the drain can all reach one question, and only the
    // first may answer it. The loser posts nothing (exit 5).
    const claimed =
      existing !== undefined && question !== undefined
        ? await claimAnswer(store, existing.issueId, question.askedAt, recorded)
        : null;
    if (claimed === false) {
      throw new SettledError(
        `another answer to ${identifier}'s question got there first (a person, the deadline or the reviewer agent), so nothing was posted`
      );
    }
    try {
      await adapter.comment(item, body);
    } catch (error) {
      if (claimed === true && existing !== undefined && question !== undefined) {
        await releaseAnswer(store, existing.issueId, question.askedAt, recorded);
      }
      throw error;
    }
    if (caller !== null) recordPersonAct(ctx, 'answer', identifier, caller);
  }
  const who =
    by === 'person'
      ? 'your answer'
      : by === 'agent-default'
        ? "the agent's pick"
        : "the reviewer agent's check";
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      by,
      answer,
      recorded: question !== undefined,
    },
    text: `${ctx.dryRun ? 'Would post' : 'Posted'} ${who} on ${identifier}. The work goes on from there.`,
  };
}
