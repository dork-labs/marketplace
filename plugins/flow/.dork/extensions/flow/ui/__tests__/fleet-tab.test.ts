import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetTab } from '../fleet-tab.ts';
import {
  GUIDE_LINK_TEXT,
  GUIDE_URL,
  NOTHING_IN_ROTATION_TEXT,
  NOTHING_USABLE_TEXT,
  ROLE_LINES,
} from '../notice.ts';
import { account, claudeGroup, codexGroup, fleet, stubFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the tab and wait for its first `GET /fleet`. */
async function renderTab() {
  render(React.createElement(FleetTab));
  await act(async () => {});
}

/** The role radio group of the account named `name`. */
function roles(name: string) {
  return screen.getByRole('radiogroup', { name });
}

describe('FleetTab: groups and rows', () => {
  it('captions the Claude Code group even when it is the only runtime', async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')])]),
    });
    await renderTab();
    expect(screen.getByText('Which accounts flow may use')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.getByRole('img', { name: 'Acct 2' })).toBeTruthy();
  });

  it('shows a Codex group with its implicit account in the stone color', async () => {
    stubFetch({ status: 200, body: fleet([claudeGroup([account('Main', 'main')]), codexGroup()]) });
    await renderTab();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    const dot = screen.getByRole('img', { name: "Codex (this computer's sign-in)" });
    expect(dot.style.background).toBe('rgb(120, 113, 108)');
  });

  it('renders warnings as a muted list', async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('Main', 'main')])], {
        warnings: ['Ignored a bad reserve.'],
      }),
    });
    await renderTab();
    expect(screen.getByRole('listitem').textContent).toBe('Ignored a bad reserve.');
  });

  it('says to add accounts first when there are none', async () => {
    stubFetch({ status: 200, body: fleet([claudeGroup([])]) });
    await renderTab();
    expect(screen.getByText('Add Claude accounts in Settings → Runtimes first.')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('asks for a newer DorkOS on 501 host-too-old', async () => {
    stubFetch({ status: 501, body: { reason: 'host-too-old' } });
    await renderTab();
    expect(screen.getByText('Update DorkOS to choose how flow uses your accounts.')).toBeTruthy();
    expect(screen.queryByText('Which accounts flow may use')).toBeNull();
  });
});

describe('FleetTab: the role radio group', () => {
  it('marks the chosen role, keeps one tab stop, and arrows move and write', async () => {
    const after = fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'kept-out')])]);
    const stub = stubFetch(
      {
        status: 200,
        body: fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')])]),
      },
      [{ status: 200, body: after }]
    );
    await renderTab();
    const group = roles('Acct 2');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => {
      fireEvent.keyDown(radios[1], { key: 'ArrowRight' });
    });
    expect(stub.puts()).toEqual([
      {
        method: 'PUT',
        url: '/api/ext/flow/fleet/accounts/claude-code%3AAcct%202',
        body: { role: 'kept-out' },
      },
    ]);
    const now = within(roles('Acct 2')).getAllByRole('radio');
    expect(now[2].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(now[2]);
  });

  it('wraps with the arrows and jumps with Home and End', async () => {
    const stub = stubFetch(
      { status: 200, body: fleet([claudeGroup([account('Solo', 'main')])]) },
      [],
      { hold: true }
    );
    await renderTab();
    const radios = within(roles('Solo')).getAllByRole('radio');
    fireEvent.keyDown(radios[0], { key: 'ArrowLeft' });
    fireEvent.keyDown(radios[2], { key: 'Home' });
    fireEvent.keyDown(radios[0], { key: 'End' });
    fireEvent.keyDown(radios[2], { key: 'ArrowDown' });
    expect(stub.puts().map((call) => (call.body as { role: string }).role)).toEqual([
      'kept-out',
      'main',
      'kept-out',
      'main',
    ]);
  });

  it('shows the answered body: a new Main shows the old one as Rotation', async () => {
    const answered = fleet([claudeGroup([account('Main', 'rotation'), account('Acct 2', 'main')])]);
    stubFetch(
      {
        status: 200,
        body: fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')])]),
      },
      [{ status: 200, body: answered }]
    );
    await renderTab();
    await act(async () => {
      fireEvent.click(within(roles('Acct 2')).getByRole('radio', { name: 'Main' }));
    });
    expect(
      within(roles('Main')).getByRole('radio', { name: 'Rotation' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(
      within(roles('Acct 2')).getByRole('radio', { name: 'Main' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('shows a write at once, then rolls back and says why on a 409', async () => {
    const stub = stubFetch(
      {
        status: 200,
        body: fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')])]),
      },
      [{ status: 409, body: { error: 'fleet.json changed while you were editing it.' } }],
      { hold: true }
    );
    await renderTab();
    fireEvent.click(within(roles('Acct 2')).getByRole('radio', { name: 'Kept out' }));
    // Optimistic: the choice shows before flow answers.
    expect(
      within(roles('Acct 2')).getByRole('radio', { name: 'Kept out' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(screen.getByText('Only for these repos:')).toBeTruthy();

    await act(async () => {
      stub.release();
    });
    expect(
      within(roles('Acct 2')).getByRole('radio', { name: 'Rotation' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(
      'fleet.json changed while you were editing it.'
    );
    expect(screen.queryByText('Only for these repos:')).toBeNull();
  });
});

describe('FleetTab: the Main inset', () => {
  it('names the reserve slider, moves the number on input and writes only on change', async () => {
    const stub = stubFetch({ status: 200, body: fleet([claudeGroup([account('Main', 'main')])]) });
    await renderTab();
    const slider = screen.getByRole('slider', {
      name: 'Share of the weekly limit kept for you',
    }) as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('50%');
    expect([slider.min, slider.max, slider.step]).toEqual(['0', '100', '5']);

    fireEvent.input(slider, { target: { value: '65' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('65%');
    expect(screen.getByText('65%').tagName).toBe('B');
    expect(stub.puts()).toEqual([]);

    await act(async () => {
      fireEvent.change(slider, { target: { value: '70' } });
    });
    expect(stub.puts().map((call) => call.body)).toEqual([{ reservePct: 70 }]);
  });

  it('lists 6-72 hours, adds a stored value outside the list, and writes a choice', async () => {
    const stub = stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('Main', 'main', { spendDownWindowHours: 36 })])]),
    });
    await renderTab();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '6',
      '12',
      '24',
      '36',
      '48',
      '72',
    ]);
    expect(select.value).toBe('36');
    await act(async () => {
      fireEvent.change(select, { target: { value: '12' } });
    });
    expect(stub.puts().map((call) => call.body)).toEqual([{ spendDownWindowHours: 12 }]);
  });
});

describe('FleetTab: repos for a Kept out account', () => {
  const keptOut = () =>
    fleet([
      claudeGroup([
        account('Main', 'main'),
        account('Client', 'kept-out', { repos: ['acme/client-app'] }),
      ]),
    ]);

  it('labels each remove button and writes the list without it', async () => {
    const stub = stubFetch({ status: 200, body: keptOut() });
    await renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove acme/client-app' }));
    });
    expect(stub.puts().map((call) => call.body)).toEqual([{ repos: [] }]);
  });

  it('"+ add" opens a field; Enter adds a valid repo', async () => {
    const stub = stubFetch({ status: 200, body: keptOut() });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: '+ add' }));
    const field = screen.getByPlaceholderText('owner/name');
    fireEvent.change(field, { target: { value: 'acme/app' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(stub.puts().map((call) => call.body)).toEqual([
      { repos: ['acme/client-app', 'acme/app'] },
    ]);
  });

  it('Escape cancels without writing', async () => {
    const stub = stubFetch({ status: 200, body: keptOut() });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: '+ add' }));
    const field = screen.getByPlaceholderText('owner/name');
    fireEvent.change(field, { target: { value: 'acme/app' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('owner/name')).toBeNull();
    expect(screen.getByRole('button', { name: '+ add' })).toBeTruthy();
    expect(stub.puts()).toEqual([]);
  });

  it('a value that is not owner/name says how to write it and writes nothing', async () => {
    const stub = stubFetch({ status: 200, body: keptOut() });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: '+ add' }));
    const field = screen.getByPlaceholderText('owner/name');
    fireEvent.change(field, { target: { value: 'just-a-name' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('Use owner/name, like acme/app.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(stub.puts()).toEqual([]);
  });
});

describe('FleetTab: fleet-wide rows', () => {
  it('the handoff control writes { handoff: "ask" }', async () => {
    const stub = stubFetch({ status: 200, body: fleet([claudeGroup([account('Main', 'main')])]) });
    await renderTab();
    const group = screen.getByRole('radiogroup', { name: 'When an account runs out' });
    expect(
      within(group)
        .getByRole('radio', { name: 'Hand off automatically' })
        .getAttribute('aria-checked')
    ).toBe('true');
    await act(async () => {
      fireEvent.click(within(group).getByRole('radio', { name: 'Ask me' }));
    });
    expect(stub.puts()).toEqual([
      { method: 'PUT', url: '/api/ext/flow/fleet/handoff', body: { handoff: 'ask' } },
    ]);
  });

  it('the cross-runtime row defaults to Off and writes { crossRuntimeFallback: "on" }', async () => {
    const stub = stubFetch({ status: 200, body: fleet([claudeGroup([account('Main', 'main')])]) });
    await renderTab();
    const group = screen.getByRole('radiogroup', { name: 'Cross-runtime fallback' });
    expect(within(group).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(
      screen.getByText(
        "When every account of a runtime is out, continue the task on another runtime from flow's checkpoint."
      )
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(group).getByRole('radio', { name: 'On' }));
    });
    expect(stub.puts()).toEqual([
      {
        method: 'PUT',
        url: '/api/ext/flow/fleet/cross-runtime',
        body: { crossRuntimeFallback: 'on' },
      },
    ]);
  });
});

describe('FleetTab: notices', () => {
  it('first visit explains the roles, links the guide, and goes once a role is stored', async () => {
    const before = fleet(
      [claudeGroup([account('Main', 'rotation'), account('Acct 2', 'rotation')])],
      {
        anyRoleStored: false,
      }
    );
    const after = fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')])]);
    stubFetch({ status: 200, body: before }, [{ status: 200, body: after }]);
    await renderTab();
    const notice = screen.getByRole('status');
    for (const line of ROLE_LINES) expect(within(notice).getByText(line)).toBeTruthy();
    const link = within(notice).getByRole('link', { name: GUIDE_LINK_TEXT });
    expect(link.getAttribute('href')).toBe('https://dorkos.ai/docs/use-all-your-accounts');
    expect(GUIDE_URL).toBe('https://dorkos.ai/docs/use-all-your-accounts');
    expect(link.textContent).toBe('How to use all your accounts');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(notice.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      fireEvent.click(within(roles('Main')).getByRole('radio', { name: 'Main' }));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('with no role stored, only the first-visit notice shows, whatever the roles resolve to', async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('Main', 'main'), account('Acct 2', 'kept-out')])], {
        anyRoleStored: false,
      }),
    });
    await renderTab();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(ROLE_LINES[0])).toBeTruthy();
    expect(screen.queryByText(NOTHING_IN_ROTATION_TEXT)).toBeNull();
  });

  it('with no role stored and every account kept out, only the first-visit notice shows', async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('A', 'kept-out'), account('B', 'kept-out')])], {
        anyRoleStored: false,
      }),
    });
    await renderTab();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText(NOTHING_USABLE_TEXT)).toBeNull();
  });

  it('nothing in rotation shows with a Main and no Claude Code account in Rotation, even with Codex in Rotation', async () => {
    const answered = fleet([
      claudeGroup([account('Main', 'main'), account('Acct 2', 'rotation')]),
      codexGroup(),
    ]);
    stubFetch(
      {
        status: 200,
        body: fleet([
          claudeGroup([account('Main', 'main'), account('Acct 2', 'kept-out')]),
          codexGroup(),
        ]),
      },
      [{ status: 200, body: answered }]
    );
    await renderTab();
    expect(screen.getByRole('status').textContent).toBe(NOTHING_IN_ROTATION_TEXT);
    expect(NOTHING_IN_ROTATION_TEXT).toBe(
      'Nothing is in rotation yet, so flow only uses your main account.'
    );

    await act(async () => {
      fireEvent.click(within(roles('Acct 2')).getByRole('radio', { name: 'Rotation' }));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('with roles stored and nothing Main or Rotation, says flow cannot use any account', async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('A', 'kept-out'), account('B', 'kept-out')])]),
    });
    await renderTab();
    expect(screen.getByRole('status').textContent).toBe(
      "Flow can't use any account yet. Make one account Main or Rotation."
    );
  });

  it("does not say that while Codex's implicit account is in Rotation", async () => {
    stubFetch({
      status: 200,
      body: fleet([claudeGroup([account('A', 'kept-out')]), codexGroup('rotation')]),
    });
    await renderTab();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
