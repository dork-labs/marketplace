/**
 * Flow's pages (spec `flow-multiproject` §4, V4, N8): Flow home's three bands
 * and their counts; the project filter kept in the page's address, read back
 * on a fresh load, and a gone name; one project shows its page and none says
 * so; "Pause all projects" asks how long with tomorrow first and resumes all;
 * asks open Activity; a project's page with its decisions, and an unknown
 * name; the settings page's frame; "Capacity this week"; and registration
 * only on a DorkOS with pages.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapacityView } from '../../lib/capacity.ts';
import type { ExtensionPageProps } from '../../lib/host-types.ts';
import type { FlowDecision, FlowModel } from '../../lib/model.ts';
import {
  JOURNAL_OFF_TEXT,
  accountWeekText,
  browserWeekStart,
  forgetCapacity,
  projectWeekText,
} from '../capacity-view.ts';
import {
  ALL_PROJECTS_TEXT,
  HOME_EMPTY_TEXT,
  createPages,
  fineLine,
  homeBands,
  missingFilterText,
  pauseAllState,
  registerPages,
  unknownProjectText,
} from '../home-page.ts';
import { ANSWERED_IN_FLOW_NOTE, type AnswerApi } from '../answers.ts';
import { FlowIcon } from '../flow-icon.ts';
import { NOT_HERE_YET_TEXT, SHARED_FILE } from '../project-settings.ts';
import { FlowStore } from '../store.ts';
import { flowModel, flowProject, routeFetch, runRow } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  forgetCapacity();
});

const NOW = new Date('2026-09-28T12:00:00.000Z');

/** An open decision. */
function decision(project: string, extra: Partial<FlowDecision> = {}): FlowDecision {
  return {
    key: `k:${project}:${extra.kind ?? 'review'}`,
    project,
    kind: 'review',
    title: 'Ship the new out-of-usage banner?',
    detail: null,
    identifier: 'DOR-2387',
    raisedAt: '2026-09-28T09:00:00.000Z',
    actions: {
      kind: 'yes-no',
      approveLabel: 'Ship it',
      rejectLabel: 'Send it back',
      rejectAsksForNote: true,
    },
    answerIn: 'activity',
    why: "It's built, tests pass, and the reviewer agent found nothing.",
    defaultChoice: null,
    decideBy: null,
    ...extra,
  };
}

/** A host with the inbox, over a model's asks. */
function inboxApi(model: FlowModel) {
  return {
    listDecisions: vi.fn(async () =>
      model.decisions.map((d) => ({
        id: `core-${d.key}`,
        key: d.key,
        title: d.title,
        why: d.why,
        detail: d.detail,
        project: null,
        projectLabel: null,
        since: null,
        actions: d.actions,
        link: null,
        raisedAt: d.raisedAt,
      }))
    ),
    answerDecision: vi.fn(async () => ({
      resolved: true,
      message: null,
      navigate: null,
      watch: { sessionId: 'chat-9', label: 'Sorting 12 ideas…' },
    })),
  };
}

/** Three projects: one that needs you, one that is off, one that is fine. */
function threeProjects(): FlowModel {
  return flowModel(
    [
      flowProject('blintz', {
        conditions: [
          { kind: 'sign-in', since: '2026-09-28T09:14:00.000Z', escalated: false, detail: {} },
        ],
      }),
      flowProject('client-api', {
        pause: { since: '2026-09-28T08:00:00.000Z', until: null },
        conditions: [
          { kind: 'paused', since: '2026-09-28T08:00:00.000Z', escalated: false, detail: {} },
        ],
      }),
      flowProject('dorkos', {
        runs: [runRow('DOR-1'), runRow('DOR-2'), runRow('DOR-3', { state: 'done' })],
        queue: { next: [{ identifier: 'DOR-4', title: 'x' }], more: 3 },
      }),
    ],
    {
      decisions: [
        decision('dorkos'),
        decision('blintz', {
          kind: 'ideas',
          actions: { kind: 'word', label: 'Sort them' },
          answerIn: 'flow',
          raisedAt: '2026-09-28T08:00:00.000Z',
          title: '12 new ideas haven’t been sorted',
        }),
      ],
    }
  );
}

