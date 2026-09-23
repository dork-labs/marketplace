/**
 * Bump-on-change: every package whose files changed must raise its version.
 *
 * Claude Code resolves a plugin's version as `plugin.json`'s `version`, else the
 * marketplace entry's, else the commit SHA. Once a package declares a version,
 * a commit that leaves it alone never reaches anyone: installs compare versions,
 * see nothing new, and keep the old files. DorkOS resolves "latest" the same
 * way. So a change to a package has to come with a higher version.
 *
 * Packages are identified by their `.claude-plugin/marketplace.json` entry name,
 * the name people install. A directory move whose entry keeps its name is one
 * package; a changed entry name is a new package plus a deleted one, which is
 * exactly what anyone who installed it sees.
 *
 * Every git call goes through `execFileSync` with an argv array, never a shell.
 *
 * @module bump
 */

import { execFileSync } from 'node:child_process';
import semver from 'semver';
import {
  PLUGINS_DIR,
  collectPackageVersions,
  declaredVersionOf,
  type ReadRepoFile,
} from './versions.ts';

/** One package whose change broke the bump rule, or an informational note. */
export interface BumpFinding {
  /** The package's marketplace entry name (its install identity). */
  pkg: string;
  /** What happened and why it matters, in plain words. */
  message: string;
  /** `error` fails CI; `note` is printed only (the no-version exemption). */
  level: 'error' | 'note';
}

/** Why a version has to go up, said once and the same way in every failure. */
const REASON = 'Claude Code and DorkOS only deliver a change to people when the version goes up.';

const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';

/**
 * Run git in `repoRoot` and return its stdout.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param args - Arguments after `git -C <repoRoot>`.
 */
function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * A reader over one git revision; undefined when the path does not exist there.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param rev - Any revision git understands.
 */
function readerAt(repoRoot: string, rev: string): ReadRepoFile {
  return (relPath) => {
    try {
      return git(repoRoot, ['show', `${rev}:${relPath}`]);
    } catch {
      return undefined;
    }
  };
}

/**
 * Whether a directory exists at a revision.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param rev - Any revision git understands.
 * @param dir - Repo-relative directory.
 */
function dirExistsAt(repoRoot: string, rev: string, dir: string): boolean {
  try {
    git(repoRoot, ['cat-file', '-e', `${rev}:${dir}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a relative `source` to a repo-relative directory: `./plugins/a/`
 * becomes `plugins/a`.
 *
 * @param source - A marketplace entry's string `source`.
 */
function normalizeSource(source: string): string {
  return source.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/**
 * The marketplace entries at one revision whose `source` is a relative path, as
 * a map from entry name to directory. Remote (object) sources are skipped: their
 * files live in another repository.
 *
 * @param read - A reader over the revision.
 */
function entriesAt(read: ReadRepoFile): Map<string, string> {
  const entries = new Map<string, string>();
  const raw = read(MARKETPLACE_FILE);
  if (raw === undefined) return entries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries;
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return entries;
  for (const entry of plugins) {
    const { name, source } = (entry ?? {}) as { name?: unknown; source?: unknown };
    if (typeof name !== 'string' || typeof source !== 'string') continue;
    entries.set(name, normalizeSource(source));
  }
  return entries;
}

/**
 * The package directories (`plugins/<dir>`) touched between the merge base of
 * `base` and `head`, and `head`. Three-dot, so commits that landed on the base
 * branch after this branch forked never count.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param base - The base revision.
 * @param head - The head revision.
 */
function changedPackageDirs(repoRoot: string, base: string, head: string): Set<string> {
  const out = git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', `${base}...${head}`]);
  const dirs = new Set<string>();
  for (const file of out.split('\0')) {
    const parts = file.split('/');
    if (parts.length < 3 || parts[0] !== PLUGINS_DIR) continue;
    dirs.add(`${PLUGINS_DIR}/${parts[1]}`);
  }
  return dirs;
}

/**
 * Compare every package changed between `base` and `head` in the git repo at
 * `repoRoot`.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param base - The revision the change is measured from (a PR's base, or the
 *   commit before a push).
 * @param head - The revision holding the change.
 * @returns One finding per changed package that failed the rule (`error`) or is
 *   exempt from it (`note`); packages that passed are not listed.
 */
export function checkVersionBumps(repoRoot: string, base: string, head: string): BumpFinding[] {
  const changedDirs = changedPackageDirs(repoRoot, base, head);
  if (changedDirs.size === 0) return [];

  const readBase = readerAt(repoRoot, base);
  const readHead = readerAt(repoRoot, head);
  const baseEntries = entriesAt(readBase);
  const headEntries = entriesAt(readHead);

  // Every changed directory resolves to the entry name(s) pointing at it at
  // either revision; a directory neither revision lists falls back to its name.
  const dirsByName = new Map<string, { baseDir?: string; headDir?: string }>();
  const nameFor = (entries: Map<string, string>, dir: string) =>
    [...entries].filter(([, d]) => d === dir).map(([name]) => name);
  for (const dir of changedDirs) {
    const names = new Set([...nameFor(baseEntries, dir), ...nameFor(headEntries, dir)]);
    if (names.size > 0) {
      for (const name of names) {
        dirsByName.set(name, { baseDir: baseEntries.get(name), headDir: headEntries.get(name) });
      }
      continue;
    }
    const name = dir.slice(PLUGINS_DIR.length + 1);
    if (dirsByName.has(name)) continue;
    dirsByName.set(name, {
      baseDir: dirExistsAt(repoRoot, base, dir) ? dir : undefined,
      headDir: dirExistsAt(repoRoot, head, dir) ? dir : undefined,
    });
  }

  const findings: BumpFinding[] = [];
  for (const [pkg, { baseDir, headDir }] of [...dirsByName].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    // A new package has nothing to bump past; a deleted one has nothing to raise.
    if (baseDir === undefined || headDir === undefined) continue;

    const before = declaredVersionOf(collectPackageVersions(readBase, baseDir));
    const after = declaredVersionOf(collectPackageVersions(readHead, headDir));

    if (before === undefined && after === undefined) {
      findings.push({
        pkg,
        level: 'note',
        message: `${pkg} declares no version, so Claude Code serves it by commit and every change already reaches people. Declare a version to opt in to version-based updates.`,
      });
      continue;
    }
    if (before === undefined) continue; // Declaring a first version opts in.
    if (after === undefined) {
      findings.push({
        pkg,
        level: 'error',
        message: `${pkg}: its version (${before}) was removed. ${REASON}`,
      });
      continue;
    }

    const invalid = [before, after].find((v) => semver.valid(v) === null);
    if (invalid !== undefined) {
      findings.push({
        pkg,
        level: 'error',
        message: `${pkg}: version "${invalid}" is not semver, so the bump can't be checked. ${REASON}`,
      });
      continue;
    }
    if (before === after || semver.eq(before, after)) {
      findings.push({
        pkg,
        level: 'error',
        message: `${pkg} changed but its version stayed ${before}. ${REASON}`,
      });
      continue;
    }
    if (!semver.gt(after, before)) {
      findings.push({
        pkg,
        level: 'error',
        message: `${pkg}: its version went down from ${before} to ${after}. ${REASON}`,
      });
    }
  }
  return findings;
}
