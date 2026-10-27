/**
 * The cleared-but-unarmed sweep (DOR-3341): which open PRs have every review
 * their route needs at their current head, with green checks, and still sit
 * unarmed. Pure; `cli/sweep.ts` reads the facts and arms through the arm guard.
 *
 * A PR is cleared when all of these hold:
 *
 * 1. it is neither armed nor in the merge queue;
 * 2. every required check passed (a check still running is not green, and a
 *    required check that never reported has not passed);
 * 3. the security label was added after the current head
 *    last arrived as the PR's head (`Forge.headPushedAt`: the newest check
 *    suite or force-push, server times a commit's own dates cannot move, so a
 *    force-push back to an older commit counts as a new head);
 * 4. the QA label likewise, when the route has a QA step (not `light`);
 * 5. the design label likewise, when the route has a design step.
 *
 * "Carries over by diff" is a reviewer's call: after a push, the reviewer
 * reads the range-diff and adds the label again, and that new label is at the
 * new head. Flow never carries a label over by itself.
 *
 * Clearance is only the sweep's question. Arming is still the arm guard's:
 * a cleared PR is armed only when `guardArm` says so, and only at the head
 * whose labels were checked.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/land/sweep
 */

import type { ArmFacts } from '../forge/types.ts';
import type { ReviewRoute } from './review-route.ts';

/** Why a PR is not cleared. */
export type NotClearedReason =
  | 'armed'
  | 'queued'
  | 'checks-not-green'
  | 'unreadable'
  | 'security-label-missing'
  | 'security-label-stale'
  | 'qa-label-missing'
  | 'qa-label-stale'
  | 'design-label-missing'
  | 'design-label-stale';

/** The sweep's verdict on one PR. */
export type Clearance =
  { cleared: true } | { cleared: false; reason: NotClearedReason; detail: string };

/** Everything {@link clearance} reads about one PR. */
export interface ClearanceFacts {
  /** Whether auto-merge is armed. */
  armed: boolean;
  /** Whether it sits in the merge queue. */
  queued: boolean;
  /** The arm guard's facts: head, checks and labels. */
  facts: ArmFacts;
  /** The checks `main` requires, or `null` when the forge cannot tell (every check counts). */
  requiredChecks: string[] | null;
  /** When the head last arrived as the PR's head, or `null` when unknown. */
  headSeenAt: string | null;
  /** When each review label was last added, by label name (lower case); `null` when it is not on. */
  labelledAt: Readonly<Record<string, string | null>>;
  /** The route. */
  route: ReviewRoute;
}

/** The three review labels. */
export interface ReviewLabels {
  /** `land.securityPaths.label`. */
  security: string;
  /** `review.qaLabel`. */
  qa: string;
  /** `review.designLabel`. */
  design: string;
}

/**
 * The required checks that are not green: failed, cancelled, still running,
 * or required and never reported.
 *
 * @param facts - The PR's checks.
 * @param required - The required names, or `null` (every check counts, and there must be one).
 * @returns The names, or `['(no checks have reported)']`.
 */
export function notGreen(facts: ArmFacts, required: readonly string[] | null): string[] {
  const green = new Set(['pass', 'skipping']);
  if (required === null) {
    if (facts.checks.length === 0) return ['(no checks have reported)'];
    return facts.checks.filter((c) => !green.has(c.bucket)).map((c) => c.name);
  }
  return required.filter((name) => {
    const runs = facts.checks.filter((c) => c.name === name);
    return runs.length === 0 || runs.some((c) => !green.has(c.bucket));
  });
}

/**
 * Whether one PR is cleared.
 *
 * @param input - What was read about it.
 * @param labels - The review labels.
 * @returns Cleared, or the first reason it is not.
 */
export function clearance(input: ClearanceFacts, labels: ReviewLabels): Clearance {
  const no = (reason: NotClearedReason, detail: string): Clearance => ({
    cleared: false,
    reason,
    detail,
  });
  if (input.armed) return no('armed', 'auto-merge is already armed');
  if (input.queued) return no('queued', 'it is already in the merge queue');
  const red = notGreen(input.facts, input.requiredChecks);
  if (red.length > 0)
    return no('checks-not-green', `required checks are not green: ${red.join(', ')}`);
  const head = input.facts.headRefOid.slice(0, 7);
  const steps: { label: string; step: 'security' | 'qa' | 'design'; on: boolean }[] = [
    { label: labels.security, step: 'security', on: input.route.steps.security },
    { label: labels.qa, step: 'qa', on: input.route.steps.qa },
    { label: labels.design, step: 'design', on: input.route.steps.design },
  ];
  for (const { label, step, on } of steps) {
    if (!on) continue;
    const at = input.labelledAt[label.toLowerCase()] ?? null;
    if (at === null) {
      return no(`${step}-label-missing`, `it has no "${label}" label`);
    }
    if (input.headSeenAt === null) {
      return no(
        'unreadable',
        `flow cannot tell when ${head} was pushed, so it cannot tell whether "${label}" covers it`
      );
    }
    if (Date.parse(at) <= Date.parse(input.headSeenAt)) {
      return no(
        `${step}-label-stale`,
        `"${label}" was added before the head moved to ${head}; it covers an older commit, so the ${step} review looks again (by range-diff when that is enough) and adds it back`
      );
    }
  }
  return { cleared: true };
}
