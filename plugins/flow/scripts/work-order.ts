/**
 * The **work order** (DOR-5063): the one function that answers "what is
 * next?" for people and agents alike. `flow order` prints it; `flow next`
 * takes its picks from it when `dispatch.ladder` is `v2`. Nothing else in the
 * plugin sorts work items (`engine-tests/tracker-confinement.test.ts` holds
 * that), so every caller quotes the same list.
 *
 * ## Two lists
 *
 * 1. **Projects** ({@link rankProjects | `project-order.ts`}): Started projects
 *    are "now" and feed the issue order; Planned ones are "next"; Paused and
 *    Backlog ones are "later".
 * 2. **Issues**, in bands, first to last: pinned (label `pin`), Urgent
 *    (priority 1), release gate (label `release-gate`), Must (priority 2 in a
 *    `unstarted` state, i.e. Todo), Should (priority 3, or priority 2 still in
 *    Backlog), Could (priority 4). Inside a band the keys in
 *    `dispatch.orderKeys` decide, then the issue number. Urgent skips the
 *    project-rank key: broken is broken, whatever the project.
 *
 * ## What does not rank, and where it goes instead
 *
 * - Started items (In Progress, In Review) are {@link WorkOrder.inFlight}:
 *   shown, never re-ranked.
 * - Items in triage, or with no priority, no project or no estimate, are
 *   {@link WorkOrder.needsTriage}, with the missing fields named. Urgent items
 *   and release gates rank without a project.
 * - An item blocked by an open item is {@link WorkOrder.held} ("held by
 *   DOR-x"); its blocker inherits the better of its own place and the blocked
 *   item's, through any depth.
 * - An item in a project that is not Started is held "waits for project
 *   <P>", unless it is Urgent or a release gate.
 * - An item or project labelled `owner/dorian` is {@link WorkOrder.dorian}: out
 *   of the agent order.
 *
 * ## Pure
 *
 * Same input, same output: no clock (the caller passes `now`), no network, and
 * input order never matters. Bad adapter data degrades the way
 * `dispatch-policy.ts` describes (neutral, never a guess, never a throw).
 *
 * @see research/20261122_work-sequencing.md §3 (dorkos repo), the signed-off method
 * @module @dorkos/flow/work-order
 */

import type { FlowConfig, OrderKeySchema, SizeOrderSchema } from './config-schema.ts';
import { sizeOrdinal } from './dispatch-policy.ts';
import { rankProjects } from './project-order.ts';
import { readinessOf } from './readiness.ts';
import { labelsOf } from './work-item.ts';
import type { ProjectInfo, WorkItem } from './work-item.ts';
import type { z } from 'zod';

/** One key that orders items inside a band (mirrors `OrderKeySchema`). */
export type OrderKey = z.infer<typeof OrderKeySchema>;

/** The band an item ranks in, first to last. */
export type Band = 'pin' | 'urgent' | 'releaseGate' | 'must' | 'should' | 'could';

/** One plain-words reason an item or project sits where it does. */
export interface OrderReason {
  /** The key that gave this reason: a band name, an {@link OrderKey}, `inherits`, `pin`. */
  key: string;
  /** Plain words: "due Nov 27", "project #2 Release branches", "size 2". */
  text: string;
}

/** Whether an item is ready to start, and if not, why. Readiness never moves an item. */
export interface Readiness {
  /** `true` when nothing stands between an agent and starting it. */
  ready: boolean;
  /** Each thing missing: "needs a size", "blocked by DOR-12", and so on. Empty when ready. */
  reasons: string[];
}

/** One ranked item of the issue order. */
export interface OrderedIssue {
  /** 1-based place in the order. */
  place: number;
  /** Human key, e.g. `DOR-123`. */
  identifier: string;
  /** The item's title. */
  title: string;
  /** The band it ranks in. */
  band: Band;
  /** One reason per key that decided its place, band first. */
  why: OrderReason[];
  /** Whether it is ready to start. */
  readiness: Readiness;
  /** Its project's id, when it has one. */
  projectId?: string;
  /** The blocked item whose place this one took, when it inherited a better one. */
  inheritsFrom?: string;
}

