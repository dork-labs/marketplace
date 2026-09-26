/**
 * Was a merge-queue ejection this PR's fault? (spec `flow-handoff-dispatch`
 * §4.6, the "prove innocence" check.)
 *
 * When the queue drops a PR, its failing checks are compared with the other
 * merge-group attempts on the same base branch in the last 30 minutes. A check
 * that also failed for groups that did not hold this PR is failing for
 * everyone (a flaky test, a broken base), so the PR is innocent and may be
 * re-armed once. A check that failed only here makes the PR a suspect.
 *
 * Pure: no imports, so it runs before `npm install`.
 *
 * @module @dorkos/flow/forge/ejection
 */

/** What {@link judgeEjection} decides. */
export type EjectionVerdict = 'innocent' | 'suspect' | 'unknown';

/** What {@link judgeEjection} reads. */
export interface EjectionInput {
  /** The checks that failed in this PR's own merge-group attempt. */
  failing: readonly string[];
  /** Recent merge-group attempts with failing checks, this PR's own included or not. */
  otherGroups: readonly { prs: readonly number[]; failing: readonly string[] }[];
  /** This PR's number. Groups that may contain it never count as someone else's. */
  pr: number;
}

/**
 * Judge an ejection.
 *
 * - `unknown` when no failing check was reported, or no other group ran.
 * - `innocent` when every failing check also failed in at least one group
 *   that does not contain this PR.
 * - `suspect` when any failing check failed only here.
 *
 * @param input - The PR's failing checks, the recent groups and the PR number.
 * @returns The verdict. Only `innocent` justifies re-arming.
 */
export function judgeEjection(input: EjectionInput): EjectionVerdict {
  const others = input.otherGroups.filter((group) => !group.prs.includes(input.pr));
  if (input.failing.length === 0 || others.length === 0) return 'unknown';
  const failedElsewhere = new Set(others.flatMap((group) => group.failing));
  return input.failing.every((name) => failedElsewhere.has(name)) ? 'innocent' : 'suspect';
}
