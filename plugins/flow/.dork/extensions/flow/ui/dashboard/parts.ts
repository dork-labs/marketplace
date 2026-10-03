/**
 * What the dashboard's three pages share (spec "Flow Dashboard", M1): the read
 * of a page and its Refresh, the filters kept in the page's address, and the
 * frame: the way back to Flow home, the links between pages, the project
 * picker, each source's age and error, and what is wrong in the config.
 *
 * Every title and name read from a tracker or a repository is drawn as text,
 * never as HTML: React escapes it, and nothing here sets inner HTML.
 *
 * @module @dorkos/flow/extension/ui/dashboard/parts
 */

import type {
  DashboardBody,
  DashboardKind,
  DashboardView,
  SourceStatus,
} from '../../lib/dashboard/types.ts';
import type { ClientApi, ExtensionPageProps } from '../../lib/host-types.ts';
import { UNREACHABLE_MESSAGE, getDashboard, refreshDashboard } from '../api.ts';
import { HOME_PATH, dashboardPath, webHref } from '../links.ts';
import { BAND, SR_ONLY, pageRoot } from '../page-parts.ts';
import { BUTTON, LINK, MUTED, PILL } from '../parts.ts';
import { h, useEffect, useState, type Node, type Style } from '../react.ts';
import { ageText } from '../run-chip.ts';
import { ALERT } from '../styles.ts';

/** How often an open page asks for its data again, in ms (the server reads when it is over a minute old). */
export const PAGE_POLL_MS = 60_000;

/** Each page's name, in the order the links show them. */
export const PAGE_TITLES: Readonly<Record<DashboardKind, string>> = {
  issues: 'Issues',
  prs: 'Pull requests',
  releases: 'Releases',
};

/** Said when no project has a `dashboard` block. */
export const NO_DASHBOARD_TEXT = 'No project has a dashboard yet.';

/** How to add one. */
export const ADD_DASHBOARD_HINT =
  'Add a "dashboard" block to the project\'s .agents/flow/config.json.';

/**
 * Said when the named project has no `dashboard` block.
 *
 * @param project - The project.
 * @returns The words.
 */
export function notConfiguredText(project: string): string {
  return `${project} has no dashboard yet.`;
}

/**
 * Said when a page is switched off in the project's `views`.
 *
 * @param title - The page's name.
 * @param project - The project.
 * @returns The words.
 */
export function viewOffText(title: string, project: string): string {
  return `${title} is off in ${project}'s dashboard settings.`;
}

/** The filters a page keeps in its address. */
export interface DashboardFilters {
  /** One project's name, or `null` for the first with a dashboard. */
  project: string | null;
  /** One team, or `null` for all. */
  team: string | null;
  /** One repository, or `null` for all. */
  repo: string | null;
  /** One state, or `null` for all. */
  state: string | null;
  /** Only what is waiting on you. */
  mine: boolean;
}

/**
 * The filters in a page's address. An empty value is no filter.
 *
 * @param search - The page's query.
 * @returns The filters.
 */
export function filtersFrom(search: Readonly<Record<string, string>>): DashboardFilters {
  const value = (key: string) => (search[key] ? search[key] : null);
  return {
    project: value('project'),
    team: value('team'),
    repo: value('repo'),
    state: value('state'),
    mine: search.mine === '1',
  };
}

/**
 * How long ago something happened, or a dash when unknown.
 *
 * @param iso - The moment.
 * @param now - The clock.
 * @returns "just now", "3m ago", "2d ago".
 */
export function agoText(iso: string | null, now: Date): string {
  const at = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(at) ? ageText(now.getTime() - at) : '—';
}

/**
 * One source's line: its name and age, or why it could not be read.
 *
 * @param source - The source.
 * @param now - The clock.
 * @returns The words, and whether they say something failed.
 */
export function sourceLine(source: SourceStatus, now: Date): { text: string; failed: boolean } {
  const note = source.note === null ? '' : ` · ${source.note}`;
  if (source.error === null) {
    return { text: `${source.label} · read ${agoText(source.fetchedAt, now)}${note}`, failed: false };
  }
  const last = source.fetchedAt === null ? '' : ` Last read ${agoText(source.fetchedAt, now)}.`;
  return { text: `${source.label}: ${source.error}${last}`, failed: true };
}