/** An item kept out of the order for now, with the reason. */
export interface HeldIssue {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** Why it waits: "held by DOR-12", "waits for project Billing", "PR cap". */
  reason: string;
}

/** An item that cannot rank until a person fills a field. */
export interface NeedsTriage {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** What is missing: `priority`, `project`, `estimate`, `triage state`. */
  missing: string[];
}

/** An item already being worked on: shown, never re-ranked. */
export interface InFlight {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** The tracker's state name, e.g. "In Review". */
  stateName: string;
  /** Account id of the assignee, when there is one. */
  assignee?: string;
}

/** A project as the project list shows it. */
export interface ProjectEntry {
  /** 1-based place inside its list ("now", "next" or "later"). */
  place: number;
  /** Tracker-native project id. */
  id: string;
  /** Project name. */
  name: string;
  /** Its status. */
  status: 'started' | 'planned' | 'paused' | 'backlog';
  /** One reason per key that decided its place. */
  why: OrderReason[];
  /** What a person should fix: "needs a priority", "needs a target date", "over cap", "can't start: waits on <P>". */
  flags: string[];
}

/** The ranked project lists. */
export interface ProjectRanking {
  /** Started projects, in rank: they feed the issue order. */
  now: ProjectEntry[];
  /** Planned projects, in rank: queued. */
  next: ProjectEntry[];
  /** Paused and Backlog projects, in rank: shown only with `--all`. */
  later: ProjectEntry[];
  /** Whole-list flags, e.g. "over cap: 9 Started, cap 6; lowest: P1, P2". */
  flags: string[];
  /**
   * Each listed project's rank for the issue order's project key: its place in
   * `now`, then `next`, then `later` read as one list (1 is best). A project
   * not listed has no rank and sorts after every ranked one.
   */
  rankOf: ReadonlyMap<string, number>;
}

/** The full answer to "what is next?". */
export interface WorkOrder {
  /** The `now` the caller passed, ISO-8601. Never read from a clock inside. */
  generatedAt: string;
  /** One-line notices printed above the order, e.g. "Urgent below pins: DOR-1, DOR-2". Display only. */
  banners: string[];
  /** The project lists. */
  projects: { now: ProjectEntry[]; next: ProjectEntry[]; later: ProjectEntry[]; flags: string[] };
  /** The issue order, best first. */
  issues: OrderedIssue[];
  /** Items being worked on now. */
  inFlight: InFlight[];
  /** Items kept out of the order, with reasons. */
  held: HeldIssue[];
  /** Items that need a person to fill a field before they can rank. */
  needsTriage: NeedsTriage[];
  /** Items labelled `owner/dorian`, or in such a project: out of the agent order. */
  dorian: { identifier: string; title: string }[];
}

/** The settings the work order reads, resolved from the flow config by {@link orderConfigOf}. */
export interface OrderConfig {
  /** `dispatch.orderKeys`: the in-band keys in precedence. */
  orderKeys: readonly OrderKey[];
  /** `dispatch.sizeOrder`: whether smaller or larger items go first in the size key. */
  sizeOrder: z.infer<typeof SizeOrderSchema>;
  /** `projects.startedCap`: how many projects may be Started at once. */
  startedCap: number;
}

/** What {@link computeWorkOrder} reads. */
export interface WorkOrderInput {
  /** Every open item of the team (the snapshot's `items`). */
  items: readonly WorkItem[];
  /** Every open project of the team (the snapshot's `projectInfo`). */
  projects: readonly ProjectInfo[];
  /** The resolved order settings. */
  config: OrderConfig;
  /** The moment to stamp the order with, ISO-8601. */
  now: string;
}

/**
 * Read the order settings out of a resolved flow config.
 *
 * @param config - The resolved flow config.
 * @returns The settings {@link computeWorkOrder} reads.
 */
export function orderConfigOf(config: FlowConfig): OrderConfig {
  return {
    orderKeys: config.dispatch.orderKeys,
    sizeOrder: config.dispatch.sizeOrder,
    startedCap: config.projects.startedCap,
  };
}

// ---------------------------------------------------------------------------
// The issue ladder.
// ---------------------------------------------------------------------------

/** The bands, best first; a band's index is its first sort key. */
const BANDS: readonly Band[] = ['pin', 'urgent', 'releaseGate', 'must', 'should', 'could'];

