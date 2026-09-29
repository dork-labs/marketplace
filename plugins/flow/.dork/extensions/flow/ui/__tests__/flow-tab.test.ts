/**
 * The Flow tab (spec `flow-multiproject` §3, §5.3, §9.3, §10): the lens
 * follows the chat's project (DorkOS's `currentProject`, or flow's own
 * `cwdProject` on a DorkOS without it); the project lens's order, pills, "Up
 * next", footer, setup state and version line; the all-projects lens lists
 * only projects that need something; "Set up flow here" only for a repo with
 * no flow; every pause asks how long; and no account rows anywhere.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowModel } from '../../lib/model.ts';
import type { ProjectRef, ReadableState } from '../../lib/host-types.ts';
import { NO_PROJECTS_TEXT, SET_UP_HERE_TEXT } from '../all-projects.ts';
import { PERSON_ONLY_MESSAGE } from '../api.ts';
import { LOAD_FAILED_TEXT, createFlowTab } from '../flow-tab.ts';
import {
  NOTHING_RUNNING_TEXT,
  NOT_SET_UP_TEXT,
  PAUSE_FROM_CHAT_TEXT,
  SCHEDULES_OFF_TEXT,
} from '../project-lens.ts';
import { FlowStore } from '../store.ts';
import { flowModel, flowProject, routeFetch, runRow } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A host whose chat is in `project` (or nowhere); `undefined` is a DorkOS without the field. */
function host(project: ProjectRef | null | undefined, cwd: string | null = '/work/dorkos') {
  const state: ReadableState =
    project === undefined ? { currentCwd: cwd } : { currentCwd: cwd, currentProject: project };
  return { navigate: vi.fn(), getState: () => state };
}

/** Render the tab over a store serving `model` for every read. */
async function renderTab(model: FlowModel, api = host(null)) {
  const fetch = routeFetch((method, url) => {
    if (method === 'GET' && url.includes('/ext/flow/model')) return { status: 200, body: model };
    return { status: 200, body: model };
  });
  const store = new FlowStore(api);
  store.start();
  const Tab = createFlowTab(api, store);
  render(React.createElement(Tab));
  await act(async () => {});
  return { store, api, fetch };
}

const DORKOS: ProjectRef = { root: '/work/dorkos', name: 'dorkos' };