/** What a page's read hook gives back. */
export interface DashboardRead<T> {
  /** The body, or `null` before the first answer. */
  body: DashboardBody<T> | null;
  /** Why the page could not be read, or `null`. */
  error: string | null;
  /** Whether a Refresh is running. */
  refreshing: boolean;
  /** Why the last Refresh failed, or `null`. */
  refreshError: string | null;
  /** Read the page again now. */
  refresh(): void;
}

/**
 * Read one dashboard page, again every minute while it is open, and offer a
 * Refresh that reads it now.
 *
 * @param kind - The page.
 * @param project - The project in the address, or `null`.
 * @returns The read.
 */
export function useDashboard<T>(kind: DashboardKind, project: string | null): DashboardRead<T> {
  const [body, setBody] = useState<DashboardBody<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      getDashboard<T>(kind, project).then(
        (next) => {
          if (!live) return;
          setBody(next);
          setError(null);
        },
        (failure: unknown) => {
          if (live) setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
        }
      );
    setBody(null);
    void read();
    const timer = setInterval(() => void read(), PAGE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [kind, project]);
  return {
    body,
    error,
    refreshing,
    refreshError,
    refresh: () => {
      const name = body?.project;
      if (refreshing || name === null || name === undefined) return;
      setRefreshing(true);
      setRefreshError(null);
      refreshDashboard<T>(kind, name).then(
        (next) => {
          setBody(next);
          setRefreshing(false);
        },
        (failure: unknown) => {
          setRefreshing(false);
          setRefreshError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
        }
      );
    },
  };
}

/**
 * A link that opens a tracker or GitHub page in a new tab, or plain text when
 * the address is not one it can open.
 *
 * @param props - The address and the words.
 * @returns The link.
 */
export function OutLink(props: { href: string | null; text: string; style?: Style }): Node {
  const href = webHref(props.href);
  if (href === null) return h('span', { style: props.style }, props.text);
  return h(
    'a',
    {
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: { color: 'inherit', textUnderlineOffset: '2px', ...props.style },
    },
    props.text
  );
}

/**
 * A small neutral pill.
 *
 * @param props - Its words, and whether it calls for attention.
 * @returns The pill.
 */
export function Tag(props: { text: string; strong?: boolean }): Node {
  return h(
    'span',
    { style: { ...PILL, fontWeight: props.strong === true ? 600 : 400 } },
    props.text
  );
}

/** A select of the filter's choices, with "All" first. */
export function FilterSelect(props: {
  label: string;
  all: string;
  value: string | null;
  options: readonly { value: string; text: string }[];
  onChange: (value: string | null) => void;
}): Node {
  return h(
    'select',
    {
      'aria-label': props.label,
      value: props.value ?? '',
      style: { ...BUTTON, padding: '2px 6px', fontSize: '12px' },
      onChange: (event: { target: { value: string } }) =>
        props.onChange(event.target.value === '' ? null : event.target.value),
    },
    h('option', { value: '' }, props.all),
    ...props.options.map((option) =>
      h('option', { key: option.value, value: option.value }, option.text)
    )
  );
}

/** The "Waiting on you" checkbox. */
export function MineToggle(props: { on: boolean; onChange: (on: boolean) => void }): Node {
  return h(
    'label',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' } },
    h('input', {
      type: 'checkbox',
      checked: props.on,
      onChange: (event: { target: { checked: boolean } }) => props.onChange(event.target.checked),
    }),
    'Waiting on you'
  );
}

/**
 * A dashboard page's frame: the way back, the links between the pages that
 * are on, the project picker, Refresh, each source's line and the config's
 * problems, then the page's own content.
 *
 * @param props - The page, its read, the host API, the page props, the filter
 *   controls and the content.
 * @returns The page.
 */
