/**
 * `ProjectFlowSettings` (spec `flow-multiproject` §8, §7.7, V6, V10): one
 * component on a project's settings page and in Settings → Flow under a
 * project switcher; the shared and just-me writes; the dial and Customize,
 * written only through `api.projectSettings.set`; and what an older DorkOS or
 * an older flow gets instead.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientApi } from '../../lib/host-types.ts';
import type { FlowProject } from '../../lib/model.ts';
import { forgetEligibilityProbe } from '../core-api.ts';
import {
  DIAL_NEEDS_NEWER_DORKOS_TEXT,
  DIAL_NEEDS_NEWER_FLOW_TEXT,
  NOT_CHOSEN_TEXT,
  NO_REVIEWER_TEXT,
  REQUIRE_LOGIN_TEXT,
} from '../dial.ts';
import { createPages } from '../home-page.ts';
import {
  ProjectFlowSettings,
  READ_ONLY_TEXT,
  SHARED_NOTE,
  SHARED_SAVED_TEXT,
} from '../project-settings.ts';
import { createSettingsTab } from '../settings-tab.ts';
import { FlowStore } from '../store.ts';
import type { MigrationDeps } from '../migrate-repos.ts';
import { flowModel, flowProject, routeFetch, settingsView } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  forgetEligibilityProbe();
});

/** A project flow first saw with no history (its dial defaults to Tell me after). */
function newProject(name = 'dorkos', extra: Partial<FlowProject> = {}): FlowProject {
  return flowProject(name, {
    version: { flow: '0.52.0', behaviour: 2, olderBehaviour: null },
    autonomy: {
      chosen: false,
      firstSeen: 'new',
      stops: { ship: 'tell', questions: 'tell', sort: 'tell', retry: 'tell' },
    },
    ...extra,
  });
}

/** DorkOS's per-project settings, in memory, with every write recorded. */
function projectSettings(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const set = vi.fn(async (root: string, value: unknown) => {
    values.set(root, value);
  });
  return {
    api: {
      get: vi.fn(async (root: string) => (values.get(root) ?? null) as never),
      set,
    },
    set,
    values,
  };
}

/** Answer flow's settings route and DorkOS's (no eligibility routes unless given). */
function serve(
  opts: {
    view?: ReturnType<typeof settingsView>;
    put?: (body: unknown) => { status: number; body: unknown };
    model?: ReturnType<typeof flowModel>;
    eligibility?: { status: number; body: unknown };
  } = {}
) {
  return routeFetch((method, url, body) => {
    if (url.includes('/ext/flow/settings/')) {
      if (method === 'PUT')
        return opts.put?.(body) ?? { status: 200, body: opts.view ?? settingsView() };
      return { status: 200, body: opts.view ?? settingsView() };
    }
    if (url.includes('/runtimes/claude-code/account-eligibility')) {
      return opts.eligibility ?? { status: 404, body: {} };
    }
    if (url.includes('/ext/flow/fleet/migration')) return { status: 200, body: { accounts: {} } };
    if (url.includes('/ext/flow/fleet')) {
      return {
        status: 200,
        body: {
          handoff: 'auto',
          crossRuntimeFallback: 'off',
          groups: [],
          anyRoleStored: false,
          warnings: [],
        },
      };
    }
    return { status: 200, body: opts.model ?? flowModel([newProject()]) };
  });
}

type SettingsApi = Pick<ClientApi, 'navigate' | 'projectSettings' | 'getState'>;

/** Render the component for one project. */
async function renderSettings(project: FlowProject, api: Partial<SettingsApi> = {}) {
  const full = { navigate: vi.fn(), ...api } as SettingsApi & {
    navigate: ReturnType<typeof vi.fn>;
  };
  render(React.createElement(ProjectFlowSettings, { project, api: full }));
  await act(async () => {});
  await act(async () => {});
  return full;
}

/** A migration that finds nothing to move. */
const NO_MOVE: MigrationDeps = {
  hasEligibilityRoutes: async () => false,
  getFleet: async () => {
    throw new Error('not called');
  },
  listProjects: async () => [],
  getEligibility: async () => ({ project: null, allow: null, accounts: [] }),
  putOnlyProjects: async () => ({}),
  putAccount: async () => ({}),
  getRecord: async () => ({ accounts: {} }),
  putRecord: async () => ({}),
  now: () => new Date('2026-09-29T10:00:00Z'),
};

