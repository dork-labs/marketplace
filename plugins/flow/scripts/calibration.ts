/**
 * The calibration ladder (§5) — the canonical, typed implementation of the
 * single most important behavior in the `/flow` engine: **uncertainty-gated
 * (not stage-gated) human involvement**.
 *
 * At every decision point the agent walks this five-row ladder top-down and
 * acts on the **first matching row**. Only three behaviors exist
 * ({@link InvolvementBehavior}); the only things that ever block the autonomous
 * loop are the floor (row 0), sticky uncertainty (row 2), and uncertainty in an
 * intent stage (row 3 routed to `ask`).
 *
 * | # | Condition | Behavior | Blocks loop? |
 * |---|-----------|----------|--------------|
 * | 0 | Floor — irreversible/destructive · outward-facing · secrets/spend/prod · scope change | stop-and-ask (forces a check) — even at full confidence | yes |
 * | 1 | Reversible + confident | proceed-silently | no |
 * | 2 | Sticky + not-confident | stop-and-ask | yes |
 * | 3 | Reversible + not-confident (the ambiguous middle) | routed by `stageBias` | stage-dependent |
 * | 4 | Sticky + confident | proceed-with-trail (announce) | no |
 *
 * Stage bias routes row 3 with the frozen spec as the cut line: intent stages
 * (CAPTURE/TRIAGE/IDEATE/SPECIFY → `intake`) ask; execution stages
 * (DECOMPOSE/EXECUTE/VERIFY → `execution`) proceed on the best default and log
 * the assumption. That single rule yields "IDEATE asks freely, EXECUTE asks
 * rarely" as an emergent property.
 *
 * **Who answers a stop-and-ask** ({@link AnsweredBy}, spec `flow-multiproject`
 * §13): the floor is inviolable in the sense "someone must check", not "a human
 * must answer". The project's "Agent questions" stop (`autonomy.ts`) picks the
 * checker: you at Ask me first; you, then at the deadline the reviewer agent
 * (floor) or the agent's own pick (not floor), at Tell me after; the reviewer
 * agent (floor) or the agent's pick (not floor) at Just do it. A floor row is
 * never settled by the agent's own pick, and a decision carrying
 * `secrets-or-spend` always waits for you: spending past a limit you set is
 * something only you can decide.
 *
 * **This module is the pinned oracle.** The v1 prose skills describe these same
 * rules in natural language, but this TypeScript is the tested source of truth
 * and the P5 promotion surface the spec is building toward — it is the library
 * core, not dead code. Every threshold is driven from the
 * {@link Calibration} config (`proceedSilentlyWhen`, `alwaysAsk`, `stageBias`,
 * `assumptionLog`) so re-tuning involvement never touches code.
 *
 * @see specs/unified-workflow-system/02-specification.md §5
 * @module @dorkos/flow/calibration
 */

import type { z } from 'zod';
import type { AutonomyStop } from './autonomy.ts';
import type { CalibrationSchema } from './config-schema.ts';

/**
 * The resolved `involvement.calibration` config block (§5) that drives every
 * threshold in the ladder. Inferred from {@link CalibrationSchema} so the
 * config schema in `config-schema.ts` stays the single source of truth.
 */
export type Calibration = z.infer<typeof CalibrationSchema>;

/**
 * The four floor triggers (§5, ladder row 0). Any one present forces a
 * `stop-and-ask` (a check) regardless of confidence or reversibility. Mirrors
 * the `alwaysAsk` config tags ({@link Calibration.alwaysAsk}).
 */
export type FloorTrigger =
  'irreversible-or-destructive' | 'outward-facing' | 'secrets-or-spend' | 'scope-change';

/**
 * Reversibility of the decision (§5). `reversible` = cheap to undo inside the
 * loop (code edit, worktree file, draft comment). `sticky` = costly or visible
 * to undo.
 */
export type Reversibility = 'reversible' | 'sticky';

