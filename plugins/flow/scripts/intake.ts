/**
 * Intake sources and their last-read marks (DOR-3258, DOR-3259).
 *
 * **Sources.** The configured team always counts, read by `flow snapshot`.
 * `intake.sources` adds tracker queues (`kind: tracker`, which TRIAGE's Path C
 * reads through the adapter) and GitHub repositories' issues (`kind: github`).
 * The older `connection.intake` queues read as tracker sources until they move.
 *
 * **Marks.** `<main checkout>/.dork/flow/intake.json` keeps, per source, when
 * flow last read it (`lastReadAt`, which the Health block shows) and, for a
 * GitHub source, how far its issues are captured (`captured`: a time, plus the
 * numbers of the issues at or after it already shown). `flow snapshot` marks
 * the team; `flow intake` marks each GitHub source. The model never writes a
 * mark, and every write holds the file's lock.
 *
 * **Two steps for GitHub.** A read records the window it pulled as `pending`;
 * `flow intake done` makes it the capture point once triage has captured the
 * issues. A run that dies between the two reads the same window again, and a
 * read that fails drops its pending window, so `done` never marks captured
 * what no capturing run saw. A window ends a margin before now, since GitHub's
 * search lags a new issue. Nothing is skipped quietly.
 *
 * **Outside words.** Issue titles and bodies are written by anyone who can open
 * an issue. They only ever become the text of a new tracker item; flow runs
 * nothing they say. The `gh` call is fixed and read-only, built from a repo and
 * labels that matched their patterns whole, and a mark that is not a plain UTC
 * time is never passed on.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/intake
 */

import path from 'node:path';

import { readJsonFile, updateJsonFile } from './atomic-json.ts';
import { RUN_FILES_DIR } from './config-names.ts';

/** The marks file's name in {@link RUN_FILES_DIR}. */
export const INTAKE_FILE = 'intake.json';

/** The longest body flow passes on; the issue's link has the rest. */
export const BODY_LIMIT = 4000;

/** The fields one read asks for: fixed, so the command is always the same. */
export const ISSUE_FIELDS = 'number,title,body,author,createdAt,url,labels';

/** A plain UTC time as flow writes it. Anything else in a mark is never passed to gh. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** `owner/name`, matched whole (the same rule as the config schema's). */
const REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** A label, matched whole (the same rule as the config schema's). */
const LABEL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,49}$/;

/** A configured source, as flow reads it. */
export type IntakeSource =
  | { kind: 'tracker'; id: string; name?: string }
  | { kind: 'github'; repo: string; name?: string; labels: string[]; limit: number };

/** The config fields this module reads. */
export interface IntakeConfig {
  tracker: string;
  connection: {
    team: { key: string | null; id: string | null };
    intake: readonly { id: string; name?: string }[];
  };
  intake: { sources: readonly IntakeSource[] };
}

/**
 * The sources in force: the configured team always comes first, then
 * `intake.sources` (else the older `connection.intake` queues). A listed
 * source with the team's key adds nothing.
 *
 * @param config - The loaded config.
 * @returns The sources, never empty.
 */
export function resolveIntakeSources(config: IntakeConfig): IntakeSource[] {
  const team = config.connection.team.key ?? config.connection.team.id ?? config.tracker;
  const listed: IntakeSource[] =
    config.intake.sources.length > 0
      ? [...config.intake.sources]
      : config.connection.intake.map((queue) => ({
          kind: 'tracker' as const,
          id: queue.id,
          ...(queue.name === undefined ? {} : { name: queue.name }),
        }));
  const sources: IntakeSource[] = [{ kind: 'tracker', id: team }];
  for (const source of listed) {
    const key = sourceKey(source);
    const at = sources.findIndex((s) => sourceKey(s) === key);
    if (at === -1) sources.push(source);
    else if (source.name !== undefined) sources[at] = { ...sources[at], name: source.name };
  }
  return sources;
}

/**
 * Whether a tracker source is the configured team (which `flow snapshot`
 * reads), rather than a queue Path C reads through the adapter.
 *
 * @param config - The loaded config.
 * @param source - A tracker source.
 * @returns Whether it is the team.
 */
export function isTeamSource(config: IntakeConfig, source: IntakeSource): boolean {
  if (source.kind !== 'tracker') return false;
  const id = source.id.toLowerCase();
  return [config.connection.team.key, config.connection.team.id, config.tracker].some(
    (team) => team !== null && team.toLowerCase() === id
  );
}

/**
 * A source's key in the marks file: `tracker:<id>` or `github:<owner/name>`,
 * lower-cased, so `DOR` and `dor` share one mark.
 *
 * @param source - The source.
 * @returns Its key.
 */
export function sourceKey(source: IntakeSource): string {
  return source.kind === 'tracker'
    ? `tracker:${source.id.toLowerCase()}`
    : `github:${source.repo.toLowerCase()}`;
}

