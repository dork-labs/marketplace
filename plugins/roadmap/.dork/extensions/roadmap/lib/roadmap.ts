/**
 * `roadmap.json`, read and checked. The contract is the roadmap v1 schema
 * (the README's "The file"): bets only, each with an id, `kind: "project"`, a
 * horizon, a MoSCoW, an owner, a status and a why, plus optional target, links
 * and asks. Unknown keys are allowed and ignored here (this extension never
 * writes the file, so it can't drop them).
 *
 * An item that breaks the schema is skipped and listed with a reason, so one
 * bad edit never blanks the board. Text is cleaned of control and
 * direction-override characters before anything shows it.
 *
 * @module @dorkos/roadmap/extension/lib/roadmap
 */

/** A column. */
export type Horizon = 'now' | 'next' | 'later';
/** A MoSCoW priority. */
export type Moscow = 'must' | 'should' | 'could' | 'wont';
/** Where a bet stands. */
export type Status = 'exploring' | 'planned' | 'building' | 'blocked' | 'shipped' | 'dropped';

/** The horizons, in board order. */
export const HORIZONS: readonly Horizon[] = ['now', 'next', 'later'];
const MOSCOWS: readonly Moscow[] = ['must', 'should', 'could', 'wont'];
const STATUSES: readonly Status[] = [
  'exploring',
  'planned',
  'building',
  'blocked',
  'shipped',
  'dropped',
];
const LINK_KINDS = ['linear', 'spec', 'pr', 'doc', 'url'] as const;

/** A date the timeline is drawn against. */
export interface Milestone {
  id: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

/** A link out of a bet. */
export interface Link {
  kind: (typeof LINK_KINDS)[number];
  ref: string;
  label: string | null;
}

/** Something a bet needs from the person who decides. Listed here, answered where it lives. */
export interface Need {
  id: string;
  kind: 'decision' | 'permission';
  ask: string;
  recommend: string | null;
  askedBy: string;
  /** `YYYY-MM-DD`, or null. */
  by: string | null;
  /** For a decision: the room and entry where it is answered. */
  thread: { roomId: string; entryId: string } | null;
  /** For a permission: the real approval card's id. */
  approval: string | null;
}

/** One bet. */
export interface Item {
  id: string;
  title: string;
  horizon: Horizon;
  moscow: Moscow;
  owner: string;
  /** A date, `milestone:<id>`, or null. */
  target: string | null;
  status: Status;
  why: string;
  links: Link[];
  needs: Need[];
}

/** The roadmap as the board draws it. */
export interface Board {
  milestones: Milestone[];
  items: Item[];
}

/** An item (or part of one) the board left out, and why. */
export interface Skipped {
  id: string;
  reason: string;
}

/** Where a file stopped parsing. */
export interface ParseError {
  /** One line for the banner, such as `line 48: unexpected '}'`. */
  message: string;
  /** 1-based, or null when the problem is the whole document. */
  line: number | null;
}

/** What {@link parseRoadmap} found. */
export type ParseResult =
  { ok: true; board: Board; skipped: Skipped[] } | { ok: false; error: ParseError };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HANDLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MILESTONE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TARGET = /^(\d{4}-\d{2}-\d{2}|milestone:[a-z0-9][a-z0-9-]{0,39})$/;
/** `room:<roomId>#<entryId>`, ids made of id-safe characters only. */
const THREAD = /^room:([0-9A-Za-z_-]{1,64})#([0-9A-Za-z_-]{1,64})$/;
const APPROVAL = /^[0-9A-Za-z_-]{1,80}$/;
const MAX_ITEMS = 200;

/** C0/C1 controls, zero-width and direction-override characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Text safe to show: a string with control and direction-override characters
 * removed, runs of whitespace (newlines included) folded to one space, and cut
 * to `max` characters with an ellipsis.
 *
 * @param value - Anything; a non-string gives `''`.
 * @param max - The longest result, in characters.
 * @returns The cleaned text.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The 1-based line and the character at a 0-based offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * The offset where `text` stops being JSON. `JSON.parse` doesn't always say
 * (V8 leaves the position out of some messages), so this walks the text with
 * the same grammar and stops at the first character that breaks it.
 *
 * @param text - Text `JSON.parse` refused.
 * @returns The 0-based offset; `text.length` when it ends too soon.
 */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i += 1;
  };
  const literal = (word: string) => {
    for (const char of word) {
      if (text[i] !== char) fail();
      i += 1;
    }
  };
  const string = () => {
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail();
      if (text[i] === '\\') {
        i += 1;
        if (text[i] === 'u') {
          for (let k = 0; k < 4; k += 1) {
            i += 1;
            if (!/[0-9a-fA-F]/.test(text[i] ?? '')) fail();
          }
        } else if (!'"\\/bfnrt'.includes(text[i] ?? '-')) fail();
      }
      i += 1;
    }
    if (i >= text.length) fail();
    i += 1;
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match || match[0] === '-') fail();
    i += match![0].length;
  };
  /** How deep the current value sits inside objects and arrays. */
  let depth = 0;
  /** Step past a closing `}` or `]`, one level up. */
  const close = () => {
    i += 1;
    depth -= 1;
  };
  const value = (): void => {
    space();
    const char = text[i];
    // Nothing a roadmap needs nests this deep; stop before the stack does.
    if ((char === '{' || char === '[') && ++depth > 256) fail();
    if (char === '{') {
      i += 1;
      space();
      if (text[i] === '}') return close();
      for (;;) {
        space();
        if (text[i] !== '"') fail();
        string();
        space();
        if (text[i] !== ':') fail();
        i += 1;
        value();
        space();
        if (text[i] === ',') i += 1;
        else if (text[i] === '}') return close();
        else fail();
      }
    }
    if (char === '[') {
      i += 1;
      space();
      if (text[i] === ']') return close();
      for (;;) {
        value();
        space();
        if (text[i] === ',') i += 1;
        else if (text[i] === ']') return close();
        else fail();
      }
    }
    if (char === '"') return string();
    if (char === 't') return literal('true');
    if (char === 'f') return literal('false');
    if (char === 'n') return literal('null');
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return number();
    fail();
  };
  try {
    value();
    space();
    return i < text.length ? i : text.length;
  } catch (offset) {
    return typeof offset === 'number' ? Math.min(offset, text.length) : text.length;
  }
}

