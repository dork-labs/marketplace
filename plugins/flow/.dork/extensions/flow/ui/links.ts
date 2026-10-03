/**
 * Where flow's pages live (spec `flow-multiproject` §4.1, N8), and where a
 * link goes on a DorkOS without pages (§10).
 *
 * DorkOS mounts an extension's pages at `/x/<extension id>/<path>`: Flow home
 * at `/x/flow`, a project's lens at `/x/flow/p/<name>`, its settings at
 * `/x/flow/p/<name>/settings`. A project's name is core's, URL-safe as given,
 * so it is only encoded, never rewritten.
 *
 * @module @dorkos/flow/extension/ui/links
 */

import type { ClientApi } from '../lib/host-types.ts';

/** Flow home. */
export const HOME_PATH = '/x/flow';

/** The page paths flow registers, relative to {@link HOME_PATH}. */
export const PAGE_PATHS = { home: '', project: 'p/:name', settings: 'p/:name/settings' } as const;

/** The dashboard's pages, relative to {@link HOME_PATH}. */
export const DASHBOARD_PATHS = { issues: 'issues', prs: 'prs', releases: 'releases' } as const;

/**
 * A dashboard page, for one project or the first with a dashboard.
 *
 * @param kind - The page.
 * @param project - Core's project name, or `null`.
 * @returns `/x/flow/<kind>`, with `?project=<name>` when one is named.
 */
export function dashboardPath(
  kind: keyof typeof DASHBOARD_PATHS,
  project: string | null = null
): string {
  const page = `${HOME_PATH}/${DASHBOARD_PATHS[kind]}`;
  return project === null ? page : `${page}?project=${encodeURIComponent(project)}`;
}

/** Settings → Flow, on a DorkOS without pages (the Settings tab is `flow:fleet`). */
export const SETTINGS_TAB_LINK = '?settings=flow:fleet';

/** DorkOS's Activity page, where flow's asks are answered. */
export const ACTIVITY_ROUTE = '/activity';

/**
 * Whether this DorkOS can show flow's pages.
 *
 * @param api - The host API.
 * @returns True when it has `registerPage`.
 */
export function hasPages(api: Pick<ClientApi, 'registerPage'>): boolean {
  return typeof api.registerPage === 'function';
}

/**
 * A project's lens page.
 *
 * @param name - Core's project name.
 * @returns `/x/flow/p/<name>`.
 */
export function projectPath(name: string): string {
  return `${HOME_PATH}/p/${encodeURIComponent(name)}`;
}

/**
 * A project's settings page.
 *
 * @param name - Core's project name.
 * @returns `/x/flow/p/<name>/settings`.
 */
export function settingsPath(name: string): string {
  return `${projectPath(name)}/settings`;
}

/**
 * A tracker link that is safe to open: an `http:` or `https:` address, or
 * `null` for anything else (a `javascript:` URL in a run record, say).
 *
 * @param url - The address, as recorded.
 * @returns The address, or `null`.
 */
export function webHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
