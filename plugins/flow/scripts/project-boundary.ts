/**
 * Keep `--project` inside the checkout flow was started in (DOR-3377).
 *
 * `--project` picks the checkout whose config, run state and tracker adapter
 * code a verb uses, and a project's own adapter code is code flow runs. A
 * scheduled run may call `flow <verb>` without asking, so if `--project` could
 * name any folder, a run could load another checkout's adapter code: one the
 * schedule was never approved for. DorkOS's matcher refuses `--project` in a
 * scheduled run's allowed commands; this check makes flow refuse it on its own,
 * for every run, because nothing tells flow whether a schedule started it.
 *
 * The rule, after resolving every symlink:
 *
 * - Inside a git checkout, `--project` must be in the same checkout: its git top
 *   level must be the run folder's. A subfolder passes. Another checkout fails,
 *   and so do a symlink to one, a linked worktree and a submodule, which each
 *   have a top level of their own.
 * - Outside git, `--project` must be the run folder or inside it, and not inside
 *   a git checkout. Flow loads only its shipped adapters outside git (0.56.0),
 *   so this keeps a run from reaching into one that has adapter code.
 *
 * Git runs without the caller's `GIT_*` variables, so `GIT_DIR` or
 * `GIT_WORK_TREE` cannot make one checkout answer for another.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/project-boundary
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from './errors.ts';

/** A path with every symlink resolved, or the path made absolute when it does not exist. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** This process's environment without any `GIT_*` variable. */
function gitFreeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
  );
}

/**
 * The git top level `dir` is in, symlinks resolved, or `null` outside git.
 *
 * @param dir - Any folder.
 * @returns The checkout's real top level, or `null`.
 */
export function gitTopLevel(dir: string): string | null {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: gitFreeEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top === '' ? null : real(top);
  } catch {
    return null;
  }
}

/** Whether `child` is `parent` or inside it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuse a `--project` outside the checkout flow was started in.
 *
 * @param cwd - The folder flow was started in.
 * @param project - The `--project` value as given, relative to `cwd` or absolute.
 * @throws {UsageError} When `project` is outside `cwd`'s checkout (exit 2).
 */
export function assertProjectInRunCheckout(cwd: string, project: string): void {
  const runTop = gitTopLevel(cwd);
  const target = path.resolve(cwd, project);
  const targetTop = gitTopLevel(target);
  if (runTop !== null) {
    if (targetTop === runTop) return;
    throw new UsageError(
      `--project ${project} is outside this checkout (${runTop}); flow only acts for the checkout it runs in. Run flow from that project's own folder instead`
    );
  }
  if (targetTop === null && isWithin(real(target), real(cwd))) return;
  throw new UsageError(
    `--project ${project} is outside the folder flow runs in (${real(cwd)}); flow only acts for the folder it runs in. Run flow from that project's own folder instead`
  );
}