/**
 * Confidence in the decision (§5). `confident` means the answer is determined
 * by the frozen spec, an ADR/decision, a strong codebase convention, or a prior
 * human answer — not a hunch. Anything requiring guessing intent or choosing
 * between materially-different approaches with no steer is `not-confident`.
 */
export type Confidence = 'confident' | 'not-confident';

/**
 * Stage class that routes the ambiguous middle (row 3). Intent stages
 * (CAPTURE/TRIAGE/IDEATE/SPECIFY) are `intake`; execution stages
 * (DECOMPOSE/EXECUTE/VERIFY) are `execution`.
 */
export type DecisionStage = 'intake' | 'execution';

/**
 * The three — and only three — behaviors the ladder can produce (§5):
 * - `proceed-silently` — act with no trail (row 1).
 * - `proceed-with-trail` — act on the best default, then leave an
 *   `agent/assumption` trail (rows 3-proceed and 4).
 * - `stop-and-ask` — call `needsInput()` and block the loop (rows 0, 2, 3-ask).
 */
export type InvolvementBehavior = 'proceed-silently' | 'proceed-with-trail' | 'stop-and-ask';

/**
 * The ladder row that matched, top-down (first-match-wins). Exposed so callers
 * can audit, log, or branch on *why* a behavior was chosen.
 *
 * An erasable `const` object (not a TS `enum`) so the module type-strips cleanly
 * under `node --experimental-strip-types` — enums emit runtime code that the
 * strip-only loader rejects. The numeric row values are unchanged.
 */
export const CalibrationRow = {
  /** Row 0 — a floor trigger fired. */
  Floor: 0,
  /** Row 1 — reversible + confident. */
  ReversibleConfident: 1,
  /** Row 2 — sticky + not-confident. */
  StickyNotConfident: 2,
  /** Row 3 — reversible + not-confident (the ambiguous middle, stage-routed). */
  AmbiguousMiddle: 3,
  /** Row 4 — sticky + confident. */
  StickyConfident: 4,
} as const;

/** The matched ladder row value (`0`–`4`), the companion type to {@link CalibrationRow}. */
export type CalibrationRow = (typeof CalibrationRow)[keyof typeof CalibrationRow];

/**
 * A decision descriptor — the evidence-based facts about a single decision
 * point, fed to {@link resolveInvolvement}.
 */
export interface DecisionDescriptor {
  /**
   * Floor triggers present on this decision (§5, row 0). Any non-empty set
   * forces a `stop-and-ask`. Pass the specific triggers; an empty array (or
   * omission) means no floor trigger fired.
   */
  floorTriggers?: readonly FloorTrigger[];
  /** Whether the decision is cheap (`reversible`) or costly (`sticky`) to undo. */
  reversibility: Reversibility;
  /** Whether the answer is evidence-determined (`confident`) or a guess. */
  confidence: Confidence;
  /** Stage class, used only to route the ambiguous middle (row 3). */
  stage: DecisionStage;
}

/**
 * Who answers a `stop-and-ask` (spec `flow-multiproject` §13):
 *
 * - `person` — you.
 * - `reviewer-agent` — an independent reviewer agent checks the agent's pick and
 *   either approves it or leaves it for you.
 * - `agent-default` — the agent goes ahead with its own pick and writes down why.
 *   Never for a floor row.
 */
export type AnsweredBy = 'person' | 'reviewer-agent' | 'agent-default';

/** The trigger that always waits for a person, whatever the dial says. */
export const PERSON_ONLY_TRIGGER: FloorTrigger = 'secrets-or-spend';

