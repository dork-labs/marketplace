/**
 * `flow sweep [--dry-run]` (DOR-3341): arm every open PR that is cleared but
 * unarmed, through the arm guard, and say why each other unarmed PR is not.
 * The drain runs it on every tick.
 *
 * For each open PR that is not armed, it reads the PR's queue state, the arm
 * guard's facts, when its head last arrived, and when each review label
 * its route needs was added (`land/sweep.ts`). A cleared PR goes to the arm
 * guard with its current head as the reviewed commit, and is armed only when
 * the guard allows, at exactly that head (`--match-head-commit`). The guard
 * refuses on a moved head, red checks, a hold label, a freeze and the rest; its
 * `land.preArm` checks are left to the drain (`pre-arm-deferred`).
 *
 * It arms only when `drain.armAutoMerge` is on or `--arm` is passed, like
 * `flow pr`; otherwise, and always with `--dry-run`, it judges and arms
 * nothing (`would-arm`). Every PR it does not arm comes back with a reason. Exits 4 when the open PRs
 * cannot be read at all, 7 while flow is paused (unless `--manual`).
 *
 * @module @dorkos/flow/cli/sweep
 */

import { PausedError } from '../errors.ts';
import type { OpenPr } from '../forge/open-prs.ts';
import { ForgeError, type Forge } from '../forge/types.ts';
import { ARM_BASE } from '../land/arm-decision.ts';
import { policyFor } from '../land/arm-guard.ts';
import { reviewRoute, type ReviewRoute } from '../land/review-route.ts';
import { clearance, type ReviewLabels } from '../land/sweep.ts';
import { loadProjectConfig } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { readOpenPrs } from './open-prs-read.ts';

/** What the sweep did with one PR. */
export interface SweepResult {
  /** The PR. */
  number: number;
  /** Its web address. */
  url: string;
  /** `armed`, `would-arm` (dry run), `refused` (by the guard) or `not-cleared`. */
  outcome: 'armed' | 'would-arm' | 'refused' | 'not-cleared';
  /** The reason, when it was not armed. */
  reason?: string;
  /** What is wrong, for a person, when it was not armed. */
  detail?: string;
  /** The head it judged. */
  head: string;
  /** Its review route, when its files were read. */
  route?: ReviewRoute;
}

/**
 * Judge one PR and arm it when it is cleared and the guard allows.
 *
 * @param ctx - The verb's context.
 * @param forge - The forge.
 * @param pr - The PR.
 * @param shared - The required checks, labels, route policy and whether to arm.
 * @returns What happened.
 */
async function sweepOne(
  ctx: VerbContext,
  forge: Forge,
  pr: OpenPr,
  shared: {
    requiredChecks: string[] | null;
    labels: ReviewLabels;
    policy: Parameters<typeof reviewRoute>[1];
    dryRun: boolean;
  }
): Promise<SweepResult> {
  const base = { number: pr.number, url: pr.url, head: pr.headSha };
  let route: ReviewRoute | undefined;
  try {
    const status = await forge.prStatus(pr.number);
    const facts = await forge.armFacts(pr.number);
    route = reviewRoute(facts.files, shared.policy);
    const wanted = [
      shared.labels.security,
      ...(route.steps.qa ? [shared.labels.qa] : []),
      ...(route.steps.design ? [shared.labels.design] : []),
    ];
    const labelledAt: Record<string, string | null> = {};
    for (const label of wanted) {
      labelledAt[label.toLowerCase()] =
        forge.labelledAt === undefined ? null : await forge.labelledAt(pr.number, label);
    }
    const headSeenAt =
      forge.headPushedAt === undefined
        ? null
        : await forge.headPushedAt(pr.number, facts.headRefOid, facts.headRefName);
    const verdict = clearance(
      {
        armed: status.armed || pr.armed,
        queued: status.queued,
        facts,
        requiredChecks: shared.requiredChecks,
        headSeenAt,
        labelledAt,
        route,
      },
      shared.labels
    );
    const head = facts.headRefOid;
    if (!verdict.cleared) {
      return {
        ...base,
        head,
        route,
        outcome: 'not-cleared',
        reason: verdict.reason,
        detail: verdict.detail,
      };
    }
    if (shared.dryRun) return { ...base, head, route, outcome: 'would-arm' };
    // The guard decides; the head is the one whose labels were just checked.
    const guard = await ctx.armGuard({
      forge,
      pr: pr.number,
      reviewedSha: head,
      worktree: ctx.projectDir,
      preArm: 'defer',
    });
    if (!guard.ok) {
      return {
        ...base,
        head,
        route,
        outcome: 'refused',
        reason: guard.reason,
        detail: guard.detail,
      };
    }
    await forge.arm(pr.number, head);
    return { ...base, head, route, outcome: 'armed' };
  } catch (error) {
    // One PR that cannot be read or armed is reported, never the end of the sweep.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      ...(route === undefined ? {} : { route }),
      outcome: 'not-cleared',
      reason: 'unreadable',
      detail: `flow could not read or arm #${pr.number}: ${message}`,
    };
  }
}