describe('which lens', () => {
  it("shows the chat's project when DorkOS says the chat is in it", async () => {
    await renderTab(flowModel([flowProject('dorkos'), flowProject('blintz')]), host(DORKOS));
    expect(screen.getByText('dorkos')).toBeTruthy();
    expect(screen.getByText('· Linear DOR')).toBeTruthy();
    expect(screen.queryByText('All projects')).toBeNull();
  });

  it('shows all projects for a chat in no flow project', async () => {
    await renderTab(flowModel([flowProject('dorkos')]), host({ root: '/elsewhere', name: 'x' }));
    expect(screen.getByText('All projects')).toBeTruthy();
  });

  it("uses flow's own answer on a DorkOS that does not name the chat's project", async () => {
    const { fetch } = await renderTab(
      flowModel([flowProject('dorkos'), flowProject('blintz')], { cwdProject: 'blintz' }),
      host(undefined, '/work/blintz/wt')
    );
    expect(screen.getByText('blintz')).toBeTruthy();
    expect(fetch.calls[0].url).toBe('/api/ext/flow/model?cwd=%2Fwork%2Fblintz%2Fwt');
  });

  it('says so when it could not load, and tries again', async () => {
    routeFetch(() => ({ status: 500, body: {} }));
    const api = host(DORKOS);
    const store = new FlowStore(api);
    store.start();
    render(React.createElement(createFlowTab(api, store)));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(LOAD_FAILED_TEXT);
    routeFetch(() => ({ status: 200, body: flowModel([flowProject('dorkos')]) }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.getByText('dorkos')).toBeTruthy();
  });
});

describe('the project lens', () => {
  it('shows what is running with neutral pills, then Up next and how many more', async () => {
    const api = host(DORKOS);
    await renderTab(
      flowModel([
        flowProject('dorkos', {
          capacity: { busy: 2, slots: 3 },
          runs: [
            runRow('DOR-2387', { title: 'Out-of-usage banner', sessionId: 's-1', cwd: '/wt/2387' }),
            runRow('DOR-2401', { title: 'Keep the old API?', state: 'needs-you' }),
            runRow('DOR-2300', { state: 'done' }),
          ],
          queue: {
            next: [
              { identifier: 'DOR-2412', title: 'Faster sidebar load' },
              { identifier: 'DOR-2419', title: 'Relay retry copy' },
            ],
            more: 5,
          },
          tracker: { label: 'Linear', team: 'DOR', url: 'https://linear.app/acme/team/DOR' },
        }),
      ]),
      api
    );
    expect(screen.getByText('Running · 2 of 3')).toBeTruthy();
    expect(screen.getByText('Building')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    // A finished run is for the run chip, not the lens.
    expect(screen.queryByText(/DOR-2300/)).toBeNull();
    expect(screen.getByText('DOR-2412 Faster sidebar load')).toBeTruthy();
    expect(screen.getByText('+ 5 more')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open in Linear ↗' });
    expect(link.getAttribute('href')).toBe('https://linear.app/acme/team/DOR');
    fireEvent.click(screen.getByRole('button', { name: /DOR-2387 Out-of-usage banner/ }));
    expect(api.navigate).toHaveBeenCalledWith('/session?session=s-1&dir=%2Fwt%2F2387');
    // Accounts left the tab.
    expect(screen.queryByText('Accounts')).toBeNull();
  });

  it('says when nothing is running, and hides Up next before flow could read it', async () => {
    await renderTab(flowModel([flowProject('dorkos')]), host(DORKOS));
    expect(screen.getByText(NOTHING_RUNNING_TEXT)).toBeTruthy();
    expect(screen.queryByText('Up next')).toBeNull();
    expect(screen.queryByText(/Open in/)).toBeNull();
  });

  it('says why Up next is missing over mcp, or with the project’s own tracker code', async () => {
    await renderTab(flowModel([flowProject('dorkos', { upNext: 'agent-only' })]), host(DORKOS));
    expect(screen.getByText('Up next is shown when flow can reach Linear from here.')).toBeTruthy();
  });

  it('shows what is wrong in plain words, with the way to fix it behind ⓘ', async () => {
    await renderTab(
      flowModel([
        flowProject('dorkos', {
          conditions: [
            {
              kind: 'tracker-unreachable',
              since: '2026-09-28T09:14:00.000Z',
              escalated: false,
              detail: {},
            },
            { kind: 'sign-in', since: '2026-09-28T09:14:00.000Z', escalated: false, detail: {} },
          ],
        }),
      ]),
      host(DORKOS)
    );
    expect(
      screen.getByText(/Linear hasn't answered since .*\. Flow keeps trying\. Nothing is lost\./)
    ).toBeTruthy();
    const signIn = screen.getByText(/Sign in to Linear again\./);
    expect(signIn.textContent).not.toContain('/flow');
    fireEvent.click(screen.getByRole('button', { name: 'How to do this' }));
    expect(screen.getByText(/type \/flow:init and ask it to reconnect Linear/)).toBeTruthy();
  });

  it('shows only the setup line for a project flow is installed in but not set up', async () => {
    await renderTab(
      flowModel([flowProject('dorkos', { setup: 'not-set-up', tracker: null })]),
      host(DORKOS)
    );
    expect(screen.getByText(NOT_SET_UP_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByText(/Running/)).toBeNull();
  });

  it('says when the project runs an older flow, and opens the Marketplace to update it', async () => {
    const api = host(DORKOS);
    await renderTab(
      flowModel([
        flowProject('dorkos', {
          version: { flow: '0.46.1', behaviour: 0, olderBehaviour: 'timed pauses end on time' },
        }),
      ]),
      api
    );
    expect(
      screen.getByText(
        /dorkos runs an older flow \(0\.46\.1\), so timed pauses may not end on time\./
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update flow here' }));
    expect(api.navigate).toHaveBeenCalledWith('/marketplace');
  });

  it('says to switch schedules back on by hand when DorkOS would not', async () => {
    const { store } = await renderTab(flowModel([flowProject('dorkos')]), host(DORKOS));
    await act(async () => {
      (store as unknown as { set(p: object): void }).set({ schedulesStuck: new Set(['dorkos']) });
    });
    expect(screen.getByText(SCHEDULES_OFF_TEXT)).toBeTruthy();
  });
});

describe('pausing from the lens', () => {
  it('asks how long, sends the end, then says until when with Resume beside it', async () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 28, 22, 0), toFake: ['Date'] });
    const quiet = flowModel([flowProject('dorkos')]);
    const tomorrow = new Date(2026, 8, 29, 9, 0);
    const paused = flowModel([
      flowProject('dorkos', { pause: { since: null, until: tomorrow.toISOString() } }),
    ]);
    const fetch = routeFetch((method) =>
      method === 'POST' ? { status: 200, body: paused } : { status: 200, body: quiet }
    );
    const api = host(DORKOS);
    const store = new FlowStore(api);
    store.start();
    render(React.createElement(createFlowTab(api, store)));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const menu = screen.getByRole('menu', { name: 'Pause flow in dorkos' });
    expect(menu.textContent).toBe('Until tomorrow 9amFor 1 hourUntil I resume');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Until tomorrow 9am' }));
    });
    const post = fetch.calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/ext/flow/pause');
    const body = post?.body as { project: string; until: string };
    expect(body.project).toBe('dorkos');
    expect(Date.parse(body.until)).toBe(tomorrow.getTime());
    expect(screen.getByText(/^Paused until tomorrow /)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    });
    expect(fetch.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/ext/flow/resume',
      body: { project: 'dorkos' },
    });
  });

  it("shows DorkOS's refusal in plain words", async () => {
    const quiet = flowModel([flowProject('dorkos')]);
    routeFetch((method) =>
      method === 'POST' ? { status: 403, body: { error: 'nope' } } : { status: 200, body: quiet }
    );
    const api = host(DORKOS);
    const store = new FlowStore(api);
    store.start();
    render(React.createElement(createFlowTab(api, store)));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'For 1 hour' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(PERSON_ONLY_MESSAGE);
  });

  it('offers no Pause button where DorkOS cannot tell a person from an agent', async () => {
    await renderTab(flowModel([flowProject('dorkos')], { canChange: false }), host(DORKOS));
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    const words = screen.getByText(PAUSE_FROM_CHAT_TEXT);
    expect(words.textContent).not.toMatch(/\/flow:pause.*\/flow:pause/);
  });
});

