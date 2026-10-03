/**
 * The dashboard's Releases page (spec "Flow Dashboard", M1) at
 * `/x/flow/releases`: each product's last release and newest tag, the version
 * in its checkout, how many changes wait to be released, the checks on its
 * default branch and the latest run of each workflow it watches. Read only:
 * this version never starts a release. The repository filter lives in the
 * page's address.
 *
 * @module @dorkos/flow/extension/ui/dashboard/releases-page
 */

import type { DashboardRelease, WatchedWorkflow } from '../../lib/dashboard/types.ts';
import type { ClientApi, ExtensionPageProps } from '../../lib/host-types.ts';
import { BAND_ROW } from '../page-parts.ts';
import { MUTED } from '../parts.ts';
import { h, type Node } from '../react.ts';
import { ALERT } from '../styles.ts';
import {
  DashboardFrame,
  FilterSelect,
  OutLink,
  agoText,
  bandTitle,
  filtersFrom,
  useDashboard,
} from './parts.ts';

/** Said when the block lists no product. */
export const NO_PRODUCTS_TEXT = 'No products listed in this dashboard.';

/** A checks state's words. */
const CHECKS_TEXT: Readonly<Record<DashboardRelease['ci']['state'], string>> = {
  passing: 'checks passing',
  failing: 'checks failing',
  pending: 'checks running',
  none: 'no checks',
};

/** A workflow state's words. */
const WORKFLOW_TEXT: Readonly<Record<WatchedWorkflow['state'], string>> = {
  passing: 'passed',
  failing: 'failed',
  running: 'running',
  never: 'never ran',
  error: "couldn't read",
};

/**
 * How many changes wait, in words.
 *
 * @param release - The product's release state.
 * @returns "3 changes not released yet", "Nothing waiting to release", or why it cannot be counted.
 */
export function unreleasedText(release: DashboardRelease): string {
  if (release.unreleased === null) return release.unreleasedNote ?? '';
  if (release.unreleased === 0) return 'Nothing waiting to release';
  return `${release.unreleased} change${release.unreleased === 1 ? '' : 's'} not released yet`;
}

/** One product's block. */
function ReleaseRow(props: { release: DashboardRelease; now: Date }): Node {
  const { release, now } = props;
  const last = release.lastRelease;
  const lines: Node[] = [
    h(
      'p',
      { key: 'release', style: { margin: 0 } },
      last === null
        ? 'No release yet'
        : [
            h(OutLink, { key: 'tag', href: last.url, text: last.tag }),
            last.publishedAt === null ? null : ` · released ${agoText(last.publishedAt, now)}`,
          ]
    ),
  ];
  if (release.lastTag !== null && release.lastTag !== last?.tag) {
    lines.push(h('p', { key: 'tag', style: MUTED }, `Newest tag: ${release.lastTag}`));
  }
  if (release.fileVersion !== null) {
    lines.push(h('p', { key: 'file', style: MUTED }, `This checkout says ${release.fileVersion}`));
  }
  lines.push(h('p', { key: 'unreleased', style: MUTED }, unreleasedText(release)));
  lines.push(
    h(
      'p',
      { key: 'ci', style: MUTED },
      `${release.ci.branch ?? 'Default branch'}: ${CHECKS_TEXT[release.ci.state]}`
    )
  );
  for (const workflow of release.workflows) {
    lines.push(
      h(
        'p',
        {
          key: `wf:${workflow.name}`,
          style: workflow.state === 'error' ? { ...MUTED, color: ALERT.color } : MUTED,
        },
        h(OutLink, { href: workflow.url, text: workflow.name }),
        `: ${WORKFLOW_TEXT[workflow.state]}`,
        workflow.at === null ? '' : ` · ${agoText(workflow.at, now)}`,
        workflow.error === null ? '' : ` · ${workflow.error}`
      )
    );
  }
  return h(
    'div',
    { className: 'flow-drow', style: BAND_ROW },
    h(
      'div',
      { className: 'flow-pcol' },
      h('div', { style: { fontWeight: 600 } }, release.id),
      h('p', { style: MUTED }, release.repo)
    ),
    h('div', { style: { flex: 1, minWidth: 0 } }, ...lines)
  );
}

/**
 * Build the Releases page.
 *
 * @param api - The host API.
 * @returns The page.
 */
export function createReleasesPage(api: Pick<ClientApi, 'navigate'>) {
  return function ReleasesPage(props: ExtensionPageProps): Node {
    const filters = filtersFrom(props.search);
    const read = useDashboard<DashboardRelease>('releases', filters.project);
    const body = read.body;
    const controls =
      body !== null && body.repos.length > 1
        ? [
            h(FilterSelect, {
              key: 'repo',
              label: 'Repository',
              all: 'All repositories',
              value: filters.repo,
              options: body.repos.map((repo) => ({ value: repo, text: repo })),
              onChange: (repo) => props.setSearch({ repo }),
            }),
          ]
        : undefined;
    return h(DashboardFrame<DashboardRelease>, {
      kind: 'releases',
      read,
      api,
      page: props,
      filters: controls,
      children: (loaded) => {
        const shown = loaded.items.filter(
          (release) => filters.repo === null || release.repo === filters.repo
        );
        const now = new Date();
        return h(
          'section',
          { 'aria-label': 'Releases' },
          bandTitle('Products', shown.length),
          shown.length === 0
            ? h('p', { style: MUTED }, NO_PRODUCTS_TEXT)
            : shown.map((release) => h(ReleaseRow, { key: release.id, release, now }))
        );
      },
    });
  };
}
