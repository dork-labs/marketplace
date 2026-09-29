/**
 * "Accounts this project may use" (spec `flow-multiproject` §8.4): read and
 * written only through DorkOS's own routes, from the browser; an account kept
 * to other projects asks first and widens its own rule before it is allowed
 * here; unchecking the last account warns; DorkOS's refusals (a 403 from its
 * person bar, a 409, any other) show its words and retry nothing; and on a
 * DorkOS without the routes nothing is drawn.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountCheckboxes, PROBE_FAILED_TEXT, nextAllow } from '../account-checkboxes.ts';
import { forgetEligibilityProbe, type AccountEligibility } from '../core-api.ts';
import { routeFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  forgetEligibilityProbe();
});

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

/** Serve DorkOS's three routes from one mutable state, recording every call. */
function core(
  initial: AccountEligibility,
  opts: { refuse?: { status: number; body: unknown } } = {}
) {
  let state = initial;
  const routed = routeFetch((method, url, body) => {
    if (method === 'PUT' && opts.refuse !== undefined) return opts.refuse;
    if (url.includes('/project-accounts')) {
      const allow = (body as { allow: string[] | null }).allow;
      state = eligibility({ allow, workOnly: state.accounts[0].onlyProjects });
      return { status: 200, body: state };
    }
    if (url.includes('/only-projects')) {
      const projects = (body as { projects: string[] }).projects;
      state = eligibility({
        allow: state.allow,
        workOnly: projects.map((root) => ({ root, name: root.split('/').pop()! })),
      });
      return { status: 200, body: { onlyProjects: state.accounts[0].onlyProjects } };
    }
    return { status: 200, body: state };
  });
  return routed;
}

async function renderBoxes() {
  const navigate = vi.fn();
  render(React.createElement(AccountCheckboxes, { root: ROOT, projectName: 'dorkos', navigate }));
  await act(async () => {});
  await act(async () => {});
  return { navigate };
}

const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });

describe('Accounts this project may use', () => {
  it('lists every account from DorkOS, all checked with no project list, and names Main', async () => {
    const { calls } = core(eligibility());
    await renderBoxes();
    expect((box('Work') as HTMLInputElement).checked).toBe(true);
    expect((box('Acct 2') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("(this computer's sign-in)")).toBeTruthy();
    // Only DorkOS's routes, never flow's.
    expect(calls.every((call) => call.url.includes('/runtimes/claude-code/'))).toBe(true);
  });

  it('unchecking writes the project’s list through DorkOS and redraws from its answer', async () => {
    const { calls } = core(eligibility());
    await renderBoxes();
    fireEvent.click(box('Acct 2'));
    await act(async () => {});
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toMatch(/\/api\/runtimes\/claude-code\/project-accounts$/);
    expect(put.body).toEqual({ project: ROOT, allow: ['work', 'default'] });
    expect((box('Acct 2') as HTMLInputElement).checked).toBe(false);
  });

  it('checking the last one back sends no list at all: every account again', async () => {
    const { calls } = core(eligibility({ allow: ['work', 'default'] }));
    await renderBoxes();
    fireEvent.click(box('Acct 2'));
    await act(async () => {});
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      project: ROOT,
      allow: null,
    });
  });

  it('an account kept to another project says so, and checking it asks, then widens its own rule first', async () => {
    const { calls } = core(
      eligibility({ workOnly: [{ root: '/work/client-app', name: 'client-app' }] })
    );
    await renderBoxes();
    expect(screen.getByText('· only for client-app')).toBeTruthy();
    expect((box('Work') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box('Work'));
    expect(screen.getByText('Work is only for client-app. Let dorkos use it too?')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Let dorkos use it' }));
    await act(async () => {});
    await act(async () => {});
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts[0].url).toMatch(/\/accounts\/work\/only-projects$/);
    expect(puts[0].body).toEqual({ projects: ['/work/client-app', ROOT] });
    expect((box('Work') as HTMLInputElement).checked).toBe(true);
  });

  it('Cancel leaves everything as it was', async () => {
    const { calls } = core(
      eligibility({ workOnly: [{ root: '/work/client-app', name: 'client-app' }] })
    );
    await renderBoxes();
    fireEvent.click(box('Work'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('unchecking the last account warns that every chat in the project will be refused', async () => {
    const { calls } = core(eligibility({ allow: ['acct2'] }));
    await renderBoxes();
    fireEvent.click(box('Acct 2'));
    expect(
      screen.getByText(
        'With no accounts allowed, every chat in dorkos will be refused, including yours. Continue?'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow no accounts' }));
    await act(async () => {});
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ project: ROOT, allow: [] });
  });

  it('shows DorkOS’s person-bar refusal plainly and tries nothing again', async () => {
    const { calls } = core(eligibility(), {
      refuse: {
        status: 403,
        body: {
          error: 'Only a person can change where an account may be used.',
          code: 'operator_only_config',
        },
      },
    });
    await renderBoxes();
    fireEvent.click(box('Acct 2'));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(
      'Only a person can change where an account may be used.'
    );
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect((box('Acct 2') as HTMLInputElement).checked).toBe(true);
  });

  it('shows a 409, like any other refusal, in DorkOS’s own words', async () => {
    core(eligibility(), {
      refuse: { status: 409, body: { error: 'That project changed; try again.' } },
    });
    await renderBoxes();
    fireEvent.click(box('Acct 2'));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('That project changed; try again.');
  });

  it('says plainly when DorkOS could not be asked, and Retry asks again', async () => {
    let up = false;
    routeFetch(() => (up ? { status: 200, body: eligibility() } : { status: 500, body: {} }));
    render(
      React.createElement(AccountCheckboxes, {
        root: ROOT,
        projectName: 'dorkos',
        navigate: vi.fn(),
      })
    );
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(PROBE_FAILED_TEXT);
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    await act(async () => {});
    expect((box('Work') as HTMLInputElement).checked).toBe(true);
  });

  it('draws nothing on a DorkOS without the account rules', async () => {
    routeFetch(() => ({ status: 404, body: {} }));
    const { container } = render(
      React.createElement(AccountCheckboxes, {
        root: ROOT,
        projectName: 'dorkos',
        navigate: vi.fn(),
      })
    );
    await act(async () => {});
    await act(async () => {});
    expect(container.textContent).toBe('');
  });
});

describe('nextAllow', () => {
  it('keeps DorkOS’s account order and sends null once every account is allowed', () => {
    const answer = eligibility({ allow: ['default'] });
    expect(nextAllow(answer, 'work', true)).toEqual(['work', 'default']);
    expect(nextAllow(eligibility({ allow: ['work', 'default'] }), 'acct2', true)).toBeNull();
    expect(nextAllow(eligibility(), 'work', false)).toEqual(['acct2', 'default']);
  });
});
