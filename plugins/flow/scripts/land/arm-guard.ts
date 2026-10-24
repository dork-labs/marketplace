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
import { PreconditionError } from '../errors.ts';
import type { Forge } from '../forge/types.ts';
import { ARM_BASE, decideArm, type ArmPolicy, type RefusalSlug } from './arm-decision.ts';
import { readBaseLand } from './base-config.ts';
import { readFreeze } from './freeze.ts';
import { runPreArm, type PreArmOutcome } from './pre-arm.ts';

/** Paths that count as security paths while a `wait: workflow` entry exists. */
export const WORKFLOW_SECURITY_GLOBS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
];

/** Why the guard refused, beyond the decision's own reasons. */
export type GuardRefusal =
  RefusalSlug | 'config-unreadable' | 'forge-unreadable' | 'pre-arm-failed';

/** The guard's answer. */
export type GuardResult =
  | { ok: true; preArm: PreArmOutcome[] }
  | {
      ok: false;
      /** A stable, machine-readable reason. */
      reason: GuardRefusal;
      /** What is wrong and what to do, for a person. */
      detail: string;
      /** Whether a `land.preArm` entry ran before the refusal (the drain does not retry those on its own). */
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
  const waitsOnWorkflow = land.preArm.some((entry) => 'workflow' in entry);
  const policy: ArmPolicy = {
    securityGlobs: [
      ...land.securityPaths.globs,
      ...(waitsOnWorkflow ? WORKFLOW_SECURITY_GLOBS : []),
    ],
    securityPattern: land.securityPaths.pattern,
    securityLabel: land.securityPaths.label,
  };
  const decision = decideArm(
    { ...facts, requiredChecks, reviewedSha, freeze: readFreeze(input.mainCheckout) },
    policy
  );
  if (decision.verdict === 'REFUSE') return early(decision.reason, decision.detail);

  // decideArm checked reviewedSha is a full SHA equal to the head.
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
  return { ok: true, preArm: pre.outcomes };
}

/** The guard refused to arm (exit 5). */
export class ArmRefusedError extends PreconditionError {
  /** The refusal. */
  readonly refusal: Extract<GuardResult, { ok: false }>;
  /**
   * @param pr - The PR.
   * @param refusal - The guard's refusal.
   */
  constructor(pr: number, refusal: Extract<GuardResult, { ok: false }>) {
    super(`flow did not arm #${pr} (${refusal.reason}): ${refusal.detail}`);
    this.refusal = refusal;
  }
}

/**
 * Run the guard and throw when it refuses.
 *
 * @param input - As for {@link guardArm}.
 * @param io - As for {@link guardArm}.
 * @returns The pre-arm outcomes, when it may arm.
 * @throws {ArmRefusedError} When it may not.
 */
export async function assertArmable(input: GuardInput, io: GuardIo): Promise<PreArmOutcome[]> {
  const result = await guardArm(input, io);
  if (!result.ok) throw new ArmRefusedError(input.pr, result);
  return result.preArm;
}
