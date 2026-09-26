/**
 * The journal (spec `flow-self-improvement` §2, DOR-2391): a small, local,
 * secret-free record of how flow's runs go, one JSON line per event.
 *
 * It lives at `<main checkout>/.dork/flow/journal.jsonl`, so every worktree of a
 * project writes one file (`config-files.ts` {@link journalSettings} says where,
 * and whether it is on). Nothing here needs `zod`: a verb can write its line
 * before `npm install`. The line schema is in `journal-schema.ts`, loaded only by
 * code that validates hand-entered input.
 *
 * - **Never secrets.** Only the fields in the schema are stored, and the free
 *   text fields (`note.text`, `oracle.error.errorClass`) pass {@link redact} and
 *   a length cap in {@link buildLine}, whoever the caller is.
 * - **Writing.** One `appendFileSync` per event, opened `O_APPEND`, so writers in
 *   several processes never interleave inside a line.
 * - **Never in the way.** {@link append} never throws. A failure (full disk,
 *   permissions) is one warning on stderr, and the caller's exit code and output
 *   stay as they were.
 * - **Rotation.** At `maxBytes`, `journal.jsonl` becomes `journal.1.jsonl`, the
 *   older files shift up one, and `journal.<keep>.jsonl` is dropped. A `wx` lock
 *   file makes one writer do it; see {@link rotateIfFull}.
 * - **Out of git.** The first write adds `.dork/flow/` to the repository's
 *   `info/exclude` unless git already ignores the file.
 *
 * @module @dorkos/flow/journal
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPlainObject } from './_shared.ts';
import {
  RUN_FILES_DIR,
  findConfigRoots,
  journalSettings,
  refusalFor,
  type JournalSettings,
} from './config-files.ts';
import { ensureIgnored } from './git-exclude.ts';
import { detectRuntime, type Runtime } from './runtime-detect.ts';
import type { JournalLine } from './journal-schema.ts';

/** Every line kind, in the order of the spec's table. */
export const JOURNAL_KINDS = [
  'verb',
  'oracle.error',
  'stage',
  'item.readied',
  'claim',
  'retry',
  'operator.wait',
  'review',
  'ci',
  'handoff',
  'note',
  'selftest',
  'retro',
  'usage.snapshot',
] as const;

/** A line kind. */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** What an agent's `flow note` is about. */
export const NOTE_KINDS = ['friction', 'workaround', 'confusion'] as const;

/** The closed set of review finding categories. */
export const REVIEW_CATEGORIES = [
  'logic',
  'race',
  'test',
  'migration',
  'security',
  'docs',
  'scope',
  'style',
  'other',
] as const;

/** The most characters `note.text` keeps. */
export const NOTE_TEXT_MAX = 1000;
/** The most characters `oracle.error.errorClass` keeps. */
export const ERROR_CLASS_MAX = 200;
/** The most characters `item` keeps. */
export const ITEM_MAX = 64;
/** The most characters any other text field keeps (a verb, a skill, an account). */
export const NAME_MAX = 100;
/** The lock file one writer holds while it rotates, beside the journal. */
export const LOCK_FILE = 'journal.lock';
/** A lock older than this is left over from a writer that died, and is deleted. */
export const STALE_LOCK_MS = 30_000;

/** `Omit` applied to each member of a union, so the union survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a caller passes it: a line without the fields {@link buildLine} stamps. */
export type JournalEvent = DistributiveOmit<
  JournalLine,
  'v' | 'ts' | 'flow' | 'session' | 'runtime' | 'harness'
>;

/**
 * The `runtime` and `harness` a verb stamps on its lines, read from the verb's
 * own environment (its `VerbContext.env`), never from this process's, so a
 * test or a launcher that hands a verb an environment gets that answer.
 *
 * @param env - The environment to read.
 * @returns The runtime and harness for {@link LineMeta}.
 */
export function runtimeOf(env: Readonly<Record<string, string | undefined>>): {
  runtime: Runtime;
  harness: string;
} {
  const { runtime, harness } = detectRuntime(env);
  return { runtime, harness };
}

/** One usage window as a `usage.snapshot` line carries it. */
export interface UsageWindowReading {
  /** Share of the window used, 0 to 100. */
  usedPct: number;
  /** When the window resets, ISO-8601, or `null` when unknown. */
  resetsAt: string | null;
}

