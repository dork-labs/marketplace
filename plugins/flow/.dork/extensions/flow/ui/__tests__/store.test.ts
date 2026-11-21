/**
 * The live store (spec `flow-multiproject` §3.5), one per frame on DorkOS
 * client API v2: it reads the model when it starts, every 15 s and when the
 * chat's folder changes; it never opens DorkOS's event stream, which a frame
 * cannot reach; and it never touches a DorkOS schedule, which only a person
 * switches back on.
 */

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadableState } from '../../lib/host-types.ts';
import { FlowStore, POLL_MS, STALE_STORE_MS, storeIsFresh } from '../store.ts';
import { flowModel, flowProject, routeRequests } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
  it('reads when it starts and every 15 s, and when the chat moves; start is idempotent', async () => {
    vi.useFakeTimers();
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    const fetch = routeRequests(() => ({ status: 200, body: flowModel([]) }));
    const api = host({ currentCwd: '/a', currentProject: null });
    const store = new FlowStore(api);
    store.start();
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /folders']);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /folders',
      'GET /model?cwd=%2Fa',
    ]);
    api.move({ currentCwd: '/b', currentProject: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/folders',
      body: { cwd: '/b' },
    });
    // No stream: a frame has no network of its own.
    expect(eventSource).not.toHaveBeenCalled();
    store.stop();
    expect(api.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetch.calls).toHaveLength(3);
  });

  it('tells flow the folder again after a read fails, as the server may have restarted', async () => {
    let fail = false;
    const fetch = routeRequests(() =>
      fail ? { status: 502, body: {} } : { status: 200, body: flowModel([]) }
    );
    const store = new FlowStore(host({ currentCwd: '/a', currentProject: null }));
    store.start();
    await settle();
    await store.refresh();
    fail = true;
    await store.refresh();
    fail = false;
    await store.refresh();
    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /folders',
      'GET /model?cwd=%2Fa',
      'GET /model?cwd=%2Fa',
      'POST /folders',
    ]);
    store.stop();
  });

  it("tells flow about a chat's folder as the person, then only reads, and reads anyway when refused (DOR-3581)", async () => {
    const model = flowModel([flowProject('dorkos')]);
    let refuse = true;
    const fetch = routeRequests((method) =>
      method === 'POST' && refuse ? { status: 403, body: {} } : { status: 200, body: model }
    );
    const store = new FlowStore(host({ currentCwd: '/work/dorkos', currentProject: null }));
    store.start();
    await settle();
    // Refused: the tab still shows the model from a plain read.
    expect(store.get()).toMatchObject({ phase: 'ready', model });
    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /folders',
      'GET /model?cwd=%2Fwork%2Fdorkos',
    ]);
    expect(fetch.calls[0].body).toEqual({ cwd: '/work/dorkos' });
    // It asks again on the next read, and once it is through, only reads.
    refuse = false;
    await store.refresh();
    await store.refresh();
    expect(fetch.calls.slice(2).map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /folders',
      'GET /model?cwd=%2Fwork%2Fdorkos',
    ]);
    store.stop();
  });

  it('never switches a finished pause’s schedules back on itself: only a person can', async () => {
    const before = flowModel([flowProject('dorkos', { restoreSchedules: ['s-1', 's-2'] })]);
    const fetch = routeRequests(() => ({ status: 200, body: before }));
    const store = new FlowStore(host({ currentCwd: null }));
    store.start();
    await settle();
    await settle();
    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /model']);
    expect(store.get().model).toEqual(before);
    store.stop();
  });

  it('knows how fresh its facts are: for five minutes after a model arrived', async () => {
    routeRequests(() => ({ status: 200, body: flowModel([]) }));
    let now = 1_000_000;
    const store = new FlowStore(host({ currentCwd: null, currentProject: null }), () => now);
    expect(storeIsFresh(store.get(), now)).toBe(false);
    store.start();
    await settle();
    expect(store.get().heardAt).toBe(1_000_000);
    now += STALE_STORE_MS;
    expect(storeIsFresh(store.get(), now)).toBe(true);
    now += 1;
    expect(storeIsFresh(store.get(), now)).toBe(false);
    store.stop();
  });
});