describe('homeBands', () => {
  it('sorts every project into one band, oldest decision first', () => {
    const bands = homeBands(threeProjects(), null, NOW);
    expect(bands.needsYou.map((d) => d.project)).toEqual(['blintz', 'dorkos']);
    expect(bands.off.map((line) => [line.project.name, line.text, line.paused])).toEqual([
      ['blintz', 'Sign in to Linear again', false],
      ['client-api', 'Paused', true],
    ]);
    expect(bands.fine.map((line) => [line.project.name, line.text])).toEqual([
      ['dorkos', '2 running · 4 up next'],
    ]);
  });

  it('narrows every band to one project', () => {
    const bands = homeBands(threeProjects(), 'blintz', NOW);
    expect(bands.needsYou).toHaveLength(1);
    expect(bands.off.map((line) => line.project.name)).toEqual(['blintz']);
    expect(bands.fine).toEqual([]);
  });

  it('words a quiet project in facts', () => {
    expect(fineLine(flowProject('a', { queue: { next: [], more: 0 } })).text).toBe(
      'Nothing ready to work on'
    );
    expect(fineLine(flowProject('a')).text).toBe('Nothing running');
    expect(fineLine(flowProject('a', { setup: 'not-set-up' }))).toMatchObject({
      text: "Flow isn't set up here yet",
      hint: expect.stringContaining('/flow:init'),
    });
  });

  it('says a pause with each project’s end, or "Paused" when the ends differ', () => {
    const until = (at: string | null) => ({ pause: { since: null, until: at } });
    expect(
      pauseAllState(flowModel([flowProject('a'), flowProject('b', until(null))]), NOW)
    ).toEqual({
      kind: 'pause',
    });
    expect(
      pauseAllState(flowModel([flowProject('a', until(null)), flowProject('b', until(null))]), NOW)
    ).toEqual({ kind: 'paused', text: 'Paused', resume: 'Resume' });
    expect(
      pauseAllState(
        flowModel([
          flowProject('a', until('2026-09-29T09:00:00.000Z')),
          flowProject('b', until(null)),
        ]),
        NOW
      )
    ).toEqual({ kind: 'paused', text: 'Paused', resume: 'Resume all' });
    expect(pauseAllState(flowModel([flowProject('a', { setup: 'not-set-up' })]), NOW)).toEqual({
      kind: 'none',
    });
  });
});

/** Serve `model` for every read and `answer` for writes. */
function serve(model: FlowModel, write?: (method: string, url: string, body: unknown) => unknown) {
  return routeFetch((method, url, body) => {
    if (url.includes('/ext/flow/capacity')) return { status: 200, body: capacity() };
    if (method === 'GET') return { status: 200, body: model };
    return { status: 200, body: write?.(method, url, body) ?? model };
  });
}

/** A `GET /capacity` body. */
function capacity(): CapacityView {
  return {
    since: '2026-09-28T00:00:00.000Z',
    accounts: [
      { key: 'claude-code:work', label: 'Work', color: '#2563eb', usedPct: 64, resetsAt: null },
      { key: 'codex:default', label: 'Codex', color: '#78716c', usedPct: null, resetsAt: null },
    ],
    projects: [
      { name: 'blintz', journal: 'off', hours: 0, finished: 0, handoffs: 0 },
      { name: 'dorkos', journal: 'on', hours: 3.5, finished: 2, handoffs: 1 },
    ],
  };
}

/**
 * Render a page the way DorkOS does: `search` from the address, and a
 * `setSearch` that writes it (null removes a key) and draws the page again.
 */
