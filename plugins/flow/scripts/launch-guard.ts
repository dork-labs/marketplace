/**
 * The check a verb runs before it starts unattended sessions (`drain`,
 * `handoff`, `report … review-launch`; DOR-3062): the settings and the tracker
 * adapter those sessions act on must be what the project committed.
 *
 * Three commands may edit the project without asking. A steered agent in one
 * of them could plant adapter code or change `config.json`, and the next
 * unattended run would act on it. So:
 *
 * - `config.json` must be tracked by git and unchanged from HEAD.
 * - A project's own adapter folder must hold only tracked, unchanged files
 *   (ignored files count as changes: the adapter could load one), and nothing
 *   in it may be a link that leaves the checkout.
 * - An adapter counts as flow's own (shipped, or still inside the plugin) only
 *   when its real path is under the plugin's real path, never by its name.
 *
 * git runs with hooks, fsmonitor and signature programs switched off, so
 * repo-local config cannot name a program for these checks to run.
 *
 * @module @dorkos/flow/launch-guard
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { PreconditionError } from './errors.ts';

/** git with nothing repo-local able to name a program. */
const SAFE_GIT = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=false',
];

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 15_000;

/** git's exit code and output, without throwing. */
function git(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('git', [...SAFE_GIT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    });
    return { code: 0, out };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return { code: typeof status === 'number' ? status : 128, out: '' };
  }
}

/** Whether `child` is `parent` or inside it (both real paths). */
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A real path, or null when it does not resolve. */
function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** The checkout a file is in (git's top level from its folder), or null. */
function checkoutOf(file: string): string | null {
  const top = git(path.dirname(file), ['rev-parse', '--show-toplevel']);
  return top.code === 0 ? real(top.out.trim()) : null;
}

/** Refuse unless git tracks `target` (a file or folder) and it matches HEAD. */
function requireCommitted(top: string, target: string, what: string, fix: string): void {
  const rel = path.relative(top, target);
  if (git(top, ['ls-files', '--error-unmatch', '--', rel]).code !== 0) {
    throw new PreconditionError(`${what} at ${target} is not committed; ${fix}`);
  }
  if (git(top, ['diff', '--quiet', 'HEAD', '--', rel]).code !== 0) {
    throw new PreconditionError(`${what} at ${target} has changes that are not committed; ${fix}`);
  }
  const extra = git(top, ['ls-files', '--others', '--', rel]);
  if (extra.code !== 0 || extra.out.trim() !== '') {
    throw new PreconditionError(
      `${what} at ${target} holds files git does not track (${extra.out.trim().split('\n')[0] || 'unknown'}); ${fix}`
    );
  }
}

/** Every entry under a folder, refusing a link whose target leaves `top`. */
function requireNoLinksOut(folder: string, top: string, what: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) {
        const target = real(entry);
        if (target === null || !inside(top, target)) {
          throw new PreconditionError(
            `${what} has a link that leaves the project (${entry}); flow will not start sessions that would run it`
          );
        }
      } else if (stat.isDirectory()) {
        walk(entry);
      }
    }
  };
  walk(folder);
}

/**
 * Refuse to start sessions unless the settings and adapter are committed.
 *
 * @param opts.committedConfig - The `config.json` flow read, or null.
 * @param opts.adapterPath - The adapter's `SKILL.md` flow resolved, or null.
 * @param opts.flowRoot - The plugin's root.
 * @throws {PreconditionError} Naming the file and the fix.
 */
export function assertLaunchable(opts: {
  committedConfig: string | null;
  adapterPath: string | null;
  flowRoot: string;
}): void {
  const { committedConfig, adapterPath, flowRoot } = opts;
  const commitFix = 'commit it (or undo the change) before flow starts unattended sessions';

  if (committedConfig !== null) {
    const top = checkoutOf(committedConfig);
    if (top === null) {
      throw new PreconditionError(
        `${committedConfig} is not in a git checkout; flow starts unattended sessions only from one`
      );
    }
    requireCommitted(top, committedConfig, "flow's settings (config.json)", commitFix);
  }

  if (adapterPath === null) return;
  const folder = real(path.dirname(adapterPath));
  const pluginRoot = real(flowRoot);
  if (folder === null) throw new PreconditionError(`the adapter folder for ${adapterPath} is gone`);
  if (pluginRoot !== null && inside(pluginRoot, folder)) return; // flow's own adapter
  const top = checkoutOf(adapterPath);
  if (top === null || !inside(top, folder)) {
    throw new PreconditionError(
      `the tracker adapter at ${folder} is neither flow's own nor inside the project; flow will not start sessions that would run it`
    );
  }
  requireNoLinksOut(folder, top, `the tracker adapter at ${folder}`);
  requireCommitted(top, folder, 'the tracker adapter', commitFix);
}
