/**
 * The arm guard (DOR-3262), run by every flow path that arms auto-merge
 * (`flow pr --arm`, `flow sweep`, `flow review --approve` with
 * `mergeOnApproval`, and the drain's re-arm) just before it calls the forge's
 * `arm`.
 *
 * Every arm needs the security label, added by a person after the head arrived,
 * on any PR (DOR-3724): `--arm` and `drain.armAutoMerge` are an agent's to set,
 * so they prove no review. The one exception is `labelRule: 'security-paths'`,
 * which only a person's `flow review --approve` passes, after the person gate.
 * On a `review:deep` PR, every arm also needs `security-deep-reviewed` by the same
 * rules (DOR-3766).
 *
 * A guard rail, not the gate: flow runs inside the agent, and the gate that
 * holds is on GitHub (the required security status and the ruleset). The guard
 * only refuses. It never sets that status, never adds or removes the security
 * label, and arms nothing itself.
 *
 * In order, stopping at the first refusal:
 *
 * 1. Read the repository's default branch from the forge (`Forge.defaultBranch`),
 *    then `land` from the committed config on it (`base-config.ts`).
 * 2. Read the PR (`Forge.armFacts`), the checks the default branch requires,
 *    how it merges (`Forge.mergeSettings`), and the release freeze
 *    (`freeze.ts`); for a PR with the security label or a deep review, also when
 *    the label was added and when the head arrived (`Forge.labelledAt`,
 *    `Forge.headPushedAt`), so a label from an older head never counts.
 * 3. Decide (`arm-decision.ts`, pinned by `scripts/fixtures/arm-decisions.json`).
 * 4. Run the `land.preArm` entries the PR's files send (`pre-arm.ts`).
 *
 * A pass carries the merge route the decision checked (`queue` or `squash`),
 * which the caller hands to `Forge.arm`, so an arm never assumes a method.
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
import type { ArmFacts, Forge } from '../forge/types.ts';
import {
  armMergeFor,
  decideArm,
  DEEP_REVIEW_LABEL,
  SECURITY_DEEP_LABEL,
  type ArmMerge,
  type ArmPolicy,
  type MergeSettings,
  type RefusalSlug,
} from './arm-decision.ts';
import { readBaseLand } from './base-config.ts';
import { dependencyConflict, touchesDependency } from './dependency-queue.ts';
import { readFreeze } from './freeze.ts';
import { describeEntry, entryTouched, runPreArm, type PreArmOutcome } from './pre-arm.ts';

/** Paths that count as security paths while a `wait: workflow` entry exists. */
export const WORKFLOW_SECURITY_GLOBS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
];

/** Why the guard refused, beyond the decision's own reasons. */
export type GuardRefusal =
  | RefusalSlug
  | 'config-unreadable'
  | 'forge-unreadable'
  | 'pre-arm-failed'
  | 'pre-arm-deferred'
  | 'dependency-queue-busy'
  | 'dependency-queue-unreadable';

/** The guard's answer. */
export type GuardResult =
  | {
      ok: true;
      preArm: PreArmOutcome[];
      /** How to arm: with no method flag into a squashing queue, or with `--squash`. */
      merge: ArmMerge;
    }
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
  /** The PR's worktree (base config is read through it; `run` entries check out from its objects). */
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
  /**
   * `every-pr` (default): the PR needs the security label whatever it touches.
   * `security-paths`: only when it touches a security path. Only a person's
   * approval, which passed the person gate (`cli/person-gate.ts`), asks for it.
   */
  labelRule?: 'every-pr' | 'security-paths';
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
 * @param land - The `land` block from the default branch on `origin`.
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

/**
 * When the labels this PR's decision reads were last added, and when the head
 * arrived: read only for a label on the PR, and the deep label only on a
 * `review:deep` PR. A forge without the reads, or a read that fails, gives
 * `null`, and the decision refuses a PR that needs the label on it.
 */
async function labelTimes(
  forge: Forge,
  pr: number,
  facts: ArmFacts,
  label: string
): Promise<{
  securityLabelledAt: string | null;
  deepLabelledAt: string | null;
  headArrivedAt: string | null;
}> {
  const has = (name: string) =>
    facts.labels?.some((l) => l.name.toLowerCase() === name.toLowerCase()) ?? false;
  const security = has(label);
  const deep = has(DEEP_REVIEW_LABEL) && has(SECURITY_DEEP_LABEL);
  const read = async (fn: () => Promise<string | null> | undefined): Promise<string | null> => {
    try {
      return (await fn()) ?? null;
    } catch {
      return null;
    }
  };
  return {
    securityLabelledAt: security ? await read(() => forge.labelledAt?.(pr, label)) : null,
    deepLabelledAt: deep ? await read(() => forge.labelledAt?.(pr, SECURITY_DEEP_LABEL)) : null,
    headArrivedAt:
      security || deep
        ? await read(() => forge.headPushedAt?.(pr, facts.headRefOid, facts.headRefName))
        : null,
  };
}

