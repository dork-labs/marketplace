/**
 * Intake routing — the TRIAGE stage's third entry shape (Path C).
 *
 * A **report** is something an outside party filed: a support message, a public
 * issue, a feedback-form submission, a sales question. A **work item** is
 * something we committed to doing. They are two objects with two lifecycles, and
 * Path C exists because the other two TRIAGE paths cannot keep them apart:
 * Path B (evaluate an existing item) converts **in place**, which would hand raw
 * reporter prose to a dispatching agent and destroy the reporter's receipt.
 *
 * Three facts force the split, and each of them is a rule this module encodes:
 *
 * 1. **The report is the reporter's receipt.** Its state is what an outside
 *    surface (a status page, a notification, a reply thread) reads back, so the
 *    engine may set an outcome on it but must never repurpose it as work.
 * 2. **Many reports, one fix.** Several reports routinely resolve to one work
 *    item — and you cannot move five objects into one. A link can point five
 *    ways; a move cannot.
 * 3. **Most reports are not work at all.** Four of the six exits create nothing.
 *
 * So the rule is **link, do not move and do not mirror**, and the six exits below
 * are the whole vocabulary. `promote` is the only exit that creates work, and it
 * never creates work without recording the link back — {@link INTAKE_ROUTING}
 * makes that structural rather than a habit.
 *
 * **Off by default.** Nothing here runs unless `connection.intake` names at
 * least one source. With the key absent — every adopter who has not asked for
 * intake — {@link planIntake} reports that Path C does not apply and never even
 * asks the adapter what it supports.
 *
 * @module @dorkos/flow/intake
 */

import type { z } from 'zod';
import type { IntakeSourceSchema } from './config-schema.ts';

/**
 * The six bounded exits a report can take. Every report leaves intake through
 * exactly one of them; there is no seventh, and there is deliberately no
 * "leave it open" — an un-exited report is the failure state intake exists to
 * end.
 *
 * The order is the order to try them in, which is the ordering rationale of the
 * whole path: `duplicate` first because deduplication is the cheapest filter and
 * the one that changes the shape of everything after it, then the two exits that
 * touch work, then the three that close the loop without work.
 */
export const INTAKE_EXITS = [
  'duplicate',
  'promote',
  'attach',
  'needs-info',
  'decline',
  'junk',
] as const;

/** One of the six bounded intake exits (see {@link INTAKE_EXITS}). */
export type IntakeExit = (typeof INTAKE_EXITS)[number];

/**
 * The three OPTIONAL adapter verbs intake adds (adapter contract 1.2.0): pull
 * reports, promote one into work with a link, push the outcome back. An adapter
 * may support none of them and still conform — see {@link INTAKE_VERB_FALLBACK}
 * for what a caller does instead.
 */
export const INTAKE_VERBS = ['listIntake', 'promote', 'resolveIntake'] as const;

/** One of the three optional intake verbs (see {@link INTAKE_VERBS}). */
export type IntakeVerb = (typeof INTAKE_VERBS)[number];

/** What the work side of an exit does. */
export type IntakeWorkEffect = 'none' | 'new' | 'existing';

/** What durable link an exit records, and to what. */
export type IntakeLinkEffect = 'none' | 'report' | 'work';

/** What the reporter reads back once the exit is taken. */
export type IntakeReporterOutcome = 'merged' | 'accepted' | 'question' | 'reason' | 'nothing';

/** How one exit routes: what it does to work, to the link graph, and to the reporter. */
export interface IntakeExitRouting {
  /** The exit this row describes. */
  exit: IntakeExit;
  /** Work side: no work, a new work item, or an existing one. */
  work: IntakeWorkEffect;
  /** The durable link recorded: to another report, to a work item, or none. */
  link: IntakeLinkEffect;
  /** What the reporter sees on their own receipt. */
  reporter: IntakeReporterOutcome;
  /**
   * Whether the exit reaches an outside party. Every outcome except `junk` does,
   * which puts it under the calibration floor's `outward-facing` trigger — the
   * one condition that always stops and asks, at any confidence.
   */
  outward: boolean;
  /** The optional adapter verbs this exit names. */
  verbs: readonly IntakeVerb[];
}

/**
 * The exit table — the single definition of what each exit does, shared by the
 * skill prose and by anything that has to reason about intake.
 *
 * Read the columns together and the design reads off the table: exactly one exit
 * creates work, exactly two touch work at all, and every exit records an outcome
 * on the report (all six name `resolveIntake`), because a report that is silently
 * left alone is indistinguishable from one nobody looked at.
 */