/** Turn text `JSON.parse` refused into the banner's words. */
function describeJsonError(text: string): ParseError {
  const offset = jsonErrorOffset(text);
  const line = lineAt(text, offset);
  const char = text[offset];
  const what = char === undefined ? 'the file ends too soon' : `unexpected '${char}'`;
  return { message: `line ${line}: ${what}`, line };
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required string field, or the reason it is missing. */
function str(raw: Raw, key: string, max: number): string | { reason: string } {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return { reason: `has no ${key}` };
  if (typeof value !== 'string') return { reason: `${key} is not text` };
  if (value.length > max) return { reason: `${key} is longer than ${max} characters` };
  return value;
}

/** A field that must be one of `allowed`. */
function oneOf<T extends string>(
  raw: Raw,
  key: string,
  allowed: readonly T[]
): T | { reason: string } {
  const value = raw[key];
  if (value === undefined) return { reason: `has no ${key}` };
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  return { reason: `${key} is ${JSON.stringify(value).slice(0, 40)}` };
}

function failed(value: unknown): value is { reason: string } {
  return typeof value === 'object' && value !== null && 'reason' in value;
}

function readLinks(raw: unknown): Link[] {
  if (!Array.isArray(raw)) return [];
  const links: Link[] = [];
  for (const entry of raw.slice(0, 12)) {
    if (!isObject(entry)) continue;
    const kind = entry.kind;
    const ref = entry.ref;
    if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) continue;
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 300) continue;
    // A url link opens in a new tab, so only https is kept.
    if (kind === 'url' && !/^https:\/\/[^\s]+$/i.test(ref)) continue;
    links.push({
      kind: kind as Link['kind'],
      ref: cleanText(ref, 300),
      label: typeof entry.label === 'string' ? cleanText(entry.label, 40) || null : null,
    });
  }
  return links;
}

