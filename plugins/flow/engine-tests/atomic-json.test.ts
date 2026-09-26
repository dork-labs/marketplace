/**
 * Unit suite for the shared lock-and-rename JSON writer (`scripts/atomic-json.ts`,
 * spec `flow-cli-core` §1.2 "Writing").
 *
 * Every file two processes share (the usage ledger, `fleet.json`,
 * `flow-state.json`) is written through this one module, and DorkOS implements the
 * same steps on its side. These tests pin the steps one by one in a single
 * process; the cross-process proofs (8 writers, two breakers racing for one stale
 * lock) live in `fleet-concurrency.test.ts`.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCK_GIVE_UP_MS,
  LOCK_STALE_MS,
  acquireLock,
  breakStaleLock,
  readJsonFile,
  releaseLock,
  updateJsonFile,
} from '../scripts/atomic-json.ts';

let dir: string;
let file: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flow-atomic-json-'));
  file = path.join(dir, 'data.json');
  lock = `${file}.lock`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Push a file's mtime into the past so the lock reads as stale. */
function age(target: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(target, when, when);
}

/** Every name in the test folder, sorted, to catch leftovers. */
function names(): string[] {
  return readdirSync(dir).sort();
}

describe('the contract constants', () => {
  // Purpose: the 10 s stale age and 2 s give-up are shared with DorkOS. A change
  // here is a contract change, so pin the numbers themselves.
  it('uses a 10 s stale age and gives up after 2 s', () => {
    expect(LOCK_STALE_MS).toBe(10_000);
    expect(LOCK_GIVE_UP_MS).toBe(2_000);
  });
});

describe('updateJsonFile', () => {
  // Purpose: the happy path creates the folder 0700 and the file 0600, merges
  // the caller's change, and leaves no lock or temp file behind.
  it('creates a missing file with private modes and cleans up', async () => {
    const nested = path.join(dir, 'a', 'b', 'data.json');
    const result = await updateJsonFile(nested, (current) => {
      expect(current).toBeUndefined();
      return { hello: 'world' };
    });
    expect(result.status).toBe('written');
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ hello: 'world' });
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, 'a')).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(dir, 'a', 'b'))).toEqual(['data.json']);
  });

  // Purpose: the merge sees what is on disk, so two sequential writers compose
  // instead of the second overwriting the first.
  it('hands the current contents to the merge callback', async () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    const result = await updateJsonFile(file, (current) => ({
      ...(current as object),
      b: 2,
    }));
    expect(result.status).toBe('written');
    expect(result.value).toEqual({ a: 1, b: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1, b: 2 });
  });

  // Purpose: step 5, "if nothing changed, release the lock and stop". A replay
  // must not touch the file (its mtime and bytes stay), or every status-line
  // tick would rewrite the ledger.
  it('skips the write when the merge changes nothing', async () => {
    writeFileSync(file, '{"a":1}');
    age(file, 60_000);
    const before = statSync(file).mtimeMs;
    const result = await updateJsonFile(file, (current) => current);
    expect(result.status).toBe('unchanged');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(statSync(file).mtimeMs).toBe(before);
    expect(names()).toEqual(['data.json']);
  });

  // Purpose: step 4, an unparsable file is set aside under
  // `<file>.corrupt-<epoch ms>` (never deleted) and the merge starts empty.
  it('quarantines an unparsable file and starts empty', async () => {
    writeFileSync(file, '{not json');
    const result = await updateJsonFile(file, (current) => ({ seen: current ?? null }), {
      now: () => 1_700_000_000_000,
    });
    expect(result.status).toBe('written');
    expect(result.warnings.map((w) => w.code)).toEqual(['file-corrupt']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ seen: null });
    expect(readFileSync(`${file}.corrupt-1700000000000`, 'utf8')).toBe('{not json');
  });

  // Purpose: flow-state.json must never be replaced when it cannot be read
  // (§1.3), so a caller can ask for a refusal instead of the quarantine.
  it('can refuse an unparsable file and leave it byte-for-byte alone', async () => {
    writeFileSync(file, '{not json');
    await expect(updateJsonFile(file, () => ({ x: 1 }), { onUnparsable: 'throw' })).rejects.toThrow(
      /data\.json/
    );
    expect(readFileSync(file, 'utf8')).toBe('{not json');
    expect(names()).toEqual(['data.json']);
  });

  // Purpose: an error from the caller's own merge propagates (it is the
  // caller's decision), but the lock is still released, so the next writer is
  // not stuck behind it for 10 s.
  it('releases the lock when the merge throws', async () => {
    await expect(
      updateJsonFile(file, () => {
        throw new Error('merge refused');
      })
    ).rejects.toThrow('merge refused');
    expect(existsSync(lock)).toBe(false);
  });

  // Purpose: step 3, a writer that cannot get the lock within the give-up time
  // drops its write with a warning and never throws into the caller's turn.
  it('drops the write with a warning when the lock never frees', async () => {
    writeFileSync(lock, 'someone:else');
    const started = Date.now();
    const result = await updateJsonFile(file, () => ({ x: 1 }), { giveUpMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(result.status).toBe('dropped');
    expect(result.warnings.map((w) => w.code)).toEqual(['lock-timeout']);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('someone:else');
  });

  // Purpose: an async merge holds the lock across its await, so two writers in
  // one process serialize rather than both reading the same old contents.
  it('serializes two writers in one process', async () => {
    const slow = updateJsonFile(file, async (current) => {
      await new Promise((r) => setTimeout(r, 80));
      return { ...(current as object), a: 1 };
    });
    await new Promise((r) => setTimeout(r, 10));
    const fast = updateJsonFile(file, (current) => ({ ...(current as object), b: 2 }));
    const [a, b] = await Promise.all([slow, fast]);
    expect([a.status, b.status]).toEqual(['written', 'written']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1, b: 2 });
  });
});