describe('one component, two entry points', () => {
  it('draws the same boxes on the project page and in Settings → Flow, whose switcher starts on the chat’s project', async () => {
    const model = flowModel([newProject('blintz'), newProject('dorkos')]);
    serve({ model });
    const settings = projectSettings();

    const pageStore = new FlowStore({});
    pageStore.start();
    const pages = createPages(
      { navigate: vi.fn(), projectSettings: settings.api, getState: () => ({ currentCwd: null }) },
      pageStore
    );
    const page = render(
      React.createElement(pages.settings, {
        params: { name: 'dorkos' },
        search: {},
        setSearch: vi.fn(),
      })
    );
    await act(async () => {});
    await act(async () => {});
    const onPage = ['Shared with the repo', 'Just me'].map(
      (name) => within(page.container).getByRole('heading', { name }).textContent
    );
    expect(within(page.container).getByText(SHARED_NOTE)).toBeTruthy();
    page.unmount();

    const state = {
      currentCwd: '/work/dorkos/src',
      currentProject: { root: '/work/dorkos', name: 'dorkos' },
    };
    const tabStore = new FlowStore({ getState: () => state, subscribe: () => () => {} });
    tabStore.start();
    const Tab = createSettingsTab(
      { navigate: vi.fn(), projectSettings: settings.api, getState: () => state },
      tabStore,
      NO_MOVE
    );
    render(React.createElement(Tab));
    await act(async () => {});
    await act(async () => {});
    expect((screen.getByRole('combobox', { name: 'Project:' }) as HTMLSelectElement).value).toBe(
      'dorkos'
    );
    expect(screen.getByRole('heading', { name: 'Editing dorkos' })).toBeTruthy();
    expect(
      ['Shared with the repo', 'Just me'].map(
        (name) => screen.getByRole('heading', { name }).textContent
      )
    ).toEqual(onPage);
    expect(screen.getByRole('heading', { name: 'This computer' })).toBeTruthy();

    // Switching edits the other project, and the heading says so.
    fireEvent.change(screen.getByRole('combobox', { name: 'Project:' }), {
      target: { value: 'blintz' },
    });
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Editing blintz' })).toBeTruthy();
  });

  it('opens on the project ⚙ asked for, on a DorkOS without flow’s pages', async () => {
    serve({ model: flowModel([newProject('blintz'), newProject('dorkos')]) });
    const store = new FlowStore({});
    store.start();
    store.settingsProject = 'blintz';
    render(React.createElement(createSettingsTab({ navigate: vi.fn() }, store, NO_MOVE)));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Editing blintz' })).toBeTruthy();
  });
});

describe('Settings → Flow and "Only for these repos"', () => {
  /** One kept-out Claude account whose repo is client-app, and DorkOS with no rule for it. */
  function movable(put: ReturnType<typeof vi.fn>): MigrationDeps {
    return {
      ...NO_MOVE,
      hasEligibilityRoutes: async () => true,
      getFleet: async () => ({
        handoff: 'auto',
        crossRuntimeFallback: 'off',
        groups: [
          {
            runtime: 'claude-code',
            label: 'Claude Code',
            supportsAccounts: true,
            accounts: [
              {
                key: 'claude-code:work',
                id: 'work',
                label: 'Work',
                color: '#000000',
                implicit: false,
                role: 'kept-out',
                reservePct: 0,
                spendDownWindowHours: 24,
                repos: ['acme/app'],
                effectiveReservePct: 0,
              },
            ],
          },
        ],
        anyRoleStored: true,
        warnings: [],
      }),
      listProjects: async () => [
        { root: '/work/client-app', name: 'client-app', originRepo: 'acme/app' },
      ],
      getEligibility: async () => ({
        project: null,
        allow: null,
        accounts: [
          {
            id: 'work',
            label: 'Work',
            color: '#000000',
            implicit: false,
            onlyProjects: null,
            allowedByAccount: true,
            allowedByProject: true,
            eligible: true,
          },
        ],
      }),
      putOnlyProjects: put,
    };
  }

  it('writes nothing on open; the account row offers the move, which runs only on a click', async () => {
    const fleetBody = {
      handoff: 'auto',
      crossRuntimeFallback: 'off',
      groups: [
        {
          runtime: 'claude-code',
          label: 'Claude Code',
          supportsAccounts: true,
          accounts: [
            {
              key: 'claude-code:work',
              id: 'work',
              label: 'Work',
              color: '#000000',
              implicit: false,
              role: 'kept-out',
              reservePct: 0,
              spendDownWindowHours: 24,
              repos: ['acme/app'],
              effectiveReservePct: 0,
            },
          ],
        },
      ],
      anyRoleStored: true,
      warnings: [],
    };
    routeFetch((_method, url) => {
      if (url.includes('/ext/flow/fleet')) return { status: 200, body: fleetBody };
      if (url.includes('/ext/flow/settings/')) return { status: 200, body: settingsView() };
      if (url.includes('/runtimes/claude-code/account-eligibility')) return { status: 404, body: {} };
      return { status: 200, body: flowModel([newProject()]) };
    });
    const store = new FlowStore({});
    store.start();
    const put = vi.fn(async () => ({}));
    render(React.createElement(createSettingsTab({ navigate: vi.fn() }, store, movable(put))));
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
    expect(
      screen.getByText(
        'Move "Only for these repos" into DorkOS? DorkOS will keep Work to client-app.',
        { exact: false }
      )
    ).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    await act(async () => {});
    await act(async () => {});
    expect(put).toHaveBeenCalledWith('work', ['/work/client-app']);
  });

  it('forgets the project ⚙ asked for once the tab closes', async () => {
    serve({ model: flowModel([newProject('blintz'), newProject('dorkos')]) });
    const store = new FlowStore({});
    store.start();
    store.settingsProject = 'blintz';
    const view = render(React.createElement(createSettingsTab({ navigate: vi.fn() }, store, NO_MOVE)));
    await act(async () => {});
    view.unmount();
    expect(store.settingsProject).toBeNull();
  });
});

