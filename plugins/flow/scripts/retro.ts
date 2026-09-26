/**
 * The retro's measures and proposal rules (spec `flow-self-improvement` §3,
 * DOR-2392): pure functions over journal lines, the self-test history, one
 * backlog snapshot and the prose word counts. `flow retro` (`cli/retro.ts`)
 * reads those inputs and writes the report; nothing here touches a file.
 *
 * - **No data is not zero.** A measure with nothing to measure in a window is
 *   {@link NO_DATA}, never `0`, so an empty week never reads as a good one.
 * - **Every measure has the previous window beside it**, and every journal
 *   measure is also split by the runtime that wrote each line (`claude-code`,
 *   `codex`, `opencode`, `unknown`). The two measures that come from outside
 *   the journal, the backlog and the prose, belong to no runtime, and say so.
 * - **usageTrend** reads the `usage.snapshot` lines, per
 *   `accountRuntime:account` and usage window.
 * - **Proposals** come from four deterministic rules, each with a fingerprint
 *   that stays the same from run to run for the same subject, so filing can
 *   find an item it filed before.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/retro
 */

import { createHash } from 'node:crypto';

import { isPlainObject } from './_shared.ts';
import type { JournalLine } from './journal-schema.ts';
import { RUNTIMES } from './runtime-detect.ts';
import type { WorkItem } from './work-item.ts';

/** What a measure reads when its window holds nothing to measure. */
export const NO_DATA = 'no data';

/** A measured value, or {@link NO_DATA}. */
export type Value<T> = T | typeof NO_DATA;

/** The runtimes a measure is split by: each runtime flow knows, and `unknown`. */
export const RUNTIME_KEYS = [...RUNTIMES, 'unknown'] as const;

/** One runtime key. */
export type RuntimeKey = (typeof RUNTIME_KEYS)[number];

/** A value in this window and the one before. */
export interface Pair<T> {
  /** This window. */
  now: Value<T>;
  /** The window before it. */
  prev: Value<T>;
}

/** A journal measure: the pair overall, and the pair per runtime. */
export interface JournalMeasure<T> extends Pair<T> {
  /** The same pair over only the lines each runtime wrote. */
  byRuntime: Record<RuntimeKey, Pair<T>>;
}

/** A measure that belongs to no runtime (the backlog, the prose). */
export interface GlobalMeasure<T> extends Pair<T> {
  /** Why there is no split by runtime. */
  byRuntime: null;
}

/** Open ready items and open items with no type. */
export interface ReadyVsUntriaged {
  /** Open items with `agent/ready`. */
  ready: number;
  /** Open items with no `type/*` label. */
  untriaged: number;
}

/** The prose word counts. */
export interface PluginWords {
  /** Words over the doc-lint file set. */
  total: number;
  /** The sum of each file's words above its target. */
  overTarget: number;
}

/** Every measure the retro reports. */
export interface Measures {
  /** From the snapshot: open `agent/ready` vs open with no `type/*` label. */
  readyVsUntriaged: GlobalMeasure<ReadyVsUntriaged>;
  /** Median days from an item's creation to its `item.readied` line. */
  captureToReadyDaysMedian: JournalMeasure<number>;
  /** Of round-1 `review` lines, the share with verdict `clean`, 0 to 100. */
  firstReviewCleanPct: JournalMeasure<number>;
  /** Blockers plus should-fix findings over every `review` line. */
  reviewCatchCount: JournalMeasure<number>;
  /** `ci` lines that are an ejection of an innocent PR. */
  innocentEjections: JournalMeasure<number>;
  /** The prose word counts. */
  pluginWords: GlobalMeasure<PluginWords>;
  /** `oracle.error` lines, counted by oracle. */
  oracleErrors: JournalMeasure<Record<string, number>>;
  /** Median hours an agent waited on the operator (`operator.wait` end lines). */
  operatorWaitHoursMedian: JournalMeasure<number>;
}

