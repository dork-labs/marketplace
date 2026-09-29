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
import { FleetTab } from '../fleet-tab.ts';
import { FlowIcon } from '../flow-icon.ts';
import { COMMANDS, NOT_IN_PROJECT_TEXT } from '../palette.ts';
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
    expect(api.registerSettingsTab).toHaveBeenCalledWith('fleet', 'Flow', FleetTab, {
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
    commands.get('pause-project')?.();
    const dialog = dialogs.get('pause-project')!;
    expect(dialog.open).toHaveBeenCalledTimes(1);
    render(React.createElement(dialog.component));
    expect(screen.getByText(NOT_IN_PROJECT_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause all projects instead' }));
    expect(screen.getByRole('menu', { name: 'Pause all projects' })).toBeTruthy();
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
});