async function renderPage(
  page: 'home' | 'project' | 'settings',
  model: FlowModel,
  opts: {
    params?: Record<string, string>;
    search?: Record<string, string>;
    api?: Partial<AnswerApi>;
  } = {}
) {
  const store = new FlowStore({});
  store.start();
  const api = { navigate: vi.fn(), ...opts.api };
  const Page = createPages(api, store)[page];
  const address = { search: { ...(opts.search ?? {}) } as Record<string, string> };
  const writes: Record<string, string | null>[] = [];
  function Host(): React.ReactNode {
    const [search, setSearchState] = React.useState(address.search);
    const props: ExtensionPageProps = {
      params: opts.params ?? {},
      search,
      setSearch: (next) => {
        writes.push(next);
        const merged: Record<string, string> = { ...address.search };
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        address.search = merged;
        setSearchState(merged);
      },
    };
    return React.createElement(Page, props);
  }
  render(React.createElement(Host));
  await act(async () => {});
  return { api, store, address, writes };
}

describe('Flow home', () => {
  it('shows three bands with counts; a review gate goes to Activity, the rest are answered here', async () => {
    serve(threeProjects());
    const inbox = inboxApi(threeProjects());
    const { api } = await renderPage('home', threeProjects(), { api: inbox });
    expect(screen.getByRole('heading', { level: 1, name: 'Flow' })).toBeTruthy();
    expect(screen.getByText('Needs you · 2')).toBeTruthy();
    expect(screen.getByText("Something's off · 2")).toBeTruthy();
    expect(screen.getByText('All fine · 1')).toBeTruthy();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    // A review gate has no buttons here: shipping must be credited to you.
    expect(within(needs).queryByRole('button', { name: /Ship it/ })).toBeNull();
    fireEvent.click(within(needs).getByRole('button', { name: 'Review in Activity →' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/activity');
    // The note that such answers are credited to Flow shows once.
    expect(within(needs).getAllByText(ANSWERED_IN_FLOW_NOTE)).toHaveLength(1);
    expect(within(needs).getByRole('button', { name: 'Sort them' })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('region', { name: 'All fine' })).getByRole('button', {
        name: 'dorkos',
      })
    );
    expect(api.navigate).toHaveBeenLastCalledWith('/x/flow/p/dorkos');
  });

  it('keeps the project filter in the address, and reads it back on a fresh load', async () => {
    serve(threeProjects());
    const { address, writes } = await renderPage('home', threeProjects());
    const filter = screen.getByRole('combobox', { name: 'Show projects' }) as HTMLSelectElement;
    expect(filter.value).toBe('');
    expect(within(filter).getByRole('option', { name: ALL_PROJECTS_TEXT })).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'blintz' } });
    expect(writes.at(-1)).toEqual({ project: 'blintz' });
    expect(address.search).toEqual({ project: 'blintz' });
    expect(screen.getByText('Needs you · 1')).toBeTruthy();
    expect(screen.queryByText(/All fine/)).toBeNull();

    // A bookmark of that address opens filtered.
    const saved = { ...address.search };
    document.body.innerHTML = '';
    serve(threeProjects());
    await renderPage('home', threeProjects(), { search: saved });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('blintz');
    expect(screen.getByText('Needs you · 1')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(screen.getByText('Needs you · 2')).toBeTruthy();
  });

  it('shows everything, and says so, for a filter naming a project that is gone', async () => {
    serve(threeProjects());
    await renderPage('home', threeProjects(), { search: { project: 'gone' } });
    expect(screen.getByRole('status').textContent).toBe(missingFilterText('gone'));
    expect(screen.getByText('Needs you · 2')).toBeTruthy();
  });

  it('shows the one project’s page at one project, and says so at none', async () => {
    const one = flowModel([flowProject('dorkos')]);
    serve(one);
    const { writes } = await renderPage('home', one);
    expect(screen.queryByRole('heading', { level: 1, name: 'Flow' })).toBeNull();
    expect(screen.getByText('dorkos')).toBeTruthy();
    expect(screen.queryByText('← Flow home')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Capacity this week →' }));
    expect(writes.at(-1)).toEqual({ tab: 'capacity' });
    await act(async () => {});
    expect(screen.getByRole('tab', { name: 'Capacity this week', selected: true })).toBeTruthy();

    document.body.innerHTML = '';
    serve(flowModel([]));
    await renderPage('home', flowModel([]));
    expect(screen.getByText(HOME_EMPTY_TEXT)).toBeTruthy();
  });

  it('pauses every project until tomorrow 9am by default, and resumes them all', async () => {
    const quiet = flowModel([flowProject('a'), flowProject('b')]);
    const paused = flowModel([
      flowProject('a', { pause: { since: null, until: null } }),
      flowProject('b', { pause: { since: null, until: null } }),
    ]);
    const fetch = serve(quiet, (_method, url) => (url.endsWith('/pause') ? paused : quiet));
    await renderPage('home', quiet);
    fireEvent.click(screen.getByRole('button', { name: 'Pause all projects ▾' }));
    const menu = screen.getByRole('menu', { name: 'Pause all projects' });
    const first = within(menu).getAllByRole('menuitem')[0];
    expect(first.textContent).toBe('Until tomorrow 9am');
    expect(first.getAttribute('data-default')).toBe('true');
    await act(async () => {
      fireEvent.click(first);
    });
    const pause = fetch.calls.find((call) => call.url.endsWith('/pause'));
    expect(pause?.body).toMatchObject({ all: true, until: expect.stringMatching(/T09:00:00/) });
    expect(screen.getByText('Paused')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    });
    expect(fetch.calls.at(-1)).toMatchObject({ url: '/api/ext/flow/resume', body: { all: true } });
  });

  it('resumes one paused project from its line', async () => {
    const fetch = serve(threeProjects());
    await renderPage('home', threeProjects());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume flow in client-api' }));
    });
    expect(fetch.calls.at(-1)).toMatchObject({
      url: '/api/ext/flow/resume',
      body: { project: 'client-api' },
    });
  });

  it('shows this week’s capacity on its tab, narrowed by the filter', async () => {
    const fetch = serve(threeProjects());
    const { writes } = await renderPage('home', threeProjects());
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity this week' }));
    expect(writes.at(-1)).toEqual({ tab: 'capacity' });
    await act(async () => {});
    const read = fetch.calls.find((call) => call.url.includes('/capacity'));
    expect(read?.url).toMatch(/since=2026-/);
    expect(screen.getByText('64% of this week')).toBeTruthy();
    expect(screen.getByText('3.5 hours of agent work · 2 finished · 1 handoff')).toBeTruthy();
    expect(screen.getByText(JOURNAL_OFF_TEXT)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dorkos' } });
    expect(screen.queryByText(JOURNAL_OFF_TEXT)).toBeNull();
  });
});

