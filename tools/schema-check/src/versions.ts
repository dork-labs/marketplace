/**
 * Version agreement: the third check behind `npm run check`.
 *
 * A package can state its version in up to three files: `.dork/manifest.json`
 * (what DorkOS reads), `.claude-plugin/plugin.json` (what Claude Code reads),
 * and a root `package.json`, whose `package-lock.json` has to follow it. Nothing used to compare them, and flow shipped with
 * its manifest saying 0.6.0 while Claude Code ran 0.7.2. DorkOS now rejects a
 * package whose manifest and `plugin.json` disagree (`VERSION_MISMATCH`); this
 * applies that rule here, at the source, before a package is ever published.
 *
 * The collector takes a reader rather than a directory so the bump-on-change
 * check (`bump.ts`) can run it against a git revision as well as the working
 * tree.
 *
 * @module versions
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from './validate.ts';

/** Directory holding every package in this marketplace. */
export const PLUGINS_DIR = 'plugins';

/** A version-bearing file inside one package, and the version it declares. */
export interface DeclaredVersionFile {
  /** Repo-relative path, e.g. `plugins/flow/.claude-plugin/plugin.json`. */
  file: string;
  /** The `version` string, or undefined when the file declares none. */
  version: string | undefined;
}

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadRepoFile = (relPath: string) => string | undefined;

/** The version files of one package directory. Missing files are omitted. */
export interface PackageVersions {
  /** `<dir>/.dork/manifest.json`, the version DorkOS reads. */
  manifest?: DeclaredVersionFile;
  /** `<dir>/.claude-plugin/plugin.json`, the version Claude Code reads. */
  plugin?: DeclaredVersionFile;
  /** `<dir>/package.json`, only at the package root and only when it has a string `version`. */
  packageJson?: DeclaredVersionFile;
  /**
   * `<dir>/package-lock.json`'s top-level `version`, only when `packageJson` is
   * collected: npm keeps the two in step, and a hand-edited `package.json` does not.
   */
  packageLock?: DeclaredVersionFile;
  /**
   * Repo-relative paths of version files that exist but are not valid JSON, so
   * their version can't be read. Such a file is otherwise treated as absent.
   */
  unreadable?: string[];
}

/** The version files, in the order they are reported. */
const VERSION_FILES = [
  { key: 'manifest', rel: '.dork/manifest.json' },
  { key: 'plugin', rel: '.claude-plugin/plugin.json' },
  { key: 'packageJson', rel: 'package.json' },
  { key: 'packageLock', rel: 'package-lock.json' },
] as const;

/**
 * Plugin directory names under `plugins/`, sorted.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function pluginDirs(repoRoot: string): string[] {
  const abs = path.join(repoRoot, PLUGINS_DIR);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A reader over the working tree at `repoRoot`.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function workingTreeReader(repoRoot: string): ReadRepoFile {
  return (relPath) => {
    const abs = path.join(repoRoot, relPath);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  };
}

/**
 * Collect the versions one package declares. Only the package's own root files
 * are read; a nested `package.json` (a test workspace, say) never is.
 *
 * @param read - Reads a repo-relative file, from the working tree or a git revision.
 * @param pkgDir - Repo-relative package directory, e.g. `plugins/flow`.
 */
export function collectPackageVersions(read: ReadRepoFile, pkgDir: string): PackageVersions {
  const result: PackageVersions = {};
  for (const { key, rel } of VERSION_FILES) {
    const file = path.posix.join(pkgDir, rel);
    // The lockfile only follows a package.json that is itself a declaration.
    if (key === 'packageLock' && result.packageJson === undefined) continue;
    const raw = read(file);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      (result.unreadable ??= []).push(file);
      continue;
    }
    const value =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).version
        : undefined;
    const version = typeof value === 'string' ? value : undefined;
    // A package.json (or lockfile) without a version is not a declaration.
    if ((key === 'packageJson' || key === 'packageLock') && version === undefined) continue;
    result[key] = { file, version };
  }
  return result;
}

/**
 * The version a package declares, in Claude Code's order: `plugin.json`, else
 * the manifest. A root `package.json` never decides it; it only has to agree.
 *
 * @param v - The package's collected version files.
 */
export function declaredVersionOf(v: PackageVersions): string | undefined {
  return v.plugin?.version ?? v.manifest?.version;
}

/**
 * Check that every package's version files agree.
 *
 * Fails a package when two declared versions differ, or when its manifest
 * declares a version and its `plugin.json` exists without one. A package with
 * no `plugin.json`, or with no version anywhere, passes.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns One finding per package that is wrong, keyed to the package directory
 *   (or, for an unparseable file, to that file). The CLI prints the key before
 *   the message, so the message itself does not repeat it.
 */
export function checkVersionAgreement(repoRoot: string): Finding[] {
  const read = workingTreeReader(repoRoot);
  const findings: Finding[] = [];

  for (const name of pluginDirs(repoRoot)) {
    const pkgDir = path.posix.join(PLUGINS_DIR, name);
    const versions = collectPackageVersions(read, pkgDir);

    // An unparseable manifest is already reported by validateManifests; report
    // the other two here so no broken file is reported twice or not at all.
    const unreadable = (versions.unreadable ?? []).filter(
      (file) => !file.endsWith('.dork/manifest.json')
    );
    for (const file of unreadable) {
      findings.push({ file, message: "Not valid JSON, so its version can't be read." });
    }

    const declared = VERSION_FILES.flatMap(({ key, rel }) => {
      const version = versions[key]?.version;
      return version === undefined ? [] : [{ rel, version }];
    });

    if (new Set(declared.map((d) => d.version)).size > 1) {
      const said = declared.map((d) => `${d.rel} says ${d.version}`).join(', ');
      findings.push({
        file: pkgDir,
        message: `Versions disagree: ${said}. Set every file to the same version.`,
      });
      continue;
    }

    const manifestVersion = versions.manifest?.version;
    if (manifestVersion !== undefined && versions.plugin && versions.plugin.version === undefined) {
      findings.push({
        file: pkgDir,
        message: `.dork/manifest.json says version ${manifestVersion} but .claude-plugin/plugin.json has no version. Add "version": "${manifestVersion}" to plugin.json so Claude Code and DorkOS agree.`,
      });
    }
  }

  return findings;
}