/**
 * A usage window name (fleet decision R2): `five_hour`, `seven_day`,
 * `seven_day_opus`, `seven_day_sonnet`, `model:<slug>` or `window:<minutes>`.
 */
export const USAGE_WINDOW_NAME =
  /^(five_hour|seven_day|seven_day_opus|seven_day_sonnet|model:[a-z0-9._-]{1,40}|window:\d{1,6})$/;

/** The most windows one `usage.snapshot` line may carry. */
export const USAGE_WINDOWS_MAX = 12;

/** Whether a value is an ISO-8601 time `Date.parse` can read, or `null`. */
function isResetTime(value: unknown): boolean {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

/**
 * Why a `usage.snapshot` event cannot be written, or `null` when it can. The
 * journal writes lines without zod, so this is the snapshot's check: a finite
 * `usedPct` from 0 to 100, a known window name, at most
 * {@link USAGE_WINDOWS_MAX} windows, a readable `resetsAt`, and a finite,
 * non-negative spend. {@link append} refuses an event that fails it.
 *
 * @param event - The event.
 * @returns The first problem, or `null`.
 */
export function usageSnapshotProblem(event: JournalEvent): string | null {
  if (event.kind !== 'usage.snapshot') return null;
  const windows = event.windows as Record<string, unknown>;
  if (!isPlainObject(windows)) return 'windows must be an object';
  const names = Object.keys(windows);
  if (names.length > USAGE_WINDOWS_MAX) return `at most ${USAGE_WINDOWS_MAX} windows`;
  for (const name of names) {
    if (!USAGE_WINDOW_NAME.test(name)) return `unknown window "${name.slice(0, 40)}"`;
    const reading = windows[name];
    if (!isPlainObject(reading)) return `window ${name} is not a reading`;
    const pct = reading.usedPct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return `window ${name} usedPct must be a number from 0 to 100`;
    }
    if (!isResetTime(reading.resetsAt)) return `window ${name} resetsAt must be a time or null`;
  }
  const spend = event.spend as Record<string, unknown> | undefined;
  if (spend !== undefined) {
    for (const key of ['costUsd', 'limitUsd'] as const) {
      const value = spend[key];
      if (value === undefined && key === 'limitUsd') continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return `spend.${key} must be a number of 0 or more`;
      }
    }
  }
  return null;
}

/** Two reset times closer than this count as the same reset (formatting, jitter). */
export const USAGE_RESET_TOLERANCE_MS = 60_000;

/** A `usage.snapshot` sample needs this long since the last one of the same account... */
export const USAGE_SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
/** ...unless a window moved at least this many points, or reset, since then. */
export const USAGE_SAMPLE_DELTA_PCT = 5;

/**
 * Whether a usage writer should add a `usage.snapshot` line now (fleet decision
 * R8: the ledger keeps only the latest reading; the journal keeps a SAMPLED
 * history for the retro's trends). Sample when there is no earlier snapshot of
 * this account, when its time cannot be read or lies in the future (clock
 * skew), when {@link USAGE_SAMPLE_INTERVAL_MS} has passed, when any window moved
 * {@link USAGE_SAMPLE_DELTA_PCT} points or more, or when a window appeared,
 * disappeared or reset (its `resetsAt` moved by more than
 * {@link USAGE_RESET_TOLERANCE_MS}, compared as times so `15:00:00Z` and
 * `15:00:00.000Z` are the same reset).
 *
 * `previous` is the account's LAST snapshot line in file order, never the one
 * with the latest `ts`: a previous time in the future (clock skew) samples, and
 * choosing by latest `ts` would keep sampling every reading until the clock
 * caught up.
 *
 * @param previous - The account's last snapshot line (`ts` and `windows`), if any.
 * @param windows - The new readings by window name.
 * @param now - The time of the new reading.
 * @returns `true` when the reading should be journaled.
 */
