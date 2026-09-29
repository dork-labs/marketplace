/**
 * `flow ask <identifier>` (spec `flow-multiproject` §7.5): how an agent parks a
 * question. It offers its own pick and says why, so a person can answer with
 * one click, and so the pick can stand in for an answer when the project lets
 * it.
 *
 * `flow ask <id> --question <text> --choice <text> --choice <text>… --pick <n>
 * --why <text> [--floor <trigger,…>] [--decide-by <iso>]`:
 *
 * 1. Works out who answers from the project's "Agent questions" stop
 *    (`flow autonomy`) and the floor triggers the question carries
 *    (`whoAnswers` in `calibration.ts`). At Just do it a question that is not
 *    on the floor is refused: the agent goes ahead with its pick and writes
 *    down why instead.
 * 2. Sets the deadline: at Tell me after, for a question not on the floor, now
 *    plus the project's wait (4 hours unless the settings say otherwise), or
 *    `--decide-by`. A floor question, or any at Ask me first, has none.
 * 3. Posts the question on the item (once), marks it `agent/needs-input`, and
 *    writes the question on the run. A drain run parks until someone answers.
 *
 * `flow ask <id> --check-pick` hands the pick of a floor question to the
 * reviewer agent once its wait is over: it prints a brief with a token, and the
 * reviewer approves the pick with `flow answer <id> --pick --by reviewer-agent
 * --token <t>`, or leaves the question for a person.
 *
 * @module @dorkos/flow/cli/ask
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { stopInForce } from '../autonomy.ts';
import { whoAnswers, type FloorTrigger } from '../calibration.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun, RunQuestion } from '../flow-run.ts';
import {
  checkBrief,
  choicesOf,
  formatWhen,
  personOnly,
  pickOf,
  questionComment,
  questionProblem,
} from '../question.ts';
import { requireOtherSession, callerSessions } from './caller.ts';
import { claimCheck } from './question-write.ts';
import { AGENT_NEEDS_INPUT, projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { isWritableDrain } from './drain-run.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { tokenHash } from './report.ts';
import {
  applyAndVerify,
  requireStored,
  runFor,
  sessionProvenance,
  setupWrite,
} from './work-write.ts';

/** The floor triggers `--floor` accepts. */
const FLOOR_TRIGGERS: readonly FloorTrigger[] = [
  'irreversible-or-destructive',
  'outward-facing',
  'secrets-or-spend',
  'scope-change',
];

/** How many of the latest comments are checked for an earlier post of the question. */
const RECENT_COMMENTS = 10;

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** The floor triggers named by `--floor`. */
function floorOf(ctx: VerbContext): FloorTrigger[] {
  const given = flag(ctx, 'floor');
  if (given === undefined) return [];
  const triggers = given
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const trigger of triggers) {
    if (!(FLOOR_TRIGGERS as readonly string[]).includes(trigger)) {
      throw new UsageError(`--floor takes ${FLOOR_TRIGGERS.join(', ')}; "${trigger}" is not one`);
    }
  }
  return [...new Set(triggers)] as FloorTrigger[];
}