/** One account window's trend inside one retro window. */
export interface UsageTrendValue {
  /** The first sampled `usedPct`. */
  first: number;
  /** The last sampled `usedPct`. */
  last: number;
  /** The highest sampled `usedPct`. */
  peak: number;
  /** How many times the window ran out: a sample at 100 after one below it, or after a reset. */
  hitLimit: number;
  /** How many samples there were. */
  samples: number;
}

/** `usageTrend`: by `accountRuntime:account`, then by usage window name. */
export type UsageTrend = Record<string, Record<string, Pair<UsageTrendValue>>>;

/** One entry of the self-test history (`.dork/flow/selftest/history.jsonl`). */
export interface HistoryEntry {
  /** When the run started (ISO). */
  startedAt: string;
  /** The tiers it ran. */
  tiers: string[];
  /** Each check it ran, with its status. */
  checks: { id: string; status: string; fingerprint?: string }[];
}

/** The four proposal rules. */
export const PROPOSAL_RULES = [
  'note-cluster',
  'oracle-error',
  'selftest-regression',
  'measure-worse',
] as const;

/** One proposal rule. */
export type ProposalRule = (typeof PROPOSAL_RULES)[number];

/** One piece of evidence behind a proposal. */
export interface Evidence {
  /** When it happened (ISO). */
  ts: string;
  /** What happened, in one line (already redacted where it came from the journal). */
  text: string;
}

/** A change the retro proposes. */
export interface Proposal {
  /** `sha1(rule + ":" + subjectKey)`, first 12 hex characters. */
  fingerprint: string;
  /** The rule that fired. */
  rule: ProposalRule;
  /** A short title. */
  title: string;
  /** What fired it, oldest first. */
  evidence: Evidence[];
  /** What to change (a template; the scheduled agent rewrites it). */
  proposal: string;
}

/** The retro window: what it is called and where it starts and ends. */
export interface RetroWindow {
  /** The duration as given, for example `7d`. */
  label: string;
  /** Start of this window (ISO), inclusive. */
  since: string;
  /** End of this window (ISO): now. */
  until: string;
  /** Start of the window before it (ISO); it ends at `since`. */
  prevSince: string;
}

/** Everything the measures read. */
export interface RetroInput {
  /** The window. */
  window: RetroWindow;
  /** Journal lines in this window. */
  journal: readonly JournalLine[];
  /** Journal lines in the window before. */
  prevJournal: readonly JournalLine[];
  /** The self-test history, oldest first. */
  selftestHistory: readonly HistoryEntry[];
  /** Open items from one snapshot, or `null` when there is none. */
  snapshot: readonly WorkItem[] | null;
  /** The prose word counts now. */
  words: PluginWords | null;
  /** From the newest earlier retro report: its snapshot and word measures. */
  previous?: { readyVsUntriaged?: Value<ReadyVsUntriaged>; pluginWords?: Value<PluginWords> };
}

