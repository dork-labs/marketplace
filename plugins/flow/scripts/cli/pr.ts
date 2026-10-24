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
 * 4. otherwise opens the PR against origin's default branch and records
 *    `drain.pr`;
 * 5. names the PR's reviewer in a comment of its own (DOR-3262): the
 *    committed config on `origin/main` says who, `land.securityPaths.reviewer`
 *    when the PR touches a security path, else `land.reviewer`;
 * 6. on `--arm` or `drain.armAutoMerge`, arms it only when the arm guard
 *    allows (`land/arm-guard.ts`). A refusal leaves the PR open and unarmed
 *    and exits 5 saying why.
 *
 * @module @dorkos/flow/cli/pr
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import type { LandConfig } from '../config-schema.ts';
import { securityPathsTouched } from '../land/arm-decision.ts';
import { readBaseLand } from '../land/base-config.ts';
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

/** What the reviewer mention did. */
interface Mention {
  /** Who was named. */
  reviewer: string;
  /** Why them: the PR touches a security path, or the default reviewer. */
  route: 'security' | 'default';
  /** Whether the comment was posted. */
  posted: boolean;
  /** Why it was not, when it was not. */
  error?: string;
}

/**
 * Name the new PR's reviewer in a comment, from `land` on `origin/main`: the
 * security reviewer when the PR touches a security path (or flow cannot tell),
 * else the default reviewer; nothing when neither is set. A failure is
 * reported, never thrown: the PR is open either way.
 */
async function mentionReviewer(
  ctx: VerbContext,
  forge: Forge,
  pr: ForgePr,
  land: LandConfig,
  head: string,
  launcher: string | undefined
): Promise<Mention | null> {
  let security = true;
  if (land.securityPaths.reviewer !== null) {
    try {
      const facts = await forge.armFacts(pr.number);
      security =
        facts.files === null ||
        securityPathsTouched(facts.files, {
          securityGlobs: land.securityPaths.globs,
          securityPattern: land.securityPaths.pattern,
          securityLabel: land.securityPaths.label,
        }).length > 0;
    } catch {
      security = true;
    }
  }
  const route = land.securityPaths.reviewer !== null && security ? 'security' : 'default';
  const handle = route === 'security' ? land.securityPaths.reviewer : land.reviewer;
  if (handle === null) return null;
  const reviewer = handle.startsWith('@') ? handle : `@${handle}`;
  const body =
    route === 'security'
      ? `${reviewer}: this PR touches security paths. Please review it at ${short(head)}.`
      : `${reviewer}: this PR is ready for your review at ${short(head)}.`;
  try {
    await forge.comment(pr.number, signedPrBody(ctx, body, launcher));
    return { reviewer, route, posted: true };
  } catch (error) {
    const message = (error as Error).message;
    ctx.warn(`flow opened ${pr.url} but could not mention ${reviewer}: ${message}`);
    return { reviewer, route, posted: false, error: message };
  }
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
    openFlowStateFile(ctx.projectDir, { now: ctx.now }),
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

  const drainRun = findDrainRun(
    openFlowStateFile(ctx.projectDir, { now: ctx.now }),
    identifier,
    'pr'
  );
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
  // Who to name comes from main's committed config, like the guard's checks.
  const baseLand = await readBaseLand(ctx.runProcess, worktree);
  const created = await forge.createPr({
    head: branch,
    base,
    title: title.trim(),
    body: signedPrBody(ctx, body, drainRun.host),
  });
  // Recorded before arming, so a failed arm never leaves an unrecorded PR.
  await recordPr(ctx, drainRun, forge, created, false);
  const mention = baseLand.ok
    ? await mentionReviewer(ctx, forge, created, baseLand.land, head, drainRun.host)
    : null;
  if (!baseLand.ok)
    ctx.warn(`flow opened ${created.url} but named no reviewer: ${baseLand.detail}`);
  let armed = false;
  let armRefused: { reason: string; detail: string } | null = null;
  if (arm) {
    const guard = await ctx.armGuard({ forge, pr: created.number, reviewedSha: head, worktree });
    if (guard.ok) {
      await forge.arm(created.number, head);
      await recordPr(ctx, drainRun, forge, created, true);
      armed = true;
    } else {
      armRefused = { reason: guard.reason, detail: guard.detail };
    }
  }
  const mentionText =
    mention === null
      ? ''
      : mention.posted
        ? ` Asked ${mention.reviewer} to review it.`
        : ` Could not ask ${mention.reviewer} to review it: ${mention.error}.`;
  return {
    ...(armRefused === null ? {} : { exitCode: 5 as const }),
    json: {
      ok: armRefused === null,
      identifier,
      pr: { repo: forge.repo, number: created.number, url: created.url, armed },
      base,
      head,
      mention,
      armRefused,
    },
    text: `Opened ${created.url} for ${identifier} into ${base}${armed ? ', auto-merge armed' : ''}.${mentionText}${
      armRefused === null ? '' : ` Did not arm it (${armRefused.reason}): ${armRefused.detail}.`
    }`,
  };
}
