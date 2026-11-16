/**
 * DorkOS's account rules and projects, read by flow's server half for the
 * Flow screens (`GET /accounts/eligibility`, `GET /known-projects`). On DorkOS
 * client API version 2 a screen runs in its own frame and can call only
 * flow's routes, so the reads it used to make of DorkOS's own routes come
 * through here.
 *
 * **Read only.** Only a person changes which accounts may work where, so
 * nothing here writes, and flow has no route that does: the screens send the
 * person to Settings → Runtimes instead. The rules come from
 * `<dorkHome>/config.json`, the way the advisor and a terminal `flow drain`
 * read them (`scripts/fleet/project-eligibility.ts`, fleet contract 4.2.0).
 * DorkOS's own eligibility read is open to any caller too, so these routes
 * show nothing new.
 *
 * The answer has the shape of DorkOS's `AccountEligibilityResponse`, without
 * its `launch` block, which the screens never read.
 *
 * @module @dorkos/flow/extension/lib/account-rules
 */

import path from 'node:path';
import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  MAIN_ACCOUNT_ID,
  canonicalRoot,
  readProjectEligibilityRules,
} from '../../../../scripts/fleet/project-eligibility.ts';
import { isValidAccountId } from '../../../../scripts/fleet/usage-ledger.ts';
import { RouteError } from './fleet.ts';
import type { AccountSummary, ProjectInfo, ProjectRef } from './host-types.ts';

/** One Claude account as a project's rules see it (DorkOS `AccountEligibilityRow`). */
export interface AccountEligibilityRow {
  /** The registry id, or `default` for Main. */
  id: string;
  /** What the person calls it, or null. */
  label: string | null;
  /** Its dot's color. */
  color: string;
  /** True for Main when it has no registry row. */
  implicit: boolean;
  /** The projects it is kept to, or null for any project. */
  onlyProjects: ProjectRef[] | null;
  /** Whether its own rule lets it work here. */
  allowedByAccount: boolean;
  /** Whether the project's rule lets it work here. */
  allowedByProject: boolean;
  /** Whether it may work here. */
  eligible: boolean;
}

/** Every Claude account as one project sees it (DorkOS `AccountEligibilityResponse`). */
export interface AccountEligibility {
  /** The project, or null when none was asked about. */
  project: ProjectRef | null;
  /** The project's own allow list, or null for every account. */
  allow: string[] | null;
  /** Every Claude account, Main last when it has no row. */
  accounts: AccountEligibilityRow[];
}

/** A known project, with the repo it comes from (DorkOS `ProjectInfo`, trimmed). */
export interface CoreProject {
  /** Its main checkout. */
  root: string;
  /** Core's name for it. */
  name: string;
  /** `owner/name` from its origin, or null. */
  originRepo: string | null;
}

/** What the reads need. */
export interface AccountRulesDeps {
  /** The DorkOS home, which holds `config.json`. */
  dorkHome: string;
  /** DorkOS's accounts. */
  listAccounts: () => Promise<AccountSummary[]>;
  /** The projects flow knows, by root and name: the only ones a screen may ask about. */
  listProjects: () => Promise<ProjectRef[]>;
  /** Follows symlinks (tests stand in for the disk). */
  realpath?: (folder: string) => string;
}

/** Refused when a screen asks about a folder that is not one of flow's projects. */
export const UNKNOWN_PROJECT_TEXT =
  "Flow doesn't know that project, so it can't say which accounts may work there.";

/**
 * Every Claude account as one project's rules see it, or with no project,
 * each account's own rule alone.
 *
 * @param deps - Where the rules, accounts and projects come from.
 * @param project - A project's main checkout, as flow lists it, or undefined.
 * @returns DorkOS's rules for it.
 * @throws {RouteError} 404 when `project` is not one of flow's projects.
 */
export async function readEligibility(
  deps: AccountRulesDeps,
  project: string | undefined
): Promise<AccountEligibility> {
  const canonical = (root: string) => canonicalRoot(root, deps.realpath);
  const known = await deps.listProjects();
  const byRoot = new Map(known.map((entry) => [canonical(entry.root), entry]));
  let here: ProjectRef | null = null;
  if (project !== undefined) {
    const found = byRoot.get(canonical(project));
    if (found === undefined) throw new RouteError(404, UNKNOWN_PROJECT_TEXT);
    here = { root: found.root, name: found.name };
  }
  const rules = readProjectEligibilityRules(
    readJsonFile(path.join(deps.dorkHome, 'config.json')).value,
    deps.realpath
  );
  const hereRoot = here === null ? null : canonical(here.root);
  const listed = hereRoot === null ? undefined : rules.projectAllow.get(hereRoot);
  const allow = listed === undefined ? null : [...listed];
  const nameOf = (root: string): ProjectRef =>
    byRoot.get(root) ?? { root, name: path.basename(root) || root };
  const accounts = (await deps.listAccounts())
    .filter((account) => account.runtime === 'claude-code' && routable(account))
    .map((account): AccountEligibilityRow => {
      const own = rules.onlyProjects.get(account.id) ?? null;
      const allowedByAccount = own === null || (hereRoot !== null && own.includes(hereRoot));
      const allowedByProject = allow === null || allow.includes(account.id);
      return {
        id: account.id,
        label: account.label,
        color: account.color,
        implicit: account.implicit,
        onlyProjects: own === null ? null : own.map((root) => refOf(nameOf(root))),
        allowedByAccount,
        allowedByProject,
        eligible: allowedByAccount && allowedByProject,
      };
    });
  // Main last when it has no registry row, as DorkOS lists it.
  accounts.sort(
    (a, b) =>
      Number(a.id === MAIN_ACCOUNT_ID && a.implicit) -
      Number(b.id === MAIN_ACCOUNT_ID && b.implicit)
  );
  return { project: here, allow, accounts };
}

/** The id DorkOS reserves for DorkOS credits, never a registered row's (core `isReservedAccountId`). */
const CREDITS_ACCOUNT_ID = 'dorkos-credits';

/**
 * Whether DorkOS can launch the account, so its own eligibility read lists it:
 * Main, or a registered row whose id passes the id pattern and is not one
 * DorkOS reserves (`default`, `dorkos-credits`).
 */
function routable(account: AccountSummary): boolean {
  if (account.implicit) return account.id === MAIN_ACCOUNT_ID;
  return (
    account.id !== MAIN_ACCOUNT_ID && account.id !== CREDITS_ACCOUNT_ID && isValidAccountId(account.id)
  );
}

/** A project reference with only its root and name. */
function refOf(project: ProjectRef): ProjectRef {
  return { root: project.root, name: project.name };
}

/**
 * The projects DorkOS lists for flow, with the repo each comes from.
 *
 * @param list - DorkOS's project list (`ctx.projects.list`), or undefined on a host without it.
 * @returns The projects.
 */
export async function knownProjects(
  list: (() => Promise<ProjectInfo[]>) | undefined
): Promise<CoreProject[]> {
  if (list === undefined) return [];
  return (await list()).map((project) => ({
    root: project.root,
    name: project.name,
    originRepo: project.originRepo,
  }));
}