/** Bands that rank whatever their project's status, and without a project. */
const ANY_PROJECT_BANDS = new Set<Band>(['pin', 'urgent', 'releaseGate']);

/** State categories of an open item. */
const OPEN_CATEGORIES = new Set(['backlog', 'unstarted', 'started']);

/** The labels the work order reads, matched by group and name. */
const PIN_LABEL = 'pin';
const RELEASE_GATE_LABEL = 'release-gate';
const OWNER_DORIAN_LABEL = 'owner/dorian';

/** A neutral key: sorts after every real value. */
const NEUTRAL = Number.POSITIVE_INFINITY;

/**
 * Type key: broken or confusing before new. Linear's `Bug`, `Improvement` and
 * `Feature` labels, and flow's `type/*` family mapped onto them. A `Map` for
 * the reason `dispatch-policy.ts` gives on its own lookup tables.
 */
const TYPE_RANK = new Map<string, number>([
  ['bug', 0],
  ['improvement', 1],
  ['task', 1],
  ['feature', 2],
  ['idea', 2],
]);

/** Plain names for each type rank, for the `why` list. */
const TYPE_NAME = ['Bug', 'Improvement', 'Feature'];

/** Month names for plain-words dates, so the text never depends on the machine's locale. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One ranked candidate, with the tuple it sorts by. */
interface Entry {
  /** The item. */
  item: WorkItem;
  /** Its own band. */
  band: Band;
  /** Its own sort tuple: band index, each order key, its issue number. */
  own: number[];
  /** The tuple it sorts by: its own, or a better one it inherited. */
  effective: number[];
  /** The band of {@link effective}. */
  effectiveBand: Band;
  /** The blocked item whose tuple it inherited, when it did. */
  inheritsFrom?: string;
}

/** Everything {@link buildOrder} works out, for the order and for `--why`. */
interface Built {
  /** The work order. */
  order: WorkOrder;
  /** Every ranked candidate by identifier, in rank order. */
  entries: Entry[];
  /** The project ranking. */
  rankOf: ReadonlyMap<string, number>;
  /** The settings. */
  config: OrderConfig;
}

/** Compare two numbers, two neutrals tying. */
function compareKey(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compare two tuples left to right; a shorter one ties on the missing tail. */
function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = compareKey(a[i] ?? NEUTRAL, b[i] ?? NEUTRAL);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The number in an identifier (`DOR-123` gives 123), or neutral. */
function issueNumber(identifier: string): number {
  const match = /-(\d+)$/.exec(identifier);
  return match === null ? NEUTRAL : Number(match[1]);
}

/** Order identifiers by issue number, then as text. */
function compareIdentifiers(a: string, b: string): number {
  return compareKey(issueNumber(a), issueNumber(b)) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A `YYYY-MM-DD` or ISO-8601 string as milliseconds, or neutral. */
function dateKey(value: unknown): number {
  if (typeof value !== 'string') return NEUTRAL;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}

/** A date in plain words, "Nov 27", with the year when it is not the year of `now`. */
function plainDate(value: string, now: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const date = new Date(ms);
  const nowYear = new Date(Date.parse(now)).getUTCFullYear();
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === nowYear ? day : `${day}, ${date.getUTCFullYear()}`;
}

/** Whether an item carries a label (exact, by group and name). */
function has(item: WorkItem, label: string): boolean {
  return labelsOf(item).includes(label);
}

/** Whether a label list names Security: a bare `security` or any family's `security` leaf, any case. */
function isSecurity(item: WorkItem): boolean {
  return labelsOf(item).some((label) => label.toLowerCase().split('/').pop() === 'security');
}

/** The item's priority when it is a real 1–4, else `undefined`. */
function priorityOf(item: WorkItem): number | undefined {
  const p = item.priority;
  return typeof p === 'number' && p >= 1 && p <= 4 ? p : undefined;
}

/**
 * The band an item ranks in, or `null` when it has no priority and is
 * neither pinned nor a release gate.
 *
 * @param item - The item.
 * @returns Its band.
 */
function bandOf(item: WorkItem): Band | null {
  if (has(item, PIN_LABEL)) return 'pin';
  const priority = priorityOf(item);
  if (priority === 1) return 'urgent';
  if (has(item, RELEASE_GATE_LABEL)) return 'releaseGate';
  if (priority === 2) {
    return item.stateCategory === 'unstarted' && item.triage !== true ? 'must' : 'should';
  }
  if (priority === 3) return 'should';
  if (priority === 4) return 'could';
  return null;
}

/** The band's reason in plain words. */
function bandReason(item: WorkItem, band: Band, now: string): OrderReason {
  switch (band) {
    case 'pin': {
      const pin = item.pin;
      const by = pin?.actorName ?? pin?.actor;
      const meta = [by ? `by ${by}` : null, pin?.at ? plainDate(pin.at, now) : null].filter(
        (part): part is string => part !== null
      );
      const reason = pin?.reason ? pin.reason : 'no pin: comment';
      return {
        key: 'pin',
        text: `pinned: ${reason}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`,
      };
    }
    case 'urgent':
      return { key: 'band', text: 'Urgent' };
    case 'releaseGate':
      return { key: 'band', text: 'release gate' };
    case 'must':
      return { key: 'band', text: 'Must (High, Todo)' };
    case 'should':
      return {
        key: 'band',
        text: priorityOf(item) === 2 ? 'Should (High, still in Backlog)' : 'Should (Medium)',
      };
    case 'could':
      return { key: 'band', text: 'Could (Low)' };
  }
}

/** The type rank of an item from its labels, or neutral. */
function typeKey(item: WorkItem): number {
  let best = NEUTRAL;
  for (const label of labelsOf(item)) {
    const parts = label.toLowerCase().split('/');
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'type')) continue;
    const rank = TYPE_RANK.get(parts[parts.length - 1]);
    if (rank !== undefined && rank < best) best = rank;
  }
  return best;
}

