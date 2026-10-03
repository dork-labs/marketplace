/**
 * The dashboard's Issues page (spec "Flow Dashboard", M1) at `/x/flow/issues`:
 * every open item of the project's tracker team and every open issue of its
 * repositories, with each source's age and error above them. The filters
 * (team, repository, state, waiting on you) live in the page's address.
 *
 * @module @dorkos/flow/extension/ui/dashboard/issues-page
 */

import type { DashboardIssue, IssueState } from '../../lib/dashboard/types.ts';
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

/** Each state's words. */
export const ISSUE_STATE_TEXT: Readonly<Record<IssueState, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  'in-progress': 'In progress',
};

/** Said when no issue is open, or none passes the filters. */
export const NO_ISSUES_TEXT = 'Nothing open here.';

/**
 * The issues the filters keep.
 *
 * @param items - Every issue.
 * @param filters - The page's filters.
 * @returns The issues shown.
 */
export function filterIssues(
  items: readonly DashboardIssue[],
  filters: DashboardFilters
): DashboardIssue[] {
  return items.filter(
    (item) =>
      (filters.team === null || item.team === filters.team) &&
      (filters.repo === null || item.repo === filters.repo) &&
      (filters.state === null || item.state === filters.state) &&
      (!filters.mine || item.waitingOnYou)
  );
}

/** One issue's row. */
function IssueRow(props: { item: DashboardIssue; now: Date }): Node {
  const { item } = props;
  const facts = [
    item.stateName || ISSUE_STATE_TEXT[item.state],
    item.assignee === null ? null : `assigned to ${item.assignee}`,
    item.createdAt === null ? null : `opened ${agoText(item.createdAt, props.now)}`,
  ].filter((fact): fact is string => fact !== null);
  return h(
    'div',
    { className: 'flow-drow', style: BAND_ROW },
    h(OutLink, { href: item.url, text: item.key, style: { flex: 'none', width: '130px' } }),
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { overflowWrap: 'anywhere' } }, item.title),
      h('p', { style: MUTED }, facts.join(' · '))
    ),
    item.waitingOnYou ? h(Tag, { text: 'Waiting on you', strong: true }) : null
  );
}

/**
 * Build the Issues page.
 *
 * @param api - The host API.
 * @returns The page.
 */
export function createIssuesPage(api: Pick<ClientApi, 'navigate'>) {
  return function IssuesPage(props: ExtensionPageProps): Node {
    const filters = filtersFrom(props.search);
    const read = useDashboard<DashboardIssue>('issues', filters.project);
    const body = read.body;
    const controls =
      body === null
        ? undefined
        : [
            body.teams.length > 0
              ? h(FilterSelect, {
                  key: 'team',
                  label: 'Team',
                  all: 'All teams',
                  value: filters.team,
                  options: body.teams.map((team) => ({ value: team, text: team })),
                  onChange: (team) => props.setSearch({ team }),
                })
              : null,
            body.repos.length > 0
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
              options: (Object.keys(ISSUE_STATE_TEXT) as IssueState[]).map((state) => ({
                value: state,
                text: ISSUE_STATE_TEXT[state],
              })),
              onChange: (state) => props.setSearch({ state }),
            }),
            h(MineToggle, {
              key: 'mine',
              on: filters.mine,
              onChange: (on) => props.setSearch({ mine: on ? '1' : null }),
            }),
          ];
    return h(DashboardFrame<DashboardIssue>, {
      kind: 'issues',
      read,
      api,
      page: props,
      filters: controls,
      children: (loaded) => {
        const shown = filterIssues(loaded.items, filters);
        const now = new Date();
        return h(
          'section',
          { 'aria-label': 'Issues' },
          bandTitle('Open', shown.length),
          shown.length === 0
            ? h('p', { style: MUTED }, NO_ISSUES_TEXT)
            : shown.map((item) => h(IssueRow, { key: item.id, item, now }))
        );
      },
    });
  };
}