/** A source's label for a person: its name, else its id or repo. */
export function sourceLabel(source: IntakeSource): string {
  return source.name ?? (source.kind === 'tracker' ? source.id : source.repo);
}

/** A capture point: issues created before `through` are captured, and so are those numbered in `seen`. */
export interface CapturePoint {
  through: string;
  seen: number[];
}

/** One source's mark. */
export interface IntakeMark {
  /** When flow last read the source (ISO). */
  lastReadAt?: string;
  /** GitHub: how far its issues are captured. */
  captured?: CapturePoint;
  /** GitHub: the last read's window, waiting on `flow intake done`. */
  pending?: CapturePoint & { readAt: string };
}

/** The marks file. */
export interface IntakeMarks {
  v: 1;
  sources: Record<string, IntakeMark>;
}

/**
 * The marks file's path.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The absolute path.
 */
export function intakePath(mainCheckout: string): string {
  return path.join(mainCheckout, RUN_FILES_DIR, INTAKE_FILE);
}

/** A string that is a plain UTC time, else `undefined`. */
function iso(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/** The most issue numbers a capture point keeps. */
const SEEN_LIMIT = 200;

/** A capture point read back, or `undefined` when it is not one flow wrote. */
function capturePoint(value: unknown): CapturePoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const through = iso(entry.through);
  const seen = entry.seen;
  if (through === undefined || !Array.isArray(seen) || seen.length > SEEN_LIMIT) return undefined;
  if (!seen.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)) return undefined;
  return { through, seen: seen as number[] };
}

/**
 * Normalise whatever the marks file holds. Anything flow did not write (a
 * time that is not plain UTC, a list that is not issue numbers) reads as no
 * mark: Health then says unknown, and a GitHub source starts over from now
 * rather than from a value flow did not write.
 *
 * @param value - The parsed file, or `undefined`.
 * @returns The marks.
 */