/**
 * The human text: one line per PR.
 *
 * @param repo - `owner/name`.
 * @param results - What happened to each.
 * @returns The text.
 */
export function renderSweep(repo: string, results: readonly SweepResult[]): string {
  if (results.length === 0) return `No unarmed open pull requests on ${repo}.`;
  const lines = results.map((r) => {
    switch (r.outcome) {
      case 'armed':
        return `  #${r.number}: armed at ${r.head.slice(0, 7)}.`;
      case 'would-arm':
        return `  #${r.number}: cleared; would arm at ${r.head.slice(0, 7)}.`;
      case 'refused':
        return `  #${r.number}: cleared, but the arm guard refused (${r.reason}): ${r.detail}.`;
      default:
        return `  #${r.number}: not cleared (${r.reason}): ${r.detail}.`;
    }
  });
  return [`Unarmed open pull requests on ${repo}:`, ...lines].join('\n');
}

/**
 * Run `flow sweep`.
 *
 * @param ctx - The verb's context.
 * @returns One result per unarmed open PR.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const project = loadProjectConfig(ctx);
  const { config, paused } = project.loaded;
  project.flushWarnings();
  // Arming follows the repo's policy, as flow pr's does: drain.armAutoMerge,
  // or --arm from a person who means it.
  const dryRun = ctx.dryRun || !(ctx.args.flags.arm === true || config.drain.armAutoMerge);
  if (paused !== null && !ctx.manual && !dryRun) {
    throw new PausedError(
      'flow is paused; /flow:resume lifts it, or pass --manual when a person is driving'
    );
  }
  const swept = await sweepOpenPrs(ctx, config, { dryRun });
  if (swept.repo === null) {
    return {
      json: { repo: null, results: [], why: swept.why },
      text: `Nothing to sweep: ${swept.why}.`,
    };
  }
  return { json: swept, text: renderSweep(swept.repo, swept.results) };
}

/** What {@link sweepOpenPrs} did. */
export type Swept =
  { repo: string; results: SweepResult[] } | { repo: null; results: []; why: string };

/**
 * The sweep itself, for `flow sweep` and the drain's pass.
 *
 * @param ctx - The verb's context.
 * @param config - The project config.
 * @param opts - `dryRun`: judge, and arm nothing.
 * @returns One result per unarmed open PR, or why there is nothing to sweep.
 * @throws {ForgeError} When the open PRs cannot be read.
 */
export async function sweepOpenPrs(
  ctx: VerbContext,
  config: ReturnType<typeof loadProjectConfig>['loaded']['config'],
  opts: { dryRun: boolean }
): Promise<Swept> {
  const { dryRun } = opts;
  const open = await readOpenPrs(ctx, ctx.projectDir);
  if (open.kind === 'none') return { repo: null, results: [], why: open.why };
  if (open.kind === 'unreadable') {
    throw new ForgeError(`flow could not list the open pull requests: ${open.error}`);
  }
  const { forge, prs } = open;
  let requiredChecks: string[] | null = null;
  try {
    requiredChecks = (await forge.requiredChecks?.(ARM_BASE)) ?? null;
  } catch {
    requiredChecks = null;
  }
  const shared = {
    requiredChecks,
    labels: {
      security: config.land.securityPaths.label,
      qa: config.review.qaLabel,
      design: config.review.designLabel,
    },
    policy: {
      arm: policyFor(config.land),
      designPaths: config.review.designPaths,
      lightPaths: config.review.lightPaths,
    },
    dryRun,
  };
  const results: SweepResult[] = [];
  for (const pr of prs) {
    if (pr.armed) continue;
    results.push(await sweepOne(ctx, forge, pr, shared));
  }
  return { repo: forge.repo, results };
}
