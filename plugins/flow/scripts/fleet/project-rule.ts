/**
 * The project a folder belongs to, with DorkOS's account rules for it (fleet
 * contract 4.2.0): what `flow next`, `flow drain` and the Flow extension's
 * advisor hand `rankAccounts`, so a terminal run never spends an account DorkOS
 * would refuse in that project.
 *
 * Kept apart from `project-eligibility.ts` so the pure rule stays free of git
 * and files. Dependency-free (node builtins and local zero-dependency modules).
 *
 * @module @dorkos/flow/fleet/project-rule
 */

import path from 'node:path';
import { readJsonFile } from '../atomic-json.ts';
import { canonicalProjectRoot } from '../main-checkout.ts';
import { readProjectEligibilityRules, type ProjectRule } from './project-eligibility.ts';

/** How long reading a folder's project root from git may take, in ms. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The project a folder belongs to, with DorkOS's rules read from
 * `<dorkHome>/config.json`: what `rankAccounts` needs to leave out an account
 * DorkOS would refuse there. A folder in no git repository is "no project"; a
 * missing or unreadable `config.json` has no rules.
 *
 * @param dorkHome - The DorkOS home.
 * @param folder - The folder the work runs in (any worktree or subfolder).
 * @returns The project and its rules.
 */
export function loadProjectRule(dorkHome: string, folder: string): ProjectRule {
  let root: string | null;
  try {
    root = canonicalProjectRoot(folder, { timeoutMs: GIT_TIMEOUT_MS });
  } catch {
    root = null;
  }
  const { value } = readJsonFile(path.join(dorkHome, 'config.json'));
  return { root, rules: readProjectEligibilityRules(value) };
}
