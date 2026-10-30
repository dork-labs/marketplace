/**
 * Intake sources and their last-read marks (DOR-3258, DOR-3259).
 *
 * **Sources.** `intake.sources` lists where new work comes from: tracker teams
 * (`kind: tracker`) and GitHub repositories' issues (`kind: github`). An empty
 * list means the configured team alone. The older `connection.intake` queues
 * read as tracker sources until they move.
 *
 * **Marks.** `<main checkout>/.dork/flow/intake.json` keeps, per source, when
 * flow last read it (`lastReadAt`, which the Health block shows) and, for a
 * GitHub source, how far its issues have been captured (`capturedThrough`).
 * `flow snapshot` marks the configured team; `flow intake` marks each GitHub
 * source it reads. The model never writes a mark.
 *
 * **Two steps for GitHub.** A read records the window it pulled as `pending`;
 * `flow intake done` moves `capturedThrough` up to it once triage has captured
 * the issues. A run that dies between the two reads the same window again, and
 * triage's title tag (`[owner/name#N]`) finds what it already captured. Nothing
 * is skipped quietly.
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
const LABEL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9 _.:/-]{0,49}$/;

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
 * The sources in force: `intake.sources`; else the older `connection.intake`
 * queues as tracker sources; else the configured team.
 *
 * @param config - The loaded config.
 * @returns The sources, never empty.
 */
export function resolveIntakeSources(config: IntakeConfig): IntakeSource[] {
  if (config.intake.sources.length > 0) return [...config.intake.sources];
  if (config.connection.intake.length > 0) {
    return config.connection.intake.map((queue) => ({
      kind: 'tracker' as const,
      id: queue.id,
      ...(queue.name === undefined ? {} : { name: queue.name }),
    }));
  }
  const team = config.connection.team.key ?? config.connection.team.id ?? config.tracker;
  return [{ kind: 'tracker', id: team }];
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

/** One source's mark. */
export interface IntakeMark {
  /** When flow last read the source (ISO). */
  lastReadAt?: string;
  /** GitHub: issues created before this are captured. */
  capturedThrough?: string;
  /** GitHub: the last read's window, waiting on `flow intake done`. */
  pending?: { readAt: string; through: string };
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

/**
 * Read the marks. A missing or unreadable file, or a field that is not a plain
 * UTC time, reads as no mark: Health then says unknown, and a GitHub source
 * starts over from now rather than from a time flow did not write.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The marks.
 */
export function readIntakeMarks(mainCheckout: string): IntakeMarks {
  const empty: IntakeMarks = { v: 1, sources: {} };
  const file = intakePath(mainCheckout);
  if (!existsSync(file)) return empty;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  const sources =
    typeof value === 'object' && value !== null
      ? (value as { sources?: unknown }).sources
      : undefined;
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return empty;
  const marks: IntakeMarks = { v: 1, sources: {} };
  for (const [key, raw] of Object.entries(sources as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const mark: IntakeMark = {};
    const lastReadAt = iso(entry.lastReadAt);
    const capturedThrough = iso(entry.capturedThrough);
    if (lastReadAt !== undefined) mark.lastReadAt = lastReadAt;
    if (capturedThrough !== undefined) mark.capturedThrough = capturedThrough;
    const pending = entry.pending as Record<string, unknown> | undefined;
    const readAt = iso(pending?.readAt);
    const through = iso(pending?.through);
    if (readAt !== undefined && through !== undefined) mark.pending = { readAt, through };
    marks.sources[key] = mark;
  }
  return marks;
}

/**
 * Change the marks: read them, apply `change`, write them through a temp file
 * and a rename, so a reader never sees half a file.
 *
 * @param mainCheckout - The project's main checkout.
 * @param change - Edits the marks in place.
 * @returns The marks written.
 */
export function updateIntakeMarks(
  mainCheckout: string,
  change: (marks: IntakeMarks) => void
): IntakeMarks {
  const marks = readIntakeMarks(mainCheckout);
  change(marks);
  const file = intakePath(mainCheckout);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marks, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return marks;
}

/**
 * The one read-only `gh` call for a GitHub source: its open issues created at
 * or after `since`, oldest first, at most `limit`.
 *
 * @param source - The source; its repo and labels must match their patterns whole.
 * @param since - A plain UTC time.
 * @returns The argv after `gh`.
 * @throws {Error} When the repo, a label or the time does not match.
 */
export function issueListArgs(
  source: Extract<IntakeSource, { kind: 'github' }>,
  since: string
): string[] {
  if (!REPO_PATTERN.test(source.repo)) throw new Error(`"${source.repo}" is not owner/name`);
  if (iso(since) === undefined) throw new Error(`"${since}" is not a plain UTC time`);
  if (!Number.isInteger(source.limit) || source.limit < 1 || source.limit > 100) {
    throw new Error(`limit ${source.limit} is not between 1 and 100`);
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
    // GitHub's date qualifier takes whole seconds.
    `created:>=${since.replace(/\.\d{3}Z$/, 'Z')} sort:created-asc`,
    '--limit',
    String(source.limit),
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
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

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