export function DashboardFrame<T>(props: {
  kind: DashboardKind;
  read: DashboardRead<T>;
  api: Pick<ClientApi, 'navigate'>;
  page: ExtensionPageProps;
  filters?: Node;
  children: (body: DashboardBody<T>) => Node;
  now?: () => Date;
}): Node {
  const { kind, read, api, page } = props;
  const title = PAGE_TITLES[kind];
  const back = h(
    'button',
    { type: 'button', style: LINK, onClick: () => api.navigate(HOME_PATH) },
    '← Flow home'
  );
  if (read.error !== null && read.body === null) {
    return pageRoot(back, h('p', { role: 'alert', style: { ...ALERT, marginTop: '8px' } }, read.error));
  }
  const body = read.body;
  if (body === null) return pageRoot(back, h('div', { 'aria-busy': true }));
  const heading = h('h1', { style: SR_ONLY }, title);
  if (body.project === null) {
    return pageRoot(
      back,
      heading,
      h('p', { style: { margin: '12px 0 4px' } }, NO_DASHBOARD_TEXT),
      h('p', { style: MUTED }, ADD_DASHBOARD_HINT)
    );
  }
  const project = body.project;
  const now = (props.now ?? (() => new Date()))();
  const shown = (['issues', 'prs', 'releases'] as const).filter((view) =>
    body.views.includes(view as DashboardView)
  );
  const nav =
    shown.length > 1
      ? h(
          'nav',
          {
            'aria-label': 'Dashboard',
            style: { display: 'flex', gap: '14px', margin: '10px 0 2px', flexWrap: 'wrap' },
          },
          ...shown.map((view) =>
            h(
              'button',
              {
                key: view,
                type: 'button',
                'aria-current': view === kind ? 'page' : undefined,
                style: {
                  ...LINK,
                  fontSize: '13px',
                  fontWeight: view === kind ? 600 : 400,
                  textDecoration: view === kind ? 'none' : 'underline',
                },
                onClick: () => api.navigate(dashboardPath(view, project)),
              },
              PAGE_TITLES[view]
            )
          )
        )
      : null;
  const picker =
    body.projects.length > 1
      ? h(
          'select',
          {
            'aria-label': 'Project',
            value: project,
            style: { ...BUTTON, padding: '2px 6px', fontSize: '12px' },
            onChange: (event: { target: { value: string } }) =>
              page.setSearch({ project: event.target.value }),
          },
          ...body.projects.map((name) => h('option', { key: name, value: name }, name))
        )
      : null;
  const refresh = body.canRefresh
    ? h(
        'button',
        {
          type: 'button',
          style: { ...BUTTON, cursor: read.refreshing ? 'progress' : 'pointer' },
          'aria-disabled': read.refreshing || undefined,
          onClick: () => read.refresh(),
        },
        read.refreshing ? 'Refreshing…' : 'Refresh'
      )
    : null;
  const header = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
    back,
    h('span', { style: { flex: 1 } }),
    picker,
    refresh
  );
  if (!body.configured) {
    return pageRoot(
      header,
      heading,
      h('p', { style: { margin: '12px 0 4px' } }, notConfiguredText(project)),
      h('p', { style: MUTED }, ADD_DASHBOARD_HINT)
    );
  }
  if (!body.views.includes(kind)) {
    return pageRoot(
      header,
      heading,
      nav,
      h('p', { style: { margin: '12px 0 4px' } }, viewOffText(title, project))
    );
  }
  return pageRoot(
    header,
    heading,
    nav,
    read.refreshError === null
      ? null
      : h('p', { role: 'alert', style: ALERT }, read.refreshError),
    body.problems.length === 0
      ? null
      : h(
          'div',
          { role: 'status', style: { margin: '8px 0 0' } },
          h('p', { style: { ...MUTED, color: ALERT.color } }, 'Some dashboard settings were left out:'),
          ...body.problems.map((problem) => h('p', { key: problem, style: MUTED }, problem))
        ),
    h(
      'section',
      { 'aria-label': 'Sources', style: { margin: '8px 0 0' } },
      ...body.sources.map((source) => {
        const line = sourceLine(source, now);
        return h(
          'p',
          { key: source.id, style: line.failed ? { ...MUTED, color: ALERT.color } : MUTED },
          line.text
        );
      })
    ),
    props.filters === undefined
      ? null
      : h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
              marginTop: '10px',
            },
          },
          props.filters
        ),
    props.children(body)
  );
}

/** A band caption with its count. */
export function bandTitle(text: string, count: number): Node {
  return h('h2', { style: BAND }, `${text} · ${count}`);
}