describe('the all-projects lens', () => {
  it('lists only projects that need something, most urgent first, then how many are fine', async () => {
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    await renderTab(
      flowModel([
        flowProject('client-api', {
          pause: { since: null, until: soon },
          conditions: [{ kind: 'paused', since: soon, escalated: false, detail: {} }],
        }),
        flowProject('blintz', {
          conditions: [{ kind: 'sign-in', since: soon, escalated: false, detail: {} }],
        }),
        flowProject('dorkos'),
        flowProject('quiet'),
      ]),
      host(null)
    );
    const lines = screen.getAllByText(/^· /).map((node) => node.parentElement?.textContent);
    expect(lines).toEqual([
      'blintz · Sign in to Linear again',
      expect.stringMatching(/^client-api · Paused until /),
    ]);
    expect(screen.getByText('2 other projects are fine')).toBeTruthy();
  });

  it('offers to set flow up, quietly, only in a repo with no flow', async () => {
    const api = host({ root: '/work/new-repo', name: 'new-repo' });
    await renderTab(flowModel([flowProject('dorkos')]), api);
    expect(screen.getByText(new RegExp(SET_UP_HERE_TEXT))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up flow here' }));
    expect(api.navigate).toHaveBeenCalledWith('/marketplace');
  });

  it('offers nothing outside a repo, and says when no project has flow', async () => {
    await renderTab(flowModel([]), host(null));
    expect(screen.queryByRole('button', { name: 'Set up flow here' })).toBeNull();
    expect(screen.getByText(NO_PROJECTS_TEXT)).toBeTruthy();
  });
});