/** What one order key reads off an item: its sort value and its reason, if any. */
interface KeyValue {
  value: number;
  reason?: OrderReason;
}

/** Everything a key needs beyond the item. */
interface KeyContext {
  config: OrderConfig;
  rankOf: ReadonlyMap<string, number>;
  projectName: (id: string) => string;
  open: ReadonlyMap<string, WorkItem>;
  now: string;
}

/**
 * Read one order key off an item.
 *
 * @param key - The key.
 * @param item - The item.
 * @param band - Its band (Urgent skips the project key).
 * @param ctx - The project ranks, open items and settings.
 * @returns The sort value and, when the item has a value, the reason.
 */
function keyValue(key: OrderKey, item: WorkItem, band: Band, ctx: KeyContext): KeyValue {
  switch (key) {
    case 'dueDate': {
      const value = dateKey(item.dueDate);
      return value === NEUTRAL
        ? { value }
        : { value, reason: { key, text: `due ${plainDate(item.dueDate as string, ctx.now)}` } };
    }
    case 'projectRank': {
      if (band === 'urgent') return { value: 0 };
      const id = item.project?.id;
      const rank = typeof id === 'string' ? ctx.rankOf.get(id) : undefined;
      return rank === undefined
        ? { value: NEUTRAL }
        : {
            value: rank,
            reason: { key, text: `project #${rank} ${ctx.projectName(id as string)}` },
          };
    }
    case 'unblocks': {
      const blocks = item.relations?.blocks;
      const unblocked = (Array.isArray(blocks) ? blocks : [])
        .filter((id, i, all) => ctx.open.has(id) && all.indexOf(id) === i)
        .sort(compareIdentifiers);
      return unblocked.length === 0
        ? { value: 0 }
        : { value: -unblocked.length, reason: { key, text: `unblocks ${unblocked.join(', ')}` } };
    }
    case 'type': {
      const value = typeKey(item);
      return value === NEUTRAL ? { value } : { value, reason: { key, text: TYPE_NAME[value] } };
    }
    case 'size': {
      const ordinal = sizeOrdinal(item.size);
      if (ordinal === undefined) return { value: NEUTRAL };
      return {
        value: ctx.config.sizeOrder === 'large-first' ? -ordinal : ordinal,
        reason: { key, text: `size ${item.size}` },
      };
    }
    case 'age': {
      const value = dateKey(item.createdAt);
      return value === NEUTRAL
        ? { value }
        : { value, reason: { key, text: `filed ${plainDate(item.createdAt as string, ctx.now)}` } };
    }
  }
}