/** The resolved outcome of walking the calibration ladder. */
export interface InvolvementDecision {
  /** Which of the three behaviors to take. */
  behavior: InvolvementBehavior;
  /** Whether this decision blocks the autonomous loop (true for `stop-and-ask`). */
  blocks: boolean;
  /** The ladder row that produced this decision (first match, top-down). */
  row: CalibrationRow;
  /**
   * Whether a durable `agent/assumption` trail should be written for this
   * decision. True exactly for `proceed-with-trail` behaviors when
   * `assumptionLog.artifact` is enabled — the non-obvious calls that must be
   * auditable at the review gate (§5).
   */
  logAssumption: boolean;
  /** Who answers it first, for a `stop-and-ask`; `null` when nothing is asked. */
  answeredBy: AnsweredBy | null;
  /**
   * Who answers once the question's deadline passes unanswered, or `null` when
   * it waits for {@link answeredBy} however long it takes (always `null` when
   * nothing is asked).
   */
  answeredByAtDeadline: AnsweredBy | null;
}

/**
 * Whether a floor trigger that the config's `alwaysAsk` list recognizes is
 * present on the decision. The config drives which tags are floor triggers, so
 * an operator can narrow the floor by trimming `alwaysAsk`.
 */
function hasActiveFloorTrigger(
  floorTriggers: readonly FloorTrigger[],
  alwaysAsk: Calibration['alwaysAsk']
): boolean {
  if (floorTriggers.length === 0) return false;
  const active = new Set<string>(alwaysAsk);
  return floorTriggers.some((trigger) => active.has(trigger));
}

/**
 * Build the resolved decision for a `proceed-with-trail` outcome, deciding
 * whether to write an assumption trail from the config's `assumptionLog`.
 */
function proceedWithTrail(row: CalibrationRow, calibration: Calibration): InvolvementDecision {
  return {
    behavior: 'proceed-with-trail',
    blocks: false,
    row,
    logAssumption: calibration.assumptionLog.artifact,
    answeredBy: null,
    answeredByAtDeadline: null,
  };
}

/** A `proceed-silently` outcome: nothing is asked. */
function proceedSilently(row: CalibrationRow): InvolvementDecision {
  return {
    behavior: 'proceed-silently',
    blocks: false,
    row,
    logAssumption: false,
    answeredBy: null,
    answeredByAtDeadline: null,
  };
}

/** Who answers a question, first and once its deadline passes. */
export interface WhoAnswers {
  /** Who answers it first. */
  answeredBy: AnsweredBy;
  /** Who answers once the deadline passes unanswered, or `null` when it waits. */
  answeredByAtDeadline: AnsweredBy | null;
}

/**
 * Who answers a question (see {@link AnsweredBy}): the rule behind every
 * `stop-and-ask`, also used by `flow ask` for the question it parks.
 *
 * - A question carrying `secrets-or-spend`, or any question at `ask`: you, and
 *   it waits for you however long it takes.
 * - At `tell`: you first; at the deadline the reviewer agent (a floor
 *   question) or the agent's own pick (any other).
 * - At `auto`: the reviewer agent (a floor question) or the agent's own pick.
 *
 * @param floor - Whether the question is on the calibration floor.
 * @param floorTriggers - The floor triggers it carries.
 * @param stop - The project's "Agent questions" stop.
 * @returns Who answers.
 */
export function whoAnswers(
  floor: boolean,
  floorTriggers: readonly FloorTrigger[],
  stop: AutonomyStop
): WhoAnswers {
  // Spending past a limit you set is yours alone, at every stop. The tag is
  // treated whole: a secret and a spend cannot be told apart safely from it.
  if (floorTriggers.includes(PERSON_ONLY_TRIGGER) || stop === 'ask') {
    return { answeredBy: 'person', answeredByAtDeadline: null };
  }
  // A floor question is checked by the reviewer agent, never by the agent's own pick.
  const checker: AnsweredBy = floor ? 'reviewer-agent' : 'agent-default';
  return stop === 'tell'
    ? { answeredBy: 'person', answeredByAtDeadline: checker }
    : { answeredBy: checker, answeredByAtDeadline: null };
}

/**
 * A `stop-and-ask` outcome, with who answers it under the project's "Agent
 * questions" stop (see {@link whoAnswers}).
 */