/** `flow ask --check-pick`: hand a floor question's pick to the reviewer agent. */
async function checkPick(ctx: VerbContext, identifier: string): Promise<VerbResult> {
  for (const name of Object.keys(ctx.args.flags)) {
    if (!['check-pick', 'project', 'session'].includes(name)) {
      throw new UsageError(`--check-pick does not take --${name}`);
    }
  }
  const { adapter, store } = await setupWrite(ctx, ['getItem']);
  const item = await adapter.getItem(identifier);
  const run = runFor(store, item);
  const question = run?.question;
  if (run === undefined || question === undefined) {
    throw new PreconditionError(`${identifier} has no open question to check`);
  }
  // Read from the triggers, not the stored who-answers fields, so a record
  // edited by hand cannot hand a spend to the reviewer agent.
  if (personOnly(question)) {
    throw new PreconditionError(
      `${identifier}'s question is about secrets or spending, so only a person answers it`
    );
  }
  requireOtherSession(ctx, [question.askedBy, run.sessionId], 'check the pick of its own question');
  if (question.answer !== undefined || !item.labels.includes(AGENT_NEEDS_INPUT)) {
    throw new PreconditionError(`${identifier}'s question was already answered`);
  }
  if (question.floor.length === 0 || question.checkAfter === null) {
    throw new PreconditionError(
      `${identifier}'s question is not one the reviewer agent checks: it waits for a person${question.decideBy === null ? '' : ", or goes with the agent's pick at its deadline"}`
    );
  }
  if (Date.parse(question.checkAfter) > ctx.now().getTime()) {
    throw new PreconditionError(
      `a person still has until ${formatWhen(question.checkAfter)} to answer ${identifier}; check the pick after that`
    );
  }
  const token = randomBytes(16).toString('hex');
  if (!ctx.dryRun && !(await claimCheck(store, run.issueId, question.askedAt, tokenHash(token)))) {
    throw new PreconditionError(
      `${identifier}'s pick was already handed to the reviewer agent, or the question was answered`
    );
  }
  const flow = `node --experimental-strip-types ${path.join(ctx.flowRoot, 'scripts', 'flow.ts')}`;
  const brief = checkBrief(question, identifier, flow, token);
  return {
    json: { ok: true, identifier, checkPick: true, token, brief, question: { ...question } },
    text: brief,
  };
}

