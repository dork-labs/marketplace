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
 * It is checked twice: on `--project` before a verb starts, for a clear exit 2,
 * and on the checkout the adapter code is loaded from, just before the import.
 * Git runs without the caller's variables that redirect it (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_CONFIG*` and the like), here and when `config-files.ts`
 * finds the checkout, so they cannot make the two answers differ.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/project-boundary
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { ConfigError, UsageError } from './errors.ts';

/** A path with every symlink resolved, or the path made absolute when it does not exist. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The variables that point git at a repository, work tree or config other than
 * the one it would find from the folder. `GIT_CEILING_DIRECTORIES` and
 * `GIT_DISCOVERY_ACROSS_FILESYSTEM` stay: they only change how far up from the
 * folder git looks, so it still finds the folder's own repository or none.
 */
const REDIRECTING_GIT_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]);

/** Whether a variable redirects git: one of {@link REDIRECTING_GIT_VARS}, or any `GIT_CONFIG*`. */
function redirectsGit(name: string): boolean {
  const upper = name.toUpperCase();
  return REDIRECTING_GIT_VARS.has(upper) || upper.startsWith('GIT_CONFIG');
}

/**
 * This process's environment without the variables that redirect git, for
 * every git call that decides which checkout flow acts for.
 *
 * @returns A copy of `process.env` without them.
 */
export function gitFreeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !redirectsGit(name)));
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
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Refuse a `--project` outside the checkout flow was started in.
 *
 * @param cwd - The folder flow was started in.
 * @param project - The `--project` value as given, relative to `cwd` or absolute.
 * @throws {UsageError} When `project` is outside `cwd`'s checkout, or, inside
 *   one, does not exist (exit 2).
 */
export function assertProjectInRunCheckout(cwd: string, project: string): void {
  const target = path.resolve(cwd, project);
  const runTop = gitTopLevel(cwd);
  // Only `rev-parse` may ever run against a `--project` target: its own
  // `.git/config` still applies, and `rev-parse --show-toplevel` runs nothing it
  // names. Never `status`, `diff` or anything else that runs fsmonitor, filters
  // or hooks, which that config can point at any program.
  const targetTop = gitTopLevel(target);
  // Where to run flow instead: the target's checkout, or the folder itself
  // outside git. A plain path, printed as data, never quoted for a shell.
  const runFrom = targetTop ?? real(target);
  if (runTop !== null) {
    if (targetTop === runTop) return;
    // Git cannot place a missing folder, so say what is really wrong with a typo.
    if (!existsSync(target)) throw new UsageError(`--project ${project} does not exist`);
    throw new UsageError(
      `--project ${project} is outside this checkout (${runTop}); flow only acts for the checkout it runs in. Run flow from inside ${runFrom}`
    );
  }
  if (targetTop === null && isWithin(real(target), real(cwd))) return;
  throw new UsageError(
    `--project ${project} is outside the folder flow runs in (${real(cwd)}); flow only acts for the folder it runs in. Run flow from inside ${runFrom}`
  );
}

/**
 * Refuse to load a project's own adapter code from any checkout but the run's.
 *
 * @param runDir - The folder flow was started in.
 * @param checkout - The checkout the adapter code would be loaded for.
 * @throws {ConfigError} When `checkout` is not `runDir`'s git top level (exit 3).
 */
export function assertCheckoutIsRunCheckout(runDir: string, checkout: string): void {
  const runTop = gitTopLevel(runDir);
  if (runTop !== null && real(checkout) === runTop) return;
  throw new ConfigError(
    `flow loads a project's own adapter code only for the checkout it runs in, and ${checkout} is not ${runTop ?? runDir}`
  );
}
