/**
 * The reviewer worktree `flow release` cleans up (DOR-3704). The lane
 * supervisor parks a quiet reviewer rather than start a second one (DOR-3263),
 * so the reviewer's detached worktree outlives its review. Releasing the item
 * removes it, under three rules:
 *
 * - Only the folder flow made for this item's review: exactly
 *   `reviewWorktreePath` for the item and the reviewed commit, listed by git as
 *   a worktree of this checkout, detached at that commit. Anything else is kept,
 *   and the release goes on.
 * - Only once every session recorded in it (the drain's reviewer, and a VERIFY
 *   reviewer started at the same path) is confirmed done: its host says it
 *   exited or is gone (DorkOS's 404, the rule DOR-3263 restarts on). Idle,
 *   busy, limited, unknown or a start not yet confirmed refuses the release,
 *   so the run record survives for the next try.
 * - Only clean, unless `--discard-review-changes`: uncommitted changes refuse
 *   the release too.
 *
 * Release never stops a session.
 *
 * @module @dorkos/flow/cli/release-worktree
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { reviewWorktreePath } from '../drain/worktree.ts';
import type { FlowRun } from '../flow-run.ts';
import { realLauncher } from '../launchers/real.ts';
import {
  handleRuntime,
  HOST_NAMES,
  type HostName,
  type SessionHandle,
} from '../launchers/types.ts';
import type { VerbContext } from './context.ts';

/** What release says when the reviewer's session may still run. */
export const REVIEWER_MAY_RUN =
  'reviewer session may still be running; stop it, then run `flow release` again';

/** What release decided about the reviewer worktree. */
export type ReviewWorktreePlan =
  /** Remove it once the release is written (`force`: with uncommitted changes). */
  | { action: 'remove'; path: string; force: boolean }
  /** Leave it, and release anyway. */
  | { action: 'keep'; path: string; reason: string }
  /** Refuse the release: nothing is written. */
  | { action: 'refuse'; path: string; reason: string };

/** What release reports about the reviewer worktree. */
export interface ReviewWorktreeOutcome {
  /** The folder. */
  path: string;
  /** Whether release removed it. */
  removed: boolean;
  /** Why, in a few words. */
  reason: string;
}

/** `p` resolved through symlinks when it exists (git prints real paths). */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The `HEAD` git lists for the worktree at `target`, `detached` or not; `null` when unlisted. */
async function listed(
  ctx: VerbContext,
  mainCheckout: string,
  target: string
): Promise<{ head: string | null; detached: boolean } | null> {
  const out = await ctx.runProcess('git', ['worktree', 'list', '--porcelain'], {
    cwd: mainCheckout,
  });
  if (out.code !== 0) return null;
  for (const block of out.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (at === undefined || real(at) !== real(target)) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
    return { head, detached: lines.includes('detached') };
  }
  return null;
}

/** A recorded session that may work in a folder. */
interface FolderSession {
  host: string;
  runtime?: string;
  sessionId: string;
  cwd: string;
  pending?: boolean;
}

/**
 * Every recorded session that may work in `target`: the drain's reviewer, and
 * a VERIFY reviewer `flow report review-launch` started at the same path.
 */
function sessionsIn(run: FlowRun, target: string): FolderSession[] {
  const out: FolderSession[] = [];
  if (run.drain?.reviewer) out.push(run.drain.reviewer);
  const verify = run.review?.reviewer;
  if (verify !== undefined && real(verify.cwd) === real(target)) out.push(verify);
  return out;
}

/**
 * Whether the host confirms the session no longer runs: it exited, or it is
 * gone (DorkOS's 404, the rule DOR-3263 restarts on). Idle, busy, limited or
 * unknown may still run; so may a start not yet confirmed (`pending`).
 */
async function sessionDone(ctx: VerbContext, session: FolderSession): Promise<boolean> {
  if (session.pending === true) return false;
  if (!(HOST_NAMES as readonly string[]).includes(session.host)) return false;
  const host = session.host as HostName;
  try {
    const launcher = ctx.createLauncher?.(host) ?? realLauncher(host, ctx.env, ctx.io.osHome);
    const state = await launcher.state({
      ...session,
      runtime: handleRuntime(session as { runtime?: SessionHandle['runtime'] }),
    } as SessionHandle);
    return state.kind === 'exited' || (state.kind === 'unknown' && state.gone === true);
  } catch {
    return false;
  }
}