export function shouldSampleUsage(
  previous: { ts: string; windows: Readonly<Record<string, UsageWindowReading>> } | undefined,
  windows: Readonly<Record<string, UsageWindowReading>>,
  now: Date
): boolean {
  if (previous === undefined) return true;
  const elapsed = now.getTime() - Date.parse(previous.ts);
  if (!(elapsed >= 0 && elapsed < USAGE_SAMPLE_INTERVAL_MS)) return true;
  const names = new Set([...Object.keys(previous.windows), ...Object.keys(windows)]);
  for (const name of names) {
    const before = previous.windows[name];
    const after = windows[name];
    if (before === undefined || after === undefined) return true;
    if (resetMoved(before.resetsAt, after.resetsAt)) return true;
    if (!(Math.abs(after.usedPct - before.usedPct) < USAGE_SAMPLE_DELTA_PCT)) return true;
  }
  return false;
}

/** Whether two reset times differ by more than the tolerance (or one is unreadable). */
function resetMoved(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return before !== after;
  const a = Date.parse(before);
  const b = Date.parse(after);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return Math.abs(a - b) > USAGE_RESET_TOLERANCE_MS;
}

/** Where a journal is and how it is written: {@link JournalSettings}, or a test's own. */
export type JournalTarget = JournalSettings;

/** What {@link buildLine} stamps on every line. */
export interface LineMeta {
  /** The event time. Default: now. */
  now?: Date;
  /** The flow plugin version. Default: `unknown`. */
  flowVersion?: string;
  /** The harness session id; only its first 8 characters are kept. */
  session?: string;
  /**
   * The agent runtime the writer runs under. A verb passes `runtimeOf(ctx.env)`;
   * absent, the line says `unknown` (never a guess from this process's env).
   */
  runtime?: Runtime;
  /** What hosts the session, from `runtimeOf(ctx.env)`; absent, `unknown`. */
  harness?: string;
}

/** How {@link append} behaves beyond the line itself. */
export interface AppendOptions extends LineMeta {
  /** Where the one failure warning goes. Default: a `flow: warning:` line on stderr. */
  warn?: (message: string) => void;
  /**
   * Test seam: runs after this writer found the file over the cap and before it
   * tries the lock, so a test can put another writer's rotation in between.
   */
  beforeLock?: () => void;
}

/** What {@link append} did: wrote the line, found the journal off, or failed (and warned). */
export type AppendOutcome = 'written' | 'off' | 'failed';

/** Token shapes replaced by `[redacted]`, most specific first. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[bap]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Header credentials, any case. The value must look like a token, so prose
  // survives: 8+ characters holding a digit (or `.`, `+`, `=` for bearer; `+`,
  // `=` for basic, since `/` is common in prose). "the bearer credential
  // expired" and "a basic setup/teardown step" are kept.
  /\bbearer\s+(?=[A-Za-z0-9._~+/=-]*[0-9.+=])[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bbasic\s+(?=[A-Za-z0-9+/=]*[0-9+=])[A-Za-z0-9+/]{8,}={0,2}/gi,
];
/** An email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * A run of 32 or more base64 or hex characters holding at least one letter and
 * one digit: the shape of a bare key, a full commit SHA included. The
 * letter-and-digit rule spares long plain words. `/` is a base64 character, so a
 * long path without dots that has a digit in it (`specs/x-y/02-spec…`) is
 * redacted too: over-redacting a path costs a diagnostic detail, while stopping
 * runs at `/` would let a base64 key through in pieces.
 */
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/** Escape a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove what must never be stored from free text: token shapes (`sk-…`,
 * `ghp_…`, `github_pat_…`, `glpat-…`, `lin_api_…`, `xox[bap]-…`, `AKIA…`,
 * `Bearer …` and `Basic …` in any case, any run of 32+ base64 or hex
 * characters) become `[redacted]`, email addresses become `[email]`, and the
 * home folder becomes `~`.
 *
 * @param text - Free text from an agent or an error message.
 * @param home - The home folder to shorten. Default: the current user's.
 * @returns The text with every match replaced.
 */