/** The measures, usageTrend, proposals and caveats. */
export interface RetroResult {
  /** The measures. */
  measures: Measures;
  /** Usage by account and window. */
  usageTrend: UsageTrend;
  /** The proposals, in rule order. */
  proposals: Proposal[];
  /** What the numbers cannot see. */
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Helpers

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A duration like `7d`, `48h` or `2w`: the same shape as `selfImprovement.retro.window`. */
export const DURATION = /^[1-9][0-9]*[hdw]$/;

/**
 * A duration in milliseconds.
 *
 * @param text - A count and a unit: `h`, `d` or `w`.
 * @returns The milliseconds, or `null` when the text is not a duration.
 */
export function durationMs(text: string): number | null {
  if (!DURATION.test(text)) return null;
  const count = Number(text.slice(0, -1));
  const unit = text.slice(-1);
  return count * (unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS);
}

/**
 * The retro window ending now, and the one before it.
 *
 * @param label - The duration, for example `7d`.
 * @param now - The end of the window.
 * @returns The window, or `null` when `label` is not a duration.
 */
export function windowFor(label: string, now: Date): RetroWindow | null {
  const ms = durationMs(label);
  if (ms === null) return null;
  return {
    label,
    since: new Date(now.getTime() - ms).toISOString(),
    until: now.toISOString(),
    prevSince: new Date(now.getTime() - 2 * ms).toISOString(),
  };
}

/**
 * Split lines into this window and the one before (lines outside both are
 * dropped).
 *
 * @param lines - Journal lines, any order.
 * @param window - The window.
 * @returns The two sets, each in input order.
 */
export function splitWindows(
  lines: readonly JournalLine[],
  window: RetroWindow
): { journal: JournalLine[]; prevJournal: JournalLine[] } {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const prevSince = Date.parse(window.prevSince);
  const journal: JournalLine[] = [];
  const prevJournal: JournalLine[] = [];
  for (const line of lines) {
    const ts = Date.parse(line.ts);
    if (ts >= since && ts <= until) journal.push(line);
    else if (ts >= prevSince && ts < since) prevJournal.push(line);
  }
  return { journal, prevJournal };
}

/** The line's runtime, `unknown` when absent or not one flow knows. */
function runtimeKey(line: JournalLine): RuntimeKey {
  const runtime = (line as { runtime?: unknown }).runtime;
  return (RUNTIME_KEYS as readonly string[]).includes(runtime as string)
    ? (runtime as RuntimeKey)
    : 'unknown';
}

/** Lines of one kind, typed. */
function ofKind<K extends JournalLine['kind']>(
  lines: readonly JournalLine[],
  kind: K
): Extract<JournalLine, { kind: K }>[] {
  return lines.filter((line) => line.kind === kind) as Extract<JournalLine, { kind: K }>[];
}

/**
 * The median of a list: the middle value, or the mean of the two middle ones.
 *
 * @param values - The numbers.
 * @returns The median, or {@link NO_DATA} for an empty list.
 */
export function median(values: readonly number[]): Value<number> {
  if (values.length === 0) return NO_DATA;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Round to two decimals, so a report reads cleanly and compares exactly. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Apply a journal measure to both windows, overall and per runtime. */
function journalMeasure<T>(
  input: Pick<RetroInput, 'journal' | 'prevJournal'>,
  measure: (lines: readonly JournalLine[]) => Value<T>
): JournalMeasure<T> {
  const byRuntime = {} as Record<RuntimeKey, Pair<T>>;
  for (const key of RUNTIME_KEYS) {
    byRuntime[key] = {
      now: measure(input.journal.filter((line) => runtimeKey(line) === key)),
      prev: measure(input.prevJournal.filter((line) => runtimeKey(line) === key)),
    };
  }
  return { now: measure(input.journal), prev: measure(input.prevJournal), byRuntime };
}

// ---------------------------------------------------------------------------
// Measures

/**
 * Open items with `agent/ready`, and open items with no `type/*` label.
 *
 * @param snapshot - Open items, or `null` when there is no snapshot.
 * @returns The counts, or {@link NO_DATA}.
 */
export function readyVsUntriaged(snapshot: readonly WorkItem[] | null): Value<ReadyVsUntriaged> {
  if (snapshot === null) return NO_DATA;
  const labels = (item: WorkItem) => (Array.isArray(item.labels) ? item.labels : []);
  return {
    ready: snapshot.filter((item) => labels(item).includes('agent/ready')).length,
    untriaged: snapshot.filter((item) => !labels(item).some((l) => l.startsWith('type/'))).length,
  };
}

/**
 * The median days from each readied item's creation to its `item.readied`
 * line. An item the snapshot does not hold (closed since, or no `createdAt`)
 * is left out.
 *
 * @param lines - Journal lines.
 * @param createdAt - Creation time (ISO) by item identifier.
 * @returns The median, or {@link NO_DATA}.
 */
export function captureToReadyDaysMedian(
  lines: readonly JournalLine[],
  createdAt: ReadonlyMap<string, string>
): Value<number> {
  const days: number[] = [];
  for (const line of ofKind(lines, 'item.readied')) {
    const created = line.item === undefined ? undefined : createdAt.get(line.item);
    if (created === undefined) continue;
    const ms = Date.parse(line.ts) - Date.parse(created);
    if (Number.isFinite(ms) && ms >= 0) days.push(ms / DAY_MS);
  }
  const value = median(days);
  return value === NO_DATA ? NO_DATA : round2(value);
}

/**
 * Of round-1 reviews, the share that came back clean, as a percentage.
 *
 * @param lines - Journal lines.
 * @returns 0 to 100, or {@link NO_DATA} when no round-1 review was recorded.
 */
export function firstReviewCleanPct(lines: readonly JournalLine[]): Value<number> {
  const first = ofKind(lines, 'review').filter((line) => line.round === 1);
  if (first.length === 0) return NO_DATA;
  const clean = first.filter((line) => line.verdict === 'clean').length;
  return round2((clean / first.length) * 100);
}

/**
 * Blockers plus should-fix findings over every review.
 *
 * @param lines - Journal lines.
 * @returns The sum, or {@link NO_DATA} when no review was recorded.
 */
export function reviewCatchCount(lines: readonly JournalLine[]): Value<number> {
  const reviews = ofKind(lines, 'review');
  if (reviews.length === 0) return NO_DATA;
  return reviews.reduce((sum, line) => sum + line.blocker + line.shouldFix, 0);
}

/**
 * Ejections from the merge queue that were not the PR's fault.
 *
 * @param lines - Journal lines.
 * @returns The count, or {@link NO_DATA} when no CI event was recorded.
 */
export function innocentEjections(lines: readonly JournalLine[]): Value<number> {
  const ci = ofKind(lines, 'ci');
  if (ci.length === 0) return NO_DATA;
  return ci.filter((line) => line.event === 'ejected' && line.class === 'innocent').length;
}

/**
 * `oracle.error` lines counted by oracle. A window with journal lines but no
 * errors is `{}` (none happened); a window with no lines at all is
 * {@link NO_DATA}.
 *
 * @param lines - Journal lines.
 * @returns The counts, or {@link NO_DATA}.
 */
export function oracleErrors(lines: readonly JournalLine[]): Value<Record<string, number>> {
  if (lines.length === 0) return NO_DATA;
  const counts: Record<string, number> = {};
  for (const line of ofKind(lines, 'oracle.error')) {
    counts[line.oracle] = (counts[line.oracle] ?? 0) + 1;
  }
  return counts;
}

/**
 * The median hours an agent waited on the operator.
 *
 * @param lines - Journal lines.
 * @returns The median, or {@link NO_DATA} when no wait ended with a duration.
 */
export function operatorWaitHoursMedian(lines: readonly JournalLine[]): Value<number> {
  const waits = ofKind(lines, 'operator.wait')
    .filter((line) => line.phase === 'end' && typeof line.waitedMs === 'number')
    .map((line) => (line.waitedMs as number) / HOUR_MS);
  const value = median(waits);
  return value === NO_DATA ? NO_DATA : round2(value);
}

/** The trend of one account window over some samples, oldest first. */
function trendOf(
  samples: readonly { usedPct: number; resetsAt: string | null }[]
): UsageTrendValue {
  let hitLimit = 0;
  samples.forEach((sample, i) => {
    if (sample.usedPct < 100) return;
    const before = samples[i - 1];
    if (before === undefined || before.usedPct < 100 || before.resetsAt !== sample.resetsAt) {
      hitLimit += 1;
    }
  });
  return {
    first: samples[0].usedPct,
    last: samples[samples.length - 1].usedPct,
    peak: Math.max(...samples.map((s) => s.usedPct)),
    hitLimit,
    samples: samples.length,
  };
}

/** Samples by `accountRuntime:account`, then by window name, in time order. */
function usageSamples(
  lines: readonly JournalLine[]
): Map<string, Map<string, { usedPct: number; resetsAt: string | null }[]>> {
  const out = new Map<string, Map<string, { usedPct: number; resetsAt: string | null }[]>>();
  const snapshots = ofKind(lines, 'usage.snapshot')
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const line of snapshots) {
    const key = `${line.accountRuntime}:${line.account}`;
    const byWindow = out.get(key) ?? new Map();
    out.set(key, byWindow);
    if (!isPlainObject(line.windows)) continue;
    for (const [name, reading] of Object.entries(line.windows)) {
      if (typeof reading?.usedPct !== 'number') continue;
      const list = byWindow.get(name) ?? [];
      list.push({ usedPct: reading.usedPct, resetsAt: reading.resetsAt ?? null });
      byWindow.set(name, list);
    }
  }
  return out;
}

/**
 * Usage per `accountRuntime:account` and usage window: the first, last and
 * peak `usedPct` sampled in each retro window, and how many times it ran out.
 * An account or window seen in only one retro window reads {@link NO_DATA} in
 * the other.
 *
 * @param journal - This window's lines.
 * @param prevJournal - The previous window's lines.
 * @returns The trend.
 */
export function usageTrend(
  journal: readonly JournalLine[],
  prevJournal: readonly JournalLine[]
): UsageTrend {
  const now = usageSamples(journal);
  const prev = usageSamples(prevJournal);
  const out: UsageTrend = {};
  for (const account of [...new Set([...now.keys(), ...prev.keys()])].sort()) {
    const nowWindows = now.get(account) ?? new Map();
    const prevWindows = prev.get(account) ?? new Map();
    const windows: Record<string, Pair<UsageTrendValue>> = {};
    for (const name of [...new Set([...nowWindows.keys(), ...prevWindows.keys()])].sort()) {
      const a = nowWindows.get(name);
      const b = prevWindows.get(name);
      windows[name] = {
        now: a === undefined ? NO_DATA : trendOf(a),
        prev: b === undefined ? NO_DATA : trendOf(b),
      };
    }
    if (Object.keys(windows).length > 0) out[account] = windows;
  }
  return out;
}

/**
 * Every measure over the input.
 *
 * @param input - The retro's inputs.
 * @returns The measures.
 */
export function computeMeasures(input: RetroInput): Measures {
  const createdAt = new Map<string, string>();
  for (const item of input.snapshot ?? []) {
    if (typeof item.createdAt === 'string') createdAt.set(item.identifier, item.createdAt);
  }
  return {
    readyVsUntriaged: {
      now: readyVsUntriaged(input.snapshot),
      prev: input.previous?.readyVsUntriaged ?? NO_DATA,
      byRuntime: null,
    },
    captureToReadyDaysMedian: journalMeasure(input, (lines) =>
      captureToReadyDaysMedian(lines, createdAt)
    ),
    firstReviewCleanPct: journalMeasure(input, firstReviewCleanPct),
    reviewCatchCount: journalMeasure(input, reviewCatchCount),
    innocentEjections: journalMeasure(input, innocentEjections),
    pluginWords: {
      now: input.words ?? NO_DATA,
      prev: input.previous?.pluginWords ?? NO_DATA,
      byRuntime: null,
    },
    oracleErrors: journalMeasure(input, oracleErrors),
    operatorWaitHoursMedian: journalMeasure(input, operatorWaitHoursMedian),
  };
}

// ---------------------------------------------------------------------------
// Proposal rules

/** Rule 1 fires at this many notes on one subject. */
export const NOTE_CLUSTER_MIN = 2;
/** Rule 2 fires at this many repeats of one oracle error. */
export const ORACLE_REPEAT_MIN = 2;
/** Rule 4: first-review clean share down this many points. */
export const CLEAN_DROP_POINTS = 15;
/** Rule 4: capture-to-ready median up by this share (0.5 = 50%). */
export const CAPTURE_RISE_SHARE = 0.5;
/** Rule 4: this many innocent ejections in the window. */
export const INNOCENT_EJECTIONS_MIN = 3;

/** Words too common to tell two notes apart. */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have i if in into is ' +
    'it its me my no not of on or our so than that the their then there these they this to ' +
    'was we were what when which while who will with would you your'
  ).split(' ')
);

