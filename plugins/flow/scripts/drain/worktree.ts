/**
 * Worktrees for the parallel drain (spec `flow-handoff-dispatch` §4.7): one per
 * worker, on its own branch, and one detached per review, so no two sessions
 * ever write in one folder.
 *
 * - A worker's worktree is `<dorkHome>/workspaces/<repo name>/<branch>`, on the
 *   branch `<identifier>-<slug>`, created from origin's default branch after a
 *   fetch. A worktree already on that branch is reused (a resumed run).
 * - A reviewer's worktree is `<dorkHome>/workspaces/<repo name>/review-<identifier>-<sha7>`,
 *   detached at the SHA under review, and removed after its verdict.
 *
 * Plain `git worktree` only (Decision D8). Every git call goes through the
 * injected {@link ProcessRunner}, with argv arrays and no shell.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/drain/worktree
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { PreconditionError } from '../errors.ts';
import type { ProcessRunner } from '../cli/context.ts';

/** The longest slug a branch name carries. */
export const MAX_SLUG_LENGTH = 40;

/** How long a fetch may take. */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * A title as a branch slug: lowercased, every run of characters outside
 * `[a-z0-9]` turned into `-`, trimmed of `-`, at most {@link MAX_SLUG_LENGTH}.
 *
 * @param title - The item's title.
 * @returns The slug, possibly empty.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/**
 * The worker's branch: `<identifier>-<slug>`, or the identifier alone when the
 * title has no letters or digits.
 *
 * @param identifier - The item, e.g. `ACME-12`.
 * @param title - Its title.
 * @returns The branch name.
 */
export function branchFor(identifier: string, title: string): string {
  const slug = slugify(title);
  return slug === '' ? identifier : `${identifier}-${slug}`;
}

/**
 * Where the drain's worktrees for a repository live.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param repoName - The repository's name (the part after `owner/`).
 * @returns `<dorkHome>/workspaces/<repoName>`.
 */
export function workspacesDir(dorkHome: string, repoName: string): string {
  return path.join(dorkHome, 'workspaces', repoName);
}

/**
 * The detached review worktree for one SHA.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param repoName - The repository's name.
 * @param identifier - The item.
 * @param sha - The commit under review.
 * @returns `<dorkHome>/workspaces/<repoName>/review-<identifier>-<sha7>`.
 */
export function reviewWorktreePath(
  dorkHome: string,
  repoName: string,
  identifier: string,
  sha: string
): string {
  return path.join(workspacesDir(dorkHome, repoName), `review-${identifier}-${sha.slice(0, 7)}`);
}

/** Run git and throw a precondition error naming what failed. */
async function git(
  run: ProcessRunner,
  cwd: string,
  args: readonly string[],
  what: string,
  timeoutMs?: number
): Promise<string> {
  let result;
  try {
    result = await run('git', args, { cwd, timeoutMs });
  } catch (error) {
    throw new PreconditionError(`could not ${what}: ${(error as Error).message}`);
  }
  if (result.code !== 0) {
    throw new PreconditionError(
      `could not ${what}: ${result.stderr.trim() || `git exited ${result.code}`}`
    );
  }
  return result.stdout;
}

/**
 * Origin's default branch: `origin/HEAD` when it is set, else what the remote
 * says its HEAD is, else `main`.
 *
 * @param run - The process runner.
 * @param checkout - Any checkout of the repository.
 * @returns The branch name, without `origin/`.
 */
export async function defaultBranch(run: ProcessRunner, checkout: string): Promise<string> {
  try {
    const local = await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: checkout });
    const name = local.stdout.trim();
    if (local.code === 0 && name.startsWith('origin/')) return name.slice('origin/'.length);
    const remote = await run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd: checkout,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.stdout);
    if (remote.code === 0 && match) return match[1];
  } catch {
    // fall through to the convention
  }
  return 'main';
}

/** One entry of `git worktree list --porcelain`. */
interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Parse `git worktree list --porcelain`. */
function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.find((line) => line.startsWith('worktree '));
    if (at === undefined) continue;
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'));
    entries.push({
      path: at.slice('worktree '.length),
      branch: branch === undefined ? null : branch.slice('branch refs/heads/'.length),
    });
  }
  return entries;
}

