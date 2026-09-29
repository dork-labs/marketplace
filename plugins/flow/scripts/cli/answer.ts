/**
 * `flow answer <identifier>` (spec `flow-multiproject` §7.5): answer an agent's
 * parked question.
 *
 * - `--text <text>` or `--text-file <file>`: a person's answer, from DorkOS. It
 *   is posted on the item without the agent's marker, as the tracker account
 *   flow uses, with "Answered in DorkOS." as its last line, so the comment rules
 *   (`shouldRespondToComment`) count it as the reply. It is also recorded on the
 *   run, so the drain resumes on it even when flow posts through the agent's
 *   own tracker account (then the comment reads as the agent's, not a reply).
 * - `--pick --by agent-default`: the question's deadline passed with no answer,
 *   so the agent's own pick stands. Posted as the agent ("No answer by …, so
 *   going with …"). Refused for a floor question: a deadline alone never
 *   settles one.
 * - `--pick --by reviewer-agent --token <t>`: the reviewer agent checked a floor
 *   question's pick and agrees. The token comes from `flow ask --check-pick`.
 *
 * It refuses (exit 5) an item that no longer carries `agent/needs-input`, or
 * whose question was already answered: whoever got there first wins, and the
 * second does nothing. It never lifts `agent/needs-input` itself: the drain and
 * the inbox pass see the answer and resume the work, as they do for any reply.
 *
 * @module @dorkos/flow/cli/answer
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import {
  MAX_ANSWER_LENGTH,
  personOnly,
  pickComment,
  pickIsDue,
  type QuestionSettler,
} from '../question.ts';
import { requireOtherSession } from './caller.ts';
import { claimAnswer, releaseAnswer } from './question-write.ts';
import { AGENT_NEEDS_INPUT } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody } from './provenance.ts';
import { tokenHash } from './report.ts';
import { runFor, sessionProvenance, setupWrite } from './work-write.ts';

/** The last line of a person's answer posted from DorkOS. */
export const ANSWERED_IN_DORKOS = 'Answered in DorkOS.';

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** The person's answer from `--text` or `--text-file`. */
function answerText(ctx: VerbContext): string {
  const text = flag(ctx, 'text');
  const file = flag(ctx, 'text-file');
  if ((text === undefined) === (file === undefined)) {
    throw new UsageError('give the answer with exactly one of --text or --text-file');
  }
  let value = text;
  if (file !== undefined) {
    try {
      value = readFileSync(path.resolve(ctx.cwd, file), 'utf8');
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
 * Run `flow answer`.
 *
 * @param ctx - The verb's context.
 * @returns What was posted and recorded.
 * @throws {UsageError} On a missing or empty answer, or wrong flags (exit 2).
 * @throws {PreconditionError} When the question was already answered, or the
 *   pick may not stand yet (exit 5).
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
  const text = pick ? null : answerText(ctx);

  const { loaded, adapter, store } = await setupWrite(ctx, ['getItem', 'comment']);
  const item = await adapter.getItem(identifier);
  const existing: FlowRun | undefined = runFor(store, item);
  const question = existing?.question;
  const settled = () =>
    new PreconditionError(
      `${identifier}'s question was already answered (it no longer carries ${AGENT_NEEDS_INPUT}), so nothing was posted`
    );
  if (!item.labels.includes(AGENT_NEEDS_INPUT) || question?.answer !== undefined) throw settled();

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
    if (claimed === false) throw settled();
    try {
      await adapter.comment(item, body);
    } catch (error) {
      if (claimed === true && existing !== undefined && question !== undefined) {
        await releaseAnswer(store, existing.issueId, question.askedAt, recorded);
      }
      throw error;
    }
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
