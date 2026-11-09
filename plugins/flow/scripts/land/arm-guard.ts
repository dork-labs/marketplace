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
 * `land.securityPaths.labelOn: security-paths` on the default branch lets an
 * agent's arm skip the label on a PR that touches no security path (DOR-3768,
 * `label-on.ts`). It counts more paths as security paths, refuses
 * (`no-required-checks`) unless the default branch requires a check, and still
 * wants both labels on a `review:deep` PR.
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
  isSecurityCheck,
  SECURITY_DEEP_LABEL,
  type ArmMerge,
  type ArmPolicy,
  type MergeSettings,
  type RefusalSlug,
} from './arm-decision.ts';
import { readBaseGitlinks, readBaseLand } from './base-config.ts';
import { LABEL_ON_SECURITY_GLOBS, rubricGlob } from './label-on.ts';
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
  | 'no-required-checks'
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
 * entry exists, and {@link LABEL_ON_SECURITY_GLOBS}, the review rubric and
 * every submodule while `labelOn` is `security-paths`. The guard and
 * `flow pr`'s reviewer route both use it.
 *
 * @param land - The `land` block from the default branch on `origin`.
 * @param rubric - `review.rubric` from the same config, or `null` for the default.
 * @param gitlinks - The default branch's submodule paths (`readBaseGitlinks`).
 * @returns The policy.
 */
export function policyFor(
  land: LandConfig,
  rubric: string | null = null,
  gitlinks: readonly string[] = []
): ArmPolicy {
  const waitsOnWorkflow = land.preArm.some((entry) => 'workflow' in entry);
  const labelOnPaths = land.securityPaths.labelOn === 'security-paths';
  const rubricPath = labelOnPaths ? rubricGlob(rubric) : null;
  return {
    securityGlobs: [
      ...land.securityPaths.globs,
      ...(waitsOnWorkflow ? WORKFLOW_SECURITY_GLOBS : []),
      ...(labelOnPaths ? LABEL_ON_SECURITY_GLOBS : []),
      ...(rubricPath === null ? [] : [rubricPath]),
      // A submodule bump shows only as its path; the commit it points at runs in CI.
      ...(labelOnPaths ? gitlinks.flatMap((link) => [link, `${link}/**`]) : []),
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

/**
 * The label rule for this arm, and the facts the decision reads. A person's
 * approval needs the security label only on a security path. An agent's needs
 * it on every PR, unless the default branch sets `labelOn` to
 * `security-paths`. Even then a PR that is `review:deep`, or whose labels can't
 * be read, needs it; and so does one that ever was `review:deep` (an agent
 * could take the trigger off), or whose label history can't be read, which is
 * decided as though the trigger were still on, so it needs the deep label too.
 */
async function labelRuleFor(
  input: GuardInput,
  land: LandConfig,
  facts: ArmFacts
): Promise<{ facts: ArmFacts; everyPr: boolean }> {
  if (input.labelRule === 'security-paths') return { facts, everyPr: false };
  if (land.securityPaths.labelOn !== 'security-paths') return { facts, everyPr: true };
  const labels = facts.labels;
  if (!Array.isArray(labels)) return { facts, everyPr: true };
  if (
    labels.some((l) => typeof l?.name !== 'string' || l.name.toLowerCase() === DEEP_REVIEW_LABEL)
  ) {
    return { facts, everyPr: true };
  }
  let ever = true;
  try {
    ever = (await input.forge.labelEverAdded?.(input.pr, DEEP_REVIEW_LABEL)) ?? true;
  } catch {
    ever = true;
  }
  return ever
    ? { facts: { ...facts, labels: [...labels, { name: DEEP_REVIEW_LABEL }] }, everyPr: true }
    : { facts, everyPr: false };
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
  // An agent's arm with no label rests on the checks GitHub waits for.
  const unattended =
    input.labelRule !== 'security-paths' && land.securityPaths.labelOn === 'security-paths';

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
  // Security's verdict checks pass on a PR that touches no security path, so
  // they test nothing here: at least one other required check must.
  const testing = requiredChecks?.filter((name) => !isSecurityCheck({ name })) ?? [];
  if (unattended && testing.length === 0) {
    return early(
      'no-required-checks',
      `land.securityPaths.labelOn is "security-paths" on ${defaultBranch}, and ${requiredChecks === null ? 'flow could not read which checks it requires' : `${defaultBranch} requires no check that tests the code`}. Ask a person to merge it by hand`
    );
  }
  let gitlinks: string[] = [];
  if (land.securityPaths.labelOn === 'security-paths') {
    const links = await readBaseGitlinks(io.runProcess, input.worktree, base.baseSha);
    if (links === null) {
      return early(
        'config-unreadable',
        `could not list the submodules on ${defaultBranch} (${base.baseSha.slice(0, 7)})`
      );
    }
    gitlinks = links;
  }
  const reviewedSha = input.reviewedSha?.toLowerCase() ?? null;
  const policy = policyFor(land, base.rubric, gitlinks);
  let mergeSettings = await mergeSettingsOf(input.forge, defaultBranch);
  const rule = await labelRuleFor(input, land, facts);
  const decision = decideArm(
    {
      ...rule.facts,
      defaultBranch,
      mergeSettings,
      ...(await labelTimes(input.forge, input.pr, rule.facts, policy.securityLabel)),
      requiredChecks,
      reviewedSha,
      securityLabelOnEveryPr: rule.everyPr,
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
  const ruleAfter = await labelRuleFor(input, land, after);
  const again = decideArm(
    {
      ...ruleAfter.facts,
      defaultBranch,
      mergeSettings,
      ...(await labelTimes(input.forge, input.pr, ruleAfter.facts, policy.securityLabel)),
      requiredChecks,
      reviewedSha,
      securityLabelOnEveryPr: ruleAfter.everyPr,
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
