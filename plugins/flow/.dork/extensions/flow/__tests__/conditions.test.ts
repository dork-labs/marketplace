/**
 * When a condition reaches a person (spec `flow-multiproject` §7.1): ideas
 * waiting only at Ask me first after a day idle with room to work, never
 * while paused; the idle clock survives a restart; and a project's own
 * adapter runs only after a person allowed that exact file (§2.2).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterTrust, ownAdapterFile } from '../lib/adapter-trust.ts';
import { IDLE_BEFORE_ASK_MS, IdleClock, ideasAskDue, ideasWaiting } from '../lib/conditions.ts';
import { conditionsOf } from '../lib/model.ts';
import type { FlowProjectEntry } from '../lib/projects.ts';
import { SharedStorage } from '../lib/shared-storage.ts';
import { canReadOnTimer, type TrackerRead } from '../lib/tracker-reads.ts';

const NOW = new Date('2026-09-28T12:00:00.000Z');

/** A read that answered, with `next`'s facts. */
function read(facts: Partial<NonNullable<TrackerRead['facts']>>): TrackerRead {
  return {
    at: NOW.toISOString(),
    queue: { next: [], more: 0 },
    teamUrl: null,
    facts: { eligibleCount: 0, shapeableCount: 12, starved: true, atWipCap: false, ...facts },
    failure: null,
  };
}

/** Storage in memory. */
function memory(data: { value: unknown } = { value: null }) {
  return new SharedStorage({
    loadData: async <T>() => data.value as T,
    saveData: async (value) => {
      data.value = JSON.parse(JSON.stringify(value));
    },
  });
}

describe('ideas waiting', () => {
  it('counts ideas only when nothing is ready and the project is not at its limit', () => {
    expect(ideasWaiting(read({}))).toBe(12);
    expect(ideasWaiting(read({ eligibleCount: 2 }))).toBeNull();
    expect(ideasWaiting(read({ atWipCap: true }))).toBeNull();
    expect(ideasWaiting(read({ shapeableCount: 0 }))).toBeNull();
    expect(ideasWaiting(null)).toBeNull();
  });

  it('asks only at Ask me first, after 24 hours idle, with room to work, and never while paused', () => {
    const base = {
      waiting: 12,
      stop: 'ask' as const,
      idleSince: new Date(NOW.getTime() - IDLE_BEFORE_ASK_MS).toISOString(),
      busy: 0,
      slots: 1,
      paused: false,
      now: NOW,
    };
    expect(ideasAskDue(base)).toBe(true);
    expect(ideasAskDue({ ...base, stop: 'tell' })).toBe(false);
    expect(ideasAskDue({ ...base, stop: 'auto' })).toBe(false);
    expect(
      ideasAskDue({
        ...base,
        idleSince: new Date(NOW.getTime() - IDLE_BEFORE_ASK_MS + 1).toISOString(),
      })
    ).toBe(false);
    expect(ideasAskDue({ ...base, busy: 1 })).toBe(false);
    expect(ideasAskDue({ ...base, paused: true })).toBe(false);
    expect(ideasAskDue({ ...base, idleSince: null })).toBe(false);
    expect(ideasAskDue({ ...base, waiting: null })).toBe(false);
  });

  it('shows the condition with its count only when due, and never raises for a slow tracker', () => {
    const since = '2026-09-27T09:00:00.000Z';
    expect(
      conditionsOf(null, read({}), NOW, {
        ideas: { waiting: 12, idleSince: since, due: true },
        escalated: new Set(['nothing-ready']),
      })
    ).toEqual([{ kind: 'nothing-ready', since, escalated: true, detail: { untriaged: 12 } }]);
    expect(
      conditionsOf(null, read({}), NOW, { ideas: { waiting: 12, idleSince: since, due: false } })
    ).toEqual([]);
    const slow: TrackerRead = {
      ...read({}),
      failure: { kind: 'unreachable', since: NOW.toISOString() },
    };
    expect(conditionsOf(null, slow, NOW)).toEqual([]);
  });
});

describe('the idle clock', () => {
  it('starts when nothing runs, stops when something does, and survives a restart', async () => {
    const data = { value: null as unknown };
    const clock = new IdleClock(memory(data));
    const first = await clock.note(
      new Map([
        ['/a', false],
        ['/b', true],
      ]),
      NOW
    );
    expect(first.get('/a')).toBe(NOW.toISOString());
    expect(first.get('/b')).toBeNull();
    const later = new Date(NOW.getTime() + 60_000);
    const again = await new IdleClock(memory(data)).note(new Map([['/a', false]]), later);
    expect(again.get('/a')).toBe(NOW.toISOString());
    const busy = await new IdleClock(memory(data)).note(new Map([['/a', true]]), later);
    expect(busy.get('/a')).toBeNull();
  });
});

describe("a project's own adapter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'flow-trust-'));
    mkdirSync(path.dirname(ownAdapterFile(dir, 'linear')), { recursive: true });
    writeFileSync(ownAdapterFile(dir, 'linear'), 'export const adapter = 1;\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs only after a person allowed that exact file, and asks again when it changes', async () => {
    const data = { value: null as unknown };
    const trust = new AdapterTrust(memory(data));
    expect(await trust.isAllowed(dir, 'linear')).toBe(false);
    expect(await trust.allow(dir, 'linear')).toBe(true);
    expect(await trust.isAllowed(dir, 'linear')).toBe(true);
    // Kept in storage: a restart still knows.
    expect(await new AdapterTrust(memory(data)).isAllowed(dir, 'linear')).toBe(true);
    writeFileSync(ownAdapterFile(dir, 'linear'), 'export const adapter = 2;\n');
    expect(await trust.isAllowed(dir, 'linear')).toBe(false);
    expect(await trust.allow(dir, 'nope')).toBe(false);
  });

  it('reads the tracker on the timer with the shipped adapter, and with its own only once allowed', () => {
    const entry = (adapter: 'shipped' | 'project' | 'other'): FlowProjectEntry => ({
      root: dir,
      name: 'x',
      setup: 'ready',
      tracker: { id: 'linear', label: 'Linear', team: null, transport: 'cli', adapter },
      version: { flow: null, behaviour: 1, olderBehaviour: null },
    });
    expect(canReadOnTimer(entry('shipped'))).toBe(true);
    expect(canReadOnTimer(entry('project'))).toBe(false);
    expect(canReadOnTimer(entry('project'), true)).toBe(true);
    expect(canReadOnTimer(entry('other'), true)).toBe(false);
  });
});