function stopAndAsk(
  row: CalibrationRow,
  floorTriggers: readonly FloorTrigger[],
  stop: AutonomyStop
): InvolvementDecision {
  return {
    behavior: 'stop-and-ask',
    blocks: true,
    row,
    logAssumption: false,
    ...whoAnswers(row === CalibrationRow.Floor, floorTriggers, stop),
  };
}

/**
 * Walk the calibration ladder (§5) top-down and return the first matching
 * behavior — the canonical involvement decision for one decision point.
 *
 * The ladder is evaluated strictly in order; the first matching row wins:
 * - **Row 0 (floor)** — any active `alwaysAsk` trigger present → `stop-and-ask`
 *   (blocks), even at full confidence.
 * - **Row 1** — reversible + confident → `proceed-silently` (no block).
 * - **Row 2** — sticky + not-confident → `stop-and-ask` (blocks).
 * - **Row 3** — reversible + not-confident → routed by `stageBias`: `intake`
 *   (`ask`) → `stop-and-ask` (blocks); `execution` (`proceed-and-log`) →
 *   `proceed-with-trail` (no block).
 * - **Row 4** — sticky + confident → `proceed-with-trail` (announce, no block).
 *
 * Every threshold is read from `calibration`, so re-tuning involvement is a
 * config edit, never a code change. The `reversible`/`confident` membership of
 * `proceedSilentlyWhen` gates row 1; `alwaysAsk` defines the floor; `stageBias`
 * routes row 3; `assumptionLog.artifact` decides whether trail rows log.
 *
 * `stop` is the project's "Agent questions" stop (`autonomy.ts`, default `ask`).
 * It decides who answers each `stop-and-ask` ({@link AnsweredBy}), and at
 * `auto` the ambiguous middle (row 3) proceeds with a trail in every stage.
 *
 * @param decision - The evidence-based facts about the decision point.
 * @param calibration - The resolved `involvement.calibration` config block.
 * @param stop - The project's "Agent questions" stop. Default `ask`.
 * @returns The behavior to take, whether it blocks the loop, the matched row,
 *   whether to write an assumption trail, and who answers.
 */
export function resolveInvolvement(
  decision: DecisionDescriptor,
  calibration: Calibration,
  stop: AutonomyStop = 'ask'
): InvolvementDecision {
  const floorTriggers = decision.floorTriggers ?? [];

  // Row 0 — Floor. Highest precedence: a floor trigger forces a check even at
  // full confidence on a reversible decision.
  if (hasActiveFloorTrigger(floorTriggers, calibration.alwaysAsk)) {
    return stopAndAsk(CalibrationRow.Floor, floorTriggers, stop);
  }

  const isReversible = decision.reversibility === 'reversible';
  const isConfident = decision.confidence === 'confident';

  // Row 1 — reversible + confident → proceed silently. Both axes must be in the
  // config's proceedSilentlyWhen allow-list to qualify for the silent path.
  const silentTags = new Set<string>(calibration.proceedSilentlyWhen);
  if (isReversible && isConfident && silentTags.has('reversible') && silentTags.has('confident')) {
    return proceedSilently(CalibrationRow.ReversibleConfident);
  }

  // Row 2 — sticky + not-confident → stop & ask.
  if (!isReversible && !isConfident) {
    return stopAndAsk(CalibrationRow.StickyNotConfident, floorTriggers, stop);
  }

  // Row 3 — reversible + not-confident (the ambiguous middle) → routed by stage
  // bias. The frozen spec is the cut line: intake asks, execution proceeds + logs.
  // At Just do it the agent does not ask here: it proceeds and writes down why.
  if (isReversible && !isConfident) {
    const bias = stop === 'auto' ? 'proceed-and-log' : calibration.stageBias[decision.stage];
    if (bias === 'ask') {
      return stopAndAsk(CalibrationRow.AmbiguousMiddle, floorTriggers, stop);
    }
    return proceedWithTrail(CalibrationRow.AmbiguousMiddle, calibration);
  }

  // Row 4 — sticky + confident → proceed, but announce (leave a trail).
  return proceedWithTrail(CalibrationRow.StickyConfident, calibration);
}
