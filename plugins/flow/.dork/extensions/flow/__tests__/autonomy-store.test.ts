/**
 * Who answers, per project (spec `flow-multiproject` §7.7, N11): the dial is
 * read from core's person-only per-project settings and never written here;
 * the engine's copy follows it and is rewritten when anything else edits it;
 * a new project reads Tell me after, one with history keeps its "no copy"
 * behaviour until a person chooses; an accepted offer moves only its kind.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autonomyCopyPath, readAutonomyCopy, stopInForce } from '../../../../scripts/autonomy.ts';
import {
  AutonomyStore,
  FIRST_SEEN_KEY,
  REREAD_MS,
  offerPatch,
  stopOf,
} from '../lib/autonomy-store.ts';
import type { ProjectSettingsReader } from '../lib/host-types.ts';
import { SharedStorage } from '../lib/shared-storage.ts';

let dir: string;
let dorkHome: string;
let fresh: string;
let old: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flow-autonomy-'));
  dorkHome = path.join(dir, 'dork');
  fresh = path.join(dir, 'fresh');
  old = path.join(dir, 'old');
  mkdirSync(fresh, { recursive: true });
  // A project with history: a run in its store.
  mkdirSync(path.join(old, '.dork', 'flow'), { recursive: true });
  writeFileSync(
    path.join(old, '.dork', 'flow', 'flow-state.json'),
    JSON.stringify({ i1: { identifier: 'DOR-1', status: 'complete' } })
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `ctx.projectSettings` over a map a person changes. */
function settingsOf(values: Record<string, unknown> = {}) {
  const listeners: ((root: string) => void)[] = [];
  const reader: ProjectSettingsReader = {
    get: vi.fn(async (root: string) => (values[root] ?? null) as never),
    onChange: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  return {
    reader,
    values,
    /** A person changed a project's value. */
    set(root: string, value: unknown) {
      values[root] = value;
      for (const listener of listeners) listener(root);
    },
  };
}

/** A store over in-memory extension storage and a movable clock. */
function makeStore(settings?: ProjectSettingsReader, data: { value: unknown } = { value: null }) {
  let now = 1_000_000;
  const log = vi.fn();
  const storage = new SharedStorage({
    loadData: async <T>() => data.value as T,
    saveData: async (value) => {
      data.value = JSON.parse(JSON.stringify(value));
    },
  });
  const store = new AutonomyStore({ dorkHome, settings, storage, log, now: () => now });
  return { store, log, data, tick: (ms: number) => (now += ms) };
}

/** The engine's reading of a project's copy. */
function engineRead(root: string) {
  return readAutonomyCopy(autonomyCopyPath(dorkHome, root));
}

describe('the dial as flow reads it', () => {
  it('reads a new project as Tell me after, and writes the engine a copy saying so', async () => {
    const { store, data } = makeStore(settingsOf().reader);
    await store.sync([fresh]);
    expect(store.of(fresh)).toMatchObject({ chosen: false, firstSeen: 'new' });
    expect(store.stop(fresh, 'ship', true)).toBe('tell');
    const read = engineRead(fresh);
    expect(read.state).toBe('ok');
    expect(stopInForce(read, 'questions')).toBe('tell');
    expect((data.value as Record<string, unknown>)[FIRST_SEEN_KEY]).toEqual({ [fresh]: 'new' });
  });

  it('keeps a project with history as it was: no copy, so the engine asks, and fixes checks as before', async () => {
    const { store } = makeStore(settingsOf().reader);
    await store.sync([old]);
    expect(store.of(old)).toMatchObject({ copy: null, chosen: false, firstSeen: 'existing' });
    expect(store.stop(old, 'ship', true)).toBe('ask');
    expect(store.stop(old, 'retry', true)).toBe('tell');
    expect(engineRead(old).state).toBe('missing');
  });

  it('removes a copy nobody chose, planted by anything else', async () => {
    const { store, log } = makeStore(settingsOf().reader);
    const file = autonomyCopyPath(dorkHome, old);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ dial: 'auto' }));
    await store.sync([old]);
    expect(existsSync(file)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/did not write/));
  });

  it('follows what a person chose, and rewrites a copy edited on disk', async () => {
    const settings = settingsOf({ [old]: { dial: 'ask', kinds: { sort: 'auto' } } });
    const { store, log } = makeStore(settings.reader);
    await store.sync([old]);
    expect(store.of(old)?.chosen).toBe(true);
    expect(store.stop(old, 'sort', true)).toBe('auto');
    expect(store.stop(old, 'ship', true)).toBe('ask');
    // An agent edits the copy to give itself more room.
    const file = autonomyCopyPath(dorkHome, old);
    writeFileSync(file, JSON.stringify({ dial: 'auto' }));
    await store.sync([old]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      dial: 'ask',
      kinds: { sort: 'auto' },
      questionDeadlineMinutes: 240,
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/was changed; rewrote it/));
  });

  it("picks up a person's change at once, and reads again on its own after a minute", async () => {
    const settings = settingsOf();
    const { store, tick } = makeStore(settings.reader);
    await store.sync([fresh]);
    expect(store.stop(fresh, 'ship', true)).toBe('tell');
    settings.set(fresh, { dial: 'auto' });
    await store.sync([fresh]);
    expect(store.stop(fresh, 'ship', true)).toBe('auto');
    settings.values[fresh] = { dial: 'ask' };
    await store.sync([fresh]);
    expect(store.stop(fresh, 'ship', true)).toBe('auto');
    tick(REREAD_MS);
    await store.sync([fresh]);
    expect(store.stop(fresh, 'ship', true)).toBe('ask');
  });

  it('reads a stored value that is not a dial as Ask me first for everything', async () => {
    const { store } = makeStore(settingsOf({ [fresh]: { dial: 'sometimes' } }).reader);
    await store.sync([fresh]);
    for (const kind of ['ship', 'questions', 'sort', 'retry'] as const) {
      expect(store.stop(fresh, kind, true)).toBe('ask');
    }
    expect(stopInForce(engineRead(fresh), 'retry')).toBe('ask');
  });

  it('keeps shipping at Ask me first where no reviewer agent checks the work', async () => {
    const { store } = makeStore(settingsOf({ [fresh]: { dial: 'auto' } }).reader);
    await store.sync([fresh]);
    expect(store.stop(fresh, 'ship', false)).toBe('ask');
    expect(store.stop(fresh, 'questions', false)).toBe('auto');
  });

  it('remembers how it first saw a project across a restart', async () => {
    const data = { value: null as unknown };
    const first = makeStore(settingsOf().reader, data);
    await first.store.sync([fresh]);
    // The project gains history, then DorkOS restarts: still the new project's default.
    mkdirSync(path.join(fresh, '.dork', 'flow'), { recursive: true });
    writeFileSync(path.join(fresh, '.dork', 'flow', 'journal.jsonl'), '');
    const second = makeStore(settingsOf().reader, data);
    await second.store.sync([fresh]);
    expect(second.store.of(fresh)?.firstSeen).toBe('new');
  });

  it('reads and writes nothing on a DorkOS without per-project settings', async () => {
    const { store } = makeStore(undefined);
    expect(store.available).toBe(false);
    expect(await store.sync([fresh, old])).toBe(false);
    expect(engineRead(fresh).state).toBe('missing');
    expect(store.stop(fresh, 'ship', true)).toBe('ask');
    expect(store.stop(fresh, 'retry', true)).toBe('tell');
  });
});

describe('the stop in force and an offer’s patch', () => {
  it('answers the engine’s own "no copy" rule without a copy', () => {
    expect(stopOf(null, 'ship', true)).toBe('ask');
    expect(stopOf(null, 'retry', true)).toBe('tell');
  });

  it('moves only the kind offered, keeping everything else in force', () => {
    expect(
      offerPatch({ dial: 'ask', kinds: { sort: 'auto' }, questionDeadlineMinutes: 60 }, 'ship')
    ).toEqual({
      dial: 'ask',
      kinds: { sort: 'auto', ship: 'tell' },
    });
    // A project with no copy keeps fixing checks on its own after the patch.
    expect(offerPatch(null, 'questions')).toEqual({
      dial: 'ask',
      kinds: { retry: 'tell', questions: 'tell' },
    });
    expect(offerPatch(null, 'retry')).toEqual({ dial: 'ask', kinds: { retry: 'tell' } });
  });
});