export function redact(text: string, home: string = os.homedir()): string {
  let out = text;
  if (home.length > 1) {
    out = out.replace(new RegExp(`${escapeRegExp(home)}(?![A-Za-z0-9_.-])`, 'g'), '~');
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
  out = out.replace(EMAIL, '[email]');
  return out.replace(LONG_RUN, (run) =>
    /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? '[redacted]' : run
  );
}

/** The first `max` characters (code points, so no emoji is cut in half). */
function cap(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** The most characters a field keeps; any field not named here keeps {@link NAME_MAX}. */
const FIELD_MAX: Readonly<Record<string, number>> = {
  item: ITEM_MAX,
  text: NOTE_TEXT_MAX,
  errorClass: ERROR_CLASS_MAX,
};

/**
 * Redact and cap an object key. A usage window name that is already valid keeps
 * its shape (a long model slug such as `model:claude-sonnet-4-5-20250929-thinking`
 * would otherwise read as a key and be redacted, and two windows would collapse
 * into one); token and address patterns still apply.
 */
function cleanKey(field: string, key: string): string {
  if (field === 'windows' && USAGE_WINDOW_NAME.test(key)) {
    let out = key;
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out.replace(EMAIL, '[email]');
  }
  return cap(redact(key), NAME_MAX);
}

/**
 * Redact and cap one field value: every string, every string in a list, and
 * every key and string inside an object (a usage snapshot's windows).
 */
function clean(field: string, value: unknown): unknown {
  const max = FIELD_MAX[field] ?? NAME_MAX;
  if (typeof value === 'string') {
    const text = field === 'errorClass' ? (value.split(/\r?\n/, 1)[0] ?? '') : value;
    return cap(redact(text), max);
  }
  if (Array.isArray(value)) return value.map((entry) => clean(field, entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [cleanKey(field, key), clean(key, inner)])
    );
  }
  return value;
}

/**
 * Stamp an event into a line: `v`, `ts`, `flow`, the `runtime` and `harness`
 * the caller names (`unknown` when it names none) and the session prefix. Every
 * string field the caller passed (`item`, `skill`, `from`, a note's text, an
 * error's first line, each list entry) is redacted and capped at its schema
 * maximum, whoever the caller is and whether or not it loads the schema.
 *
 * @param event - The event.
 * @param meta - The time, plugin version and session.
 * @returns The line to write.
 */
export function buildLine(event: JournalEvent, meta: LineMeta = {}): JournalLine {
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(event)) {
    fields[field] = field === 'kind' ? value : clean(field, value);
  }
  return {
    v: 1,
    ts: (meta.now ?? new Date()).toISOString(),
    flow: meta.flowVersion ?? 'unknown',
    runtime: meta.runtime ?? 'unknown',
    harness: cap(redact(meta.harness ?? 'unknown'), NAME_MAX),
    ...(meta.session ? { session: meta.session.slice(0, 8) } : {}),
    ...fields,
  } as JournalLine;
}

/**
 * The path of rotated file `n` beside a journal: `journal.<n>.jsonl`.
 *
 * @param journal - The journal file (`…/journal.jsonl`).
 * @param n - The rotation number, 1 for the newest rotated file.
 * @returns The rotated file's path.
 */
export function rotatedPath(journal: string, n: number): string {
  const ext = path.extname(journal);
  return `${journal.slice(0, journal.length - ext.length)}.${n}${ext}`;
}

/** The file's size, or `null` when it does not exist. */
function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Rotate the journal when it is at or over `maxBytes` (spec §2, "Rotation"):
 *
 * 1. Create the lock with `wx`. If it exists, another writer is rotating: skip.
 *    A lock older than {@link STALE_LOCK_MS} is left from a writer that died:
 *    delete it and skip; the next append takes the lock.
 * 2. Holding the lock, check the size again. Under the cap means another writer
 *    rotated between this writer's check and its lock: release and skip.
 * 3. Drop `journal.<keep>.jsonl`, move each `journal.<n>.jsonl` to `<n+1>` from
 *    the highest down, move `journal.jsonl` to `journal.1.jsonl`, release.
 *
 * A writer that appends while the rename happens lands its line in
 * `journal.1.jsonl`, which {@link read} still reads. Throws on an IO error;
 * {@link append} turns that into its one warning.
 */