describe('the shared and just-me writes', () => {
  it('saves a shared switch to the repo’s file and then says to commit it', async () => {
    const puts: unknown[] = [];
    serve({
      put: (body) => {
        puts.push(body);
        return {
          status: 200,
          body: settingsView({
            shared: {
              ...settingsView().shared,
              reviewerAgent: { value: false, source: 'shared', locked: null },
            },
          }),
        };
      },
    });
    await renderSettings(newProject(), { projectSettings: projectSettings().api });
    fireEvent.click(screen.getByRole('switch', { name: 'Review before a PR opens' }));
    await act(async () => {});
    expect(puts).toEqual([{ shared: { reviewerAgent: false } }]);
    expect(screen.getByText(SHARED_SAVED_TEXT)).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Review before a PR opens' }).getAttribute('aria-checked')
    ).toBe('false');
  });

  it('saves "at most at once" and the pause default for this computer only', async () => {
    const puts: unknown[] = [];
    serve({
      put: (body) => {
        puts.push(body);
        return { status: 200, body: settingsView() };
      },
    });
    await renderSettings(newProject());
    fireEvent.click(screen.getByRole('button', { name: 'One more at once' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('radio', { name: 'For 1 hour' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('radio', { name: 'Only when I start it' }));
    await act(async () => {});
    expect(puts).toEqual([
      { local: { parallel: 2 } },
      { pauseDefault: 'hour' },
      { local: { startsOnItsOwn: 'manual' } },
    ]);
  });

  it('puts a refused change back and says why under it', async () => {
    serve({
      put: () => ({
        status: 400,
        body: { error: 'Flow didn’t save that: bad value', refusedBy: 'flow' },
      }),
    });
    await renderSettings(newProject());
    const merge = screen.getByRole('switch', { name: 'Merge by itself when checks pass' });
    fireEvent.click(merge);
    await act(async () => {});
    expect(merge.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('alert').textContent).toBe('Flow didn’t save that: bad value');
  });

  it('says DorkOS’s person bar refused, in plain words', async () => {
    serve({ put: () => ({ status: 403, body: { error: 'Forbidden' } }) });
    await renderSettings(newProject());
    fireEvent.click(screen.getByRole('switch', { name: 'Merge when I approve' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('Only a person can change this.');
  });

  it('shows every setting but changes none on a DorkOS that can’t tell a person from an agent', async () => {
    serve({ view: settingsView({ canChange: false }) });
    await renderSettings(newProject());
    expect(screen.getByText(READ_ONLY_TEXT)).toBeTruthy();
    expect(
      (screen.getByRole('switch', { name: 'Review before a PR opens' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});

describe('the dial', () => {
  it('starts a new project at Tell me after, and a dial choice stores every kind at that stop', async () => {
    serve();
    const settings = projectSettings();
    await renderSettings(newProject(), { projectSettings: settings.api });
    const dial = screen.getByRole('radiogroup', { name: 'How much it does on its own' });
    expect(
      within(dial).getByRole('radio', { name: 'Tell me after' }).getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(within(dial).getByRole('radio', { name: 'Just do it' }));
    await act(async () => {});
    expect(settings.set).toHaveBeenCalledWith('/work/dorkos', {
      dial: 'auto',
      kinds: {},
      questionDeadlineMinutes: 240,
    });
    expect(
      within(dial).getByRole('radio', { name: 'Just do it' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('keeps a project flow already knew at Ask me first until you choose, and says so', async () => {
    serve();
    const settings = projectSettings();
    await renderSettings(
      newProject('dorkos', {
        autonomy: {
          chosen: false,
          firstSeen: 'existing',
          stops: { ship: 'ask', questions: 'ask', sort: 'ask', retry: 'tell' },
        },
      }),
      { projectSettings: settings.api }
    );
    expect(screen.getByText(NOT_CHOSEN_TEXT)).toBeTruthy();
    const dial = screen.getByRole('radiogroup', { name: 'How much it does on its own' });
    expect(
      within(dial).getByRole('radio', { name: 'Ask me first' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('Customize moves one kind and keeps the rest, and the dial then reads Custom', async () => {
    serve();
    const settings = projectSettings({
      '/work/dorkos': { dial: 'tell', kinds: {}, questionDeadlineMinutes: 60 },
    });
    await renderSettings(newProject(), { projectSettings: settings.api });
    fireEvent.click(screen.getByRole('button', { name: 'Customize…' }));
    const sort = screen.getByRole('radiogroup', { name: 'dorkos: Sort new ideas' });
    fireEvent.click(within(sort).getByRole('radio', { name: 'Ask me first' }));
    await act(async () => {});
    expect(settings.set).toHaveBeenLastCalledWith('/work/dorkos', {
      dial: 'tell',
      kinds: { sort: 'ask' },
      questionDeadlineMinutes: 60,
    });
    expect(screen.getByText('Custom')).toBeTruthy();
  });

  it('asks how long an agent waits at Tell me after, and stores it', async () => {
    serve();
    const settings = projectSettings({
      '/work/dorkos': { dial: 'tell', kinds: {}, questionDeadlineMinutes: 240 },
    });
    await renderSettings(newProject(), { projectSettings: settings.api });
    fireEvent.change(screen.getByRole('combobox', { name: 'An agent waits for your answer for' }), {
      target: { value: '60' },
    });
    await act(async () => {});
    expect(settings.set).toHaveBeenLastCalledWith('/work/dorkos', {
      dial: 'tell',
      kinds: {},
      questionDeadlineMinutes: 60,
    });
  });

  it('says shipping still asks you when no reviewer agent checks the repo', async () => {
    serve({
      view: settingsView({
        shared: {
          ...settingsView().shared,
          reviewerAgent: { value: false, source: 'shared', locked: null },
        },
      }),
    });
    await renderSettings(newProject(), { projectSettings: projectSettings().api });
    expect(screen.getByText(NO_REVIEWER_TEXT)).toBeTruthy();
  });

  it('puts the dial back and shows DorkOS’s words when its person bar refuses', async () => {
    serve();
    const settings = projectSettings();
    settings.set.mockRejectedValueOnce(
      Object.assign(new Error('Only a person can change this setting.'), { status: 403 })
    );
    await renderSettings(newProject(), { projectSettings: settings.api });
    const dial = screen.getByRole('radiogroup', { name: 'How much it does on its own' });
    fireEvent.click(within(dial).getByRole('radio', { name: 'Ask me first' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('Only a person can change this setting.');
    expect(
      within(dial).getByRole('radio', { name: 'Tell me after' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('shows DorkOS’s Require login line, verbatim, only while Require login is off', async () => {
    serve();
    await renderSettings(newProject(), {
      projectSettings: projectSettings().api,
      getState: () => ({ currentCwd: null, requireLogin: false }),
    });
    expect(screen.getByText(REQUIRE_LOGIN_TEXT)).toBeTruthy();
    expect(REQUIRE_LOGIN_TEXT).toBe(
      'Anyone on this computer can change this. Turn on Require login so only you can.'
    );
  });

  it('hides the Require login line when it is on, or when DorkOS does not say', async () => {
    serve();
    await renderSettings(newProject(), {
      projectSettings: projectSettings().api,
      getState: () => ({ currentCwd: null, requireLogin: true }),
    });
    expect(screen.queryByText(REQUIRE_LOGIN_TEXT)).toBeNull();
  });

  it('can’t be chosen on a project whose flow cannot read it yet', async () => {
    serve();
    const settings = projectSettings();
    await renderSettings(
      newProject('dorkos', { version: { flow: '0.47.0', behaviour: 0, olderBehaviour: 'x' } }),
      { projectSettings: settings.api }
    );
    expect(screen.getByText(DIAL_NEEDS_NEWER_FLOW_TEXT)).toBeTruthy();
    const dial = screen.getByRole('radiogroup', { name: 'How much it does on its own' });
    fireEvent.click(within(dial).getByRole('radio', { name: 'Just do it' }));
    await act(async () => {});
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('says to update DorkOS on one without per-project settings, and the rest still works', async () => {
    serve();
    await renderSettings(newProject());
    expect(screen.getByText(DIAL_NEEDS_NEWER_DORKOS_TEXT)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Review before a PR opens' })).toBeTruthy();
  });
});
