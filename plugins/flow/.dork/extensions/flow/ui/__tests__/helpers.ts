/**
 * Fixtures for the Flow tab's tests: `GET /fleet` bodies and a stubbed fetch
 * that answers flow's routes.
 */

import { vi } from 'vitest';
import type { FleetAccount, FleetGroup, FleetView } from '../../lib/fleet.ts';

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
  const pending: (() => void)[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    const answer = method === 'GET' ? initial : (writes.shift() ?? initial);
    if (method !== 'GET' && opts.hold) await new Promise<void>((resolve) => pending.push(resolve));
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    /** The PUTs made so far. */
    puts: () => calls.filter((call) => call.method === 'PUT'),
    /** Let every held PUT answer. */
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
}