/**
 * Keep the items a work order can read: objects with a string identifier, one
 * per identifier (the lowest tracker id wins a repeat), in identifier order so
 * nothing downstream depends on input order.
 */
function cleanItems(items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map<string, WorkItem>();
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || typeof item.identifier !== 'string') continue;
    const seen = byId.get(item.identifier);
    if (seen === undefined || String(item.id) < String(seen.id)) byId.set(item.identifier, item);
  }
  return [...byId.values()].sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
}

/** Keep the projects a work order can read: objects with a string id, one per id. */
function cleanProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  const byId = new Map<string, ProjectInfo>();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (project === null || typeof project !== 'object' || typeof project.id !== 'string') continue;
    if (!byId.has(project.id)) {
      byId.set(project.id, {
        ...project,
        labels: Array.isArray(project.labels) ? project.labels : [],
      });
    }
  }
  return [...byId.values()];
}

/**
 * Work out the whole order: classify every open item, rank the candidates,
 * pass each blocked item's place to its blockers, and build the lists.
 *
 * @param input - The open items, projects, settings and time.
 * @returns The order and the ranked entries behind it.
 */
function buildOrder(input: WorkOrderInput): Built {
  const items = cleanItems(input.items);
  const projects = cleanProjects(input.projects);
  const config = input.config;
  const now = input.now;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const ranking = rankProjects(projects, items, config);
  const open = new Map(
    items.filter((item) => OPEN_CATEGORIES.has(item.stateCategory)).map((i) => [i.identifier, i])
  );
  const projectName = (id: string): string =>
    projectById.get(id)?.name ?? items.find((item) => item.project?.id === id)?.project?.name ?? id;
  const ctx: KeyContext = { config, rankOf: ranking.rankOf, projectName, open, now };
  const tupleOf = (item: WorkItem, band: Band): number[] => [
    BANDS.indexOf(band),
    ...config.orderKeys.map((key) => keyValue(key, item, band, ctx).value),
    issueNumber(item.identifier),
  ];

  const inFlight: InFlight[] = [];
  const held: HeldIssue[] = [];
  const needsTriage: NeedsTriage[] = [];
  const dorian: WorkOrder['dorian'] = [];
  const candidates = new Map<string, Entry>();
  /** Blocked items that would rank but for their blocker: they pass their place on. */
  const blocked = new Map<string, { item: WorkItem; tuple: number[]; band: Band }>();

  for (const item of open.values()) {
    const projectId = item.project?.id;
    const project = typeof projectId === 'string' ? projectById.get(projectId) : undefined;
    if (has(item, OWNER_DORIAN_LABEL) || project?.labels.includes(OWNER_DORIAN_LABEL)) {
      dorian.push({ identifier: item.identifier, title: item.title });
      continue;
    }
    if (item.stateCategory === 'started') {
      inFlight.push({
        identifier: item.identifier,
        title: item.title,
        stateName: item.stateName,
        ...(typeof item.assignee === 'string' ? { assignee: item.assignee } : {}),
      });
      continue;
    }
    const band = bandOf(item);
    if (band !== 'pin') {
      const missing: string[] = [];
      if (item.triage === true) missing.push('triage state');
      if (band === null) missing.push('priority');
      if (typeof projectId !== 'string' && !(band !== null && ANY_PROJECT_BANDS.has(band))) {
        missing.push('project');
      }
      if (sizeOrdinal(item.size) === undefined) missing.push('estimate');
      if (missing.length > 0 || band === null) {
        needsTriage.push({ identifier: item.identifier, title: item.title, missing });
        continue;
      }
      if (typeof projectId === 'string' && !ANY_PROJECT_BANDS.has(band)) {
        const started = project
          ? project.statusType === 'started'
          : item.project?.stateCategory === 'started';
        if (!started) {
          held.push({
            identifier: item.identifier,
            title: item.title,
            reason: `waits for project ${projectName(projectId)}`,
          });
          continue;
        }
      }
    }
    const resolvedBand = band as Band;
    const blockers = openBlockers(item, open);
    if (blockers.length > 0) {
      held.push({
        identifier: item.identifier,
        title: item.title,
        reason: `held by ${blockers.join(', ')}`,
      });
      blocked.set(item.identifier, {
        item,
        tuple: tupleOf(item, resolvedBand),
        band: resolvedBand,
      });
      continue;
    }
    const own = tupleOf(item, resolvedBand);
    candidates.set(item.identifier, {
      item,
      band: resolvedBand,
      own,
      effective: own,
      effectiveBand: resolvedBand,
    });
  }

  // Inheritance: each blocked item hands its place to every candidate in its
  // way, through any depth of blocked items, visiting each item once.
  for (const [source, { tuple, band }] of blocked) {
    const seen = new Set<string>([source]);
    const stack = [...openBlockers(blocked.get(source)!.item, open)];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const candidate = candidates.get(id);
      if (candidate !== undefined) {
        if (compareTuples(tuple, candidate.effective) < 0) {
          candidate.effective = tuple;
          candidate.effectiveBand = band;
          candidate.inheritsFrom = source;
        }
        continue;
      }
      const through = blocked.get(id);
      if (through !== undefined) stack.push(...openBlockers(through.item, open));
    }
  }

  const entries = [...candidates.values()].sort(
    (a, b) =>
      compareTuples(a.effective, b.effective) ||
      compareIdentifiers(a.item.identifier, b.item.identifier)
  );
  const issues: OrderedIssue[] = entries.map((entry, i) => {
    const why: OrderReason[] = [];
    if (entry.inheritsFrom !== undefined) {
      why.push({ key: 'inherits', text: `inherits ${entry.inheritsFrom}'s place` });
    }
    why.push(bandReason(entry.item, entry.band, now));
    for (const key of config.orderKeys) {
      const reason = keyValue(key, entry.item, entry.band, ctx).reason;
      if (reason !== undefined) why.push(reason);
    }
    return {
      place: i + 1,
      identifier: entry.item.identifier,
      title: entry.item.title,
      band: entry.effectiveBand,
      why,
      readiness: readinessOf(entry.item, { open }),
      ...(typeof entry.item.project?.id === 'string' ? { projectId: entry.item.project.id } : {}),
      ...(entry.inheritsFrom === undefined ? {} : { inheritsFrom: entry.inheritsFrom }),
    };
  });

  const banners: string[] = [];
  if (entries.some((entry) => entry.band === 'pin')) {
    const urgent = entries
      .filter((entry) => entry.band === 'urgent')
      .map((entry) => `${entry.item.identifier}${isSecurity(entry.item) ? ' (security)' : ''}`);
    if (urgent.length > 0) banners.push(`Urgent below pins: ${urgent.join(', ')}`);
  }

  const byIdentifier = <T extends { identifier: string }>(list: T[]): T[] =>
    list.sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
  return {
    order: {
      generatedAt: now,
      banners,
      projects: {
        now: ranking.now,
        next: ranking.next,
        later: ranking.later,
        flags: ranking.flags,
      },
      issues,
      inFlight: byIdentifier(inFlight),
      held: byIdentifier(held),
      needsTriage: byIdentifier(needsTriage),
      dorian: byIdentifier(dorian),
    },
    entries,
    rankOf: ranking.rankOf,
    config,
  };
}

