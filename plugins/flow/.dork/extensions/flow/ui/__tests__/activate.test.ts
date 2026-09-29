/**
 * `activate` (spec `flow-multiproject` §3.5, §5.4, §10): it starts the one
 * store, registers the Settings tab, the Flow tab and the palette commands,
 * skips each palette piece a host lacks, and its cleanup removes them all.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../../index.ts';
import { FlowIcon } from '../flow-icon.ts';
import { PANEL_TAB_ID } from '../marker.ts';
import { COMMANDS, NOT_IN_PROJECT_TEXT } from '../palette.ts';
import { CHIP_LABEL, chipUrgent, chipWhen } from '../run-chip.ts';
import { flowModel, flowProject, routeFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A full host, recording what the extension registers. */
function fullHost(
  state: { currentCwd: string | null; currentProject?: unknown } = { currentCwd: null }
) {
  const commands = new Map<string, () => void>();
  const dialogs = new Map<string, { component: ComponentType; open: ReturnType<typeof vi.fn> }>();
  const removed: string[] = [];
  const api = {
    navigate: vi.fn(),
    getState: () => state as never,
    subscribe: vi.fn(() => () => {}),
    notify: vi.fn(),
    registerSettingsTab: vi.fn(() => () => removed.push('settings')),
    registerComponent: vi.fn(() => () => removed.push('panel')),
    registerCommand: vi.fn((id: string, _label: string, callback: () => void) => {
      commands.set(id, callback);
      return () => removed.push(`command:${id}`);
    }),
    registerDialog: vi.fn((id: string, component: ComponentType) => {
      const entry = { component, open: vi.fn(), close: vi.fn() };
      dialogs.set(id, entry);
      return entry;
    }),
  };
  return { api, commands, dialogs, removed };
}

