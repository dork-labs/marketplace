/**
 * The lock-and-rename JSON writer every shared flow file goes through (spec
 * `flow-cli-core` §1.2 "Writing"): the usage ledger, `fleet.json` and
 * `flow-state.json`.
 *
 * Several processes write these files at once (a status-line hook per session,
 * the CLI, the DorkOS server), and each write is a read-merge-write. Without a
 * lock, two writers read the same old contents and the second rename deletes the
 * first writer's change. The steps below are a shared contract: DorkOS
 * implements the same ones against the same files, so change them only together
 * with `plugins/flow/conformance/fleet/CONTRACT_VERSION`.
 *
 * 1. Take the lock: exclusive-create `<file>.lock` holding a fresh token
 *    `<pid>:<random 128-bit hex>`. The token, not the pid, names the holder, so
 *    two writers in one process never mistake each other's lock.
 * 2. A lock older than {@link LOCK_STALE_MS} by mtime is stale. Read its token,
 *    rename it to `<file>.lock.stale-<random>`, read the moved token, and if it
 *    is not the token judged stale, put it back with `link` (see
 *    {@link breakStaleLock}). Delete the moved name and retry. Never delete a
 *    lock by its original name.
 * 3. Retry with 25-100 ms jittered waits; give up after {@link LOCK_GIVE_UP_MS}.
 *    Giving up drops the write with a warning and never throws.
 * 4. Under the lock, read the file. Missing = empty. Unparsable = rename it to
 *    `<file>.corrupt-<epoch ms>` and start empty (or refuse, for callers that
 *    must never replace a file they could not read).
 * 5. Merge through the caller's callback. Unchanged = release and stop.
 * 6. Write `<file>.<pid>.<random>.tmp` in the same folder, fsync, rename over.
 * 7. Release: delete the lock only if it still holds this writer's token.
 *
 * **The one accepted race.** A writer that held the lock past the stale age can
 * lose it to a breaker between step 7's read and its delete, and then delete the
 * breaker's lock. A merge takes milliseconds and every write is a merge, so this
 * is accepted and there is deliberately no second mechanism for it. The same
 * holds for the restore in step 2 when a newer lock already exists.
 *
 * Reading needs no lock: `rename` is atomic, so a reader sees the old file or the
 * new one, never half of one.
 *
 * Dependency-free (node builtins only), like every fleet-contract module.
 *
 * @module @dorkos/flow/atomic-json
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.ts';

/** A lock older than this (by mtime) is stale and may be broken. */
export const LOCK_STALE_MS = 10_000;

/** A writer that cannot take the lock within this long drops its write. */
export const LOCK_GIVE_UP_MS = 2_000;

/** The shortest jittered wait between lock attempts. */
const RETRY_MIN_MS = 25;

/** The longest jittered wait between lock attempts. */
const RETRY_MAX_MS = 100;

/** A problem this module worked around, returned to the caller rather than printed. */
export interface AtomicJsonWarning {
  /**
   * A stable code: `lock-timeout` (the write was dropped), `file-corrupt` (the
   * file could not be parsed; a writer quarantined it, a reader read it as empty).
   */
  code: 'lock-timeout' | 'file-corrupt';
  /** A plain sentence naming the file. */
  message: string;
}

/** A held lock. */
export interface HeldLock {
  /** This writer's token, `<pid>:<random 128-bit hex>`, as written into the lock file. */
  token: string;
  /** How many stale locks this writer broke on the way in (0 or more). */
  broke: number;
}

/** Tuning for {@link acquireLock}; the defaults are the contract values. */
export interface LockOptions {
  /** Give up after this many ms. Default {@link LOCK_GIVE_UP_MS}. */
  giveUpMs?: number;
  /** A lock older than this many ms is stale. Default {@link LOCK_STALE_MS}. */
  staleMs?: number;
}

