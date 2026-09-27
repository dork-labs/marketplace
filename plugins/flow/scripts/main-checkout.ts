/**
 * The main checkout of a project (spec `flow-cli-core` §1.3): the parent of
 * `git rev-parse --git-common-dir`, so a linked worktree and the main checkout
 * name the same run store.
 *
 * Kept apart from `flow-state-file.ts` because that module loads zod through
 * the run-store schema, and the Flow extension's server half (bundled by
 * DorkOS, which installs no packages for it) must stay zod-free.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/main-checkout
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ConfigError } from './errors.ts';

/** Where the run store lives inside the main checkout: `.dork/flow/flow-state.json`. */
export const STATE_RELATIVE_PATH = path.join('.dork', 'flow', 'flow-state.json');

/**
 * The main checkout of the git checkout at `project`: the parent of
 * `git rev-parse --git-common-dir` (asked for as an absolute path, git 2.31 or
 * later, so a subfolder resolves the same as the checkout root). From a linked
 * worktree this is the main checkout, not the worktree.
 *
 * @param project - Any folder inside a git checkout (main or linked worktree).
 * @returns The absolute path of the main checkout.
 * @throws {ConfigError} When `project` is not inside a git checkout.
 */
export function resolveMainCheckout(project: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new ConfigError(
      `${project} is not inside a git checkout, so flow cannot find its run store. Run flow from the project's checkout or pass --project.`
    );
  }
  return path.dirname(path.resolve(project, commonDir));
}
