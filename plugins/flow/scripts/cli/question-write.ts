/**
 * The locked writes a parked question takes (spec `flow-multiproject` §7.5).
 * Several paths can settle one question: a person through `flow answer`, the
 * DorkOS deadline, the drain's own deadline pass, the reviewer agent. Each one
 * claims the answer here, inside the run store's lock, and only when the
 * question is still the one it read (same `askedAt`) and still unanswered, so
 * exactly one wins and the others find it settled.
 *
 * Needs `zod` (through the run store), so it is reached through a verb.
 *
 * @module @dorkos/flow/cli/question-write
 */

import { PreconditionError } from '../errors.ts';
import type { RunQuestion } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';

/** An answer to record. */
export interface RecordedAnswer {
  /** The answer's words. */
  text: string;
  /** When it was given (ISO). */
  at: string;
  /** Who gave it: `person`, `agent-default` or `reviewer-agent`. */
  by: string;
}

/** Whether `current` is still the question asked at `askedAt`. */
function same(current: RunQuestion | undefined, askedAt: string): current is RunQuestion {
  return current !== undefined && current.askedAt === askedAt;
}

/** Refuse a write the lock dropped. */
function requireWritten(status: string, file: string): void {
  if (status === 'dropped') {
    throw new PreconditionError(
      `${file} stayed locked by another flow command, so nothing was recorded; run the same command again`
    );
  }
}

/**
 * Claim the answer to the question asked at `askedAt`, under the lock.
 *
 * @param store - The run store.
 * @param issueId - The run's key.
 * @param askedAt - The question's `askedAt`, as the caller read it.
 * @param answer - The answer.
 * @returns `true` when this call recorded it; `false` when the question was
 *   already answered, replaced or gone (the caller lost the race).
 * @throws {PreconditionError} When the lock stayed busy.
 */
export async function claimAnswer(
  store: FlowStateFile,
  issueId: string,
  askedAt: string,
  answer: RecordedAnswer
): Promise<boolean> {
  let won = false;
  const result = await store.updateRun(issueId, (current) => {
    won = same(current.question, askedAt) && current.question.answer === undefined;
    if (!won || current.question === undefined) return current;
    return { ...current, question: { ...current.question, answer } };
  });
  requireWritten(result.status, store.path);
  return won;
}

/**
 * Undo {@link claimAnswer} when posting the answer failed, so another path can
 * still settle the question. Only this exact answer is removed.
 *
 * @param store - The run store.
 * @param issueId - The run's key.
 * @param askedAt - The question's `askedAt`.
 * @param answer - The answer this call recorded.
 */
export async function releaseAnswer(
  store: FlowStateFile,
  issueId: string,
  askedAt: string,
  answer: RecordedAnswer
): Promise<void> {
  await store.updateRun(issueId, (current) => {
    const q = current.question;
    if (!same(q, askedAt) || q.answer?.at !== answer.at || q.answer.by !== answer.by) {
      return current;
    }
    const { answer: _dropped, ...rest } = q;
    return { ...current, question: rest };
  });
}

/**
 * Record that the reviewer agent's check of a floor question was handed out,
 * with its token's hash and the session that handed it out, once.
 *
 * @param store - The run store.
 * @param issueId - The run's key.
 * @param askedAt - The question's `askedAt`.
 * @param hash - The token's SHA-256.
 * @returns `true` when this call recorded it; `false` when a check was already
 *   handed out, or the question was answered or replaced.
 * @throws {PreconditionError} When the lock stayed busy.
 */
export async function claimCheck(
  store: FlowStateFile,
  issueId: string,
  askedAt: string,
  hash: string
): Promise<boolean> {
  let won = false;
  const result = await store.updateRun(issueId, (current) => {
    const q = current.question;
    won = same(q, askedAt) && q.answer === undefined && q.checkTokenHash === undefined;
    if (!won || q === undefined) return current;
    return { ...current, question: { ...q, checkTokenHash: hash } };
  });
  requireWritten(result.status, store.path);
  return won;
}

/**
 * Clear a question once the work resumed on its answer, so a later park never
 * mistakes it for its own.
 *
 * @param store - The run store.
 * @param issueId - The run's key.
 * @param askedAt - The question's `askedAt`.
 */
export async function clearQuestion(
  store: FlowStateFile,
  issueId: string,
  askedAt: string
): Promise<void> {
  await store.updateRun(issueId, (current) => {
    if (!same(current.question, askedAt)) return current;
    const { question: _done, ...rest } = current;
    return rest;
  });
}
