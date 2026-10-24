/**
 * The arm guard (DOR-3262), run by every flow path that arms auto-merge
 * (`flow pr --arm`, `flow review --approve` with `mergeOnApproval`, and the
 * drain's re-arm) just before it calls the forge's `arm`.
 *
 * A guard rail, not the gate: flow runs inside the agent, and the gate that
 * holds is on GitHub (the required security status and the ruleset). The guard
 * only refuses. It never sets that status, never adds or removes the security
 * label, and arms nothing itself.
 *
 * In order, stopping at the first refusal:
 *
 * 1. Read `land` from the committed config on `origin/main` (`base-config.ts`).
 * 2. Read the PR (`Forge.armFacts`), the checks `main` requires, and the
 *    release freeze (`freeze.ts`).
 * 3. Decide (`arm-decision.ts`, pinned by `scripts/fixtures/arm-decisions.json`).
 * 4. Run the `land.preArm` entries the PR's files send (`pre-arm.ts`).
 *
 * When the base config has a `wait: workflow` entry, `.github/workflows/` and
 * `.github/actions/` count as security paths too: `gh workflow run --ref
 * <pr-branch>` runs the workflow file as the PR's branch has it, so a PR that
 * edits it needs Security's label before flow trusts that run.
 *
 * @module @dorkos/flow/land/arm-guard
 */

import type { ProcessRunner } from '../cli/context.ts';
import type { LandConfig } from '../config-schema.ts';
import type { Forge } from '../forge/types.ts';
import { ARM_BASE, decideArm, type ArmPolicy, type RefusalSlug } from './arm-decision.ts';
import { readBaseLand } from './base-config.ts';
import { readFreeze } from './freeze.ts';
import { describeEntry, entryTouched, runPreArm, type PreArmOutcome } from './pre-arm.ts';

/** Paths that count as security paths while a `wait: workflow` entry exists. */
export const WORKFLOW_SECURITY_GLOBS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
];

/** Why the guard refused, beyond the decision's own reasons. */
export type GuardRefusal =
  RefusalSlug | 'config-unreadable' | 'forge-unreadable' | 'pre-arm-failed' | 'pre-arm-deferred';

/** The guard's answer. */
export type GuardResult =
  | { ok: true; preArm: PreArmOutcome[] }
  | {
      ok: false;
      /** A stable, machine-readable reason. */
      reason: GuardRefusal;
      /** What is wrong and what to do, for a person. */
      detail: string;
      /**
       * Whether a `land.preArm` check refused (`pre-arm-failed`). Only that
       * refusal is expensive to repeat; any other is asked again next time.
       */
      ranPreArm: boolean;
      /** Every entry's outcome so far. */
      preArm: PreArmOutcome[];
    };

/** What the guard is asked about. */
export interface GuardInput {
  /** The forge the PR lives on. */
  forge: Forge;
  /** The PR. */
  pr: number;
  /** The commit the review covered: what flow means to arm. */
  reviewedSha: string | null;
  /** The PR's worktree (base config is read through it; `run` entries run there). */
  worktree: string;
  /** The project's main checkout (where the freeze marker lives). */
  mainCheckout: string;
  /**
   * `run` (default): run the `land.preArm` checks the PR touches. `defer`:
   * when any applies, refuse with `pre-arm-deferred` instead of running it.
   * A command a person or an agent waits on (`flow pr`, `flow review`) is
   * killed long before a browser suite or a dispatched workflow finishes, so
   * only the drain, which keeps running, runs them.
   */
  preArm?: 'run' | 'defer';
}

/** What the guard needs from the world. */
export interface GuardIo {
  /** Runs git and `run` entries with no shell. */
  runProcess: ProcessRunner;
  /** The clock. */
  now(): Date;
  /** Waits (the workflow poll). */
  sleep(ms: number): Promise<void>;
  /** A fresh nonce (tests). */
  nonce?(): string;
}

/**
 * The security-path policy `land` sets: the repository's globs and pattern,
 * plus `.github/workflows/` and `.github/actions/` while a `wait: workflow`
 * entry exists. The guard and `flow pr`'s reviewer route both use it.
 *
 * @param land - The `land` block from `origin/main`.
 * @returns The policy.
 */
export function policyFor(land: LandConfig): ArmPolicy {
  const waitsOnWorkflow = land.preArm.some((entry) => 'workflow' in entry);
  return {
    securityGlobs: [
      ...land.securityPaths.globs,
      ...(waitsOnWorkflow ? WORKFLOW_SECURITY_GLOBS : []),
    ],
    securityPattern: land.securityPaths.pattern,
    securityLabel: land.securityPaths.label,
  };
}

