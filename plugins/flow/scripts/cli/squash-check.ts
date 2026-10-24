/**
 * `flow squash-check <identifier> [--pr <n>]` (DOR-3262): after a run's PR
 * merged, check that the squash commit on `main` is what was reviewed
 * (`land/squash-verify.ts`). The drain runs the same check by itself when it
 * sees the PR merge; this verb is for runs outside the drain, and for a person.
 *
 * The reviewed head is always the one recorded at review (`drain.reviewedSha`,
 * else a clean `review.reviewedSha`); there is no flag to name another. The
 * squash commit is the one the forge says the merge made. A failure is
 * reported loudly on the PR, naming its author and the security reviewer
 * (`land.securityPaths.reviewer`), with both trees and the files that differ.
 * It is a verdict and a report only: nothing is reverted, and no status or
 * label is touched.
 *
 * Exits 0 on a pass, 1 on a failed check, 5 when the PR has not merged or no
 * reviewed head is recorded.
 *
 * @module @dorkos/flow/cli/squash-check
 */

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import type { Forge } from '../forge/types.ts';
import { ARM_BASE } from '../land/arm-decision.ts';
import { gitIn, squashReport, verifySquash, type SquashVerdict } from '../land/squash-verify.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { originForge, short } from './drain-run.ts';
import { provenanceLine } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

/** What one squash check came to. */
export type SquashOutcome =
  | { status: 'checked'; verdict: SquashVerdict; reported: boolean; reportError?: string }
  | { status: 'not-merged' | 'unknown'; why: string };

/** What {@link checkSquash} needs. */
export interface SquashCheckInput {
  /** The forge the PR lives on. */
  forge: Forge;
  /** The PR. */
  pr: number;
  /** The head recorded at review. */
  reviewed: string;
  /** A checkout of the repository to run git in. */
  worktree: string;
  /** The security reviewer's handle, or `null`. */
  securityReviewer: string | null;
  /** Report nothing (a dry run). */
  dryRun: boolean;
  /** Signs a comment body with flow's provenance line. */
  sign(body: string): string;
}

/** `@handle`, from a handle with or without its `@`. */
function at(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * Check a merged PR's squash commit against the head recorded at review, and
 * report a failure on the PR.
 *
 * @param input - The PR, its reviewed head and where to run git.
 * @returns The outcome.
 */
export async function checkSquash(input: SquashCheckInput): Promise<SquashOutcome> {
  if (input.forge.mergeInfo === undefined) {
    return { status: 'unknown', why: 'this forge does not say which commit a merge made' };
  }
  let info;
  try {
    info = await input.forge.mergeInfo(input.pr);
  } catch (error) {
    return { status: 'unknown', why: (error as Error).message };
  }
  if (info.state !== 'merged') {
    return { status: 'not-merged', why: `#${input.pr} is ${info.state}, not merged` };
  }
  if (info.mergeCommit === null) {
    return { status: 'unknown', why: `the forge did not say which commit #${input.pr} merged as` };
  }
  const git = gitIn(input.worktree);
  // Both commits must be here: main from origin, and the reviewed head from
  // the PR's own ref (its branch is often deleted on merge). Fixed refspecs
  // only; the PR number is a number.
  await git([
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    `+refs/heads/${ARM_BASE}:refs/remotes/origin/${ARM_BASE}`,
  ]);
  if ((await git(['cat-file', '-e', `${input.reviewed}^{commit}`])).code !== 0) {
    await git(['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${input.pr}/head`]);
  }
  const verdict = await verifySquash(git, { squash: info.mergeCommit, reviewed: input.reviewed });
  if (verdict.verdict === 'pass' || input.dryRun) {
    return { status: 'checked', verdict, reported: false };
  }
  const mentions = [
    ...new Set(
      [info.author, input.securityReviewer].filter((h): h is string => h !== null).map(at)
    ),
  ];
  try {
    await input.forge.comment(input.pr, input.sign(squashReport(verdict, mentions)));
    return { status: 'checked', verdict, reported: true };
  } catch (error) {
    return { status: 'checked', verdict, reported: false, reportError: (error as Error).message };
  }
}

/** The head recorded at review for a run, or `null`. */
export function reviewedHeadOf(run: FlowRun): string | null {
  if (run.drain?.reviewedSha) return run.drain.reviewedSha;
  if (run.review?.verdict === 'clean' && run.review.reviewedSha) return run.review.reviewedSha;
  return null;
}

/** The security reviewer from this machine's settings, or `null`. */
export function securityReviewerFor(ctx: VerbContext): string | null {
  try {
    return loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env).config.land
      .securityPaths.reviewer;
  } catch {
    return null;
  }
}

/** A comment signed as flow signs PR text (public: session cut, no host). */
export function signer(ctx: VerbContext, launcher: string | undefined): (body: string) => string {
  return (body) => {
    const provenance = sessionProvenance(ctx, launcher);
    const line = provenanceLine({
      ...provenance,
      sessionId: provenance.sessionId?.slice(0, 8),
      host: undefined,
    });
    return line === undefined ? body : `${body}\n\n${line}\n`;
  };
}

/** One line for a person. */
export function describeOutcome(pr: number, outcome: SquashOutcome): string {
  if (outcome.status !== 'checked') return `could not squash-check #${pr}: ${outcome.why}`;
  const v = outcome.verdict;
  if (v.verdict === 'pass') {
    return `squash check passed for #${pr}: ${short(v.squash)} matches the reviewed ${short(v.reviewed)} (${v.check})`;
  }
  const where = outcome.reported
    ? ', reported on the PR'
    : outcome.reportError
      ? `; the report could not be posted: ${outcome.reportError}`
      : '';
  return `SQUASH CHECK FAILED for #${pr}: ${v.reason}${where}`;
}

/**
 * Run `flow squash-check`.
 *
 * @param ctx - The verb's context.
 * @returns The verdict.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const runs = Object.values(openFlowStateFile(ctx.projectDir, { now: ctx.now }).read()).filter(
    (r) => r.identifier === identifier
  );
  const found = runs[0];
  if (found === undefined) throw new PreconditionError(`${identifier} has no run record`);
  const prFlag = ctx.args.flags.pr;
  let pr = found.drain?.pr?.number;
  if (typeof prFlag === 'string') {
    if (!/^[1-9][0-9]{0,9}$/.test(prFlag)) throw new UsageError('--pr takes a PR number');
    pr = Number(prFlag);
  }
  if (pr === undefined) {
    throw new PreconditionError(`${identifier} has no PR recorded; pass --pr <number>`);
  }
  const reviewed = reviewedHeadOf(found);
  if (reviewed === null) {
    throw new PreconditionError(
      `${identifier} has no reviewed head recorded, so there is nothing to check the squash against`
    );
  }
  const forge = await originForge(ctx, ctx.projectDir);
  const outcome = await checkSquash({
    forge,
    pr,
    reviewed,
    worktree: ctx.projectDir,
    securityReviewer: securityReviewerFor(ctx),
    dryRun: ctx.dryRun,
    sign: signer(ctx, found.host),
  });
  const text = describeOutcome(pr, outcome);
  if (outcome.status !== 'checked') throw new PreconditionError(text);
  const failed = outcome.verdict.verdict === 'fail';
  return {
    ...(failed ? { exitCode: 1 as const } : {}),
    json: { ok: !failed, identifier, pr, ...outcome },
    text,
  };
}
