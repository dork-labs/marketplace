import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { panelSnapshot, PANEL_TTL_MS } from '../scripts/tracker/panel-cache.ts';
import { readSnapshotFile } from '../scripts/cli/backlog.ts';
import { TrackerError } from '../scripts/errors.ts';
import type { BacklogSnapshot } from '../scripts/tracker/types.ts';

const dirs: string[] = [];
function dir() {
  const d = mkdtempSync(path.join(tmpdir(), 'panel-cache-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const snapshot: BacklogSnapshot = {
  v: 1,
  tracker: 'fake',
  team: { id: 'team', key: 'SYN' },
  fetchedAt: '2026-01-01T00:00:00.000Z',
  items: [],
  projects: [],
  closed: [],
};

it('shares a fresh snapshot across projects and reader instances, and passes the watermark on refresh', async () => {
  const cache = dir();
  let calls = 0;
  let now = Date.parse(snapshot.fetchedAt);
  const refresh = async (previous: BacklogSnapshot | null, since: string | null) => {
    calls++;
    if (calls === 2) {
      expect(previous?.panelOnly).toBe(true);
      expect(since).toBe('2025-12-31T23:59:00.000Z');
    }
    return snapshot;
  };
  const read = () =>
    panelSnapshot({ dir: cache, account: 'account', team: 'team', now: () => now, refresh });
  expect((await read()).panelOnly).toBe(true);
  await read();
  expect(calls).toBe(1);
  now += PANEL_TTL_MS;
  await read();
  expect(calls).toBe(2);
});
it('persists an account-wide rate limit and honours a later reset without calling the reader', async () => {
  const cache = dir();
  let calls = 0;
  const now = Date.parse(snapshot.fetchedAt);
  const reset = now + 3_600_000;
  const refresh = async () => {
    calls++;
    throw new TrackerError('private ticket credential', {
      kind: 'rate-limited',
      retryAt: new Date(reset).toISOString(),
    });
  };
  await expect(
    panelSnapshot({ dir: cache, account: 'a', team: 'one', now: () => now, refresh })
  ).rejects.toMatchObject({ kind: 'rate-limited' });
  await expect(
    panelSnapshot({ dir: cache, account: 'a', team: 'two', now: () => now + 60_000, refresh })
  ).rejects.toMatchObject({ kind: 'rate-limited', retryAt: new Date(reset).toISOString() });
  expect(calls).toBe(1);
});
it('serializes concurrent readers without a second tracker call', async () => {
  const cache = dir();
  let finish!: (s: BacklogSnapshot) => void;
  let calls = 0;
  const refresh = () => {
    calls++;
    return new Promise<BacklogSnapshot>((resolve) => {
      finish = resolve;
    });
  };
  const options = {
    dir: cache,
    account: 'a',
    team: 't',
    now: () => Date.parse(snapshot.fetchedAt),
    refresh,
  };
  const first = panelSnapshot(options);
  await new Promise((r) => setTimeout(r, 10));
  await expect(panelSnapshot(options)).rejects.toMatchObject({ kind: 'unreachable' });
  finish(snapshot);
  await first;
  await panelSnapshot(options);
  expect(calls).toBe(1);
});
it('never shares data between accounts', async () => {
  const cache = dir();
  let calls = 0;
  const refresh = async () => {
    calls++;
    return snapshot;
  };
  for (const account of ['a', 'b'])
    await panelSnapshot({
      dir: cache,
      account,
      team: 't',
      now: () => Date.parse(snapshot.fetchedAt),
      refresh,
    });
  expect(calls).toBe(2);
});

it('refuses panel files as ordinary snapshots, requiring an explicit read-only opt in', () => {
  const file = path.join(dir(), 'snapshot.json');
  writeFileSync(file, JSON.stringify({ ...snapshot, panelOnly: true }));
  expect(() => readSnapshotFile(file)).toThrow(/cannot be used/);
  expect(readSnapshotFile(file, true).panelOnly).toBe(true);
});
it('shares aliases of the same resolved team', async () => {
  const cache = dir();
  let calls = 0;
  for (const team of ['KEY', 'id'])
    await panelSnapshot({
      dir: cache,
      account: 'a',
      team,
      resolveTeam: async () => 'resolved-team',
      now: () => Date.parse(snapshot.fetchedAt),
      refresh: async () => {
        calls++;
        return snapshot;
      },
    });
  expect(calls).toBe(1);
});
it('reserves a cooldown before a refresh, so an interrupted child cannot immediately repeat it', async () => {
  const cache = dir();
  const now = Date.parse(snapshot.fetchedAt);
  await expect(
    panelSnapshot({
      dir: cache,
      account: 'a',
      team: 't',
      now: () => now,
      refresh: async () => {
        throw new Error('synthetic killed child');
      },
    })
  ).rejects.toMatchObject({ kind: 'unreachable' });
  let calls = 0;
  await expect(
    panelSnapshot({
      dir: cache,
      account: 'a',
      team: 't',
      now: () => now + 300_000,
      refresh: async () => {
        calls++;
        return snapshot;
      },
    })
  ).rejects.toMatchObject({ kind: 'unreachable' });
  expect(calls).toBe(0);
});