/** A refusal before any `land.preArm` entry ran. */
function early(reason: GuardRefusal, detail: string): GuardResult {
  return { ok: false, reason, detail, ranPreArm: false, preArm: [] };
}

/**
 * Decide whether flow may arm this PR, running its pre-arm checks.
 *
 * @param input - The PR, its reviewed commit and its worktree.
 * @param io - The world.
 * @returns `ok`, or a refusal with its reason and detail.
 */
export async function guardArm(input: GuardInput, io: GuardIo): Promise<GuardResult> {
  const base = await readBaseLand(io.runProcess, input.worktree);
  if (!base.ok) return early('config-unreadable', base.detail);
  const { land } = base;

  let facts;
  try {
    facts = await input.forge.armFacts(input.pr);
  } catch (error) {
    return early('forge-unreadable', `could not read #${input.pr}: ${(error as Error).message}`);
  }
  let requiredChecks: string[] | null = null;
  try {
    requiredChecks = (await input.forge.requiredChecks?.(ARM_BASE)) ?? null;
  } catch {
    requiredChecks = null;
  }
  const reviewedSha = input.reviewedSha?.toLowerCase() ?? null;
  const policy = policyFor(land);
  const decision = decideArm(
    { ...facts, requiredChecks, reviewedSha, freeze: readFreeze(input.mainCheckout) },
    policy
  );
  if (decision.verdict === 'REFUSE') return early(decision.reason, decision.detail);

  // decideArm checked reviewedSha is a full SHA equal to the head.
  const touched = land.preArm.filter((entry) => entryTouched(entry, facts.files));
  if (touched.length === 0) {
    return {
      ok: true,
      preArm: land.preArm.map((entry) => ({ entry: describeEntry(entry), result: 'skipped' })),
    };
  }
  if (input.preArm === 'defer') {
    return early(
      'pre-arm-deferred',
      `land.preArm checks apply to it (${touched.map(describeEntry).join(', ')}); flow runs them only in the drain`
    );
  }
  const pre = await runPreArm(
    land.preArm,
    {
      worktree: input.worktree,
      branch: facts.headRefName,
      reviewedSha: reviewedSha as string,
      files: facts.files,
    },
    { runProcess: io.runProcess, forge: input.forge, now: io.now, sleep: io.sleep, nonce: io.nonce }
  );
  if (!pre.ok) {
    const refused = pre.outcomes.at(-1);
    return {
      ok: false,
      reason: 'pre-arm-failed',
      detail: `the pre-arm check ${refused?.entry ?? ''} refused: ${refused?.detail ?? 'no detail'}`,
      ranPreArm: true,
      preArm: pre.outcomes,
    };
  }
  // A preArm check can take hours. Read the PR and the freeze again, so a hold,
  // a freeze or a red check that arrived meanwhile still refuses. These
  // refusals are about the PR's state, not the checks, so they are asked again
  // (ranPreArm false): the first decision refuses cheaply until it clears.
  let after;
  try {
    after = await input.forge.armFacts(input.pr);
  } catch (error) {
    return {
      ok: false,
      reason: 'forge-unreadable',
      detail: `could not read #${input.pr} again after its pre-arm checks: ${(error as Error).message}`,
      ranPreArm: false,
      preArm: pre.outcomes,
    };
  }
  const again = decideArm(
    { ...after, requiredChecks, reviewedSha, freeze: readFreeze(input.mainCheckout) },
    policy
  );
  if (again.verdict === 'REFUSE') {
    return {
      ok: false,
      reason: again.reason,
      detail: `${again.detail} (after its pre-arm checks passed)`,
      ranPreArm: false,
      preArm: pre.outcomes,
    };
  }
  return { ok: true, preArm: pre.outcomes };
}

/**
 * Whether a refusal holds for the commit it was about, so a caller that
 * retries asks again only for a new reviewed commit: a failed `land.preArm`
 * check (expensive to repeat), a fork, or a base other than `main` (neither
 * changes while the commit does not). Every other refusal can clear on its own
 * (a freeze lifts, a label is added, a check reruns) and is asked again.
 *
 * @param result - A refusal.
 * @returns `true` when it sticks to the commit.
 */
export function refusalSticksToCommit(result: Extract<GuardResult, { ok: false }>): boolean {
  return result.ranPreArm || result.reason === 'fork' || result.reason === 'base-not-main';
}
