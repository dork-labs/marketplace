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
 * Exits 0 on a pass, 1 on anything else (a failed check, a check that could not
 * run, a merge with no clean review), 5 when the PR has not merged.
 *
 * @module @dorkos/flow/cli/squash-check
 */

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import type { Forge } from '../forge/types.ts';
import { gitIn, squashReport, verifySquash, type SquashVerdict } from '../land/squash-verify.ts';
import { isFullSha } from '../land/validate.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { originForge, short } from './drain-run.ts';
import { provenanceLine } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

/** What one squash check came to. */
export type SquashOutcome =
  | { status: 'checked'; verdict: SquashVerdict; reported: boolean; reportError?: string }
  | { status: 'unreviewed'; why: string; reported: boolean; reportError?: string }
  | { status: 'not-merged' | 'unknown'; why: string; reported: boolean; reportError?: string };

/** What {@link checkSquash} needs. */
export interface SquashCheckInput {
  /** The forge the PR lives on. */
  forge: Forge;
  /** The PR. */
  pr: number;
  /** The head a clean review recorded, or `null` when there is none (itself reported). */
  reviewed: string | null;
  /** A checkout of the repository to run git in (the main checkout). */
  worktree: string;
  /** The security reviewer's handle, or `null`. */
  securityReviewer: string | null;
  /** Report nothing (a dry run). */
  dryRun: boolean;
  /** The last try: report even a check that could not run. */
  final: boolean;
  /** Signs a comment body with flow's provenance line. */
  sign(body: string): string;
}

/** The mentions that open a report: `@a @b: `, or nothing. */
function whoOf(mentions: readonly string[]): string {
  return mentions.length > 0 ? `${mentions.join(' ')}: ` : '';
}

/** `@handle`, from a handle with or without its `@`. */
function at(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * Whether an outcome is a verdict the drain need not ask for again: a pass, or
 * a fail or a merge with no clean review that was reported. A check that could
 * not run, or a failure whose report the forge refused, is asked again.
 */
export function squashSettled(outcome: SquashOutcome, dryRun = false): boolean {
  if (outcome.status === 'checked' && outcome.verdict.verdict === 'pass') return true;
  const verdict =
    outcome.status === 'unreviewed' ||
    (outcome.status === 'checked' && outcome.verdict.verdict === 'fail');
  // A failure is settled only once someone was told: a report the forge
  // refused is posted again on the next pass.
  return verdict && (dryRun || outcome.reported);
}

/**
 * Check a merged PR's squash commit against the head a clean review recorded,
 * and report on the PR when it does not pass: always for a fail or a merge with
 * no clean review, and for a check that could not run on the last try.
 *
 * @param input - The PR, its reviewed head and where to run git.
 * @returns The outcome.
 */
export async function checkSquash(input: SquashCheckInput): Promise<SquashOutcome> {
  let author: string | null = null;
  const report = async (
    body: (mentions: string[]) => string
  ): Promise<{ reported: boolean; reportError?: string }> => {
    if (input.dryRun) return { reported: false };
    const mentions = [
      ...new Set([author, input.securityReviewer].filter((h): h is string => h !== null).map(at)),
    ];
    try {
      await input.forge.comment(input.pr, input.sign(body(mentions)));
      return { reported: true };
    } catch (error) {
      return { reported: false, reportError: (error as Error).message };
    }
  };
  const couldNot = async (why: string): Promise<SquashOutcome> => ({
    status: 'unknown',
    why,
    ...(input.final
      ? await report(
          (m) =>
            `${whoOf(m)}**Squash check could not run.** ${why}. Nobody has shown the squash is what was reviewed; check it by hand. Flow reverted nothing and changed no status.`
        )
      : { reported: false }),
  });
  if (input.forge.mergeInfo === undefined) {
    return couldNot('this forge does not say which commit a merge made');
  }
  let info;
  try {
    info = await input.forge.mergeInfo(input.pr);
  } catch (error) {
    return couldNot(`could not read how #${input.pr} merged: ${(error as Error).message}`);
  }
  author = info.author;
  if (info.state !== 'merged') {
    return {
      status: 'not-merged',
      why: `#${input.pr} is ${info.state}, not merged`,
      reported: false,
    };
  }
  if (info.mergeCommit === null) {
    return couldNot(`the forge did not say which commit #${input.pr} merged as`);
  }
  if (input.reviewed === null) {
    const why = `#${input.pr} merged with no clean review recorded at its head, so nothing shows the merge is what was reviewed`;
    return {
      status: 'unreviewed',
      why,
      ...(await report(
        (m) =>
          `${whoOf(m)}**Squash check failed.** ${why}. Flow reverted nothing and changed no status.`
      )),
    };
  }
  const git = gitIn(input.worktree);
  // Both commits must be here: the merge commit by its SHA (whatever branch it
  // went to), and the reviewed head from the PR's own ref, since its branch is
  // often deleted on merge. Fixed argv; both SHAs are checked whole, the PR
  // number is a number. A failed fetch shows up as a missing commit below.
  const fetch = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin'];
  for (const sha of [info.mergeCommit, input.reviewed]) {
    if (isFullSha(sha) && (await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
      await git([...fetch, sha]);
    }
  }
  if (
    isFullSha(input.reviewed) &&
    (await git(['cat-file', '-e', `${input.reviewed}^{commit}`])).code !== 0
  ) {
    await git([...fetch, `refs/pull/${input.pr}/head`]);
  }
  const verdict = await verifySquash(git, { squash: info.mergeCommit, reviewed: input.reviewed });
  const loud = verdict.verdict === 'fail' || (verdict.verdict === 'unverified' && input.final);
  if (!loud) return { status: 'checked', verdict, reported: false };
  return {
    status: 'checked',
    verdict,
    ...(await report((m) => squashReport(verdict, m))),
  };
}

/** The head a clean review recorded for a run, or `null`. */
export function reviewedHeadOf(run: FlowRun): string | null {
  if (run.drain !== undefined) {
    return run.drain.verdict === 'clean' ? (run.drain.reviewedSha ?? null) : null;
  }
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
  const where = outcome.reported
    ? ', reported on the PR'
    : outcome.reportError
      ? `; the report could not be posted: ${outcome.reportError}`
      : '';
  if (outcome.status === 'unreviewed')
    return `SQUASH CHECK FAILED for #${pr}: ${outcome.why}${where}`;
  if (outcome.status !== 'checked') return `could not squash-check #${pr}: ${outcome.why}${where}`;
  const v = outcome.verdict;
  if (v.verdict === 'pass') {
    return `squash check passed for #${pr}: ${short(v.squash)} matches the reviewed ${short(v.reviewed)}`;
  }
  if (v.verdict === 'unverified') return `could not squash-check #${pr}: ${v.reason}${where}`;
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
  const forge = await originForge(ctx, ctx.projectDir);
  const outcome = await checkSquash({
    forge,
    pr,
    reviewed,
    worktree: ctx.projectDir,
    securityReviewer: securityReviewerFor(ctx),
    dryRun: ctx.dryRun,
    final: true,
    sign: signer(ctx, found.host),
  });
  const text = describeOutcome(pr, outcome);
  if (outcome.status === 'not-merged') throw new PreconditionError(text);
  const passed = outcome.status === 'checked' && outcome.verdict.verdict === 'pass';
  return {
    ...(passed ? {} : { exitCode: 1 as const }),
    json: { ok: passed, identifier, pr, ...outcome },
    text,
  };
}
