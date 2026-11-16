/**
 * "Accounts this project may use" (spec `flow-multiproject` §8.4): read only,
 * through flow's own route (a v2 frame reaches no DorkOS route); each account
 * says whether it may work here and which rule keeps it out; a project with
 * its own list says where to remove it; and the only way to change anything
 * is the button to Settings → Runtimes, which says why when DorkOS refuses.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NavigateResult } from '../../lib/host-types.ts';
import type { AccountEligibility } from '../api.ts';
import {
  CHANGE_IN_RUNTIMES_TEXT,
  OPEN_RUNTIMES_LABEL,
  PROJECT_LIST_TEXT,
  ProjectAccounts,
  RUNTIMES_SETTINGS_LINK,
} from '../project-accounts.ts';
import { routeRequests } from './helpers.ts';

const ROOT = '/work/dorkos';

/** DorkOS's answer for the project. */
function eligibility(
  opts: { allow?: string[] | null; workOnly?: { root: string; name: string }[] | null } = {}
): AccountEligibility {
  const allow = opts.allow ?? null;
  const workOnly = opts.workOnly ?? null;
  const row = (id: string, label: string | null, only: typeof workOnly, implicit = false) => {
    const allowedByAccount = only === null || only.some((p) => p.root === ROOT);
    const allowedByProject = allow === null || allow.includes(id);
    return {
      id,
      label,
      color: '#2563eb',
      implicit,
      onlyProjects: only,
      allowedByAccount,
      allowedByProject,
      eligible: allowedByAccount && allowedByProject,
    };
  };
  return {
    project: { root: ROOT, name: 'dorkos' },
    allow,
    accounts: [
      row('work', 'Work', workOnly),
      row('acct2', 'Acct 2', null),
      row('default', null, null, true),
    ],
  };
}

async function renderList(navigate: (path: string) => Promise<NavigateResult> | void = vi.fn()) {
  render(React.createElement(ProjectAccounts, { root: ROOT, projectName: 'dorkos', navigate }));
  await act(async () => {});
  await act(async () => {});
  return { navigate };
}

const line = (name: string) =>
  screen.getByText(
    (_text, element) => element?.tagName === 'LI' && element.textContent?.startsWith(name) === true
  );

describe('Accounts this project may use', () => {
  it('reads flow’s route for the project, and lists every account, naming Main', async () => {
    const { calls } = routeRequests(() => ({ status: 200, body: eligibility() }));
    await renderList();
    expect(calls).toEqual([
      {
        method: 'GET',
        url: `/accounts/eligibility?project=${encodeURIComponent(ROOT)}`,
        body: undefined,
      },
    ]);
    expect(line('Work').textContent).toBe('Work · may work here');
    expect(line('Acct 2').textContent).toBe('Acct 2 · may work here');
    expect(line('Main').textContent).toBe("Main (this computer's sign-in) · may work here");
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(PROJECT_LIST_TEXT)).toBeNull();
  });

  it('says which rule keeps an account out', async () => {
    routeRequests(() => ({
      status: 200,
      body: eligibility({
        allow: ['work', 'default'],
        workOnly: [{ root: '/work/client-app', name: 'client-app' }],
      }),
    }));
    await renderList();
    expect(line('Work').textContent).toBe('Work · not here: only for client-app');
    expect(line('Acct 2').textContent).toBe("Acct 2 · not here: this project's list leaves it out");
    expect(screen.getByText(PROJECT_LIST_TEXT)).toBeTruthy();
  });

  it('changes nothing itself: its one button opens Settings → Runtimes', async () => {
    const { calls } = routeRequests(() => ({ status: 200, body: eligibility() }));
    const { navigate } = await renderList();
    expect(screen.getByText(CHANGE_IN_RUNTIMES_TEXT, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: OPEN_RUNTIMES_LABEL }));
    await act(async () => {});
    expect(navigate).toHaveBeenCalledWith(RUNTIMES_SETTINGS_LINK);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('says why when DorkOS will not open the page', async () => {
    routeRequests(() => ({ status: 200, body: eligibility() }));
    await renderList(async () => ({
      ok: false,
      reason: 'unknown-route',
      message: 'DorkOS has no page at that address.',
    }));
    fireEvent.click(screen.getByRole('button', { name: OPEN_RUNTIMES_LABEL }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('DorkOS has no page at that address.');
  });

  it('shows flow’s own refusal, or that flow did not answer, and retries on request', async () => {
    let answer: { status: number; body: unknown } = {
      status: 404,
      body: { error: "Flow doesn't know that project.", refusedBy: 'flow' },
    };
    routeRequests(() => answer);
    await renderList();
    expect(screen.getByRole('alert').textContent).toBe("Flow doesn't know that project.");
    answer = { status: 500, body: { error: 'boom' } };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(
      "Flow didn't respond, so nothing was changed. Try again."
    );
    answer = { status: 200, body: eligibility() };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(line('Work')).toBeTruthy();
  });
});
