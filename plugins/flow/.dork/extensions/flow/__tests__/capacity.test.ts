/**
 * "Capacity this week" (spec `flow-multiproject` §4.4): the week starts on
 * Monday at midnight; the journal's stage pairs add up to hours inside the
 * week only, a stage still running adds nothing, `done` ends count items
 * finished, handoffs count; broken lines are skipped; a project with its
 * journal off says so; each account's weekly window comes from DorkOS; and
 * `GET /capacity` answers it (its 501 on an older DorkOS is in
 * `model-routes.test.ts`, with every other route's).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCapacity,
  journalEnabled,
  parseSince,
  readJournalWeek,
  sumJournal,
  weekStart,
  type CapacityView,
} from '../lib/capacity.ts';
import type { AccountUsage } from '../lib/host-types.ts';
import { createFlowExtension } from '../server.ts';
import { SUMMARIES, fakeCtx, fakeRouter, makeWorld, type World } from './fixtures.ts';

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

const SINCE = new Date('2026-09-28T00:00:00.000Z');
const NOW = new Date('2026-09-30T12:00:00.000Z');

/** One journal line. */
function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, flow: '0.50.0', ...fields });
}

describe('the week', () => {
  it('starts on Monday at midnight, local time', () => {
    expect(weekStart(new Date(2026, 8, 30, 15, 0))).toEqual(new Date(2026, 8, 28));
    expect(weekStart(new Date(2026, 8, 28, 0, 1))).toEqual(new Date(2026, 8, 28));
    expect(weekStart(new Date(2026, 9, 4, 23, 59))).toEqual(new Date(2026, 8, 28));
  });

  it('takes the browser’s own Monday, and falls back to the server’s for anything odd', () => {
    expect(parseSince('2026-09-28T00:00:00-05:00', NOW).toISOString()).toBe(
      '2026-09-28T05:00:00.000Z'
    );
    for (const raw of [undefined, 'soon', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z']) {
      expect(parseSince(raw, NOW)).toEqual(weekStart(NOW));
    }
  });
});

describe('sumJournal', () => {
  it('adds each stage’s start-to-end time inside the week, and nothing for one still running', () => {
    const week = sumJournal(
      [
        // Started before the week: only the part inside it counts (1h).
        line({
          ts: '2026-09-27T23:00:00.000Z',
          kind: 'stage',
          item: 'A-1',
          stage: 'execute',
          phase: 'start',
        }),
        line({
          ts: '2026-09-28T01:00:00.000Z',
          kind: 'stage',
          item: 'A-1',
          stage: 'execute',
          phase: 'end',
        }),
        // 2h.
        line({
          ts: '2026-09-29T10:00:00.000Z',
          kind: 'stage',
          item: 'A-2',
          stage: 'verify',
          phase: 'start',
        }),
        line({
          ts: '2026-09-29T12:00:00.000Z',
          kind: 'stage',
          item: 'A-2',
          stage: 'verify',
          phase: 'end',
        }),
        // Still running: nothing.
        line({
          ts: '2026-09-30T11:00:00.000Z',
          kind: 'stage',
          item: 'A-3',
          stage: 'execute',
          phase: 'start',
        }),
        // An end with no start: nothing.
        line({
          ts: '2026-09-30T11:30:00.000Z',
          kind: 'stage',
          item: 'A-4',
          stage: 'execute',
          phase: 'end',
        }),
        'not json',
        line({ kind: 'stage', item: 'A-5', stage: 'execute', phase: 'start' }),
      ],
      SINCE,
      NOW
    );
    expect(week.hours).toBe(3);
  });

  it('counts items finished and handoffs this week only', () => {
    const week = sumJournal(
      [
        line({
          ts: '2026-09-29T09:00:00.000Z',
          kind: 'stage',
          item: 'A-1',
          stage: 'done',
          phase: 'start',
        }),
        line({
          ts: '2026-09-29T09:01:00.000Z',
          kind: 'stage',
          item: 'A-1',
          stage: 'done',
          phase: 'end',
        }),
        line({
          ts: '2026-09-29T10:00:00.000Z',
          kind: 'stage',
          item: 'A-1',
          stage: 'done',
          phase: 'end',
        }),
        line({
          ts: '2026-09-27T10:00:00.000Z',
          kind: 'stage',
          item: 'A-2',
          stage: 'done',
          phase: 'end',
        }),
        line({
          ts: '2026-09-29T10:00:00.000Z',
          kind: 'handoff',
          from: 'work',
          to: 'personal',
          reason: 'limit',
        }),
        line({
          ts: '2026-09-20T10:00:00.000Z',
          kind: 'handoff',
          from: 'work',
          to: 'personal',
          reason: 'limit',
        }),
      ],
      SINCE,
      NOW
    );
    expect(week).toMatchObject({ finished: 1, handoffs: 1 });
  });
});

/** Write a project's journal files. */
function writeJournal(root: string, file: string, lines: string[]): void {
  mkdirSync(path.join(root, '.dork', 'flow'), { recursive: true });
  writeFileSync(path.join(root, '.dork', 'flow', file), `${lines.join('\n')}\n`);
}

/** Write a project's flow settings. */
function configure(root: string, file: string, config: Record<string, unknown>): void {
  mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'flow', file), JSON.stringify(config));
}