/** The open items that block an item, by identifier, in identifier order. */
function openBlockers(item: WorkItem, open: ReadonlyMap<string, WorkItem>): string[] {
  const ids = item.relations?.blockedBy;
  return (Array.isArray(ids) ? ids : [])
    .filter((id, i, all) => id !== item.identifier && open.has(id) && all.indexOf(id) === i)
    .sort(compareIdentifiers);
}

/**
 * Compute the work order: the project lists and the issue order, with a
 * reason per item and every item that does not rank listed with why.
 *
 * @param input - The open items, the open projects, the settings and the time.
 * @returns The work order.
 */
export function computeWorkOrder(input: WorkOrderInput): WorkOrder {
  return buildOrder(input).order;
}

/** What to change to move a band up, in plain words. */
function bandAdvice(item: WorkItem, band: Band): string {
  switch (band) {
    case 'pin':
      return 'pins order among themselves by the same keys';
    case 'urgent':
      return 'only a pin goes above Urgent (label pin, plus a comment starting "pin:")';
    case 'releaseGate':
      return 'priority Urgent, if it is broken now';
    case 'must':
      return 'the release-gate label, if the next release needs it';
    case 'should':
      return priorityOf(item) === 2
        ? 'move it to Todo to confirm the Must'
        : 'priority High and state Todo (a confirmed Must)';
    case 'could':
      return 'priority Medium (a Should)';
  }
}