/** Options for {@link updateJsonFile}. */
export interface UpdateJsonOptions extends LockOptions {
  /**
   * What to do with a file that is present but not parsable JSON:
   * `quarantine` (default) renames it to `<file>.corrupt-<epoch ms>` and merges
   * from empty; `throw` releases the lock and throws a `ConfigError` naming the
   * file, leaving the file as it is.
   */
  onUnparsable?: 'quarantine' | 'throw';
  /** The clock for the quarantine name. Default `Date.now`. */
  now?: () => number;
}

/** What {@link updateJsonFile} did. */
export interface AtomicUpdateResult {
  /**
   * `written`: the merged value is on disk. `unchanged`: the merge changed
   * nothing and the file was not touched. `dropped`: the lock never freed and
   * nothing was written (see `warnings`).
   */
  status: 'written' | 'unchanged' | 'dropped';
  /** The value now on disk (`undefined` when there is none, or the write was dropped). */
  value: unknown;
  /** Everything worked around on the way. */
  warnings: AtomicJsonWarning[];
}

/**
 * The merge callback. Receives the parsed file (`undefined` when missing or
 * quarantined) and returns the value to store. Returning a value that
 * serializes the same as the input, or `undefined`, means "no change".
 */
export type JsonMerge = (current: unknown) => unknown;

/** A fresh `<pid>:<random 128-bit hex>` lock token. */
function freshToken(): string {
  return `${process.pid}:${randomBytes(16).toString('hex')}`;
}

/** Short random hex for side-file names. */
function randomSuffix(): string {
  return randomBytes(8).toString('hex');
}

/** The Node error code, when there is one. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a lock file's token and age through one descriptor, so the token and
 * the mtime come from the same file even if the lock is replaced meanwhile.
 *
 * @returns The token and mtime, or `null` when the lock is gone.
 */
function inspectLock(lockPath: string): { token: string; mtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(lockPath, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const { mtimeMs } = fstatSync(fd);
    return { token: readFileSync(fd, 'utf8'), mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/**
 * Break a lock judged stale (step 2). Renames the lock aside, reads the moved
 * token and, when it is not `judgedToken` (a fresh lock was renamed by
 * mistake), links it back to the lock name. The moved name is always deleted.
 *
 * The link-back fails when a newer lock already took the name; that is
 * accepted, like the release race (see the module header).
 *
 * @param lockPath - The lock file (`<file>.lock`).
 * @param judgedToken - The token read from the lock that was judged stale.
 * @returns `broken` (the stale lock is gone), `restored` (a different lock was
 *   moved and put back, or could not be because a newer one exists), or `gone`
 *   (there was no lock to rename).
 */
export function breakStaleLock(
  lockPath: string,
  judgedToken: string
): 'broken' | 'restored' | 'gone' {
  const moved = `${lockPath}.stale-${randomSuffix()}`;
  try {
    renameSync(lockPath, moved);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'gone';
    throw error;
  }
  let movedToken: string | null = null;
  try {
    movedToken = readFileSync(moved, 'utf8');
  } catch {
    movedToken = null;
  }
  let outcome: 'broken' | 'restored' = 'broken';
  if (movedToken !== judgedToken) {
    outcome = 'restored';
    try {
      linkSync(moved, lockPath);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        unlinkSync(moved);
        throw error;
      }
    }
  }
  unlinkSync(moved);
  return outcome;
}

/**
 * Take the lock at `lockPath` (steps 1-3). Waits on a live lock, breaks a stale
 * one, and gives up after the give-up time.
 *
 * @param lockPath - The lock file, `<file>.lock`. Its folder must exist.
 * @param options - Give-up and stale ages; the defaults are the contract values.
 * @returns The held lock, or `null` when the give-up time passed first.
 */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {}
): Promise<HeldLock | null> {
  const giveUpMs = options.giveUpMs ?? LOCK_GIVE_UP_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const token = freshToken();
  const started = Date.now();
  let broke = 0;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return { token, broke };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const existing = inspectLock(lockPath);
    if (existing === null) continue;
    if (Date.now() - existing.mtimeMs > staleMs) {
      if (breakStaleLock(lockPath, existing.token) === 'broken') broke += 1;
      continue;
    }
    const remaining = giveUpMs - (Date.now() - started);
    if (remaining <= 0) return null;
    const jitter = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
    await sleep(Math.min(jitter, remaining));
  }
}

