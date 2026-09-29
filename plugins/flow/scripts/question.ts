/**
 * An agent's question with its own pick and a deadline (spec
 * `flow-multiproject` §7.5): the rules `flow ask` checks, the words it posts,
 * and when the agent's pick may stand in for an answer.
 *
 * The limits are DorkOS's, so a question flow parks can always be raised in
 * the app's inbox as a `choice` decision: 2 to 5 choices of at most 40
 * characters, a reason of at most 300, and a deadline 5 minutes to 7 days away.
 *
 * Pure and dependency-free: no I/O, no clock (callers pass `now`).
 *
 * @module @dorkos/flow/question
 */

import { hasZone } from './_shared.ts';
import type { RunQuestion, RunQuestionChoice } from './flow-run.ts';

export { hasZone };

/** The fewest choices a question offers. */
export const MIN_CHOICES = 2;

/** The most choices a question offers. */
export const MAX_CHOICES = 5;

/** The longest a choice's words may be. */
export const MAX_CHOICE_LENGTH = 40;

/** The longest a question's reason may be. */
export const MAX_WHY_LENGTH = 300;

/** The longest a written answer may be. */
export const MAX_ANSWER_LENGTH = 2000;

/** The soonest a deadline may be, in minutes from now. */
export const MIN_DEADLINE_MINUTES = 5;

/** The latest a deadline may be, in minutes from now (seven days). */
export const MAX_DEADLINE_MINUTES = 7 * 24 * 60;

/** Who settled a question. */
export type QuestionSettler = 'person' | 'agent-default' | 'reviewer-agent';

/**
 * The choices as the run records them: ids `c1`, `c2`… in the order given.
 *
 * @param labels - The choices' words.
 * @returns The choices.
 */
export function choicesOf(labels: readonly string[]): RunQuestionChoice[] {
  return labels.map((label, index) => ({ id: `c${index + 1}`, label: label.trim() }));
}

/**
 * Why a question cannot be asked as given, or `null` when it can.
 *
 * @param input - The question's parts.
 * @param now - The time it is asked.
 * @returns A plain sentence naming the fix, or `null`.
 */
export function questionProblem(
  input: {
    text: string;
    labels: readonly string[];
    pick: number;
    why: string;
    decideBy: string | null;
  },
  now: Date
): string | null {
  if (input.text.trim() === '') return 'the question is empty; write it with --question';
  const count = input.labels.length;
  if (count < MIN_CHOICES || count > MAX_CHOICES) {
    return `give ${MIN_CHOICES} to ${MAX_CHOICES} choices with --choice (you gave ${count}), so the person can answer with one click`;
  }
  const long = input.labels.find((label) => label.trim().length > MAX_CHOICE_LENGTH);
  if (long !== undefined) {
    return `the choice "${long.trim()}" is longer than ${MAX_CHOICE_LENGTH} characters; shorten it so it fits on a button`;
  }
  if (input.labels.some((label) => label.trim() === '')) return 'a choice is empty';
  const lower = input.labels.map((label) => label.trim().toLowerCase());
  if (new Set(lower).size !== lower.length) return 'two choices say the same thing';
  if (!Number.isInteger(input.pick) || input.pick < 1 || input.pick > count) {
    return `--pick is the number of your own choice, 1 to ${count}`;
  }
  const why = input.why.trim();
  if (why === '') {
    return 'say why you ask with --why: what happens, why now, and why your pick';
  }
  if (why.length > MAX_WHY_LENGTH) {
    return `--why is longer than ${MAX_WHY_LENGTH} characters; keep it to what happens, why now, and why your pick`;
  }
  if (input.decideBy !== null) {
    const at = Date.parse(input.decideBy);
    if (!Number.isFinite(at) || !hasZone(input.decideBy)) {
      return `--decide-by must be a time with its zone, e.g. 2026-09-29T17:00:00+02:00 or …Z, not "${input.decideBy}"`;
    }
    const minutes = (at - now.getTime()) / 60_000;
    if (minutes < MIN_DEADLINE_MINUTES || minutes > MAX_DEADLINE_MINUTES) {
      return '--decide-by must be between 5 minutes and 7 days from now';
    }
  }
  return null;
}

/**
 * A time in words the same on every machine: `Sep 28, 17:00 UTC`.
 *
 * @param iso - An ISO time.
 * @returns The words.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${date.getUTCDate()}, ${hh}:${mm} UTC`;
}

/**
 * The agent's pick.
 *
 * @param question - The question.
 * @returns Its chosen choice, or `undefined` when the record is inconsistent.
 */
export function pickOf(question: RunQuestion): RunQuestionChoice | undefined {
  return question.choices.find((choice) => choice.id === question.pick);
}

/**
 * The comment `flow ask` posts on the item: the question, the choices with the
 * agent's pick marked, why, and what happens if nobody answers.
 *
 * @param question - The question.
 * @returns The comment body, before the agent's marker.
 */
export function questionComment(question: RunQuestion): string {
  const pick = pickOf(question);
  const lines = [question.text.trim(), ''];
  question.choices.forEach((choice, index) => {
    lines.push(`${index + 1}. ${choice.label}${choice.id === question.pick ? ' (my pick)' : ''}`);
  });
  lines.push('', question.why.trim(), '');
  if (question.decideBy !== null && pick !== undefined) {
    lines.push(
      `If you don't answer by ${formatWhen(question.decideBy)}, I'll go with "${pick.label}". Reply to this comment to answer.`
    );
  } else if (question.checkAfter !== null && question.answeredBy === 'reviewer-agent') {
    lines.push(
      "I won't go ahead until someone checks: the reviewer agent checks my pick, or you can answer first. Reply to this comment to answer."
    );
  } else if (question.checkAfter !== null) {
    lines.push(
      `I won't go ahead until someone checks: you, or, if you haven't answered, the reviewer agent checks my pick after ${formatWhen(question.checkAfter)}. Reply to this comment to answer.`
    );
  } else {
    lines.push("I won't go ahead until you answer. Reply to this comment to answer.");
  }
  return lines.join('\n');
}