describe('activate', () => {
  it('registers the Settings tab, the Flow tab and four palette commands, and removes them all', async () => {
    routeFetch(() => ({ status: 200, body: flowModel([]) }));
    const { api, removed } = fullHost();
    const cleanup = activate(api);
    // The same tab id, so Settings → Runtimes' link to flow:fleet still lands here.
    expect(api.registerSettingsTab).toHaveBeenCalledWith('fleet', 'Flow', expect.any(Function), {
      group: 'Add-ons',
    });
    expect(api.registerComponent).toHaveBeenCalledWith(
      'right-panel',
      'panel',
      expect.any(Function),
      {
        label: 'Flow',
        icon: FlowIcon,
      }
    );
    expect(api.registerCommand.mock.calls.map((call) => call[1])).toEqual([
      COMMANDS.pauseProject,
      COMMANDS.pauseAll,
      COMMANDS.resumeProject,
      COMMANDS.resumeAll,
    ]);
    expect(api.registerDialog.mock.calls.map((call) => call[0])).toEqual([
      'pause-project',
      'pause-all',
    ]);
    await act(async () => {});
    cleanup();
    expect(removed.sort()).toEqual(
      [
        'command:pause-all',
        'command:pause-project',
        'command:resume-all',
        'command:resume-project',
        'panel',
        'settings',
      ].sort()
    );
  });

  it('skips the palette on a host without commands, and the pause dialogs without dialogs', () => {
    routeFetch(() => ({ status: 200, body: flowModel([]) }));
    const bare = {
      navigate: vi.fn(),
      registerSettingsTab: vi.fn(() => () => {}),
      registerComponent: vi.fn(() => () => {}),
    };
    activate(bare)();
    const { api } = fullHost();
    const noDialogs = { ...api, registerDialog: undefined };
    activate(noDialogs)();
    expect(api.registerCommand.mock.calls.map((call) => call[1])).toEqual([
      COMMANDS.resumeProject,
      COMMANDS.resumeAll,
    ]);
  });

  it('opens the pause dialog from the palette, which offers Pause all outside a flow project', async () => {
    routeFetch(() => ({ status: 200, body: flowModel([flowProject('dorkos')]) }));
    const { api, commands, dialogs } = fullHost({ currentCwd: '/x', currentProject: null });
    const cleanup = activate(api);
    await act(async () => {});
    const dialog = dialogs.get('pause-project')!;
    // DorkOS draws every registered dialog all the time, closed.
    render(React.createElement(dialog.component, { open: false } as never));
    expect(screen.queryByText(NOT_IN_PROJECT_TEXT)).toBeNull();
    act(() => commands.get('pause-project')?.());
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: COMMANDS.pauseProject })).toBeTruthy();
    expect(screen.getByText(NOT_IN_PROJECT_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause all projects instead' }));
    expect(screen.getByRole('menu', { name: 'Pause all projects' })).toBeTruthy();
    cleanup();
  });

  it('draws nothing until opened, and closes on Escape or outside it (DOR-2533 live check)', async () => {
    routeFetch(() => ({ status: 200, body: flowModel([flowProject('dorkos')]) }));
    const { api, commands, dialogs } = fullHost({
      currentCwd: '/work/dorkos',
      currentProject: { root: '/work/dorkos', name: 'dorkos' },
    });
    const cleanup = activate(api);
    await act(async () => {});
    const dialog = dialogs.get('pause-all')!;
    const onOpenChange = vi.fn();
    const { container } = render(
      React.createElement(dialog.component, { open: false, onOpenChange } as never)
    );
    expect(container.innerHTML).toBe('');
    act(() => commands.get('pause-all')?.());
    expect(screen.getByRole('menu', { name: 'Pause all projects' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.innerHTML).toBe('');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    act(() => commands.get('pause-all')?.());
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(container.innerHTML).toBe('');
    cleanup();
  });

  it('resumes the chat’s project from the palette at once, and says so', async () => {
    const paused = flowModel([flowProject('dorkos', { pause: { since: null, until: null } })]);
    const resumed = flowModel([flowProject('dorkos')]);
    const fetch = routeFetch((method) =>
      method === 'POST' ? { status: 200, body: resumed } : { status: 200, body: paused }
    );
    const { api, commands } = fullHost({
      currentCwd: '/work/dorkos',
      currentProject: { root: '/work/dorkos', name: 'dorkos' },
    });
    const cleanup = activate(api);
    await act(async () => {});
    await act(async () => {
      commands.get('resume-project')?.();
    });
    expect(fetch.calls.at(-1)).toMatchObject({
      url: '/api/ext/flow/resume',
      body: { project: 'dorkos' },
    });
    expect(api.notify).toHaveBeenCalledWith('Flow is running again in dorkos.', {
      type: 'success',
    });
    await act(async () => {
      commands.get('resume-project')?.();
    });
    expect(api.notify).toHaveBeenLastCalledWith("Flow isn't paused in dorkos.", { type: 'info' });
    cleanup();
  });

  it('says exactly what Resume all projects did', async () => {
    const paused = flowModel([
      flowProject('dorkos', { pause: { since: null, until: null } }),
      flowProject('blintz', { pause: { since: null, until: null } }),
      flowProject('quiet'),
    ]);
    const fetch = routeFetch((method) =>
      method === 'POST'
        ? { status: 200, body: flowModel([flowProject('dorkos'), flowProject('blintz')]) }
        : { status: 200, body: paused }
    );
    const { api, commands } = fullHost();
    const cleanup = activate(api);
    await act(async () => {});
    await act(async () => {
      commands.get('resume-all')?.();
    });
    expect(fetch.calls.at(-1)).toMatchObject({ url: '/api/ext/flow/resume', body: { all: true } });
    expect(api.notify).toHaveBeenLastCalledWith('Flow is running again in dorkos and blintz.', {
      type: 'success',
    });
    await act(async () => {
      commands.get('resume-all')?.();
    });
    expect(api.notify).toHaveBeenLastCalledWith('Nothing was paused.', { type: 'info' });
    cleanup();
  });

  it('sends one pause from the dialog however often it is clicked, and follows the store', async () => {
    let answer: (value: unknown) => void = () => {};
    const quiet = flowModel([flowProject('dorkos')]);
    const fetch = routeFetch((method) =>
      method === 'POST'
        ? new Promise((resolve) => {
            answer = () => resolve({ status: 200, body: quiet });
          })
        : { status: 200, body: quiet }
    );
    const { api, dialogs } = fullHost({
      currentCwd: '/work/dorkos',
      currentProject: { root: '/work/dorkos', name: 'dorkos' },
    });
    const cleanup = activate(api);
    const dialog = dialogs.get('pause-project')!;
    render(React.createElement(dialog.component, { open: true } as never));
    expect(screen.getByText('Loading…')).toBeTruthy();
    await act(async () => {});
    // The model arrived after the dialog opened, and the dialog followed it.
    const item = screen.getByRole('menuitem', { name: 'For 1 hour' });
    fireEvent.click(item);
    fireEvent.click(item);
    expect(fetch.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await act(async () => {
      answer(null);
    });
    cleanup();
  });

  it('adds Flow home, the project pages, the run chip and the tab dot on a DorkOS that has them', async () => {
    const decision = {
      key: 'k',
      project: 'dorkos',
      kind: 'review',
      title: 'Ship it?',
      detail: null,
      identifier: 'DOR-1',
      raisedAt: '2026-09-28T09:00:00.000Z',
      actions: 'ship',
      why: 'It is built.',
      defaultChoice: null,
      decideBy: null,
    };
    routeFetch(() => ({
      status: 200,
      body: flowModel([flowProject('dorkos')], { decisions: [decision as never] }),
    }));
    const { api, removed } = fullHost();
    const full = {
      ...api,
      registerPage: vi.fn((path: string) => () => removed.push(`page:${path}`)),
      registerStatusBarItem: vi.fn(() => () => removed.push('chip')),
      setTabMarker: vi.fn(),
    };
    const cleanup = activate(full);
    expect(full.registerPage.mock.calls.map((call) => call[0])).toEqual([
      '',
      'p/:name',
      'p/:name/settings',
    ]);
    expect(full.registerStatusBarItem).toHaveBeenCalledWith('run', expect.any(Function), {
      label: CHIP_LABEL,
      priority: 50,
      when: chipWhen,
      urgent: chipUrgent,
    });
    await act(async () => {});
    expect(full.setTabMarker).toHaveBeenCalledWith(PANEL_TAB_ID, 'attention');
    cleanup();
    expect(removed).toEqual(
      expect.arrayContaining(['chip', 'page:', 'page:p/:name', 'page:p/:name/settings'])
    );
  });

  it('skips each newer surface cleanly on a DorkOS without its seam', async () => {
    routeFetch(() => ({ status: 200, body: flowModel([flowProject('dorkos')]) }));
    const { api } = fullHost();
    for (const missing of ['registerPage', 'registerStatusBarItem', 'setTabMarker'] as const) {
      const host = {
        ...api,
        registerPage: vi.fn(() => () => {}),
        registerStatusBarItem: vi.fn(() => () => {}),
        setTabMarker: vi.fn(),
        [missing]: undefined,
      };
      const cleanup = activate(host);
      await act(async () => {});
      // The Flow tab and everything the host does have are still there.
      expect(api.registerComponent).toHaveBeenLastCalledWith(
        'right-panel',
        'panel',
        expect.any(Function),
        expect.anything()
      );
      if (missing !== 'registerPage') expect(host.registerPage).toHaveBeenCalledTimes(3);
      if (missing !== 'registerStatusBarItem') {
        expect(host.registerStatusBarItem).toHaveBeenCalledTimes(1);
      }
      expect(() => cleanup()).not.toThrow();
    }
  });
});
