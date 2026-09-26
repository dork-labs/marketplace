/**
 * `flow pr <identifier> --title <text> --body-file <file> [--arm | --no-arm]`
 * (spec `flow-handoff-dispatch` §4.6): open a drain run's pull request, only
 * after a CLEAN review of the commit origin holds.
 *
 * This is the gate that makes "no PR before a CLEAN review" true in code: the
 * worker brief never runs `gh pr create` itself. The verb
 *
 * 1. refuses (exit 5) unless the run's verdict is `clean` and `reviewedSha` is
 *    the branch head on origin;
 * 2. appends a provenance line to the body when it has none;
 * 3. when an open PR already exists for the branch, records it and exits 5
 *    naming it, so a retry is safe;
 * 4. otherwise opens the PR against origin's default branch, arms it on
 *    `--arm` or `drain.armAutoMerge`, and records `drain.pr`.
 *
 * @module @dorkos/flow/cli/pr
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import type { Forge, ForgePr } from '../forge/types.ts';
import type { VerbContext, VerbResult } from './context.ts';
import {
  findDrainRun,
  git,
  originForge,
  originHead,
  short,
  writeDrain,
  type DrainRun,
} from './drain-run.ts';
import { provenanceLine } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

/** A signature line under either accepted name, anywhere in the body. */
const HAS_PROVENANCE = /<!--\s*(?:agent|flow):provenance\b/;

/** The base branch: origin's default, from `refs/remotes/origin/HEAD`. */
async function defaultBranch(ctx: VerbContext, worktree: string): Promise<string> {
  const result = await git(ctx, worktree, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const ref = result.stdout.trim();
  if (result.code !== 0 || !ref.startsWith('refs/remotes/origin/')) {
    throw new PreconditionError(
      `cannot tell origin's default branch in ${worktree}; run "git remote set-head origin --auto" there`
    );
  }
  return ref.slice('refs/remotes/origin/'.length);
}

/**
 * The body with a provenance line appended when it has none. A PR body is
 * world-readable on a public forge, and flow does not read the repository's
 * visibility, so it signs as for a public repository (`docs/provenance.md`
 * §8): the session id cut to 8 characters and no machine name.
 *
 * @param ctx - The verb context.
 * @param body - The body as written.
 * @param launcher - The run's launcher, when known.
 * @returns The body to post.
 */
function signedPrBody(ctx: VerbContext, body: string, launcher: string | undefined): string {
  if (HAS_PROVENANCE.test(body)) return body;
  const provenance = sessionProvenance(ctx, launcher);
  const line = provenanceLine({
    ...provenance,
    sessionId: provenance.sessionId?.slice(0, 8),
    host: undefined,
  });
  return line === undefined ? body : `${body.trimEnd()}\n\n${line}\n`;
}

/** Whether to arm: `--arm`, `--no-arm`, else config `drain.armAutoMerge`. */
function wantsArm(ctx: VerbContext): boolean {
  const arm = ctx.args.flags.arm === true;
  const noArm = ctx.args.flags['no-arm'] === true;
  if (arm && noArm) throw new UsageError('pass --arm or --no-arm, not both');
  if (arm || noArm) return arm;
  const { config } = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env);
  return config.drain.armAutoMerge;
}

/** Record `pr` on the run. */
async function recordPr(
  ctx: VerbContext,
  run: DrainRun,
  forge: Forge,
  pr: ForgePr,
  armed: boolean
): Promise<void> {
  await writeDrain(
    openFlowStateFile(ctx.projectDir),
    run,
    (drain) => ({
      ...drain,
      pr: { repo: forge.repo, number: pr.number, url: pr.url, armed, disarmedForReview: false },
    }),
    `run "flow pr ${run.identifier}" again (it will find the PR and record it)`
  );
}

/**
 * Run `flow pr`.
 *
 * @param ctx - The verb's context.
 * @returns The PR opened.
 * @throws {PreconditionError} Without a CLEAN review at origin's head, or when
 *   a PR already exists (recorded first) (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const title = ctx.args.flags.title;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new UsageError('--title <text> is required');
  }
  const bodyFlag = ctx.args.flags['body-file'];
  if (typeof bodyFlag !== 'string') throw new UsageError('--body-file <file> is required');
  let body: string;
  try {
    body = readFileSync(path.resolve(ctx.cwd, bodyFlag), 'utf8');
  } catch {
    throw new UsageError(`cannot read --body-file ${bodyFlag}`);
  }
  const arm = wantsArm(ctx);

  const drainRun = findDrainRun(openFlowStateFile(ctx.projectDir), identifier, 'pr');
  const { worktreePath: worktree, branch, drain } = drainRun;
  const head = await originHead(ctx, worktree, branch);
  if (drain.verdict !== 'clean' || head === null || drain.reviewedSha !== head) {
    const review =
      drain.verdict === null
        ? 'no review has finished'
        : `the latest review is ${drain.verdict.toUpperCase()} at ${short(drain.reviewedSha)}`;
    throw new PreconditionError(
      `no CLEAN review at ${short(head)}, the head of ${branch} on origin (${review}); a PR opens only after a clean review of the pushed commit`
    );
  }

  const forge = await originForge(ctx, worktree);
  const existing = await forge.prForBranch(branch);
  if (existing !== null) {
    const status = await forge.prStatus(existing.number);
    await recordPr(ctx, drainRun, forge, existing, status.armed);
    throw new PreconditionError(
      `a PR already exists for ${branch}: ${existing.url || `${forge.repo}#${existing.number}`}; flow recorded it on the run`
    );
  }

  const base = await defaultBranch(ctx, worktree);
  const created = await forge.createPr({
    head: branch,
    base,
    title: title.trim(),
    body: signedPrBody(ctx, body, drainRun.host),
  });
  // Recorded before arming, so a failed arm never leaves an unrecorded PR.
  await recordPr(ctx, drainRun, forge, created, false);
  if (arm) {
    await forge.arm(created.number);
    await recordPr(ctx, drainRun, forge, created, true);
  }
  return {
    json: {
      ok: true,
      identifier,
      pr: { repo: forge.repo, number: created.number, url: created.url, armed: arm },
      base,
      head,
    },
    text: `Opened ${created.url} for ${identifier} into ${base}${arm ? ', auto-merge armed' : ''}.`,
  };
}
