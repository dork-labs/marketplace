/**
 * `flow autonomy [--kind <kind>]` (spec `flow-multiproject` §7.7): how much
 * flow does on its own in this project, per kind of ask, as the project's dial
 * says. Read-only: nothing here, and no agent, can move the dial; only a person
 * can, from the project's Flow settings in DorkOS.
 *
 * The skills ask it before they decide who answers: VERIFY runs
 * `flow autonomy --kind ship --json` to learn whether the reviewer agent may
 * answer the review gate, and a parked question reads `--kind questions`.
 *
 * @module @dorkos/flow/cli/autonomy
 */

import {
  AUTONOMY_KINDS,
  autonomyCopyPath,
  readAutonomyCopy,
  stopInForce,
  type AutonomyKind,
  type AutonomyRead,
  type AutonomyStop,
} from '../autonomy.ts';
import type { AnsweredBy } from '../calibration.ts';
import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { UsageError } from '../errors.ts';
import { resolveDorkHome } from '../fleet/accounts.ts';
import { canonicalProjectRoot } from '../main-checkout.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** The words for each stop, as the settings page shows them. */
const STOP_WORDS: Readonly<Record<AutonomyStop, string>> = {
  ask: 'Ask me first',
  tell: 'Tell me after',
  auto: 'Just do it',
};

/** The words for each kind, as the settings page shows them. */
const KIND_WORDS: Readonly<Record<AutonomyKind, string>> = {
  ship: 'Ship finished work',
  questions: 'Agent questions',
  sort: 'Sort new ideas',
  retry: 'Retry and fix problems',
};

/** What one kind resolves to. */
export interface KindAnswer {
  /** The stop in force. */
  stop: AutonomyStop;
  /**
   * Who answers the ask first: for `ship`, `person` or `reviewer-agent`; for
   * `questions`, who answers a question that is not on the floor (a floor
   * question is `calibration.ts`'s to route). `null` for `sort` and `retry`,
   * which are not answered but done.
   */
  answeredBy: AnsweredBy | null;
  /** One plain sentence on what the stop means here. */
  says: string;
}

/**
 * What a stop means for one kind, in plain words.
 *
 * @param kind - The kind.
 * @param stop - The stop.
 * @param reviewerAgent - Whether a reviewer agent checks this project's work.
 * @returns The answer.
 */
export function describeKind(
  kind: AutonomyKind,
  stop: AutonomyStop,
  reviewerAgent: boolean
): KindAnswer {
  if (kind === 'ship') {
    if (stop === 'ask') {
      return {
        stop,
        answeredBy: 'person',
        says: reviewerAgent
          ? 'Finished work waits for you to ship it.'
          : "Finished work waits for you to ship it, because no reviewer agent checks this repo's work (review.adversarial is off).",
      };
    }
    return {
      stop,
      answeredBy: 'reviewer-agent',
      says: 'Finished work ships when the reviewer agent approves a clean review of the latest commit.',
    };
  }
  if (kind === 'questions') {
    if (stop === 'ask') {
      return { stop, answeredBy: 'person', says: 'An agent waits for your answer.' };
    }
    if (stop === 'tell') {
      return {
        stop,
        answeredBy: 'person',
        says: 'An agent waits for your answer until its deadline, then goes ahead with its own pick.',
      };
    }
    return {
      stop,
      answeredBy: 'agent-default',
      says: 'An agent goes ahead with its own pick and writes down why.',
    };
  }
  if (kind === 'sort') {
    return {
      stop,
      answeredBy: null,
      says:
        stop === 'ask'
          ? 'New ideas wait for you to sort them.'
          : 'New ideas are sorted every morning on their own.',
    };
  }
  return {
    stop,
    answeredBy: null,
    says:
      stop === 'ask'
        ? 'Failing checks wait for you before flow tries to fix them.'
        : 'Failing checks are fixed on their own.',
  };
}

/** The sentence for where the dial came from. */
function sourceText(read: AutonomyRead): string {
  if (read.state === 'ok') return `From this project's Flow settings in DorkOS (${read.file}).`;
  if (read.state === 'unreadable') {
    return `The copy of this project's settings at ${read.file} could not be read, so flow asks you first about everything.`;
  }
  return "This project's Flow settings in DorkOS have not been chosen yet, so flow asks you first.";
}

/**
 * Run `flow autonomy`.
 *
 * @param ctx - The verb's context.
 * @returns Each kind's stop, or the one `--kind` asked for.
 * @throws {UsageError} On an unknown `--kind`.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const kindFlag = ctx.args.flags.kind;
  if (typeof kindFlag === 'string' && !(AUTONOMY_KINDS as readonly string[]).includes(kindFlag)) {
    throw new UsageError(`--kind must be one of ${AUTONOMY_KINDS.join(', ')}, not "${kindFlag}"`);
  }
  const roots = findConfigRoots(ctx.projectDir, ctx.flowRoot);
  const { config } = loadConfig(roots, ctx.env, { now: () => ctx.now() });
  const reviewerAgent = config.review.adversarial;
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const read = readAutonomyCopy(autonomyCopyPath(dorkHome, canonicalProjectRoot(ctx.projectDir)));
  const copy = read.state === 'ok' ? read.copy : null;
  const kinds = Object.fromEntries(
    AUTONOMY_KINDS.map((kind) => [
      kind,
      describeKind(kind, stopInForce(read, kind, { reviewerAgent }), reviewerAgent),
    ])
  ) as Record<AutonomyKind, KindAnswer>;
  const minutes = copy?.questionDeadlineMinutes ?? null;
  const base = {
    ok: true,
    source: read.state === 'ok' ? 'copy' : read.state,
    file: read.file,
    questionDeadlineMinutes: minutes,
  };

  if (typeof kindFlag === 'string') {
    const kind = kindFlag as AutonomyKind;
    const answer = kinds[kind];
    return {
      json: { ...base, kind, ...answer },
      text: `${KIND_WORDS[kind]}: ${STOP_WORDS[answer.stop]}. ${answer.says}\n${sourceText(read)}`,
    };
  }
  const rows = AUTONOMY_KINDS.map((kind) => [
    KIND_WORDS[kind],
    STOP_WORDS[kinds[kind].stop],
    kinds[kind].says,
  ]);
  return {
    json: { ...base, kinds },
    text: `${formatColumns(rows)}\n${sourceText(read)}`,
  };
}