describe('reading a project', () => {
  it('reads the rotated file before the current one, so a pair split across them counts', async () => {
    writeJournal(world.main, 'journal.1.jsonl', [
      line({
        ts: '2026-09-29T10:00:00.000Z',
        kind: 'stage',
        item: 'A-1',
        stage: 'execute',
        phase: 'start',
      }),
    ]);
    writeJournal(world.main, 'journal.jsonl', [
      line({
        ts: '2026-09-29T11:30:00.000Z',
        kind: 'stage',
        item: 'A-1',
        stage: 'execute',
        phase: 'end',
      }),
    ]);
    expect((await readJournalWeek(world.main, SINCE, NOW)).hours).toBe(1.5);
    expect(await readJournalWeek(path.join(world.root, 'nowhere'), SINCE, NOW)).toEqual({
      hours: 0,
      finished: 0,
      handoffs: 0,
    });
  });

  it('knows a journal that is off, with this computer’s settings over the shared ones', () => {
    expect(journalEnabled(world.main)).toBe(true);
    configure(world.main, 'config.json', { selfImprovement: { journal: { enabled: false } } });
    expect(journalEnabled(world.main)).toBe(false);
    configure(world.main, 'config.local.json', { selfImprovement: { journal: { enabled: true } } });
    expect(journalEnabled(world.main)).toBe(true);
  });
});

/** An account's usage with a weekly window. */
function usage(runtime: string, accountId: string | null, usedPct: number | null): AccountUsage {
  return {
    runtime,
    accountId,
    label: null,
    color: '#000000',
    windows: [
      {
        key: 'seven_day',
        label: 'Week',
        usedPct,
        resetsAt: '2026-10-01T15:00:00.000Z',
        status: 'allowed',
        expired: false,
        observedAt: NOW.toISOString(),
        source: 'test',
      },
    ],
    state: 'ok',
    limit: null,
    updatedAt: NOW.toISOString(),
  };
}

describe('buildCapacity', () => {
  it('lists every account with its week, and every project by name', async () => {
    configure(world.main, 'config.json', { selfImprovement: { journal: { enabled: false } } });
    const view = await buildCapacity({
      dorkHome: world.dorkHome,
      summaries: SUMMARIES,
      usage: [usage('claude-code', 'work', 64), usage('codex', null, 12)],
      projects: [
        { name: 'zeta', root: path.join(world.root, 'nowhere') },
        { name: 'main', root: world.main },
      ],
      since: SINCE,
      now: NOW,
    });
    expect(view.accounts.map((a) => [a.key, a.usedPct])).toEqual([
      ['claude-code:work', 64],
      ['claude-code:personal', null],
      ['codex:default', 12],
    ]);
    expect(view.accounts[0]).toMatchObject({ label: 'Work', resetsAt: '2026-10-01T15:00:00.000Z' });
    expect(view.projects.map((p) => [p.name, p.journal])).toEqual([
      ['main', 'off'],
      ['zeta', 'on'],
    ]);
    expect(view.since).toBe(SINCE.toISOString());
  });
});

describe('GET /capacity', () => {
  it('answers the week for the flow projects flow knows', async () => {
    configure(world.main, 'config.json', {});
    writeJournal(world.main, 'journal.jsonl', [
      line({
        ts: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        kind: 'handoff',
        from: 'a',
        to: 'b',
        reason: 'limit',
      }),
    ]);
    const router = fakeRouter();
    const host = fakeCtx(world, { usage: [usage('claude-code', 'work', 40)] });
    const ext = createFlowExtension(router, host.ctx, {
      originOf: () => null,
      log: () => {},
      execFile: (_file, _args, _opts, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error('no'), { code: 4 }), '', ''));
        return undefined;
      },
      pidAlive: () => true,
    });
    await router.call('get', '/model', { query: { cwd: world.worktree } });
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const sent = await router.call('get', '/capacity', { query: { since } });
    expect(sent.status).toBe(200);
    const view = sent.body as CapacityView;
    expect(view.accounts.find((a) => a.key === 'claude-code:work')?.usedPct).toBe(40);
    expect(view.projects).toEqual([
      expect.objectContaining({ name: 'main', journal: 'on', handoffs: 1 }),
    ]);
    ext.dispose();
  });
});