export const INTAKE_ROUTING: Readonly<Record<IntakeExit, IntakeExitRouting>> = Object.freeze({
  /** Already reported. The report merges into the original and follows its fate. */
  duplicate: Object.freeze({
    exit: 'duplicate',
    work: 'none',
    link: 'report',
    reporter: 'merged',
    outward: true,
    verbs: Object.freeze(['resolveIntake'] as const),
  }),
  /** Real, new, and worth doing. A new work item is created and linked back. */
  promote: Object.freeze({
    exit: 'promote',
    work: 'new',
    link: 'work',
    reporter: 'accepted',
    outward: true,
    verbs: Object.freeze(['promote', 'resolveIntake'] as const),
  }),
  /** More evidence for work we already have. Nothing new is created; the report links to it. */
  attach: Object.freeze({
    exit: 'attach',
    work: 'existing',
    link: 'work',
    reporter: 'accepted',
    outward: true,
    verbs: Object.freeze(['promote', 'resolveIntake'] as const),
  }),
  /** Not actionable as written. One question goes back and the report waits on the answer. */
  'needs-info': Object.freeze({
    exit: 'needs-info',
    work: 'none',
    link: 'none',
    reporter: 'question',
    outward: true,
    verbs: Object.freeze(['resolveIntake'] as const),
  }),
  /** Understood and not doing it. The reporter gets the reason, not silence. */
  decline: Object.freeze({
    exit: 'decline',
    work: 'none',
    link: 'none',
    reporter: 'reason',
    outward: true,
    verbs: Object.freeze(['resolveIntake'] as const),
  }),
  /** Spam or noise. Closed without a reply — the only exit that says nothing. */
  junk: Object.freeze({
    exit: 'junk',
    work: 'none',
    link: 'none',
    reporter: 'nothing',
    outward: false,
    verbs: Object.freeze(['resolveIntake'] as const),
  }),
});

/**
 * Look up how one exit routes.
 *
 * @param exit - The exit taken for a report.
 * @returns The routing row for that exit.
 * @throws If `exit` is not one of the six (a payload can carry anything).
 */
export function routeIntakeExit(exit: IntakeExit): IntakeExitRouting {
  const routing = INTAKE_ROUTING[exit];
  if (!routing) {
    throw new Error(
      `unknown intake exit ${JSON.stringify(exit)} — expected one of ${INTAKE_EXITS.join(', ')}`
    );
  }
  return routing;
}

/** One step of the intake pass, in the order it runs. */
export interface IntakeStep {
  /** Step id, as the skill names it. */
  id: string;
  /** Whether the step writes anywhere (the tracker, the report, an outside party). */
  writes: boolean;
  /**
   * Whether the step may run once across the whole batch of reports rather than
   * once per report. Reading amortizes — one pull of the work set serves every
   * report in the batch. Writing never does: each write needs its own judgment,
   * and a batched write is how one wrong call becomes ten.
   */
  batchable: boolean;
}

/**
 * The intake pass in order. The order is the design, not a convenience:
 *
 * **Dedupe first, because it is the cheapest filter and it changes what the
 * later steps are even looking at.** Measured on the first hand-run of this pass
 * (12 reports → 6 promotes, 1 attach, 2 junk, 1 verify): one report shrank from
 * "build the feature" to "fix the copy" purely because the dedupe search ran
 * before anyone read it as a feature request, and another was nearly filed as a
 * regression of work that had already shipped. Both were caught by the same
 * step, and neither would have been caught by running it later.
 *
 * **Split before deciding**, because a report is one message and may carry
 * several concerns; deciding first commits all of them to one exit.
 *
 * **Close the loop last and never skip it**: the report is the reporter's
 * receipt, so a pass that promotes work and says nothing back has done half the
 * job in the visible half.
 */
export const INTAKE_STEPS: readonly IntakeStep[] = Object.freeze([
  Object.freeze({ id: 'dedupe', writes: false, batchable: true }),
  Object.freeze({ id: 'validate', writes: false, batchable: false }),
  Object.freeze({ id: 'classify', writes: false, batchable: false }),
  Object.freeze({ id: 'split', writes: false, batchable: false }),
  Object.freeze({ id: 'decide', writes: false, batchable: false }),
  Object.freeze({ id: 'promote-and-link', writes: true, batchable: false }),
  Object.freeze({ id: 'resolve', writes: true, batchable: false }),
]);

/** One configured intake source (`connection.intake[]`). */
export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

/**
 * The slice of `connection` intake reads. Structural rather than the inferred
 * config type so a caller can pass a partially-resolved connection block.
 */
