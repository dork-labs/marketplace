/**
 * The one live store (spec `flow-multiproject` §3.5): one event stream for
 * the whole extension; a model from the stream replaces the one on screen; a
 * read each time the stream opens and every 30 s while it is down; a new read
 * when the chat's folder changes; and the schedules a finished pause had
 * switched off are switched back on, as the person, then reported.
 */

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadableState } from '../../lib/host-types.ts';
import { FALLBACK_POLL_MS, FlowStore, MODEL_EVENT } from '../store.ts';
import { flowModel, flowProject, routeFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A stand-in `EventSource` that records every instance. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close() {
    this.closed = true;
  }
}

/** A host whose state the test can change. */
function host(initial: ReadableState) {
  let state = initial;
  let callback: ((value: unknown) => void) | null = null;
  return {
    getState: () => state,
    subscribe: vi.fn((_selector: unknown, cb: (value: unknown) => void) => {
      callback = cb;
      return () => {
        callback = null;
      };
    }),
    move(next: ReadableState) {
      state = next;
      callback?.(null);
    },
    get listening() {
      return callback !== null;
    },
  };
}

/** Let promises settle. */
async function settle() {
  await act(async () => {});
}

describe('FlowStore', () => {
  it('opens one stream, takes models from it, and reads again when it opens', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const first = flowModel([flowProject('dorkos')]);
    const fetch = routeFetch(() => ({ status: 200, body: first }));
    const api = host({ currentCwd: '/work/dorkos', currentProject: null });
    const store = new FlowStore(api);
    store.start();
    store.start();
    await settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/events');
    expect(store.get()).toMatchObject({ phase: 'ready', model: first, cwd: '/work/dorkos' });

    const pushed = flowModel([flowProject('dorkos'), flowProject('blintz')]);
    FakeEventSource.instances[0].emit(MODEL_EVENT, { data: JSON.stringify(pushed) });
    expect(store.get().model).toEqual(pushed);
    FakeEventSource.instances[0].emit(MODEL_EVENT, { data: 'not json' });
    expect(store.get().model).toEqual(pushed);

    FakeEventSource.instances[0].emit('open');
    await settle();
    expect(fetch.calls.filter((call) => call.method === 'GET')).toHaveLength(2);

    store.stop();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(api.listening).toBe(false);
  });

  it('reads every 30 s while the stream is down, and when the chat moves', async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetch = routeFetch(() => ({ status: 200, body: flowModel([]) }));
    const api = host({ currentCwd: '/a', currentProject: null });
    const store = new FlowStore(api);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = FakeEventSource.instances[0];
    stream.readyState = 2;
    stream.emit('error');
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(fetch.calls).toHaveLength(2);
    api.move({ currentCwd: '/b', currentProject: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.calls.at(-1)?.url).toBe('/api/ext/flow/model?cwd=%2Fb');
    stream.emit('open');
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 2);
    // Polling stopped once the stream opened: one read for the open, none after.
    expect(fetch.calls).toHaveLength(4);
    store.stop();
  });

  it('switches a finished pause’s schedules back on, then tells flow', async () => {
    const before = flowModel([flowProject('dorkos', { restoreSchedules: ['s-1', 's-2', 's-3'] })]);
    const after = flowModel([flowProject('dorkos', { restoreSchedules: ['s-3'] })]);
    const fetch = routeFetch((method, url) => {
      if (method === 'PATCH') {
        if (url.endsWith('/s-2')) return { status: 404, body: {} };
        if (url.endsWith('/s-3')) return { status: 403, body: {} };
        return { status: 200, body: {} };
      }
      if (method === 'POST') return { status: 200, body: after };
      return { status: 200, body: before };
    });
    const store = new FlowStore(host({ currentCwd: null }));
    store.start();
    await settle();
    await settle();
    const patches = fetch.calls.filter((call) => call.method === 'PATCH');
    expect(patches.map((call) => [call.url, call.body])).toEqual([
      ['/api/tasks/s-1', { enabled: true }],
      ['/api/tasks/s-2', { enabled: true }],
      ['/api/tasks/s-3', { enabled: true }],
    ]);
    // A deleted schedule is done too; the refused one stays, and the lens says so.
    expect(fetch.calls.find((call) => call.method === 'POST')).toMatchObject({
      url: '/api/ext/flow/schedules/restored',
      body: { project: 'dorkos', ids: ['s-1', 's-2'] },
    });
    expect(store.get().schedulesStuck.has('dorkos')).toBe(true);
    // The refused one is not asked again at once.
    store.apply(after);
    await settle();
    expect(fetch.calls.filter((call) => call.method === 'PATCH')).toHaveLength(3);
    store.stop();
  });

  it('switches nothing on where DorkOS cannot tell a person from an agent', async () => {
    const fetch = routeFetch(() => ({
      status: 200,
      body: flowModel([flowProject('dorkos', { restoreSchedules: ['s-1'] })], { canChange: false }),
    }));
    const store = new FlowStore(host({ currentCwd: null }));
    store.start();
    await settle();
    expect(fetch.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    store.stop();
  });
});