/**
 * Run `flow ask`.
 *
 * @param ctx - The verb's context.
 * @returns The question as recorded and who answers it.
 * @throws {UsageError} On a question that breaks the rules in `question.ts` (exit 2).
 * @throws {PreconditionError} When the project lets the agent go ahead instead,
 *   or the item cannot take a question (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  if (ctx.args.flags['check-pick'] === true) return checkPick(ctx, identifier);

  const text = flag(ctx, 'question') ?? '';
  const labels = ctx.args.repeated?.choice ?? [];
  const pickFlag = flag(ctx, 'pick');
  const pickNumber = pickFlag === undefined ? Number.NaN : Number(pickFlag);
  const why = flag(ctx, 'why') ?? '';
  const floorTriggers = floorOf(ctx);
  const decideByFlag = flag(ctx, 'decide-by') ?? null;
  const now = ctx.now();
  const problem = questionProblem(
    { text, labels, pick: pickNumber, why, decideBy: decideByFlag },
    now
  );
  if (problem !== null) throw new UsageError(problem);

  const { loaded, stages, adapter, store } = await setupWrite(ctx, [
    'getItem',
    'applyWorkState',
    'comment',
  ]);
  const { config } = loaded;
  const read = loaded.autonomy;
  const stop = read === null ? 'ask' : stopInForce(read, 'questions');
  const alwaysAsk = new Set<string>(config.involvement.calibration.alwaysAsk);
  // The floor as the project's calibration defines it, stored as such, so the
  // deadline promised here and the one `pickIsDue` honours agree. A spend
  // stays on the record whatever alwaysAsk says: only a person answers it.
  const effectiveFloor = floorTriggers.filter(
    (trigger) => alwaysAsk.has(trigger) || trigger === 'secrets-or-spend'
  );
  const floor = floorTriggers.some((trigger) => alwaysAsk.has(trigger));
  const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
  const existing: FlowRun | undefined = runFor(store, item);
  // With no run on this machine nothing would keep a deadline or hand out a
  // check, so the question promises neither: it waits for a person.
  const who =
    existing === undefined
      ? ({ answeredBy: 'person', answeredByAtDeadline: null } as const)
      : whoAnswers(floor, floorTriggers, stop);
  if (who.answeredBy === 'agent-default') {
    throw new PreconditionError(
      "this project's settings let the agent go ahead with its own pick (Agent questions: Just do it); go ahead and write down why instead of asking"
    );
  }
  const deadlineApplies = who.answeredByAtDeadline === 'agent-default';
  if (decideByFlag !== null && !deadlineApplies) {
    throw new UsageError(
      existing === undefined
        ? `${identifier} has no run on this machine, so nothing would keep a deadline; leave out --decide-by`
        : floor
          ? 'a floor question has no deadline: someone must check it, so leave out --decide-by'
          : "this project's settings wait for a person to answer (Agent questions: Ask me first), so leave out --decide-by"
    );
  }
  const minutes = read?.state === 'ok' ? read.copy.questionDeadlineMinutes : null;
  const decideBy = deadlineApplies
    ? (decideByFlag ?? new Date(now.getTime() + (minutes ?? 240) * 60_000).toISOString())
    : null;
  const checkAfter =
    who.answeredBy === 'reviewer-agent'
      ? now.toISOString()
      : who.answeredByAtDeadline === 'reviewer-agent'
        ? new Date(now.getTime() + (minutes ?? 240) * 60_000).toISOString()
        : null;
  const choices = choicesOf(labels);
  const question: RunQuestion = {
    text: text.trim(),
    choices,
    pick: choices[pickNumber - 1].id,
    why: why.trim(),
    askedAt: now.toISOString(),
    ...(callerSessions(ctx)[0] === undefined ? {} : { askedBy: callerSessions(ctx)[0] }),
    decideBy,
    floor: effectiveFloor,
    answeredBy: who.answeredBy,
    checkAfter,
  };

  const body = signBody(
    questionComment(question),
    config.identity.marker,
    sessionProvenance(ctx, existing?.host)
  );
  // Skip only a retry of this same question (still the item's latest comment).
  const last = (item.comments ?? []).at(-1);
  const alreadyPosted = last !== undefined && unsignedBody(last.body) === unsignedBody(body);
  if (!ctx.dryRun) {
    if (!alreadyPosted) await adapter.comment(item, body);
    await applyAndVerify(adapter, item, projectionFor({ type: 'needs-input' }, { stages }));
    if (existing !== undefined) {
      const written = await store.updateRun(existing.issueId, (current) => {
        const next: FlowRun = { ...current, question };
        if (!isWritableDrain(current)) return next;
        const drain = current.drain;
        return {
          ...next,
          drain: {
            ...drain,
            rev: drain.rev + 1,
            phase: 'parked',
            parkedReason: `the worker asked a question: ${question.text.split('\n')[0].slice(0, 117)}`,
            parkedFrom: drain.phase === 'parked' ? (drain.parkedFrom ?? null) : drain.phase,
            parkedAt: now.toISOString(),
            parkedFor: 'person',
          },
        };
      });
      requireStored(
        written.status,
        store.path,
        `run the same "flow ask ${identifier}" again (the question is posted, so it will not be posted twice)`
      );
    } else {
      ctx.warn(
        `${identifier} has no run on this machine, so the question is on the tracker only; DorkOS shows it once a run records it`
      );
    }
  }
  const pick = pickOf(question)?.label ?? '';
  const when =
    decideBy !== null
      ? ` If nobody answers by ${formatWhen(decideBy)}, the agent goes with "${pick}".`
      : who.answeredBy === 'reviewer-agent' || who.answeredByAtDeadline === 'reviewer-agent'
        ? ' The reviewer agent checks the pick if nobody answers first.'
        : ' It waits for a person.';
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      question,
      answeredBy: who.answeredBy,
      answeredByAtDeadline: who.answeredByAtDeadline,
      commented: !alreadyPosted && !ctx.dryRun,
      recorded: existing !== undefined && !ctx.dryRun,
    },
    text: `${ctx.dryRun ? 'Would ask' : 'Asked'} on ${identifier}: ${question.text.split('\n')[0]}.${when}`,
  };
}
