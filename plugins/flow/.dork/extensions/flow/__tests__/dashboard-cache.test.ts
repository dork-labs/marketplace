/**
 * The dashboard's cache (spec "Flow Dashboard", M1): one small JSON file per
 * project and page under `<dorkHome>/flow/cache/<projectId>/dashboard/`, each
 * source with its own `fetchedAt` and `error`. One source failing never blanks
 * the others, and keeps what it last read; a page asking reads again only when
 * the last read is over a minute old; two asks at once share one read; and a
 * file that cannot be read is rebuilt.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_REFRESH_MS,
  DASHBOARD_STALE_ON_VIEW_MS,
  DashboardCache,
  type SourcePlan,
} from '../lib/dashboard/cache.ts';
import { projectIdOf } from '../lib/tracker-reads.ts';

let dorkHome: string;
let clock: number;

beforeEach(() => {
  dorkHome = mkdtempSync(path.join(tmpdir(), 'flow-dash-cache-'));
  clock = Date.parse('2026-10-03T12:00:00.000Z');
});

afterEach(() => {
  rmSync(dorkHome, { recursive: true, force: true });
});

const ROOT = '/work/app';

/** A cache over the temp home and a clock the test moves. */
function cache(log: (message: string) => void = () => {}) {
  return new DashboardCache({ dorkHome, now: () => new Date(clock), log });
}

/** A source that answers `items`, or throws `error`. */
function plan(id: string, outcome: { items?: string[]; error?: string }): SourcePlan<string> {
  return {
    id,
    label: id.split(':')[1] ?? id,
    read: vi.fn(async () => {
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return { items: outcome.items ?? [] };
    }),
  };
}

describe('DashboardCache', () => {
  it('writes each page to its own file under the project id', async () => {
    await cache().refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1'] })]);
    const file = path.join(dorkHome, 'flow', 'cache', projectIdOf(ROOT), 'dashboard', 'prs.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.v).toBe(1);
    expect(stored.sources['github:acme/app']).toMatchObject({
      fetchedAt: '2026-10-03T12:00:00.000Z',
      error: null,
      items: ['#1'],
    });
  });

  it('serves the sources that answered when one throws, and records its error', async () => {
    const read = await cache().refresh(ROOT, 'issues', [
      plan('tracker:ACME', { error: 'the tracker did not answer' }),
      plan('github:acme/app', { items: ['acme/app#7'] }),
    ]);
    expect(read.sources.map((source) => [source.id, source.error, source.items])).toEqual([
      ['tracker:ACME', 'the tracker did not answer', []],
      ['github:acme/app', null, ['acme/app#7']],
    ]);
    expect(read.sources[0].fetchedAt).toBeNull();
  });

  it('keeps what a source last read, and when, after it starts failing', async () => {
    const c = cache();
    await c.refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1', '#2'] })]);
    clock += DASHBOARD_REFRESH_MS;
    const read = await c.refresh(ROOT, 'prs', [plan('github:acme/app', { error: 'HTTP 502' })]);
    expect(read.sources[0]).toMatchObject({
      fetchedAt: '2026-10-03T12:00:00.000Z',
      error: 'HTTP 502',
      items: ['#1', '#2'],
    });
  });

  it("takes a source's own time when it says when it read, and its note", async () => {
    const read = await cache().refresh(ROOT, 'issues', [
      {
        id: 'tracker:ACME',
        label: 'ACME',
        read: async () => ({
          items: ['ACME-1'],
          fetchedAt: '2026-10-03T11:58:00.000Z',
          note: 'Showing 50 of 80',
          viewer: 'octo',
        }),
      },
    ]);
    expect(read.sources[0]).toMatchObject({
      fetchedAt: '2026-10-03T11:58:00.000Z',
      note: 'Showing 50 of 80',
      viewer: 'octo',
    });
  });

  it('drops a source no longer configured', async () => {
    const c = cache();
    await c.refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1'] }), plan('github:acme/old', { items: ['#9'] })]);
    const read = await c.refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1'] })]);
    expect(read.sources.map((source) => source.id)).toEqual(['github:acme/app']);
  });

  it('reads again on a view only when the last read is over a minute old', async () => {
    const c = cache();
    const source = plan('github:acme/app', { items: ['#1'] });
    await c.fresh(ROOT, 'prs', () => [source], DASHBOARD_STALE_ON_VIEW_MS);
    clock += DASHBOARD_STALE_ON_VIEW_MS - 1;
    await c.fresh(ROOT, 'prs', () => [source], DASHBOARD_STALE_ON_VIEW_MS);
    expect(source.read).toHaveBeenCalledTimes(1);
    clock += 2;
    await c.fresh(ROOT, 'prs', () => [source], DASHBOARD_STALE_ON_VIEW_MS);
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it('does not read again within a minute even when every source failed', async () => {
    const c = cache();
    const source = plan('github:acme/app', { error: 'HTTP 502' });
    await c.fresh(ROOT, 'prs', () => [source], DASHBOARD_STALE_ON_VIEW_MS);
    await c.fresh(ROOT, 'prs', () => [source], DASHBOARD_STALE_ON_VIEW_MS);
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('shares one read between two asks at once', async () => {
    const c = cache();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => {
      await gate;
      return { items: ['#1'] };
    });
    const source: SourcePlan<string> = { id: 'github:acme/app', label: 'acme/app', read };
    const first = c.refresh(ROOT, 'prs', [source]);
    const second = c.refresh(ROOT, 'prs', [source]);
    release();
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('picks up the file a previous run wrote, and rebuilds one it cannot read', async () => {
    await cache().refresh(ROOT, 'releases', [plan('product:app', { items: ['app'] })]);
    const again = cache();
    expect(again.load(ROOT, 'releases').sources.map((s) => s.items)).toEqual([['app']]);
    expect(again.ageMs(ROOT, 'releases')).toBe(0);

    const dir = path.join(dorkHome, 'flow', 'cache', projectIdOf(ROOT), 'dashboard');
    writeFileSync(path.join(dir, 'issues.json'), '{ not json');
    const broken = cache();
    expect(broken.load(ROOT, 'issues').sources).toEqual([]);
    expect(broken.ageMs(ROOT, 'issues')).toBeNull();
  });

  it('keeps serving from memory when the file cannot be written, and says so once', async () => {
    const log = vi.fn();
    mkdirSync(path.join(dorkHome, 'flow', 'cache', projectIdOf(ROOT)), { recursive: true });
    // A file where the folder should be makes every write fail.
    writeFileSync(path.join(dorkHome, 'flow', 'cache', projectIdOf(ROOT), 'dashboard'), 'x');
    const c = cache(log);
    const read = await c.refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1'] })]);
    await c.refresh(ROOT, 'prs', [plan('github:acme/app', { items: ['#1'] })]);
    expect(read.sources[0].items).toEqual(['#1']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dorkHome, 'flow', 'cache', projectIdOf(ROOT), 'dashboard', 'prs.json'))).toBe(false);
  });
});