export function normaliseMarks(value: unknown): IntakeMarks {
  const marks: IntakeMarks = { v: 1, sources: {} };
  const sources =
    typeof value === 'object' && value !== null
      ? (value as { sources?: unknown }).sources
      : undefined;
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return marks;
  for (const [key, raw] of Object.entries(sources as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const mark: IntakeMark = {};
    const lastReadAt = iso(entry.lastReadAt);
    const captured = capturePoint(entry.captured);
    const pending = capturePoint(entry.pending);
    const readAt = iso((entry.pending as Record<string, unknown> | undefined)?.readAt);
    if (lastReadAt !== undefined) mark.lastReadAt = lastReadAt;
    if (captured !== undefined) mark.captured = captured;
    if (pending !== undefined && readAt !== undefined) mark.pending = { ...pending, readAt };
    marks.sources[key] = mark;
  }
  return marks;
}

/**
 * Read the marks without a lock (for status and the start of a read).
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The marks.
 */
export function readIntakeMarks(mainCheckout: string): IntakeMarks {
  return normaliseMarks(readJsonFile(intakePath(mainCheckout)).value);
}

/**
 * Change the marks under the file's lock (`atomic-json.ts`: read, merge, write
 * through a temp file and a rename, `0600`), so a `flow snapshot` and a `flow
 * intake` running at once never lose each other's mark.
 *
 * @param mainCheckout - The project's main checkout.
 * @param change - Edits the marks in place.
 * @throws {Error} When the lock never freed and nothing was written.
 */
export async function updateIntakeMarks(
  mainCheckout: string,
  change: (marks: IntakeMarks) => void
): Promise<void> {
  const result = await updateJsonFile(intakePath(mainCheckout), (current) => {
    const marks = normaliseMarks(current);
    change(marks);
    return marks;
  });
  if (result.status === 'dropped') {
    throw new Error(result.warnings.map((w) => w.message).join(' '));
  }
}

/**
 * How far behind the clock a window stops. GitHub's search index lags a new
 * issue, and this machine's clock may run ahead of GitHub's: a window that
 * ended at "now" could pass an issue no read had seen yet. The issues inside
 * the margin are read again next time, and their numbers keep them from being
 * shown twice.
 */
export const WINDOW_MARGIN_MS = 10 * 60_000;

/** A time cut to its whole second (GitHub's `createdAt` has no finer part). */
function toSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** A time as GitHub's search date qualifier documents it: `YYYY-MM-DDTHH:MM:SS+00:00`. */
function searchTime(isoTime: string): string {
  return `${toSecond(Date.parse(isoTime)).slice(0, 19)}+00:00`;
}

/**
 * Where a GitHub source's next read starts, from what one read returned.
 *
 * - The read asks for `limit + seen` issues, so issues it already showed (in
 *   `seen`) never crowd out new ones.
 * - More waiting than `limit`: the window ends at the newest issue kept, and
 *   that second's issues kept are remembered, so a second holding many issues
 *   never stalls the window.
 * - Otherwise it ends {@link WINDOW_MARGIN_MS} before now (never before where
 *   it started), remembering every kept issue created from there on.
 *
 * @param from - Where this read started.
 * @param fetched - What gh returned, oldest first.
 * @param fetchLimit - How many the read asked for.
 * @param limit - How many one read may show.
 * @param now - The clock.
 * @returns The issues to show, whether more wait, and the next capture point.
 */
export function nextWindow(
  from: CapturePoint,
  fetched: readonly IntakeIssue[],
  fetchLimit: number,
  limit: number,
  now: Date
): { issues: IntakeIssue[]; more: boolean; next: CapturePoint } {
  const fresh = fetched.filter((issue) => !from.seen.includes(issue.number));
  const issues = fresh.slice(0, limit);
  const more = fresh.length > limit || fetched.length >= fetchLimit;
  const fromMs = Date.parse(from.through);
  const last = issues.at(-1);
  const throughMs =
    more && last !== undefined
      ? Date.parse(toSecond(Date.parse(last.createdAt)))
      : Math.max(fromMs, Date.parse(toSecond(now.getTime() - WINDOW_MARGIN_MS)));
  const through = new Date(throughMs).toISOString();
  const seen = new Set(throughMs === fromMs ? from.seen : []);
  for (const issue of issues) {
    if (Date.parse(issue.createdAt) >= throughMs) seen.add(issue.number);
  }
  return { issues, more, next: { through, seen: [...seen].slice(-SEEN_LIMIT) } };
}

/**
 * The one read-only `gh` call for a GitHub source: its open issues created at
 * or after `since`, oldest first, at most `fetchLimit`.
 *
 * @param source - The source; its repo and labels must match their patterns whole.
 * @param since - A plain UTC time.
 * @param fetchLimit - How many to ask for (1 to 300).
 * @returns The argv after `gh`.
 * @throws {Error} When the repo, a label, the time or the limit does not match.
 */
export function issueListArgs(
  source: Extract<IntakeSource, { kind: 'github' }>,
  since: string,
  fetchLimit: number
): string[] {
  if (!REPO_PATTERN.test(source.repo)) throw new Error(`"${source.repo}" is not owner/name`);
  if (iso(since) === undefined) throw new Error(`"${since}" is not a plain UTC time`);
  if (!Number.isInteger(fetchLimit) || fetchLimit < 1 || fetchLimit > 300) {
    throw new Error(`limit ${fetchLimit} is not between 1 and 300`);
  }
  const labels: string[] = [];
  for (const label of source.labels) {
    if (!LABEL_PATTERN.test(label)) throw new Error(`"${label}" is not a plain label`);
    labels.push('--label', label);
  }
  return [
    'issue',
    'list',
    '-R',
    source.repo,
    '--state',
    'open',
    ...labels,
    '--search',
    `created:>=${searchTime(since)} sort:created-asc`,
    '--limit',
    String(fetchLimit),
    '--json',
    ISSUE_FIELDS,
  ];
}

/** One issue, as flow passes it on. Every text field is outside words. */
export interface IntakeIssue {
  number: number;
  title: string;
  body: string;
  /** Whether the body was cut at {@link BODY_LIMIT}. */
  bodyCut: boolean;
  author: string | null;
  createdAt: string;
  url: string;
  labels: string[];
  /** The tag a captured item's title ends with, for finding it again. */
  tag: string;
}

/** Terminal control characters: never passed on, so issue text cannot drive a terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Text with control and direction characters removed. */
function clean(text: string): string {
  return text.replace(CONTROL, '');
}

/**
 * Parse `gh issue list --json` output. A shape this does not know is an error,
 * never "no issues".
 *
 * @param stdout - What gh printed.
 * @param repo - The repo read, for each issue's tag.
 * @returns The issues, oldest first.
 * @throws {Error} When the output is not the expected list.
 */
export function parseIssues(stdout: string, repo: string): IntakeIssue[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('gh printed something that is not JSON');
  }
  if (!Array.isArray(value)) throw new Error('gh printed JSON that is not a list of issues');
  const issues = value.map((raw): IntakeIssue => {
    const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const number = entry.number;
    const createdAt = entry.createdAt;
    if (typeof number !== 'number' || !Number.isInteger(number) || typeof createdAt !== 'string') {
      throw new Error('gh printed an issue without a number or a creation time');
    }
    const body = clean(typeof entry.body === 'string' ? entry.body : '');
    const author = (entry.author as { login?: unknown } | null | undefined)?.login;
    const labels = Array.isArray(entry.labels)
      ? entry.labels
          .map((label) => (label as { name?: unknown } | null)?.name)
          .filter((name): name is string => typeof name === 'string')
          .map(clean)
      : [];
    return {
      number,
      title: clean(typeof entry.title === 'string' ? entry.title : ''),
      body: body.slice(0, BODY_LIMIT),
      bodyCut: body.length > BODY_LIMIT,
      author: typeof author === 'string' ? clean(author) : null,
      createdAt,
      url: typeof entry.url === 'string' ? clean(entry.url) : '',
      labels,
      tag: `[${repo}#${number}]`,
    };
  });
  return issues.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