describe('capacity words', () => {
  it('says an account’s week and a project’s', () => {
    expect(
      accountWeekText(
        {
          key: 'k',
          label: 'Work',
          color: '#000',
          usedPct: 63.6,
          resetsAt: new Date(2026, 8, 28, 15, 0).toISOString(),
        },
        new Date(2026, 8, 28, 12, 0),
        'en-US'
      )
    ).toMatch(/^64% of this week · resets 3:00\sPM$/);
    expect(projectWeekText({ name: 'a', journal: 'on', hours: 1, finished: 0, handoffs: 2 })).toBe(
      '1 hour of agent work · 2 handoffs'
    );
    expect(projectWeekText({ name: 'a', journal: 'on', hours: 0, finished: 0, handoffs: 0 })).toBe(
      'Nothing recorded this week.'
    );
  });

  it('starts the week on the browser’s Monday at midnight', () => {
    const monday = browserWeekStart(new Date(2026, 8, 30, 15, 0));
    expect(monday.startsWith('2026-09-28T00:00:00')).toBe(true);
    expect(browserWeekStart(new Date(2026, 8, 28, 0, 30)).startsWith('2026-09-28T00:00:00')).toBe(
      true
    );
    expect(browserWeekStart(new Date(2026, 9, 4, 23, 0)).startsWith('2026-09-28T00:00:00')).toBe(
      true
    );
  });
});

