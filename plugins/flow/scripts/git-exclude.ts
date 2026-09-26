/**
 * Keep flow's per-machine files out of git through the repository's
 * `info/exclude`: local to this clone, shared by every worktree (it lives in the
 * common git dir), and never committed. One helper, so the settings folders
 * (`config-files.ts`), the self-test results and the journal all add their lines
 * the same way.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/git-exclude
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Add each missing line to the repository's `info/exclude`, keeping its other
 * lines. Lines are compared trimmed; repeating a call changes nothing.
 *
 * @param cwd - Any folder inside the checkout.
 * @param lines - The exclude patterns to make present.
 * @returns The `info/exclude` path.
 * @throws When `cwd` is not inside a git checkout.
 */
export function addExcludeLines(cwd: string, lines: readonly string[]): string {
  let common: string;
  try {
    common = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();
  } catch {
    throw new Error(`${cwd} is not in a git checkout`);
  }
  const exclude = path.join(common, 'info', 'exclude');
  mkdirSync(path.dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line.trim()));
  if (missing.length > 0) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    writeFileSync(exclude, `${text}${separator}${missing.join('\n')}\n`);
  }
  return exclude;
}

/**
 * Make git ignore `relPath` (relative to `checkout`) by adding `pattern` to
 * `info/exclude`, unless git already ignores it. Does nothing outside a git
 * checkout or when git is missing.
 *
 * @param checkout - The checkout's top-level folder.
 * @param relPath - A path inside the checkout that must be ignored.
 * @param pattern - The exclude pattern to add when it is not.
 */
export function ensureIgnored(checkout: string, relPath: string, pattern: string): void {
  const probe = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: checkout });
  if (probe.status !== 1) return; // 0 = already ignored; anything else = not a repo, or no git
  addExcludeLines(checkout, [pattern]);
}
