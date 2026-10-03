/**
 * The dashboard's Pull requests page (spec "Flow Dashboard", M1) at
 * `/x/flow/prs`: every open PR of the project's repositories, with its
 * checks, its review, its place in the merge queue, the tracker items it
 * names and its age. The filters (repository, state, waiting on you) live in
 * the page's address.
 *
 * @module @dorkos/flow/extension/ui/dashboard/prs-page
 */

import type { DashboardPr } from '../../lib/dashboard/types.ts';
import type { ClientApi, ExtensionPageProps } from '../../lib/host-types.ts';
import { BAND_ROW } from '../page-parts.ts';
import { MUTED } from '../parts.ts';
import { h, type Node } from '../react.ts';
import {
  DashboardFrame,
  FilterSelect,
  MineToggle,
  OutLink,
  Tag,
  agoText,
  bandTitle,
  filtersFrom,
  useDashboard,
  type DashboardFilters,
} from './parts.ts';

/** The state filter's choices. */
export const PR_STATES = { ready: 'Ready', draft: 'Draft', queued: 'In merge queue' } as const;

/** Said when no PR is open, or none passes the filters. */
export const NO_PRS_TEXT = 'No open pull requests here.';

/**
 * The PRs the filters keep.
 *
 * @param items - Every PR.
 * @param filters - The page's filters.
 * @returns The PRs shown.
 */
export function filterPrs(items: readonly DashboardPr[], filters: DashboardFilters): DashboardPr[] {
  return items.filter(
    (pr) =>
      (filters.repo === null || pr.repo === filters.repo) &&
      (filters.state === null ||
        (filters.state === 'draft' && pr.draft) ||
        (filters.state === 'ready' && !pr.draft) ||
        (filters.state === 'queued' && pr.queue.queued)) &&
      (!filters.mine || pr.waitingOnYou)
  );
}

/**
 * A PR's checks in words: "Checks failing: test", "Checks running (2)",
 * "Checks passing", or `null` with no checks.
 *
 * @param checks - The PR's checks.
 * @returns The words, or `null`.
 */
export function checksText(checks: DashboardPr['checks']): string | null {
  if (checks.state === 'failing') {
    return `Checks failing: ${checks.failing.map((check) => check.name).join(', ')}`;
  }
  if (checks.state === 'pending') return `Checks running (${checks.pending})`;
  if (checks.state === 'passing') return 'Checks passing';
  return null;
}

/** A review state's words. */
const REVIEW_TEXT: Readonly<Record<DashboardPr['review'], string | null>> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review needed',
  none: null,
};

/**
 * A PR's place in the merge queue in words, or `null`.
 *
 * @param queue - The PR's queue state.
 * @returns "In merge queue (2nd)", "Auto-merge on", or `null`.
 */
export function queueText(queue: DashboardPr['queue']): string | null {
  if (queue.queued) {
    return queue.position === null ? 'In merge queue' : `In merge queue (#${queue.position})`;
  }
  return queue.armed ? 'Auto-merge on' : null;
}

/** One PR's row. */
function PrRow(props: { pr: DashboardPr; now: Date }): Node {
  const { pr } = props;
  const facts = [
    pr.author === null ? null : `by ${pr.author}`,
    pr.createdAt === null ? null : `opened ${agoText(pr.createdAt, props.now)}`,
    pr.linked.length === 0 ? null : pr.linked.join(', '),
  ].filter((fact): fact is string => fact !== null);
  const tags = [
    pr.draft ? h(Tag, { key: 'draft', text: 'Draft' }) : null,
    pr.reviewRequestedFromYou ? h(Tag, { key: 'asked', text: 'Your review', strong: true }) : null,
    pr.conflicting ? h(Tag, { key: 'conflict', text: 'Conflicts', strong: true }) : null,
  ];
  const state = [checksText(pr.checks), REVIEW_TEXT[pr.review], queueText(pr.queue)].filter(
    (fact): fact is string => fact !== null
  );
  return h(
    'div',
    { className: 'flow-drow', style: BAND_ROW },
    h(OutLink, {
      href: pr.url,
      text: `${pr.repo}#${pr.number}`,
      style: { flex: 'none', width: '130px', overflowWrap: 'anywhere' },
    }),
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { overflowWrap: 'anywhere' } }, pr.title),
      h('p', { style: MUTED }, facts.join(' · ')),
      state.length === 0 ? null : h('p', { style: MUTED }, state.join(' · '))
    ),
    h('span', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, ...tags)
  );
}

/**
 * Build the Pull requests page.
 *
 * @param api - The host API.
 * @returns The page.
 */
export function createPrsPage(api: Pick<ClientApi, 'navigate'>) {
  return function PrsPage(props: ExtensionPageProps): Node {
    const filters = filtersFrom(props.search);
    const read = useDashboard<DashboardPr>('prs', filters.project);
    const body = read.body;
    const controls =
      body === null
        ? undefined
        : [
            body.repos.length > 1
              ? h(FilterSelect, {
                  key: 'repo',
                  label: 'Repository',
                  all: 'All repositories',
                  value: filters.repo,
                  options: body.repos.map((repo) => ({ value: repo, text: repo })),
                  onChange: (repo) => props.setSearch({ repo }),
                })
              : null,
            h(FilterSelect, {
              key: 'state',
              label: 'State',
              all: 'Any state',
              value: filters.state,
              options: (Object.keys(PR_STATES) as (keyof typeof PR_STATES)[]).map((state) => ({
                value: state,
                text: PR_STATES[state],
              })),
              onChange: (state) => props.setSearch({ state }),
            }),
            h(MineToggle, {
              key: 'mine',
              on: filters.mine,
              onChange: (on) => props.setSearch({ mine: on ? '1' : null }),
            }),
          ];
    return h(DashboardFrame<DashboardPr>, {
      kind: 'prs',
      read,
      api,
      page: props,
      filters: controls,
      children: (loaded) => {
        const shown = filterPrs(loaded.items, filters);
        const now = new Date();
        return h(
          'section',
          { 'aria-label': 'Pull requests' },
          bandTitle('Open', shown.length),
          shown.length === 0
            ? h('p', { style: MUTED }, NO_PRS_TEXT)
            : shown.map((pr) => h(PrRow, { key: pr.id, pr, now }))
        );
      },
    });
  };
}