describe('readJsonFile', () => {
  // Purpose: readers take no lock; missing reads as empty and unparsable reads
  // as empty with a warning, and neither is modified.
  it('reads missing and unparsable files as empty', () => {
    expect(readJsonFile(file)).toEqual({ value: undefined, warnings: [] });
    writeFileSync(file, 'nope');
    const read = readJsonFile(file);
    expect(read.value).toBeUndefined();
    expect(read.warnings.map((w) => w.code)).toEqual(['file-corrupt']);
    expect(readFileSync(file, 'utf8')).toBe('nope');
  });
});

describe('the lock', () => {
  // Purpose: step 1, the lock file holds a `<pid>:<128-bit hex>` token, so the
  // holder is identified by token, not by pid.
  it('writes a pid-and-random token', async () => {
    const held = await acquireLock(lock);
    expect(held).not.toBeNull();
    expect(held!.token).toMatch(new RegExp(`^${process.pid}:[0-9a-f]{32}$`));
    expect(readFileSync(lock, 'utf8')).toBe(held!.token);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    releaseLock(lock, held!.token);
    expect(existsSync(lock)).toBe(false);
  });

  // Purpose: a live (fresh) lock is waited on, not broken: the second writer
  // gets it only after the holder releases.
  it('waits on a live lock', async () => {
    writeFileSync(lock, 'holder:1');
    setTimeout(() => rmSync(lock), 150);
    const started = Date.now();
    const held = await acquireLock(lock);
    expect(held).not.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(held!.broke).toBe(0);
    releaseLock(lock, held!.token);
  });

  // Purpose: step 2, a lock older than 10 s is broken and taken over, and the
  // broken lock is moved aside and removed, never deleted by its original name.
  it('breaks a stale lock', async () => {
    writeFileSync(lock, 'dead:1');
    age(lock, LOCK_STALE_MS + 1_000);
    const held = await acquireLock(lock);
    expect(held).not.toBeNull();
    expect(held!.broke).toBe(1);
    expect(readFileSync(lock, 'utf8')).toBe(held!.token);
    expect(names()).toEqual(['data.json.lock']);
    releaseLock(lock, held!.token);
  });

  // Purpose: a lock just under the stale age is still live.
  it('does not break a lock younger than 10 s', async () => {
    writeFileSync(lock, 'alive:1');
    age(lock, LOCK_STALE_MS - 2_000);
    const held = await acquireLock(lock, { giveUpMs: 100 });
    expect(held).toBeNull();
    expect(readFileSync(lock, 'utf8')).toBe('alive:1');
  });

  // Purpose: step 7, release deletes the lock only if it still holds this
  // writer's token. Two writers in ONE process (same pid) must never release
  // each other's lock: A holds past the stale age, B breaks it and takes over,
  // then A's late release must leave B's lock alone.
  it('never releases another writer in the same process', async () => {
    const a = await acquireLock(lock);
    expect(a).not.toBeNull();
    age(lock, LOCK_STALE_MS + 1_000);
    const b = await acquireLock(lock);
    expect(b).not.toBeNull();
    expect(b!.broke).toBe(1);
    releaseLock(lock, a!.token);
    expect(readFileSync(lock, 'utf8')).toBe(b!.token);
    releaseLock(lock, b!.token);
    expect(existsSync(lock)).toBe(false);
  });

  // Purpose: the break step restores a lock that turned out not to be the one
  // judged stale. This is the "late breaker" case: a first breaker already
  // replaced the stale lock with its own fresh one, and a second breaker, still
  // holding the stale token it read earlier, renames the fresh lock by mistake.
  it('restores a fresh lock renamed by a late breaker', () => {
    writeFileSync(lock, 'dead:1');
    // The first breaker: breaks the stale lock and takes a fresh one.
    expect(breakStaleLock(lock, 'dead:1')).toBe('broken');
    writeFileSync(lock, 'fresh:2');
    // The second breaker still judges "dead:1" stale and renames the fresh lock.
    expect(breakStaleLock(lock, 'dead:1')).toBe('restored');
    expect(readFileSync(lock, 'utf8')).toBe('fresh:2');
    expect(names()).toEqual(['data.json.lock']);
  });

  // Purpose: a lock that vanished between the judgment and the rename is simply
  // gone; the breaker retries without creating anything.
  it('reports a lock that is already gone', () => {
    expect(breakStaleLock(lock, 'dead:1')).toBe('gone');
    expect(names()).toEqual([]);
  });
});
