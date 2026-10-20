/**
 * The panel's words: times, dates, change sentences and the lines under the
 * header. Pure functions of the board and a clock, so they are tested without
 * a DOM.
 *
 * Everything here returns plain strings or plain parts. Commit subjects,
 * authors and roadmap text are never parsed as markdown or HTML and never
 * turned into links; React prints them as text.
 *
 * @module @dorkos/roadmap/extension/ui/format
 */

import type { BoardView, HistoryEntry } from '../lib/board-service.ts';
import type { Change } from '../lib/changes.ts';
import type { Board, Horizon, Item, Moscow, Status } from '../lib/roadmap.ts';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Now", "Next", "Later". */
export const HORIZON_LABEL: Record<Horizon, string> = { now: 'Now', next: 'Next', later: 'Later' };
/** "Must", "Should", "Could", "Won't". */
export const MOSCOW_LABEL: Record<Moscow, string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
  wont: "Won't",
};
/** Status words. */
export const STATUS_LABEL: Record<Status, string> = {
  exploring: 'Exploring',
  planned: 'Planned',
  building: 'Building',
  blocked: 'Blocked',
  shipped: 'Shipped',
  dropped: 'Dropped',
};

/** Days, hours or minutes since `iso`, short: "just now", "5m", "2h", "3d". */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/** "2h ago", "just now". */
export function agoWords(iso: string, now: Date): string {
  const short = ago(iso, now);
  return short === 'just now' ? short : `${short} ago`;
}

/** A `YYYY-MM-DD` (or ISO) date as "Oct 20", in UTC so a date never shifts a day. */
export function shortDate(date: string): string {
  const time = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(time)) return date;
  const d = new Date(time);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A clock time, "14:02", in the viewer's zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whole days from today (UTC) to a `YYYY-MM-DD` date; negative once it has passed. */
export function daysUntil(date: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / DAY_MS);
}

/** An author as the panel shows them: `@handle` for a handle-shaped name, else the name. */
export function who(author: string): string {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(author) ? `@${author}` : author;
}

/** A bet's target as a short date, reading `milestone:<id>` from the milestones. */
export function targetLabel(target: string | null, board: Board): string | null {
  if (!target) return null;
  if (!target.startsWith('milestone:')) return shortDate(target);
  const milestone = board.milestones.find((m) => m.id === target.slice('milestone:'.length));
  return milestone ? shortDate(milestone.date) : null;
}

/** The decision lane's name: "Needs Sam", or "Needs you". */
export function decider(name: string | null): string {
  return name ?? 'you';
}

/** Who can fix the GitHub connection, as one line everyone sees. */
export function reconnectLine(name: string | null): string {
  return `${name ?? 'The owner'} can reconnect it in the extension's settings.`;
}

/** One change as a sentence: a verb, the bet's title (shown bold), and the rest. */
export interface ChangeParts {
  before: string;
  title: string | null;
  after: string;
}

/**
 * One change as words.
 *
 * @param change - The change.
 * @param deciderName - The name on the decisions lane, for "asked Sam about…".
 * @returns The parts of the sentence after the author.
 */
export function changeParts(change: Change, deciderName: string | null): ChangeParts {
  switch (change.kind) {
    case 'created':
      return { before: 'started the roadmap', title: null, after: '' };
    case 'unreadable':
      return { before: "saved a version that doesn't parse", title: null, after: '' };
    case 'milestones':
      return { before: 'changed the milestones', title: null, after: '' };
    case 'reordered':
      return { before: `reordered ${HORIZON_LABEL[change.horizon]}`, title: null, after: '' };
    case 'added':
      return {
        before: 'added',
        title: change.title,
        after: ` to ${HORIZON_LABEL[change.horizon]}`,
      };
    case 'removed':
      return { before: 'removed', title: change.title, after: '' };
    case 'moved':
      return {
        before: 'moved',
        title: change.title,
        after: ` ${HORIZON_LABEL[change.from]} → ${HORIZON_LABEL[change.to]}`,
      };
    case 'moscow':
      return { before: 'made', title: change.title, after: ` a ${MOSCOW_LABEL[change.to]}` };
    case 'status':
      return {
        before: 'marked',
        title: change.title,
        after: ` ${STATUS_LABEL[change.to].toLowerCase()}`,
      };
    case 'asked':
      return {
        before: `asked ${deciderName ?? 'you'} about`,
        title: change.title,
        after: `: ${change.ask}`,
      };
    case 'ask-removed':
      return { before: 'took an ask off', title: change.title, after: `: ${change.ask}` };
    case 'edited':
      return { before: 'edited', title: change.title, after: ` (${change.fields.join(', ')})` };
  }
}

/** The history entries newer than `revision`, newest first; all of them when it isn't found. */
export function entriesSince(history: HistoryEntry[], revision: string | null): HistoryEntry[] {
  if (!revision) return history;
  const index = history.findIndex((e) => e.sha === revision);
  return index === -1 ? history : history.slice(0, index);
}

/** The bets a change names. */
function changedIds(entries: HistoryEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const change of entry.changes) if ('id' in change) ids.add(change.id);
  }
  return ids;
}

/**
 * The pill's words for changes that landed while the board was on screen:
 * "@chef moved 2 cards", "2 people changed 3 cards", "@chef changed the roadmap".
 *
 * @param entries - The new commits, newest first.
 * @returns The sentence, before "· Show".
 */