/**
 * Whether the agent's pick may now stand in for an answer: the question has a
 * deadline, it has passed, nobody answered, and it is not a floor question (a
 * floor question is never settled by a deadline alone; the reviewer agent or a
 * person checks it).
 *
 * @param question - The question.
 * @param now - The time now.
 * @returns `true` when the pick should be taken.
 */
export function pickIsDue(question: RunQuestion, now: Date): boolean {
  if (question.answer !== undefined || question.decideBy === null) return false;
  if (question.floor.length > 0 || personOnly(question)) return false;
  const at = Date.parse(question.decideBy);
  return Number.isFinite(at) && at <= now.getTime() && pickOf(question) !== undefined;
}

/**
 * The comment posted when the agent's pick stands in for an answer.
 *
 * @param question - The question.
 * @param by - Who settled it: the deadline (`agent-default`) or the reviewer agent.
 * @returns The comment body, before the agent's marker.
 */
export function pickComment(question: RunQuestion, by: 'agent-default' | 'reviewer-agent'): string {
  const label = pickOf(question)?.label ?? question.pick;
  if (by === 'reviewer-agent') {
    return `The reviewer agent checked the agent's pick and agrees, so going with "${label}".`;
  }
  const when = question.decideBy === null ? 'the deadline' : formatWhen(question.decideBy);
  return `No answer by ${when}, so going with "${label}" (the agent's pick).`;
}

/** The trigger whose questions only a person answers, at every stop. */
export const PERSON_ONLY_TRIGGER = 'secrets-or-spend';

/**
 * Whether only a person may answer this question: it carries
 * `secrets-or-spend`. Read from the triggers themselves, never from the stored
 * `answeredBy` or `checkAfter`, so a hand-edited record cannot widen it.
 *
 * @param question - The question.
 * @returns `true` when no pick and no reviewer agent may settle it.
 */
export function personOnly(question: RunQuestion): boolean {
  return question.floor.includes(PERSON_ONLY_TRIGGER);
}

/**
 * Whether a question belongs to the park that began at `since`: it was asked
 * at or after the park began. A question left on the run from an earlier park
 * (a later park for review rounds or failing checks) belongs to no park.
 *
 * @param question - The run's question.
 * @param since - When the current park began (ISO), or `null` when unknown.
 * @returns `true` when the question is this park's.
 */
export function belongsToPark(question: RunQuestion, since: string | null): boolean {
  if (since === null) return false;
  const asked = Date.parse(question.askedAt);
  const parked = Date.parse(since);
  return Number.isFinite(asked) && Number.isFinite(parked) && asked >= parked;
}

/**
 * Whether the reviewer agent may now check a floor question's pick: it is
 * this park's, unanswered, not a person's alone, its wait is over, and no
 * check was handed out yet.
 *
 * @param question - The question.
 * @param now - The time now.
 * @returns `true` when the check is due.
 */
export function checkIsDue(question: RunQuestion, now: Date): boolean {
  if (question.answer !== undefined || question.checkAfter === null) return false;
  if (question.floor.length === 0 || personOnly(question)) return false;
  if (question.checkTokenHash !== undefined) return false;
  const at = Date.parse(question.checkAfter);
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * What a parked run's recorded question says about resuming it, when no reply
 * on the tracker did. Only a question asked for the current park counts
 * ({@link belongsToPark}):
 *
 * - `recorded`: `flow answer` recorded an answer to it.
 * - `take-pick`: its deadline passed and the agent's pick now stands.
 * - `check-pick`: a floor question's wait is over; hand the pick to the
 *   reviewer agent.
 * - `null`: keep waiting.
 *
 * @param question - The run's question, if it has one.
 * @param now - The time now.
 * @param since - When the current park began (the drain's `parkedAt`).
 * @returns What to do.
 */
export function parkedAnswer(
  question: RunQuestion | undefined,
  now: Date,
  since: string | null
): 'recorded' | 'take-pick' | 'check-pick' | null {
  if (question === undefined || !belongsToPark(question, since)) return null;
  if (question.answer !== undefined) {
    const answered = Date.parse(question.answer.at);
    return answered >= Date.parse(question.askedAt) ? 'recorded' : null;
  }
  if (pickIsDue(question, now)) return 'take-pick';
  return checkIsDue(question, now) ? 'check-pick' : null;
}

/**
 * The brief the reviewer agent gets to check a floor question's pick. The
 * token appears only here.
 *
 * @param question - The question.
 * @param identifier - The item.
 * @param flow - The command prefix that runs flow.
 * @param token - The check's token.
 * @returns The brief.
 */
export function checkBrief(
  question: RunQuestion,
  identifier: string,
  flow: string,
  token: string
): string {
  const pick = pickOf(question);
  return [
    `Check an agent's pick on ${identifier} before it goes ahead.`,
    '',
    `Question: ${question.text}`,
    ...question.choices.map(
      (choice, i) => `${i + 1}. ${choice.label}${choice.id === question.pick ? ' (its pick)' : ''}`
    ),
    `Why it picked "${pick?.label ?? question.pick}": ${question.why}`,
    `It is on the floor because it is ${question.floor.join(' and ')}.`,
    '',
    `If the pick is sound, approve it: ${flow} answer ${identifier} --pick --by reviewer-agent --token ${token}`,
    'If you have any doubt, do nothing: the question waits for a person.',
  ].join('\n');
}