export interface IntakeConnectionConfig {
  /** Configured intake sources. Absent or empty means intake is off. */
  intake?: readonly IntakeSource[];
}

/**
 * The sources intake would pull from.
 *
 * @param connection - The resolved `connection` config block, or `undefined`.
 * @returns The configured sources; empty when intake is off.
 */
export function intakeSources(
  connection: IntakeConnectionConfig | undefined
): readonly IntakeSource[] {
  return connection?.intake ?? [];
}

/**
 * Whether intake is switched on at all.
 *
 * @param connection - The resolved `connection` config block, or `undefined`.
 * @returns `true` only when at least one source is configured.
 */
export function isIntakeConfigured(connection: IntakeConnectionConfig | undefined): boolean {
  return intakeSources(connection).length > 0;
}

/**
 * Find one configured source by its id.
 *
 * @param connection - The resolved `connection` config block, or `undefined`.
 * @param id - The source id to look for.
 * @returns The source, or `undefined` when nothing is configured under that id.
 */
export function selectIntakeSource(
  connection: IntakeConnectionConfig | undefined,
  id: string
): IntakeSource | undefined {
  return intakeSources(connection).find((source) => source.id === id);
}

/**
 * What an adapter declares about the three optional verbs. Per the contract's
 * reading rule, **an undeclared verb is not supported**: absence and silence
 * resolve the same way, and neither is an error.
 */
export type IntakeVerbSupport = Partial<Record<IntakeVerb, boolean>>;

/**
 * The documented fallback for each optional verb, so an adapter that supports
 * none of them still has a path through intake — slower and more manual, never a
 * stall. A caller takes the fallback and **says which path it took**.
 */
export const INTAKE_VERB_FALLBACK: Readonly<Record<IntakeVerb, string>> = Object.freeze({
  listIntake:
    'no automatic pull — a person hands the reports in as freeform TRIAGE input, one batch at a time',
  promote:
    'create the work item the way Path A creates one, then record the link to the report as a comment on both sides',
  resolveIntake:
    'comment the outcome on the report when it is reachable as a work item, otherwise report the outcome for a person to close',
});

/** One optional verb the adapter does not have, and what the caller does instead. */
export interface IntakeDegradation {
  /** The absent (or undeclared) verb. */
  verb: IntakeVerb;
  /** The documented fallback path the caller takes instead. */
  fallback: string;
}

/** Why Path C does or does not apply. */
export type IntakePlanReason = 'no-intake-configured' | 'source-not-found' | 'ready';

/** Whether intake applies right now, over which sources, and with what degradations. */
export interface IntakePlan {
  /** Whether Path C applies at all. */
  applies: boolean;
  /** Why — the honest reason, so a caller can report it rather than stall. */
  reason: IntakePlanReason;
  /** The sources to pull, narrowed when a specific source was asked for. */
  sources: readonly IntakeSource[];
  /** Absent optional verbs and the fallback each one costs. */
  degradations: readonly IntakeDegradation[];
}

/**
 * Decide whether intake applies, and how much of it the adapter can actually do.
 *
 * This is the off-by-default gate. With no configured source the answer is "does
 * not apply" and **`support` is never read** — an adopter who has not asked for
 * intake gets exactly today's TRIAGE, and their adapter is never asked a
 * question it has no answer for.
 *
 * A missing optional verb never blocks: it becomes a {@link IntakeDegradation}
 * naming the fallback, because absence is not an error under the adapter
 * contract.
 *
 * @param connection - The resolved `connection` config block, or `undefined`.
 * @param support - What the adapter declares about the three optional verbs.
 * @param options - `sourceId` narrows the pass to one configured source.
 * @returns The plan: whether Path C applies, over which sources, with what degradations.
 */
export function planIntake(
  connection: IntakeConnectionConfig | undefined,
  support: IntakeVerbSupport,
  options: { sourceId?: string } = {}
): IntakePlan {
  const configured = intakeSources(connection);
  if (configured.length === 0) {
    return { applies: false, reason: 'no-intake-configured', sources: [], degradations: [] };
  }

  const sources = options.sourceId
    ? configured.filter((source) => source.id === options.sourceId)
    : configured;
  if (sources.length === 0) {
    return { applies: false, reason: 'source-not-found', sources: [], degradations: [] };
  }

  const degradations = INTAKE_VERBS.filter((verb) => support[verb] !== true).map((verb) => ({
    verb,
    fallback: INTAKE_VERB_FALLBACK[verb],
  }));

  return { applies: true, reason: 'ready', sources, degradations };
}
