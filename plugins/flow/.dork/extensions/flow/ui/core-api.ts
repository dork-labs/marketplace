/**
 * The Flow tab's calls to DorkOS's own routes (not flow's), made from the
 * person's browser as that person (spec `flow-multiproject` §5.2, §8.4-§8.5):
 * switching a schedule back on, and the accounts each project may use. Only
 * a person changes which accounts may work where, so these writes exist only
 * here, never in flow's server half.
 *
 * @module @dorkos/flow/extension/ui/core-api
 */

import { resolveApiBaseUrl } from './api.ts';

/** What switching a schedule back on came to. */
export type EnableResult = 'on' | 'gone' | 'failed';

/**
 * Switch one DorkOS schedule back on (`PATCH /api/tasks/:id`), as the person
 * whose browser this is. A schedule someone deleted since is `gone`: there is
 * nothing left to switch on.
 *
 * @param id - The schedule's id.
 * @returns What happened.
 */
export async function enableSchedule(id: string): Promise<EnableResult> {
  try {
    const response = await fetch(`${resolveApiBaseUrl()}/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (response.ok) return 'on';
    return response.status === 404 ? 'gone' : 'failed';
  } catch {
    return 'failed';
  }
}

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
  onlyProjects: { root: string; name: string }[] | null;
  /** Whether its own rule lets it work here. */
  allowedByAccount: boolean;
  /** Whether the project's rule lets it work here. */
  allowedByProject: boolean;
  /** Whether it may work here. */
  eligible: boolean;
}

/** `GET /api/runtimes/claude-code/account-eligibility` (DorkOS `AccountEligibilityResponse`). */
export interface AccountEligibility {
  /** The project, or null for a folder in no project. */
  project: { root: string; name: string } | null;
  /** The project's own allow list, or null for every account. */
  allow: string[] | null;
  /** Every Claude account, Main last when it has no row. */
  accounts: AccountEligibilityRow[];
}

/** A known project (DorkOS `ProjectInfo`). */
export interface CoreProject {
  /** Its main checkout. */
  root: string;
  /** Core's name for it. */
  name: string;
  /** `owner/name` from its origin, or null. */
  originRepo: string | null;
}

/** Shown when DorkOS itself could not be reached. */
export const CORE_UNREACHABLE_MESSAGE = "DorkOS didn't respond, so nothing was changed. Try again.";

/** Shown when DorkOS refused a change it could not tell a person made, with no words of its own. */
export const CORE_PERSON_ONLY_MESSAGE = 'Only a person can change this.';

/** A refusal from one of DorkOS's own routes, in DorkOS's words. */
export class CoreRequestError extends Error {
  /** The HTTP status, or 0 when DorkOS could not be reached. */
  readonly status: number;
  /** DorkOS's code, when it gave one. */
  readonly code: string | null;

  /**
   * @param status - The HTTP status, or 0.
   * @param message - The words to show.
   * @param code - DorkOS's code.
   */
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'CoreRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Call one of DorkOS's routes as the person, and answer its body or throw its words. */
async function core<T>(method: 'GET' | 'PUT', route: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${resolveApiBaseUrl()}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CoreRequestError(0, CORE_UNREACHABLE_MESSAGE);
  }
  const json = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  if (response.ok) return json as T;
  const said = typeof json?.error === 'string' && json.error !== '' ? json.error : null;
  const code = typeof json?.code === 'string' ? json.code : null;
  if (response.status === 403) {
    throw new CoreRequestError(403, said ?? CORE_PERSON_ONLY_MESSAGE, code);
  }
  // DorkOS's own refusals (400, 404, 409) are plain words for a person; a 5xx is not.
  throw new CoreRequestError(
    response.status,
    response.status < 500 && said !== null ? said : CORE_UNREACHABLE_MESSAGE,
    code
  );
}

let eligibilityProbe: Promise<boolean> | null = null;

/**
 * Whether this DorkOS keeps account rules per project (the eligibility routes,
 * spec §10). Probed once per page load; a failed probe is tried again next time.
 *
 * @returns True when `GET /api/runtimes/claude-code/account-eligibility` answers.
 */
export function hasEligibilityRoutes(): Promise<boolean> {
  eligibilityProbe ??= fetch(`${resolveApiBaseUrl()}/runtimes/claude-code/account-eligibility`)
    .then((response) => {
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(String(response.status));
      return true;
    })
    .catch(() => {
      eligibilityProbe = null;
      return false;
    });
  return eligibilityProbe;
}

/** Forget the probe (tests). */
export function forgetEligibilityProbe(): void {
  eligibilityProbe = null;
}

/**
 * Every Claude account as a project's rules see it.
 *
 * @param project - Any folder in the project, or none for a folder in no project.
 * @returns DorkOS's answer.
 */
export function getEligibility(project?: string): Promise<AccountEligibility> {
  const query = project === undefined ? '' : `?project=${encodeURIComponent(project)}`;
  return core('GET', `/runtimes/claude-code/account-eligibility${query}`);
}

/**
 * Set which accounts a project may use (person only).
 *
 * @param project - Any folder in the project.
 * @param allow - The account ids, or null for every account.
 * @returns DorkOS's new answer for the project.
 */
export function putProjectAccounts(
  project: string,
  allow: string[] | null
): Promise<AccountEligibility> {
  return core('PUT', '/runtimes/claude-code/project-accounts', { project, allow });
}

/**
 * Keep an account to projects, or free it (person only).
 *
 * @param accountId - The account's id (`default` for Main).
 * @param projects - Folders of the projects, or null for any project.
 * @returns The projects it is now kept to.
 */
export function putOnlyProjects(
  accountId: string,
  projects: string[] | null
): Promise<{ onlyProjects: { root: string; name: string }[] | null }> {
  return core('PUT', `/runtimes/claude-code/accounts/${encodeURIComponent(accountId)}/only-projects`, {
    projects,
  });
}

/**
 * Every project DorkOS knows, with the repo it comes from.
 *
 * @returns The projects.
 */
export async function listCoreProjects(): Promise<CoreProject[]> {
  const body = await core<{ projects?: unknown }>('GET', '/projects');
  return Array.isArray(body?.projects) ? (body.projects as CoreProject[]) : [];
}