/**
 * The first five content words of a note, lowercased, with punctuation and
 * common words removed: how two notes with no skill are grouped.
 *
 * @param text - The note text.
 * @returns The words, space-separated.
 */
export function noteKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && word !== '-' && !STOP_WORDS.has(word))
    .slice(0, 5)
    .join(' ');
}

/**
 * A proposal's fingerprint: the first 12 hex characters of
 * `sha1(rule + ":" + subjectKey)`.
 *
 * @param rule - The rule.
 * @param subjectKey - What the proposal is about, with no counts or times.
 * @returns 12 lowercase hex characters.
 */
export function proposalFingerprint(rule: ProposalRule, subjectKey: string): string {
  return createHash('sha1').update(`${rule}:${subjectKey}`).digest('hex').slice(0, 12);
}

/** Build a proposal. */
function proposal(
  rule: ProposalRule,
  subjectKey: string,
  title: string,
  evidence: Evidence[],
  text: string
): Proposal {
  return {
    fingerprint: proposalFingerprint(rule, subjectKey),
    rule,
    title,
    evidence: [...evidence].sort((a, b) => a.ts.localeCompare(b.ts)),
    proposal: text,
  };
}

/**
 * Rule 1, note cluster: two or more notes in the window about the same skill,
 * or, with no skill, with the same first five content words.
 *
 * @param lines - This window's lines.
 * @returns One proposal per cluster.
 */
