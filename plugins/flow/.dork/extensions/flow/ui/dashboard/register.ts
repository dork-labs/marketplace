/**
 * Registering the dashboard's pages (spec "Flow Dashboard", M1) beside Flow
 * home, and the links to them that Flow home shows.
 *
 * The pages are `/x/flow/issues`, `/x/flow/prs` and `/x/flow/releases`, each
 * for one project (`?project=`). They are registered on every DorkOS with
 * pages; a page a project switched off in its `views` says so. Flow home
 * links only to the pages some project has on, so a computer with no
 * dashboard sees no links at all.
 *
 * @module @dorkos/flow/extension/ui/dashboard/register
 */

import type { ComponentType } from 'react';
import type { DashboardIndex, DashboardKind } from '../../lib/dashboard/types.ts';
import type { ClientApi, ExtensionPageProps } from '../../lib/host-types.ts';
import { getDashboardIndex } from '../api.ts';
import { FlowIcon } from '../flow-icon.ts';
import { DASHBOARD_PATHS, dashboardPath } from '../links.ts';
import { LINK } from '../parts.ts';
import { h, useEffect, useState, type Node } from '../react.ts';
import { createIssuesPage } from './issues-page.ts';
import { PAGE_TITLES } from './parts.ts';
import { createPrsPage } from './prs-page.ts';
import { createReleasesPage } from './releases-page.ts';

/** How long Flow home reuses its read of which pages are on, in ms. */
export const LINKS_REUSE_MS = 60_000;

/** The last read of which pages are on. */
let lastIndex: { at: number; index: DashboardIndex } | null = null;

/** Forget the last read (tests). */
export function forgetDashboardLinks(): void {
  lastIndex = null;
}

/**
 * The pages to link to: each page some project with a dashboard has on, in
 * page order, read leniently (an answer of another shape links nothing).
 *
 * @param index - The `GET /dashboard` body.
 * @param project - Only this project's pages, or `null` for any project's.
 * @returns The pages.
 */
export function linkedPages(index: unknown, project: string | null): DashboardKind[] {
  const projects =
    typeof index === 'object' && index !== null && Array.isArray((index as DashboardIndex).projects)
      ? (index as DashboardIndex).projects
      : [];
  const on = new Set<string>();
  for (const entry of projects) {
    if (entry?.configured !== true || !Array.isArray(entry.views)) continue;
    if (project !== null && entry.name !== project) continue;
    for (const view of entry.views) on.add(view);
  }
  return (Object.keys(DASHBOARD_PATHS) as DashboardKind[]).filter((kind) => on.has(kind));
}

/**
 * Flow home's links to the dashboard pages that are on.
 *
 * @param props - The host API, and the project Flow home narrows to.
 * @returns The links, or nothing when no page is on.
 */
export function DashboardLinks(props: {
  api: Pick<ClientApi, 'navigate'>;
  project: string | null;
}): Node {
  const reusable = () =>
    lastIndex !== null && Date.now() - lastIndex.at < LINKS_REUSE_MS ? lastIndex.index : null;
  const [index, setIndex] = useState<DashboardIndex | null>(reusable);
  useEffect(() => {
    if (reusable() !== null) return;
    let live = true;
    getDashboardIndex().then(
      (next) => {
        lastIndex = { at: Date.now(), index: next };
        if (live) setIndex(next);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);
  const pages = linkedPages(index, props.project);
  if (pages.length === 0) return null;
  return h(
    'nav',
    {
      'aria-label': 'Dashboard',
      style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' },
    },
    ...pages.map((kind) =>
      h(
        'button',
        {
          key: kind,
          type: 'button',
          style: LINK,
          onClick: () => props.api.navigate(dashboardPath(kind, props.project)),
        },
        `${PAGE_TITLES[kind]} →`
      )
    )
  );
}

/**
 * Register the Issues, Pull requests and Releases pages where DorkOS has
 * pages. None is listed in the palette or the phone menu: Flow home links to them.
 *
 * @param api - The host API.
 * @returns A function that removes them.
 */
export function registerDashboardPages(
  api: Pick<ClientApi, 'registerPage' | 'navigate'>
): () => void {
  const registerPage = api.registerPage;
  if (typeof registerPage !== 'function') return () => {};
  const pages: [DashboardKind, ComponentType<ExtensionPageProps>][] = [
    ['issues', createIssuesPage(api) as ComponentType<ExtensionPageProps>],
    ['prs', createPrsPage(api) as ComponentType<ExtensionPageProps>],
    ['releases', createReleasesPage(api) as ComponentType<ExtensionPageProps>],
  ];
  const removers = pages.map(([kind, page]) =>
    registerPage.call(api, DASHBOARD_PATHS[kind], page, {
      title: `Flow ${PAGE_TITLES[kind].toLowerCase()}`,
      icon: FlowIcon,
      menu: false,
    })
  );
  return () => {
    for (const remove of removers) remove();
  };
}