/**
 * Decide what to do with the run's reviewer worktree. Reads only.
 *
 * @param ctx - The verb's context (process runner, launcher factory).
 * @param run - The run being released.
 * @param opts - The DorkOS home, repo name, main checkout and `--discard-review-changes`.
 * @returns The plan, or `null` when the run records no reviewer worktree.
 */
export async function planReviewWorktree(
  ctx: VerbContext,
  run: FlowRun,
  opts: { dorkHome: string; repoName: string; mainCheckout: string; discard: boolean }
): Promise<ReviewWorktreePlan | null> {
  const handle = run.drain?.reviewer;
  if (!handle?.worktree) return null;
  const target = handle.worktree;
  const expected = reviewWorktreePath(opts.dorkHome, opts.repoName, run.identifier, handle.sha);
  if (path.resolve(target) !== path.resolve(expected)) {
    return {
      action: 'keep',
      path: target,
      reason: 'not the review folder flow made for this item',
    };
  }
  if (!existsSync(target)) return { action: 'keep', path: target, reason: 'already gone' };
  const entry = await listed(ctx, opts.mainCheckout, target);
  if (entry === null) {
    return { action: 'keep', path: target, reason: 'not a worktree of this checkout' };
  }
  if (!entry.detached || entry.head !== handle.sha) {
    return { action: 'keep', path: target, reason: 'no longer at the reviewed commit' };
  }
  // A VERIFY review of this commit started but not yet recorded may be starting here.
  const verify = run.review;
  if (verify?.sha === handle.sha && verify.reviewer === undefined && verify.verdict === null) {
    return { action: 'refuse', path: target, reason: REVIEWER_MAY_RUN };
  }
  for (const session of sessionsIn(run, target)) {
    if (!(await sessionDone(ctx, session))) {
      return { action: 'refuse', path: target, reason: REVIEWER_MAY_RUN };
    }
  }
  const status = await ctx.runProcess('git', ['status', '--porcelain'], { cwd: target });
  if (status.code !== 0) {
    return { action: 'refuse', path: target, reason: 'git could not read its changes' };
  }
  const changes = status.stdout.split('\n').filter((l) => l.trim() !== '').length;
  if (changes > 0 && !opts.discard) {
    return {
      action: 'refuse',
      path: target,
      reason: `it has ${changes} uncommitted change${changes === 1 ? '' : 's'}; pass --discard-review-changes to remove it anyway`,
    };
  }
  return { action: 'remove', path: target, force: changes > 0 };
}

/**
 * Carry out a plan once the release is written. Never throws.
 *
 * @param ctx - The verb's context.
 * @param mainCheckout - The main checkout, which owns the worktree.
 * @param plan - The plan ({@link planReviewWorktree}); `refuse` never gets here.
 * @returns What happened, for the report.
 */
export async function applyReviewWorktree(
  ctx: VerbContext,
  mainCheckout: string,
  plan: Exclude<ReviewWorktreePlan, { action: 'refuse' }>
): Promise<ReviewWorktreeOutcome> {
  if (plan.action === 'keep') return { path: plan.path, removed: false, reason: plan.reason };
  if (ctx.dryRun) {
    return {
      path: plan.path,
      removed: false,
      reason: plan.force ? 'would remove it, discarding its changes' : 'would remove it',
    };
  }
  const args = ['worktree', 'remove', ...(plan.force ? ['--force'] : []), plan.path];
  try {
    const out = await ctx.runProcess('git', args, { cwd: mainCheckout });
    if (out.code === 0) {
      return {
        path: plan.path,
        removed: true,
        reason: plan.force ? 'removed, with its changes discarded' : 'removed',
      };
    }
    return {
      path: plan.path,
      removed: false,
      reason: out.stderr.trim() || `git exited ${out.code}`,
    };
  } catch (error) {
    return { path: plan.path, removed: false, reason: (error as Error).message };
  }
}