export function noteClusters(lines: readonly JournalLine[]): Proposal[] {
  const groups = new Map<string, Extract<JournalLine, { kind: 'note' }>[]>();
  for (const note of ofKind(lines, 'note')) {
    const key = note.skill !== undefined ? `skill:${note.skill}` : `words:${noteKey(note.text)}`;
    if (key === 'words:') continue;
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  const out: Proposal[] = [];
  for (const [key, notes] of groups) {
    if (notes.length < NOTE_CLUSTER_MIN) continue;
    const about = key.startsWith('skill:')
      ? `the ${key.slice('skill:'.length)} skill`
      : `"${key.slice('words:'.length)}"`;
    out.push(
      proposal(
        'note-cluster',
        key,
        `${notes.length} agent notes about ${about}`,
        notes.map((note) => ({
          ts: note.ts,
          text: `${note.noteKind}${note.item ? ` on ${note.item}` : ''} (${runtimeKey(note)}): ${note.text}`,
        })),
        `Agents wrote ${notes.length} notes about ${about} this window. Read them and change the ${key.startsWith('skill:') ? 'skill' : 'instructions they name'} so the next agent does not hit the same thing.`
      )
    );
  }
  return out;
}

/**
 * Rule 2, repeated oracle error: the same oracle failing with the same error
 * two or more times in the window.
 *
 * @param lines - This window's lines.
 * @returns One proposal per repeated error.
 */
export function repeatedOracleErrors(lines: readonly JournalLine[]): Proposal[] {
  const groups = new Map<string, Extract<JournalLine, { kind: 'oracle.error' }>[]>();
  for (const line of ofKind(lines, 'oracle.error')) {
    const key = `${line.oracle}:${line.errorClass}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const out: Proposal[] = [];
  for (const [key, errors] of groups) {
    if (errors.length < ORACLE_REPEAT_MIN) continue;
    const { oracle, errorClass } = errors[0];
    out.push(
      proposal(
        'oracle-error',
        key,
        `${oracle} failed ${errors.length} times with the same error`,
        errors.map((line) => ({
          ts: line.ts,
          text: `exit ${line.exit} (${runtimeKey(line)}): ${line.errorClass}`,
        })),
        `${oracle} failed ${errors.length} times with "${errorClass}". Fix the cause in ${oracle}, or make its message name the fix.`
      )
    );
  }
  return out;
}

/**
 * Rule 3, self-test regression: a check that fails in the newest self-test run
 * inside the window, and passed in the most recent earlier run that ran it. A
 * check no earlier run ran is never a regression.
 *
 * @param history - The self-test history, oldest first.
 * @param window - The window.
 * @returns One proposal per regressed check.
 */
export function selftestRegressions(
  history: readonly HistoryEntry[],
  window: RetroWindow
): Proposal[] {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const ordered = [...history].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let latest = -1;
  ordered.forEach((entry, i) => {
    const ts = Date.parse(entry.startedAt);
    if (ts >= since && ts <= until) latest = i;
  });
  if (latest === -1) return [];
  const current = ordered[latest];
  const out: Proposal[] = [];
  for (const check of current.checks) {
    if (check.status !== 'fail') continue;
    let earlier: { entry: HistoryEntry; status: string } | undefined;
    for (let i = latest - 1; i >= 0 && earlier === undefined; i -= 1) {
      const ran = ordered[i].checks.find((c) => c.id === check.id);
      if (ran !== undefined) earlier = { entry: ordered[i], status: ran.status };
    }
    if (earlier?.status !== 'pass') continue;
    out.push(
      proposal(
        'selftest-regression',
        check.id,
        `self-test check ${check.id} passed before and fails now`,
        [
          { ts: earlier.entry.startedAt, text: `${check.id} passed` },
          { ts: current.startedAt, text: `${check.id} failed` },
        ],
        `The self-test check ${check.id} passed on ${earlier.entry.startedAt.slice(0, 10)} and fails now. Find the change in between and fix it.`
      )
    );
  }
  return out;
}

/**
 * Rule 4, a measure got worse: first-review clean share down 15 points or
 * more, capture-to-ready median up 50% or more, 3 or more innocent ejections,
 * or the prose word total up at all. A measure with no data in either window
 * never fires.
 *
 * @param measures - The measures.
 * @param at - When the evidence was gathered (the window end).
 * @returns One proposal per worse measure.
 */
export function worseMeasures(measures: Measures, at: string): Proposal[] {
  const out: Proposal[] = [];
  const num = (value: Value<number>): value is number => typeof value === 'number';
  const clean = measures.firstReviewCleanPct;
  if (num(clean.now) && num(clean.prev) && clean.prev - clean.now >= CLEAN_DROP_POINTS) {
    out.push(
      proposal(
        'measure-worse',
        'firstReviewCleanPct',
        'fewer first reviews come back clean',
        [{ ts: at, text: `first-review clean share ${clean.prev}% -> ${clean.now}%` }],
        'Fewer branches pass their first review. Look at the review categories this window and add the missing check to the verifying-work skill.'
      )
    );
  }
  const ready = measures.captureToReadyDaysMedian;
  if (num(ready.now) && num(ready.prev) && ready.prev > 0) {
    if (ready.now >= ready.prev * (1 + CAPTURE_RISE_SHARE)) {
      out.push(
        proposal(
          'measure-worse',
          'captureToReadyDaysMedian',
          'new work takes longer to become ready',
          [{ ts: at, text: `capture-to-ready median ${ready.prev} -> ${ready.now} days` }],
          'Work waits longer before it is ready. Check whether the triage schedule runs, and what the triaging-work skill leaves parked.'
        )
      );
    }
  }
  const ejections = measures.innocentEjections.now;
  if (num(ejections) && ejections >= INNOCENT_EJECTIONS_MIN) {
    out.push(
      proposal(
        'measure-worse',
        'innocentEjections',
        `${ejections} PRs were ejected from the merge queue through no fault of their own`,
        [{ ts: at, text: `${ejections} innocent ejections this window` }],
        'Innocent PRs keep getting ejected. Record which check ejected them and tell the verifying-work skill to re-arm instead of pushing.'
      )
    );
  }
  const words = measures.pluginWords;
  if (words.now !== NO_DATA && words.prev !== NO_DATA && words.now.total > words.prev.total) {
    out.push(
      proposal(
        'measure-worse',
        'pluginWords',
        "flow's instructions grew",
        [{ ts: at, text: `prose words ${words.prev.total} -> ${words.now.total}` }],
        "flow's instructions grew this window. Find the files that grew and cut them back toward their word targets."
      )
    );
  }
  return out;
}

/**
 * The whole retro over its inputs: the measures, usageTrend, the proposals in
 * rule order, and the caveats a reader needs.
 *
 * @param input - The inputs.
 * @returns The result.
 */
export function runRetro(input: RetroInput): RetroResult {
  const measures = computeMeasures(input);
  const caveats = [
    'Capture-to-ready counts only items flow readied; items readied by hand outside flow are not seen.',
  ];
  if (input.snapshot === null)
    caveats.push('No backlog snapshot, so the backlog measure has no data.');
  return {
    measures,
    usageTrend: usageTrend(input.journal, input.prevJournal),
    proposals: [
      ...noteClusters(input.journal),
      ...repeatedOracleErrors(input.journal),
      ...selftestRegressions(input.selftestHistory, input.window),
      ...worseMeasures(measures, input.window.until),
    ],
    caveats,
  };
}

// ---------------------------------------------------------------------------
// Edited proposals (`flow retro --file --input`)

/** The most characters a proposal title keeps. */
const TITLE_MAX = 200;
/** The most characters a proposal's text keeps. */
const PROPOSAL_MAX = 4000;

/**
 * Check an edited proposals file: a list of proposals, or a retro report
 * holding one under `proposals`.
 *
 * @param value - The parsed JSON.
 * @returns The proposals, or the first problem found.
 */
export function parseProposals(value: unknown): Proposal[] | string {
  const list = isPlainObject(value) ? value.proposals : value;
  if (!Array.isArray(list)) return 'expected a list of proposals, or a report with "proposals"';
  const out: Proposal[] = [];
  for (const [i, entry] of list.entries()) {
    const at = `proposal ${i + 1}`;
    if (!isPlainObject(entry)) return `${at} is not an object`;
    const { fingerprint, rule, title, evidence, proposal: text } = entry;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{12}$/.test(fingerprint)) {
      return `${at}: fingerprint must be 12 hex characters`;
    }
    if (!(PROPOSAL_RULES as readonly string[]).includes(rule as string)) {
      return `${at}: rule must be one of ${PROPOSAL_RULES.join(', ')}`;
    }
    if (typeof title !== 'string' || title.trim() === '' || title.length > TITLE_MAX) {
      return `${at}: title must be 1 to ${TITLE_MAX} characters`;
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > PROPOSAL_MAX) {
      return `${at}: proposal must be 1 to ${PROPOSAL_MAX} characters`;
    }
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return `${at}: evidence must be a non-empty list`;
    }
    for (const piece of evidence) {
      if (
        !isPlainObject(piece) ||
        typeof piece.ts !== 'string' ||
        Number.isNaN(Date.parse(piece.ts)) ||
        typeof piece.text !== 'string'
      ) {
        return `${at}: each piece of evidence needs a "ts" time and a "text"`;
      }
    }
    if (out.some((p) => p.fingerprint === fingerprint)) return `${at}: fingerprint repeats`;
    out.push({
      fingerprint,
      rule: rule as ProposalRule,
      title: title.trim(),
      evidence: evidence.map((piece) => ({ ts: piece.ts as string, text: piece.text as string })),
      proposal: text.trim(),
    });
  }
  return out;
}