function rotateIfFull(target: JournalTarget, beforeLock?: () => void): void {
  const size = sizeOf(target.path);
  if (size === null || size < target.maxBytes) return;
  beforeLock?.();

  const lock = path.join(path.dirname(target.path), LOCK_FILE);
  try {
    closeSync(openSync(lock, 'wx'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
    } catch {
      // Another writer cleared or released it first; either way, skip.
    }
    return;
  }
  try {
    const again = sizeOf(target.path);
    if (again === null || again < target.maxBytes) return;
    rmSync(rotatedPath(target.path, target.keep), { force: true });
    for (let n = target.keep - 1; n >= 1; n -= 1) {
      const from = rotatedPath(target.path, n);
      if (existsSync(from)) renameSync(from, rotatedPath(target.path, n + 1));
    }
    renameSync(target.path, rotatedPath(target.path, 1));
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Keep the journal out of git, once: when the journal file does not exist yet,
 * add `.dork/flow/` to `info/exclude` unless git already ignores it.
 *
 * @returns Why the exclude line could not be added, or `null`.
 */
function ignoreOnFirstWrite(target: JournalTarget): string | null {
  if (existsSync(target.path)) return null;
  const rel = path.relative(target.checkout, target.path);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    ensureIgnored(target.checkout, rel, `${RUN_FILES_DIR}/`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Append one event to the journal. Never throws: a failure is one warning and
 * the outcome `failed`, so a caller's exit code and output never depend on it.
 *
 * @param target - Where the journal is and how it is written.
 * @param event - The event.
 * @param options - The line's stamp, the warning sink and the test seam.
 * @returns What happened.
 */
export function append(
  target: JournalTarget,
  event: JournalEvent,
  options: AppendOptions = {}
): AppendOutcome {
  if (!target.enabled) return 'off';
  const warn = options.warn ?? ((message) => process.stderr.write(`flow: warning: ${message}\n`));
  // One warning per call at most: a failed append says so and nothing else; an
  // append that worked but could not update info/exclude says that instead.
  let excludeProblem: string | null = null;
  const invalid = usageSnapshotProblem(event);
  if (invalid !== null) {
    warn(`a usage reading was not written to the journal: ${invalid}`);
    return 'failed';
  }
  try {
    const line = `${JSON.stringify(buildLine(event, options))}\n`;
    mkdirSync(path.dirname(target.path), { recursive: true });
    excludeProblem = ignoreOnFirstWrite(target);
    rotateIfFull(target, options.beforeLock);
    appendFileSync(target.path, line, { flag: 'a' });
  } catch (error) {
    warn(`the journal at ${target.path} could not be written: ${(error as Error).message}`);
    return 'failed';
  }
  if (excludeProblem !== null) warn(`could not keep the journal out of git: ${excludeProblem}`);
  return 'written';
}

/** What {@link read} found. */
export interface JournalRead {
  /** Every line that parsed, oldest file first, in file order. */
  lines: JournalLine[];
  /** How many lines were not a journal line (bad JSON, another version). */
  skipped: number;
}

/**
 * Read the journal and its rotated files, oldest first. A line that is not JSON,
 * or not a version-1 object with a `ts` and a `kind`, is skipped and counted.
 * Lines are not checked against the full schema here, so reading needs no zod.
 *
 * @param target - The journal file and how many rotated files to read.
 * @param since - Keep only lines at or after this time.
 * @returns The lines and the skipped count.
 */
export function read(target: Pick<JournalTarget, 'path' | 'keep'>, since?: Date): JournalRead {
  const files = [
    ...Array.from({ length: target.keep }, (_, i) => rotatedPath(target.path, target.keep - i)),
    target.path,
  ];
  const lines: JournalLine[] = [];
  let skipped = 0;
  const from = since?.getTime() ?? -Infinity;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        skipped += 1;
        continue;
      }
      if (
        !isPlainObject(value) ||
        value.v !== 1 ||
        typeof value.ts !== 'string' ||
        typeof value.kind !== 'string'
      ) {
        skipped += 1;
        continue;
      }
      if (Date.parse(value.ts) < from) continue;
      // Lines written before 0.21.0 carry no runtime or harness: read them as unknown.
      if (typeof value.runtime !== 'string') value.runtime = 'unknown';
      if (typeof value.harness !== 'string') value.harness = 'unknown';
      lines.push(value as unknown as JournalLine);
    }
  }
  return { lines, skipped };
}

/**
 * The journal for a project folder: its main checkout's file and the project's
 * `selfImprovement.journal` settings.
 *
 * @param projectDir - Any folder in the project.
 * @param flowRoot - The plugin folder (`<flow-root>`).
 * @returns The settings, or a plain reason flow must not act here.
 */
export function journalFor(
  projectDir: string,
  flowRoot: string
): { settings: JournalSettings } | { refusal: string } {
  const roots = findConfigRoots(projectDir, flowRoot);
  const refusal = refusalFor(roots);
  return refusal === null ? { settings: journalSettings(roots) } : { refusal };
}