describe('a project’s page', () => {
  it('shows its decisions above its lens, with ⚙ opening its settings', async () => {
    serve(threeProjects());
    const { api } = await renderPage('project', threeProjects(), { params: { name: 'dorkos' } });
    expect(screen.getByText('Needs you · 1')).toBeTruthy();
    expect(screen.getByText('Running · 0 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Flow settings for dorkos' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/x/flow/p/dorkos/settings');
    fireEvent.click(screen.getByRole('button', { name: '← Flow home' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/x/flow');
  });

  it('says so for a name flow does not know', async () => {
    serve(threeProjects());
    const { api } = await renderPage('project', threeProjects(), { params: { name: 'nope' } });
    expect(screen.getByText(unknownProjectText('nope'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Flow home →' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/x/flow');
  });
});

describe('a project’s settings page', () => {
  it('says what it can’t do yet, where the settings live, and who a change reaches', async () => {
    serve(threeProjects());
    const { api } = await renderPage('settings', threeProjects(), { params: { name: 'dorkos' } });
    expect(screen.getByRole('heading', { level: 1, name: 'dorkos' })).toBeTruthy();
    expect(screen.getByText(NOT_HERE_YET_TEXT)).toBeTruthy();
    expect(screen.getByText(SHARED_FILE)).toBeTruthy();
    expect(SHARED_FILE).toBe('.agents/flow/config.json');
    expect(screen.getByText('everyone on this repo')).toBeTruthy();
    expect(screen.getByText('only this computer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings → Flow' }));
    expect(api.navigate).toHaveBeenLastCalledWith('?settings=flow:fleet');
  });
});

describe('registerPages', () => {
  it('registers home in the menu and the two project pages outside it', () => {
    const registerPage = vi.fn((_path: string, _page: unknown, _options: unknown) => () => {});
    registerPages({ navigate: vi.fn(), registerPage }, new FlowStore({}));
    expect(registerPage.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['', { title: 'Flow', icon: FlowIcon }],
      ['p/:name', { title: 'Flow project', icon: FlowIcon, menu: false }],
      ['p/:name/settings', { title: 'Flow settings', icon: FlowIcon, menu: false }],
    ]);
  });

  it('registers nothing on a DorkOS without pages', () => {
    expect(() => registerPages({ navigate: vi.fn() }, new FlowStore({}))()).not.toThrow();
  });
});

describe('review fixes', () => {
  it('reads an empty ?project= as no filter', async () => {
    serve(threeProjects());
    await renderPage('home', threeProjects(), { search: { project: '' } });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Needs you · 2')).toBeTruthy();
  });

  it('ties each tab to its panel and moves between them with the arrow keys', async () => {
    serve(threeProjects());
    const { writes } = await renderPage('home', threeProjects());
    const projects = screen.getByRole('tab', { name: 'Projects' });
    const panel = screen.getByRole('tabpanel');
    expect(projects.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(projects.id);
    expect(projects.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Capacity this week' }).getAttribute('tabindex')).toBe(
      '-1'
    );
    fireEvent.keyDown(projects, { key: 'ArrowRight' });
    expect(writes.at(-1)).toEqual({ tab: 'capacity' });
    await act(async () => {});
    const capacityTab = screen.getByRole('tab', { name: 'Capacity this week' });
    expect(document.activeElement).toBe(capacityTab);
    fireEvent.keyDown(capacityTab, { key: 'ArrowLeft' });
    expect(writes.at(-1)).toEqual({ tab: null });
  });

  it('reads Capacity once a minute at most, however often the tab opens', async () => {
    const fetch = serve(threeProjects());
    await renderPage('home', threeProjects(), { search: { tab: 'capacity' } });
    document.body.innerHTML = '';
    await renderPage('home', threeProjects(), { search: { tab: 'capacity' } });
    expect(screen.getByText('64% of this week')).toBeTruthy();
    expect(fetch.calls.filter((call) => call.url.includes('/capacity'))).toHaveLength(1);
  });

  it('leaves the page title to DorkOS’s bar, keeping a heading for screen readers', async () => {
    serve(threeProjects());
    await renderPage('home', threeProjects());
    const heading = screen.getByRole('heading', { level: 1, name: 'Flow' });
    expect(heading.style.position).toBe('absolute');
    expect(heading.style.width).toBe('1px');
  });
});
