/**
 * Which Claude Code accounts may work in which projects: DorkOS's rule, read
 * the way DorkOS reads it (fleet contract 4.2.0, `project-eligibility` cases;
 * spec `flow-multiproject` §8.6).
 *
 * DorkOS keeps two rules in `<dorkHome>/config.json` under
 * `runtimes.claudeCode`, and only a person changes them:
 *
 * - **The account's own rule.** `accounts[].onlyProjects` on a registered row,
 *   and `defaultAccountOnlyProjects` for Main (the id `default`, which has no
 *   row): a list of project roots, or null/absent for any project. A list never
 *   allows "no project", a folder in no git repository.
 * - **The project's rule.** `projectAccounts[<root>].allow`: the account ids
 *   that project may use. A project with no entry allows every account; "no
 *   project" has no project rule.
 *
 * An account may work in a project only when BOTH allow it; the account's rule
 * is checked first, so a refusal names the rule that refused. Roots compare
 * canonically, without a trailing separator and with symlinks resolved, on the
 * stored roots and the project's alike. A stored value of the wrong shape reads
 * as no rule: a reader never fails a launch over a hand edit.
 *
 * flow's own role for an account (`fleet.json`) still applies on top: an
 * account flow keeps out is never spent, whatever DorkOS allows. This module is
 * only DorkOS's half, so a terminal `flow drain` never spends an account
 * DorkOS would refuse in that project.
 *
 * Dependency-free (node builtins only), so the Flow extension may bundle it.
 *
 * @module @dorkos/flow/fleet/project-eligibility
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Main's id: this computer's own Claude sign-in, which has no registry row. */
export const MAIN_ACCOUNT_ID = 'default';

/** Why an account may not work in a project. */
export type IneligibleBecause = 'only-projects' | 'project-allowlist';

/** Whether an account may work in a project, and which rule refused it. */
export type ProjectEligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleBecause };

/** DorkOS's two rules, canonicalised once. */
export interface ProjectEligibilityRules {
  /** Each account's own list of project roots; an account absent here has no rule. */
  onlyProjects: ReadonlyMap<string, readonly string[]>;
  /** Each project's allow list, keyed by canonical root. */
  projectAllow: ReadonlyMap<string, readonly string[]>;
}

/** A path's real path; the default follows symlinks on disk. */
export type RealPath = (folder: string) => string;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follow symlinks on disk, or keep the path when it cannot be followed. */
function diskRealPath(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/**
 * A root the way DorkOS keys a project: normalised, without a trailing
 * separator (the filesystem root keeps its own), then through `realpath`.
 *
 * @param root - A stored or resolved project root.
 * @param realpath - Follows symlinks (default: the disk's).
 * @returns The canonical root.
 */
export function canonicalRoot(root: string, realpath: RealPath = diskRealPath): string {
  const normalised = path.normalize(root);
  const trimmed = normalised.replace(/[\\/]+$/, '');
  return realpath(trimmed === '' ? path.parse(normalised).root : trimmed);
}

/** A stored list of roots, canonical, or `null` for "no rule" (absent, null or the wrong shape). */
function rootList(value: unknown, realpath: RealPath): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    .map((entry) => canonicalRoot(entry, realpath));
}

/**
 * Read DorkOS's rules out of a parsed `config.json`.
 *
 * @param config - The parsed file, or `null`/`undefined` when there is none.
 * @param realpath - Follows symlinks (default: the disk's).
 * @returns The rules; an empty set of rules allows every account everywhere.
 */
export function readProjectEligibilityRules(
  config: unknown,
  realpath: RealPath = diskRealPath
): ProjectEligibilityRules {
  const onlyProjects = new Map<string, string[]>();
  const projectAllow = new Map<string, string[]>();
  const runtimes = isObject(config) ? config.runtimes : undefined;
  const section = isObject(runtimes) ? runtimes.claudeCode : undefined;
  if (!isObject(section)) return { onlyProjects, projectAllow };

  if (Array.isArray(section.accounts)) {
    const seen = new Set<string>();
    for (const row of section.accounts) {
      if (!isObject(row) || typeof row.id !== 'string' || row.id === '') continue;
      // The first row with an id is the one DorkOS reads.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const roots = rootList(row.onlyProjects, realpath);
      if (roots !== null) onlyProjects.set(row.id, roots);
    }
  }
  const mainRoots = rootList(section.defaultAccountOnlyProjects, realpath);
  if (mainRoots !== null) onlyProjects.set(MAIN_ACCOUNT_ID, mainRoots);

  if (isObject(section.projectAccounts)) {
    for (const [root, entry] of Object.entries(section.projectAccounts)) {
      if (!isObject(entry) || !Array.isArray(entry.allow)) continue;
      const allow = entry.allow.filter((id): id is string => typeof id === 'string');
      projectAllow.set(canonicalRoot(root, realpath), allow);
    }
  }
  return { onlyProjects, projectAllow };
}

/**
 * Whether an account may work in a project under DorkOS's rules.
 *
 * @param rules - The rules ({@link readProjectEligibilityRules}).
 * @param accountId - The Claude Code account id (`default` for Main).
 * @param projectRoot - The project's canonical root, or `null` for a folder in no project.
 * @returns Eligible, or the rule that refused it (the account's first).
 */
export function judgeProjectEligibility(
  rules: ProjectEligibilityRules,
  accountId: string,
  projectRoot: string | null
): ProjectEligibility {
  const only = rules.onlyProjects.get(accountId);
  if (only !== undefined && (projectRoot === null || !only.includes(projectRoot))) {
    return { eligible: false, reason: 'only-projects' };
  }
  if (projectRoot !== null) {
    const allow = rules.projectAllow.get(projectRoot);
    if (allow !== undefined && !allow.includes(accountId)) {
      return { eligible: false, reason: 'project-allowlist' };
    }
  }
  return { eligible: true };
}

/**
 * Whether an account may work in a project, straight from a parsed
 * `config.json` (the contract's `eligibility(config, account, projectRoot)`).
 *
 * @param config - The parsed `config.json`.
 * @param accountId - The Claude Code account id (`default` for Main).
 * @param projectRoot - The project's canonical root, or `null`.
 * @param realpath - Follows symlinks (default: the disk's).
 * @returns Eligible, or the rule that refused it.
 */
export function projectEligibility(
  config: unknown,
  accountId: string,
  projectRoot: string | null,
  realpath: RealPath = diskRealPath
): ProjectEligibility {
  return judgeProjectEligibility(
    readProjectEligibilityRules(config, realpath),
    accountId,
    projectRoot === null ? null : canonicalRoot(projectRoot, realpath)
  );
}

/** The project a launch is for, with DorkOS's rules read for it. */
export interface ProjectRule {
  /** The project's canonical root, or `null` for a folder in no project. */
  root: string | null;
  /** DorkOS's rules. */
  rules: ProjectEligibilityRules;
}