/** What {@link provisionWorktree} did. */
export interface ProvisionedWorktree {
  /** The worktree (absolute). */
  path: string;
  /** Whether a worktree already on the branch was reused. */
  reused: boolean;
}

/**
 * Give a worker its worktree: reuse one already on `branch`, else fetch origin
 * and add `<target>` on a new `branch` from origin's default branch (or on the
 * existing local `branch`, when an earlier run left one without a worktree).
 *
 * @param run - The process runner.
 * @param opts - The main checkout, the target folder and the branch.
 * @returns The worktree and whether it was reused.
 * @throws {PreconditionError} When git refuses.
 */
export async function provisionWorktree(
  run: ProcessRunner,
  opts: { mainCheckout: string; target: string; branch: string }
): Promise<ProvisionedWorktree> {
  const { mainCheckout, target, branch } = opts;
  const list = await git(
    run,
    mainCheckout,
    ['worktree', 'list', '--porcelain'],
    'list the worktrees'
  );
  const existing = parseWorktrees(list).find((entry) => entry.branch === branch);
  if (existing !== undefined && existsSync(existing.path)) {
    return { path: existing.path, reused: true };
  }
  await git(run, mainCheckout, ['fetch', '-q', 'origin'], 'fetch origin', FETCH_TIMEOUT_MS);
  const local = await run('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
    cwd: mainCheckout,
  });
  const args =
    local.code === 0
      ? ['worktree', 'add', target, branch]
      : [
          'worktree',
          'add',
          target,
          '-b',
          branch,
          `origin/${await defaultBranch(run, mainCheckout)}`,
        ];
  await git(run, mainCheckout, args, `add the worktree ${target}`);
  return { path: target, reused: false };
}

/**
 * Give a reviewer its own detached worktree at `sha`, after fetching the
 * branch so the commit is present. An existing folder at `target` is reused.
 *
 * @param run - The process runner.
 * @param opts - The main checkout, the branch, the SHA and the target folder.
 * @returns The worktree (absolute).
 * @throws {PreconditionError} When git refuses.
 */
export async function provisionReviewWorktree(
  run: ProcessRunner,
  opts: { mainCheckout: string; branch: string; sha: string; target: string }
): Promise<string> {
  const { mainCheckout, branch, sha, target } = opts;
  if (existsSync(target)) return target;
  await git(
    run,
    mainCheckout,
    ['fetch', '-q', 'origin', branch],
    `fetch ${branch} from origin`,
    FETCH_TIMEOUT_MS
  );
  await git(
    run,
    mainCheckout,
    ['worktree', 'add', '--detach', target, sha],
    `add the review worktree ${target}`
  );
  return target;
}

/**
 * Remove a worktree the drain made (a review worktree after its verdict).
 * Missing is fine; a failure is returned, not thrown, since nothing depends on
 * the folder being gone.
 *
 * @param run - The process runner.
 * @param mainCheckout - The main checkout.
 * @param target - The worktree.
 * @returns `null` when it is gone, else why it could not be removed.
 */
export async function removeWorktree(
  run: ProcessRunner,
  mainCheckout: string,
  target: string
): Promise<string | null> {
  if (!existsSync(target)) return null;
  try {
    const result = await run('git', ['worktree', 'remove', '--force', target], {
      cwd: mainCheckout,
    });
    return result.code === 0 ? null : result.stderr.trim() || `git exited ${result.code}`;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * The base a review diffs against: the merge base of `sha` with origin's
 * default branch, or the default branch's name when git cannot say.
 *
 * @param run - The process runner.
 * @param checkout - A checkout that has `sha`.
 * @param sha - The commit under review.
 * @returns A commit or ref to diff from.
 */
export async function reviewBase(
  run: ProcessRunner,
  checkout: string,
  sha: string
): Promise<string> {
  const branch = await defaultBranch(run, checkout);
  try {
    const result = await run('git', ['merge-base', `origin/${branch}`, sha], { cwd: checkout });
    if (result.code === 0 && result.stdout.trim() !== '') return result.stdout.trim();
  } catch {
    // fall through
  }
  return `origin/${branch}`;
}