/** How the base merges, or `undefined` (the decision refuses) when the forge cannot say. */
async function mergeSettingsOf(forge: Forge, base: string): Promise<MergeSettings | undefined> {
  try {
    return await forge.mergeSettings?.(base);
  } catch {
    return undefined;
  }
}

/** The route a passed decision checked; the decision refused anything else. */
function routeOf(settings: MergeSettings | undefined): ArmMerge {
  const route = armMergeFor(settings);
  if (!route.ok) throw new Error(`the arm guard passed a merge it cannot route: ${route.detail}`);
  return route.merge;
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
  // The default branch comes from the forge, never a local origin/HEAD that
  // may be stale; unknown refuses (and is asked again: it may be a blip).
  let defaultBranch: string | undefined;
  try {
    defaultBranch = await input.forge.defaultBranch?.();
  } catch (error) {
    return early(
      'forge-unreadable',
      `could not read the default branch of ${input.forge.repo}: ${(error as Error).message}`
    );
  }
  if (defaultBranch === undefined) {
    return early(
      'forge-unreadable',
      `the forge cannot say which branch of ${input.forge.repo} is the default`
    );
  }
  const base = await readBaseLand(io.runProcess, input.worktree, defaultBranch);
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
    requiredChecks = (await input.forge.requiredChecks?.(defaultBranch)) ?? null;
  } catch {
    requiredChecks = null;
  }
  const reviewedSha = input.reviewedSha?.toLowerCase() ?? null;
  const policy = policyFor(land);
  const securityLabelOnEveryPr = input.labelRule !== 'security-paths';
  let mergeSettings = await mergeSettingsOf(input.forge, defaultBranch);
  const decision = decideArm(
    {
      ...facts,
      defaultBranch,
      mergeSettings,
      ...(await labelTimes(input.forge, input.pr, facts, policy.securityLabel)),
      requiredChecks,
      reviewedSha,
      securityLabelOnEveryPr,
      freeze: readFreeze(input.mainCheckout),
    },
    policy
  );
  if (decision.verdict === 'REFUSE') return early(decision.reason, decision.detail);

  // One dependency PR at a time: refused, and asked again next pass, while
  // another lockfile or manifest PR is queued or armed (fails closed).
  if (touchesDependency(facts.files)) {
    let queue = null;
    try {
      queue = (await input.forge.dependencyQueue?.(defaultBranch)) ?? null;
    } catch {
      queue = null;
    }
    const dependency = dependencyConflict(input.pr, facts.files, queue);
    if (!dependency.ok) return early(dependency.reason, dependency.detail);
  }

  // decideArm checked reviewedSha is a full SHA equal to the head.
  const touched = land.preArm.filter((entry) => entryTouched(entry, facts.files));
  if (touched.length === 0) {
    return {
      ok: true,
      preArm: land.preArm.map((entry) => ({ entry: describeEntry(entry), result: 'skipped' })),
      merge: routeOf(mergeSettings),
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
  // The merge settings too: a queue switched to MERGE meanwhile refuses.
  mergeSettings = await mergeSettingsOf(input.forge, defaultBranch);
  const again = decideArm(
    {
      ...after,
      defaultBranch,
      mergeSettings,
      ...(await labelTimes(input.forge, input.pr, after, policy.securityLabel)),
      requiredChecks,
      reviewedSha,
      securityLabelOnEveryPr,
      freeze: readFreeze(input.mainCheckout),
    },
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
  // Another dependency PR may have armed while the checks ran.
  if (touchesDependency(after.files)) {
    let queue = null;
    try {
      queue = (await input.forge.dependencyQueue?.(defaultBranch)) ?? null;
    } catch {
      queue = null;
    }
    const dependency = dependencyConflict(input.pr, after.files, queue);
    if (!dependency.ok) {
      return {
        ok: false,
        reason: dependency.reason,
        detail: `${dependency.detail} (after its pre-arm checks passed)`,
        ranPreArm: false,
        preArm: pre.outcomes,
      };
    }
  }
  return { ok: true, preArm: pre.outcomes, merge: routeOf(mergeSettings) };
}

/**
 * Whether a refusal holds for the commit it was about, so a caller that
 * retries asks again only for a new reviewed commit: a failed `land.preArm`
 * check (expensive to repeat), or a fork (which never changes while the commit
 * does not). Every other refusal can clear on its own (a freeze lifts, a label
 * is added, a check reruns, a stacked PR is retargeted to the default branch
 * with the same head) and is asked again.
 *
 * @param result - A refusal.
 * @returns `true` when it sticks to the commit.
 */
export function refusalSticksToCommit(result: Extract<GuardResult, { ok: false }>): boolean {
  return result.ranPreArm || result.reason === 'fork';
}
