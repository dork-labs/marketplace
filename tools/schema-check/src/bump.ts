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
 * exactly what anyone who installed it sees. When an entry is missing at one
 * commit but its directory is still there and unclaimed (an entry dropped, a
 * folder newly listed, an unreadable `marketplace.json`), the package is
 * compared by directory instead. A directory no entry lists is judged by its
 * `plugins/<dir>` folder, under that path as its name.
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
 * Resolve a revision to a commit SHA, refusing anything that is not one. The
 * revision is never handed to git where it could be read as an option.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param rev - The revision the caller named.
 * @throws When `rev` is not a commit in this repository.
 */
function resolveCommit(repoRoot: string, rev: string): string {
  // `--end-of-options` makes git read even `--output=<file>` as a revision name.
  const refused = new Error(`"${rev}" is not a commit in this repository.`);
  try {
    return git(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${rev}^{commit}`,
    ]).trim();
  } catch {
    throw refused;
  }
}

/**
 * The files under `plugins/` touched between the merge base of `base` and
 * `head`, and `head`. Three-dot, so commits that landed on the base branch after
 * this branch forked never count.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param base - The base commit.
 * @param head - The head commit.
 */
function changedPluginFiles(repoRoot: string, base: string, head: string): string[] {
  const out = git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', `${base}...${head}`]);
  return out.split('\0').filter((file) => file.startsWith(`${PLUGINS_DIR}/`));
}

/**
 * The entry whose source directory holds `file`, the deepest one when sources
 * nest.
 *
 * @param entries - Entry name to source directory, at one revision.
 * @param file - A repo-relative file path.
 */
function ownerOf(entries: Map<string, string>, file: string): string | undefined {
  let owner: string | undefined;
  let depth = -1;
  for (const [name, dir] of entries) {
    if (file.startsWith(`${dir}/`) && dir.length > depth) {
      owner = name;
      depth = dir.length;
    }
  }
  return owner;
}

/** Whether any entry points at `dir`. */
function lists(entries: Map<string, string>, dir: string): boolean {
  return [...entries.values()].includes(dir);
}

/** One package to judge: how it is named, and where it lives at each revision. */
interface ChangedPackage {
  pkg: string;
  baseDir?: string;
  headDir?: string;
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
 * @throws When `base` or `head` is not a commit in the repository.
 */
export function checkVersionBumps(repoRoot: string, base: string, head: string): BumpFinding[] {
  const baseSha = resolveCommit(repoRoot, base);
  const headSha = resolveCommit(repoRoot, head);
  const files = changedPluginFiles(repoRoot, baseSha, headSha);
  if (files.length === 0) return [];

  const readBase = readerAt(repoRoot, baseSha);
  const readHead = readerAt(repoRoot, headSha);
  const baseEntries = entriesAt(readBase);
  const headEntries = entriesAt(readHead);

  // A listed package is its entry name. Where its entry is missing at one
  // revision, it is new or deleted, unless its directory is still there and no
  // other entry claims it (an entry dropped, a folder newly listed, or an
  // unreadable marketplace.json): then it is compared by directory. A renamed
  // entry keeps its directory claimed, so it stays a new package plus a deleted one.
  const entryPackage = (name: string): ChangedPackage => {
    let baseDir = baseEntries.get(name);
    let headDir = headEntries.get(name);
    if (headDir === undefined && baseDir !== undefined && !lists(headEntries, baseDir)) {
      if (dirExistsAt(repoRoot, headSha, baseDir)) headDir = baseDir;
    }
    if (baseDir === undefined && headDir !== undefined && !lists(baseEntries, headDir)) {
      if (dirExistsAt(repoRoot, baseSha, headDir)) baseDir = headDir;
    }
    return { pkg: name, baseDir, headDir };
  };

  // Keyed by kind, so an unlisted folder can never be mistaken for an entry
  // that happens to share its name.
  const packages = new Map<string, ChangedPackage>();
  for (const file of files) {
    const owners = new Set(
      [ownerOf(baseEntries, file), ownerOf(headEntries, file)].filter(
        (name): name is string => name !== undefined
      )
    );
    for (const name of owners) {
      if (!packages.has(`entry:${name}`)) packages.set(`entry:${name}`, entryPackage(name));
    }
    if (owners.size > 0) continue;
    // Listed nowhere: judge it by its folder, `plugins/<dir>`.
    const dir = file.split('/').slice(0, 2).join('/');
    if (dir === file || packages.has(`dir:${dir}`)) continue;
    packages.set(`dir:${dir}`, {
      pkg: dir,
      baseDir: dirExistsAt(repoRoot, baseSha, dir) ? dir : undefined,
      headDir: dirExistsAt(repoRoot, headSha, dir) ? dir : undefined,
    });
  }

  const findings: BumpFinding[] = [];
  const sorted = [...packages.values()].sort((a, b) => a.pkg.localeCompare(b.pkg));
  for (const { pkg, baseDir, headDir } of sorted) {
    // A new package has nothing to bump past; a deleted one has nothing to raise.
    if (baseDir === undefined || headDir === undefined) continue;

    const headVersions = collectPackageVersions(readHead, headDir);
    const broken = (headVersions.unreadable ?? []).find(
      (file) =>
        file.endsWith('/.claude-plugin/plugin.json') || file.endsWith('/.dork/manifest.json')
    );
    if (broken !== undefined) {
      findings.push({
        pkg,
        level: 'error',
        message: `${pkg}: ${broken} is not valid JSON, so its version can't be read and the bump can't be checked. ${REASON}`,
      });
      continue;
    }

    // An unreadable file at base reads as "no version": fixing it is opting in.
    const before = declaredVersionOf(collectPackageVersions(readBase, baseDir));
    const after = declaredVersionOf(headVersions);
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