/**
 * Say why one item is where it is, and what field would move it up. For an
 * item that does not rank, says why not.
 *
 * @param input - The same input {@link computeWorkOrder} takes.
 * @param identifier - The item's human key.
 * @returns Plain-words lines, first line the verdict.
 */
export function explainIssue(input: WorkOrderInput, identifier: string): string[] {
  const built = buildOrder(input);
  const { order, entries } = built;
  const at = order.issues.findIndex((issue) => issue.identifier === identifier);
  if (at === -1) return [rankOfIssue(order, identifier)];
  const issue = order.issues[at];
  const lines = [
    `${issue.identifier} is #${issue.place}: ${issue.title}`,
    ...issue.why.map((reason) => `  - ${reason.text}`),
    issue.readiness.ready
      ? '  Ready to start.'
      : `  Not ready: ${issue.readiness.reasons.join(', ')}.`,
  ];
  if (at === 0) return [...lines, '  Nothing ranks above it.'];
  const above = entries[at - 1];
  const self = entries[at];
  const index = self.effective.findIndex((value, i) => value !== above.effective[i]);
  const keyAt = index - 1;
  let advice: string;
  if (index === 0) {
    advice = self.inheritsFrom
      ? `${above.item.identifier} is in a better band than ${self.inheritsFrom}, whose place this one took`
      : `${above.item.identifier} is in a better band; to move up: ${bandAdvice(self.item, self.band)}`;
  } else if (keyAt >= 0 && keyAt < built.config.orderKeys.length) {
    const key = built.config.orderKeys[keyAt];
    const ahead = above.item.identifier;
    const advise: Record<OrderKey, string> = {
      dueDate:
        typeof above.item.dueDate === 'string'
          ? `${ahead} is due ${plainDate(above.item.dueDate, order.generatedAt)}; an earlier due date moves it up`
          : `${ahead} sorts first on due date; an earlier due date moves it up`,
      projectRank: `${ahead}'s project ranks higher; a higher project priority or an earlier target date moves its project up`,
      unblocks: `${ahead} unblocks more open items; a blocks relation to an open item counts for it`,
      type: `${ahead} is a type that ranks first (Bug, then Improvement, then Feature)`,
      size: `${ahead} is smaller; splitting it into smaller items moves the first one up`,
      age: `${ahead} was filed earlier; no field to change`,
    };
    advice = advise[key];
  } else {
    advice = `${above.item.identifier} has the lower issue number; no field to change`;
  }
  return [...lines, `  Above it: ${above.item.identifier}. ${advice}.`];
}

/**
 * One item's place in the order: its place number, or `unranked: <reason>`.
 *
 * @param order - A computed work order.
 * @param identifier - The item's human key.
 * @returns The place as text, e.g. `3`, or `unranked: held by DOR-12`.
 */
export function rankOfIssue(order: WorkOrder, identifier: string): string {
  const ranked = order.issues.find((issue) => issue.identifier === identifier);
  if (ranked !== undefined) return String(ranked.place);
  const heldItem = order.held.find((entry) => entry.identifier === identifier);
  if (heldItem !== undefined) return `unranked: ${heldItem.reason}`;
  const triage = order.needsTriage.find((entry) => entry.identifier === identifier);
  if (triage !== undefined) return `unranked: needs triage (${triage.missing.join(', ')})`;
  const flight = order.inFlight.find((entry) => entry.identifier === identifier);
  if (flight !== undefined) return `unranked: in flight (${flight.stateName})`;
  if (order.dorian.some((entry) => entry.identifier === identifier)) {
    return "unranked: on Dorian's list (owner/dorian)";
  }
  return 'unranked: not an open item of the team';
}