/**
 * Release the lock (step 7): delete it only if it still holds `token`. A lock
 * that is gone or holds another writer's token is left alone.
 *
 * @param lockPath - The lock file.
 * @param token - This writer's token from {@link acquireLock}.
 */
export function releaseLock(lockPath: string, token: string): void {
  let current: string;
  try {
    current = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (current !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/** Parse outcome for one file read. */
type ParsedFile = { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'corrupt' };

/** Read and parse `file`. Whitespace-only reads as missing (there is nothing to keep). */
function parseFile(file: string): ParsedFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (raw.trim() === '') return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(raw) };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * Read a shared JSON file without a lock. Missing and whitespace-only files read
 * as `undefined`; an unparsable file reads as `undefined` with a warning and is
 * left alone (only a writer quarantines).
 *
 * @param file - The file to read.
 * @returns The parsed value (or `undefined`) and any warning.
 */
export function readJsonFile(file: string): { value: unknown; warnings: AtomicJsonWarning[] } {
  const parsed = parseFile(file);
  if (parsed.kind === 'ok') return { value: parsed.value, warnings: [] };
  if (parsed.kind === 'missing') return { value: undefined, warnings: [] };
  return {
    value: undefined,
    warnings: [{ code: 'file-corrupt', message: `${file} is not valid JSON; read it as empty.` }],
  };
}

/** The canonical on-disk form: two-space JSON with a trailing newline. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write `contents` to a temp file beside `file`, fsync it, and rename it over `file` (step 6). */
function writeAtomically(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomSuffix()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created, or was already renamed.
    }
    throw error;
  }
}

/**
 * Read-merge-write `file` under its lock (steps 1-7). Creates the folder
 * (`0700`) when missing; the file is written `0600`.
 *
 * Never throws for a lock it could not take: that returns `status: 'dropped'`
 * with a `lock-timeout` warning. An error thrown by `merge` (or the `throw`
 * choice of `onUnparsable`) propagates after the lock is released.
 *
 * @param file - The shared JSON file.
 * @param merge - Receives the current contents, returns the new ones.
 * @param options - Lock tuning, the unparsable-file policy and the clock.
 * @returns What happened, the value on disk and any warnings.
 */
export async function updateJsonFile(
  file: string,
  merge: JsonMerge | ((current: unknown) => Promise<unknown>),
  options: UpdateJsonOptions = {}
): Promise<AtomicUpdateResult> {
  const warnings: AtomicJsonWarning[] = [];
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  const held = await acquireLock(lockPath, options);
  if (held === null) {
    warnings.push({
      code: 'lock-timeout',
      message: `Could not lock ${file} within ${options.giveUpMs ?? LOCK_GIVE_UP_MS} ms; this write was dropped.`,
    });
    return { status: 'dropped', value: undefined, warnings };
  }
  try {
    const parsed = parseFile(file);
    let current: unknown;
    if (parsed.kind === 'ok') {
      current = parsed.value;
    } else if (parsed.kind === 'corrupt') {
      if (options.onUnparsable === 'throw') {
        throw new ConfigError(
          `${file} is not valid JSON; it was left as it is. Fix or move it, then retry.`
        );
      }
      const aside = `${file}.corrupt-${(options.now ?? Date.now)()}`;
      renameSync(file, aside);
      warnings.push({
        code: 'file-corrupt',
        message: `${file} was not valid JSON; moved it to ${path.basename(aside)} and started empty.`,
      });
    }
    const next = await merge(current);
    if (next === undefined || serialize(next) === serialize(current)) {
      return { status: 'unchanged', value: current, warnings };
    }
    writeAtomically(file, serialize(next));
    return { status: 'written', value: next, warnings };
  } finally {
    releaseLock(lockPath, held.token);
  }
}
