/**
 * Fixtures for the Flow tab's tests: `GET /fleet` and `GET /model` bodies, and
 * stubbed fetches that answer flow's routes.
 */

import { vi } from 'vitest';
import type { FleetAccount, FleetGroup, FleetView } from '../../lib/fleet.ts';
import type { FlowModel, FlowProject, FlowRunRow } from '../../lib/model.ts';

/** A Claude Code account row. */
export function account(id: string, role: FleetAccount['role'], extra: Partial<FleetAccount> = {}) {
  return {
    key: `claude-code:${id}`,
    id,
    label: id,
    color: '#2563eb',
    implicit: false,
    role,
    reservePct: 50,
    spendDownWindowHours: 24,
    repos: [],
    effectiveReservePct: 50,
    ...extra,
  } satisfies FleetAccount;
}

/** Codex's implicit account, Rotation by default. */
export function codexImplicit(role: FleetAccount['role'] = 'rotation'): FleetAccount {
  return {
    key: 'codex:default',
    id: 'default',
    label: "Codex (this computer's sign-in)",
    color: '#78716c',
    implicit: true,
    role,
    reservePct: 50,
    spendDownWindowHours: 24,
    repos: [],
    effectiveReservePct: 50,
  };
}

/** A Claude Code group. */
export function claudeGroup(accounts: FleetAccount[]): FleetGroup {
  return { runtime: 'claude-code', label: 'Claude Code', supportsAccounts: true, accounts };
}

/** A Codex group with its implicit account. */
export function codexGroup(role: FleetAccount['role'] = 'rotation'): FleetGroup {
  return {
    runtime: 'codex',
    label: 'Codex',
    supportsAccounts: false,
    accounts: [codexImplicit(role)],
  };
}

/** A `GET /fleet` body. */
export function fleet(groups: FleetGroup[], extra: Partial<FleetView> = {}): FleetView {
  return {
    handoff: 'auto',
    crossRuntimeFallback: 'off',
    groups,
    anyRoleStored: true,
    warnings: [],
    ...extra,
  };
}

/** A body whose `json()` rejects, as a non-JSON error page does. */
export const NO_JSON = Symbol('no-json');

/** One answer the stub gives. */
export interface StubAnswer {
  status: number;
  body: unknown;
}

/** A recorded request. */
export interface StubCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Stub `fetch`: `GET` answers `initial`; each `PUT` answers the next of `writes`
 * (or, when none is left, a 200 with `initial`). Resolves each PUT only when
 * `hold` is false or `release()` is called.
 */
export function stubFetch(
  initial: StubAnswer,
  writes: StubAnswer[] = [],
  opts: { hold?: boolean } = {}
) {
  const calls: StubCall[] = [];
  const pending: { resolve: () => void; done: boolean }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    const answer = method === 'GET' ? initial : (writes.shift() ?? initial);
    if (method !== 'GET' && opts.hold) {
      await new Promise<void>((resolve) => pending.push({ resolve, done: false }));
    }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === NO_JSON) throw new SyntaxError('Unexpected token <');
        return answer.body;
      },
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    /** The PUTs made so far. */
    puts: () => calls.filter((call) => call.method === 'PUT'),
    /** Let every held PUT answer. */
    release: () => {
      for (const entry of pending)
        if (!entry.done) {
          entry.done = true;
          entry.resolve();
        }
    },
    /** Let the `index`th held PUT (0-based, in the order they were sent) answer. */
    releaseAt: (index: number) => {
      const entry = pending[index];
      entry.done = true;
      entry.resolve();
    },
  };
}

/** A Flow tab project, ready and quiet unless told otherwise. */
export function flowProject(name: string, extra: Partial<FlowProject> = {}): FlowProject {
  return {
    name,
    root: `/work/${name}`,
    setup: 'ready',
    tracker: { label: 'Linear', team: 'DOR', url: null },
    pause: null,
    runs: [],
    queue: null,
    upNext: 'read',
    capacity: { busy: 0, slots: 1 },
    conditions: [],
    version: { flow: '0.49.0', behaviour: 1, olderBehaviour: null },
    restoreSchedules: [],
    ...extra,
  };
}

/** A run row. */
export function runRow(identifier: string, extra: Partial<FlowRunRow> = {}): FlowRunRow {
  return {
    identifier,
    title: null,
    url: null,
    sessionId: null,
    dispatchedBy: null,
    cwd: '/work/dorkos',
    account: { key: 'claude-code:work', label: 'Work', color: '#2563eb' },
    state: 'building',
    updatedAt: null,
    ...extra,
  };
}

/** A `GET /model` body. */
export function flowModel(projects: FlowProject[], extra: Partial<FlowModel> = {}): FlowModel {
  return {
    behaviour: 1,
    generatedAt: '2026-09-28T12:00:00.000Z',
    projects,
    decisions: [],
    cwdProject: null,
    canChange: true,
    ...extra,
  };
}

/** One request a routed stub saw. */
export interface RoutedCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Stub `fetch` by route: `answer(method, url, body)` returns the status and
 * body for each request. Records every call.
 */
export function routeFetch(
  answer: (method: string, url: string, body: unknown) => StubAnswer | Promise<StubAnswer>
) {
  const calls: RoutedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url, body });
    const reply = await answer(method, url, body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