function readNeed(raw: unknown): Need | { reason: string } {
  if (!isObject(raw)) return { reason: 'an ask is not an object' };
  const id = raw.id;
  if (typeof id !== 'string' || !ULID.test(id)) return { reason: 'an ask has no valid id' };
  const kind = raw.kind;
  if (kind !== 'decision' && kind !== 'permission') return { reason: 'an ask has no kind' };
  const ask = str(raw, 'ask', 140);
  if (failed(ask)) return { reason: `an ask ${ask.reason}` };
  const askedBy = raw.askedBy;
  if (typeof askedBy !== 'string' || !HANDLE.test(askedBy)) {
    return { reason: 'an ask has no askedBy handle' };
  }
  const by = typeof raw.by === 'string' && DATE.test(raw.by) ? raw.by : null;
  let thread: Need['thread'] = null;
  let approval: string | null = null;
  if (kind === 'decision') {
    const match = typeof raw.thread === 'string' ? THREAD.exec(raw.thread) : null;
    if (!match) return { reason: 'a decision ask has no thread' };
    thread = { roomId: match[1]!, entryId: match[2]! };
  } else {
    if (typeof raw.approval !== 'string' || !APPROVAL.test(raw.approval)) {
      return { reason: 'a permission ask has no approval' };
    }
    approval = raw.approval;
  }
  return {
    id,
    kind,
    ask: cleanText(ask, 140),
    recommend: typeof raw.recommend === 'string' ? cleanText(raw.recommend, 200) || null : null,
    askedBy,
    by,
    thread,
    approval,
  };
}

function readItem(raw: unknown, skipped: Skipped[]): Item | { reason: string } {
  if (!isObject(raw)) return { reason: 'is not an object' };
  const id = raw.id;
  if (typeof id !== 'string' || !ULID.test(id)) return { reason: 'id is not a ULID' };
  if (raw.kind !== 'project') return { reason: 'kind is not "project"' };
  const title = str(raw, 'title', 120);
  if (failed(title)) return title;
  const horizon = oneOf(raw, 'horizon', HORIZONS);
  if (failed(horizon)) return horizon;
  const moscow = oneOf(raw, 'moscow', MOSCOWS);
  if (failed(moscow)) return moscow;
  const owner = raw.owner;
  if (typeof owner !== 'string' || !HANDLE.test(owner)) return { reason: 'owner is not a handle' };
  const status = oneOf(raw, 'status', STATUSES);
  if (failed(status)) return status;
  const why = str(raw, 'why', 280);
  if (failed(why)) return why;
  let target: string | null = null;
  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string' || !TARGET.test(raw.target)) {
      return { reason: 'target is not a date or milestone' };
    }
    target = raw.target;
  }
  const needs: Need[] = [];
  if (Array.isArray(raw.needs)) {
    for (const entry of raw.needs.slice(0, 5)) {
      const need = readNeed(entry);
      if (failed(need)) skipped.push({ id, reason: need.reason });
      else needs.push(need);
    }
  }
  return {
    id,
    title: cleanText(title, 120),
    horizon,
    moscow,
    owner,
    target,
    status,
    why: cleanText(why, 280),
    links: readLinks(raw.links),
    needs,
  };
}

function readMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw)) return [];
  const milestones: Milestone[] = [];
  for (const entry of raw.slice(0, 6)) {
    if (!isObject(entry)) continue;
    const { id, title, date } = entry;
    if (typeof id !== 'string' || !MILESTONE_ID.test(id)) continue;
    if (typeof date !== 'string' || !DATE.test(date)) continue;
    const name = cleanText(title, 60);
    if (!name) continue;
    milestones.push({ id, title: name, date });
  }
  return milestones;
}

/**
 * Read `roadmap.json`'s text.
 *
 * @param text - The file's contents.
 * @returns The board and what was skipped, or where the file stops making sense.
 */
export function parseRoadmap(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: describeJsonError(text) };
  }
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.items)) {
    return {
      ok: false,
      error: { message: "it isn't a version 1 roadmap (needs version: 1 and items)", line: null },
    };
  }
  const skipped: Skipped[] = [];
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const raw of doc.items.slice(0, MAX_ITEMS)) {
    const rawId = isObject(raw) && typeof raw.id === 'string' ? cleanText(raw.id, 40) : '(no id)';
    if (seen.has(rawId)) {
      skipped.push({ id: rawId, reason: 'id is used twice' });
      continue;
    }
    const item = readItem(raw, skipped);
    if (failed(item)) {
      skipped.push({ id: rawId, reason: item.reason });
      continue;
    }
    seen.add(item.id);
    items.push(item);
  }
  return { ok: true, board: { milestones: readMilestones(doc.milestones), items }, skipped };
}
