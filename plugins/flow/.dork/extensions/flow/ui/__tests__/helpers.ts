/**
 * Fixtures for the Flow tab's tests: `GET /fleet` and `GET /model` bodies,
 * a stubbed `api.request` that answers flow's routes the way the frame does,
 * and a stub host API.
 */

import { vi } from 'vitest';
import { setFlowRequester } from '../api.ts';
import type { ReadableState } from '../../lib/host-types.ts';
import type { FleetAccount, FleetGroup, FleetView } from '../../lib/fleet.ts';
import type { FlowModel, FlowProject, FlowRunRow } from '../../lib/model.ts';
import type { ProjectSettingsView } from '../../lib/settings-shape.ts';

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

/** A body that is not JSON, as an error page is: the frame hands it over as text. */
export const NO_JSON = Symbol('no-json');

/** What `NO_JSON` arrives as. */
const ERROR_PAGE = '<!doctype html><p>Bad gateway</p>';

/** One request as the frame's `api.request` takes it. */
type RequestOptions = { method?: string; body?: unknown };

/** The stub installed last, which {@link clientApi}'s `request` answers with too. */
let installed: ((path: string, options?: RequestOptions) => Promise<unknown>) | null = null;

/** Forget the stub, so no test answers with the one before (run after each test). */
export function resetRequests(): void {
  installed = null;
  setFlowRequester(null);
}

/**
 * Hand flow's calls a stub of the frame's `api.request`: a 2xx answer resolves
 * with its body; anything else rejects with its `status` and `body`, as the
 * frame does. `answer` throwing is a call DorkOS refused or nothing answered.
 */
function installRequest(
  answer: (method: string, path: string, body: unknown) => StubAnswer | Promise<StubAnswer>
) {
  const request = vi.fn(async (path: string, options: RequestOptions = {}) => {
    const reply = await answer(options.method ?? 'GET', path, options.body);
    const body = reply.body === NO_JSON ? ERROR_PAGE : reply.body;
    if (reply.status >= 200 && reply.status < 300) return body;
    throw Object.assign(new Error(`The app request failed (${reply.status}).`), {
      status: reply.status,
      body,
    });
  });
  installed = request;
  setFlowRequester({ request: request as never });
  return request;
}

/** One answer the stub gives. */
export interface StubAnswer {
  status: number;
  body: unknown;
}

/** A recorded request: its method, its path under `/api/ext/flow`, and its body. */
export interface StubCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Stub `api.request`: `GET` answers `initial`; each `PUT` answers the next of
 * `writes` (or, when none is left, a 200 with `initial`). Resolves each PUT
 * only when `hold` is false or `release()` is called.
 */
export function stubRequests(
  initial: StubAnswer,
  writes: StubAnswer[] = [],
  opts: { hold?: boolean } = {}
) {
  const calls: StubCall[] = [];
  const pending: { resolve: () => void; done: boolean }[] = [];
  installRequest(async (method, url, body) => {
    calls.push({ method, url, body });
    const answer = method === 'GET' ? initial : (writes.shift() ?? initial);
    if (method !== 'GET' && opts.hold) {
      await new Promise<void>((resolve) => pending.push({ resolve, done: false }));
    }
    return answer;
  });
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
    autonomy: null,
    sortWaits: false,
    pauseDefault: 'tomorrow',
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
 * Stub `api.request` by route: `answer(method, url, body)` returns the status
 * and body for each request, with `url` the path under `/api/ext/flow`. Records
 * every call. An `answer` that throws is a call that never reached flow.
 */
export function routeRequests(
  answer: (method: string, url: string, body: unknown) => StubAnswer | Promise<StubAnswer>
) {
  const calls: RoutedCall[] = [];
  const request = installRequest((method, url, body) => {
    calls.push({ method, url, body });
    return answer(method, url, body);
  });
  return { calls, request };
}

/** A `GET /settings/:name` body: every field at its default. */
export function settingsView(extra: Partial<ProjectSettingsView> = {}): ProjectSettingsView {
  const field = <T>(value: T) => ({ value, source: 'default' as const, locked: null });
  return {
    project: 'dorkos',
    root: '/work/dorkos',
    behaviour: 2,
    files: { shared: '.agents/flow/config.json', local: '.agents/flow/config.local.json' },
    tracker: { label: 'Linear', team: 'DOR' },
    shared: {
      reviewerAgent: field(true),
      mergeOnApproval: field(true),
      armAutoMerge: field(false),
      labels: field<string[]>([]),
    },
    local: {
      startsOnItsOwn: field<'auto' | 'manual'>('auto'),
      parallel: field(1),
    },
    pauseDefault: 'tomorrow',
    ...extra,
  };
}

/**
 * A stub of DorkOS's client API with every method flow's `minHostVersion`
 * guarantees: the chat is nowhere, and nothing registered or started does
 * anything. Spread it under a test's own fields.
 *
 * @param state - What `getState` answers.
 */
export function clientApi(state: ReadableState = { currentCwd: null }) {
  return {
    // `activate` hands flow this API: it answers with the stub installed last.
    request: vi.fn(async (path: string, options?: RequestOptions): Promise<never> => {
      if (installed === null)
        throw new Error('No request stub: use stubRequests or routeRequests.');
      return (await installed(path, options)) as never;
    }),
    navigate: vi.fn(),
    getState: () => state,
    subscribe: vi.fn(() => () => {}),
    registerSettingsTab: vi.fn(() => () => {}),
    registerComponent: vi.fn(() => () => {}),
    registerDialog: vi.fn(() => ({ open: vi.fn(), close: vi.fn() })),
    registerPage: vi.fn(() => () => {}),
    startWork: vi.fn(async () => ({ sessionId: 'started' })),
  };
}