export function pillText(entries: HistoryEntry[]): string {
  const authors = [...new Set(entries.map((e) => e.author))];
  if (authors.length === 0) return 'The roadmap changed';
  const subject = authors.length === 1 ? who(authors[0]!) : `${authors.length} people`;
  const cards = changedIds(entries).size;
  if (cards === 0) return `${subject} changed the roadmap`;
  const allMoves = entries.every((e) => e.changes.every((c) => c.kind === 'moved'));
  return `${subject} ${allMoves ? 'moved' : 'changed'} ${cards} ${cards === 1 ? 'card' : 'cards'}`;
}

/**
 * The newest move or addition of each bet among `entries`: what puts "moved it
 * here 2h ago" on a card.
 *
 * @param entries - The commits since the viewer last looked, newest first.
 * @returns For each bet id, the commit that last placed it.
 */
export function placedBy(entries: HistoryEntry[]): Map<string, HistoryEntry> {
  const placed = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    for (const change of entry.changes) {
      if ((change.kind === 'moved' || change.kind === 'added') && !placed.has(change.id)) {
        placed.set(change.id, entry);
      }
    }
  }
  return placed;
}

/** The changes in `history` that name one bet, newest first. */
export function itemHistory(history: HistoryEntry[], id: string): HistoryEntry[] {
  return history
    .map((e) => ({ ...e, changes: e.changes.filter((c) => 'id' in c && c.id === id) }))
    .filter((e) => e.changes.length > 0);
}

/** Whether a bet is on the board: shipped and dropped ones stay in the file but leave it. */
export function onBoard(item: Item): boolean {
  return item.status !== 'shipped' && item.status !== 'dropped';
}

/** The bets a column shows: its horizon, in file order, on the board. */
export function column(board: Board, horizon: Horizon): Item[] {
  return board.items.filter((i) => i.horizon === horizon && onBoard(i));
}

/** One ask on the decisions lane, with its bet. */
export interface LaneCard {
  item: Item;
  need: Item['needs'][number];
}

/** Every ask across the board, the one due soonest first; undated asks last, in file order. */
export function laneCards(board: Board): LaneCard[] {
  const cards = board.items.flatMap((item) => item.needs.map((need) => ({ item, need })));
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => {
      const ab = a.card.need.by ?? '9999-99-99';
      const bb = b.card.need.by ?? '9999-99-99';
      return ab === bb ? a.index - b.index : ab < bb ? -1 : 1;
    })
    .map(({ card }) => card);
}

/** The header's subline when the file changed in the last week, or the stale line after. */
export interface Subline {
  /** True after seven days with no change: "Last changed 9 days ago by …". */
  stale: boolean;
  text: string;
}

/**
 * The line under "Roadmap".
 *
 * @param view - The board view.
 * @param now - The clock.
 * @returns The words, and whether the board has gone a week without a change.
 */
export function subline(view: BoardView, now: Date): Subline {
  const count = view.board ? view.board.items.filter((i) => onBoard(i)).length : 0;
  const bets = `${count} ${count === 1 ? 'bet' : 'bets'}`;
  const where = `roadmap.json in ${view.repo ?? 'GitHub'}`;
  const head = view.head;
  if (!head) return { stale: false, text: `${where} · ${bets}` };
  const days = Math.floor((now.getTime() - Date.parse(head.date)) / DAY_MS);
  if (days >= 7) {
    return { stale: true, text: `Last changed ${days} days ago by ${who(head.author)}` };
  }
  return {
    stale: false,
    text: `${where} · changed ${agoWords(head.date, now)} by ${who(head.author)} · ${bets}`,
  };
}

/**
 * The quiet line under the subline in the week before the token expires.
 *
 * @param expiresAt - The token's expiry, or null.
 * @param now - The clock.
 * @returns "GitHub access expires in 3 days", or null outside that week.
 */
export function expiryWarning(expiresAt: string | null, now: Date): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(ms) || ms <= 0 || ms > 7 * DAY_MS) return null;
  const days = Math.ceil(ms / DAY_MS);
  return days <= 1 ? 'GitHub access expires within a day' : `GitHub access expires in ${days} days`;
}

/** The milestones line: "Mar 2 Public beta 27d", one per milestone. */
export function milestoneParts(board: Board, now: Date) {
  return board.milestones.map((m) => {
    const days = daysUntil(m.date, now);
    return {
      id: m.id,
      date: shortDate(m.date),
      title: m.title,
      countdown: days > 0 ? `${days}d` : days === 0 ? 'today' : null,
    };
  });
}

/** The in-app address of a decision's thread. Ids were checked when the file was read. */
export function threadPath(thread: { roomId: string; entryId: string }): string {
  return `/channels?id=${encodeURIComponent(thread.roomId)}&thread=${encodeURIComponent(thread.entryId)}`;
}

/** A link chip's address, or null for a reference shown as text. Only https leaves the app. */
export function linkHref(link: Item['links'][number], prRepo: string): string | null {
  if (link.kind === 'url') return /^https:\/\//i.test(link.ref) ? link.ref : null;
  if (link.kind === 'pr') {
    const bare = /^\d{1,7}$/.exec(link.ref);
    if (bare) return `https://github.com/${prRepo}/pull/${link.ref}`;
    const full = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})#(\d{1,7})$/.exec(link.ref);
    return full ? `https://github.com/${full[1]}/${full[2]}/pull/${full[3]}` : null;
  }
  return null;
}
