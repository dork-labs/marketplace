/**
 * The project layer of the work order (DOR-5067): which projects feed the
 * issue order, and in what rank.
 *
 * ## Lists
 *
 * Started projects are "now" and feed the issue order; Planned ones are
 * "next"; Paused and Backlog ones are "later" (shown only with `--all`);
 * Completed and Canceled ones are left out. A project labelled `owner/dorian`
 * is in none of them: it is on {@link ProjectRanking.dorian}, out of the agent
 * order, and its issues go to Dorian's list.
 *
 * ## Rank inside a list, first key first
 *
 * 1. Pinned (project label `pin`).
 * 2. Project priority, Urgent (1) to Low (4); none last, flagged
 *    `needs a priority`.
 * 3. Target date, earliest first; none last, flagged `needs a target date`.
 * 4. Dependencies: a project waiting on an open project is flagged
 *    `can't start: waits on <P>` (its issues do not rank), and the project in
 *    the way takes the better of its own keys and those of every Started or
 *    Planned project waiting on it, through any depth, cycle-safe.
 * 5. Remaining work: the estimates of its open issues added up, smaller
 *    first. An unsized issue counts as the largest bucket, so a project
 *    nobody has sized does not look small.
 * 6. Created time, older first; then the slug.
 *
 * ## The cap
 *
 * Over `projects.startedCap`, the ranking flags the lowest-ranked Started
 * projects and reports `over cap: N Started, cap M; lowest: P1, P2`. It never
 * changes a project's status: a person pauses or finishes one. Projects on
 * Dorian's list do not count toward the cap.
 *
 * Pure and deterministic, like `work-order.ts`: same input, same output, and
 * input order never matters.
 *
 * @see research/20261122_work-sequencing.md §3.2 (dorkos repo)
 * @module @dorkos/flow/project-order
 */

import { sizeOrdinal } from './dispatch-policy.ts';
import type { OrderConfig, OrderReason, ProjectEntry, ProjectRanking } from './work-order.ts';
import type { ProjectInfo, WorkItem } from './work-item.ts';

/** A neutral key: sorts after every real value. */
const NEUTRAL = Number.POSITIVE_INFINITY;

/** Which list each open status goes in. */
const LIST_OF = new Map<string, 'now' | 'next' | 'later'>([
  ['started', 'now'],
  ['planned', 'next'],
  ['paused', 'later'],
  ['backlog', 'later'],
]);

/** Statuses whose projects pass their place to the project in their way. */
const LIFTING_STATUSES = new Set(['started', 'planned']);

/** State categories of an open item. */
const OPEN_CATEGORIES = new Set(['backlog', 'unstarted', 'started']);

/** The project labels the ranking reads, matched by group and name. */
const PIN_LABEL = 'pin';
const OWNER_DORIAN_LABEL = 'owner/dorian';

/** Priority names, by priority number, for the `why` list. */
const PRIORITY_NAME = new Map<number, string>([
  [1, 'Urgent'],
  [2, 'High'],
  [3, 'Medium'],
  [4, 'Low'],
]);

/**
 * Points for each size ordinal, for a t-shirt estimate ("md" counts 3). The
 * last entry is the largest bucket of the shared scale.
 */
const POINTS_OF_ORDINAL = [1, 2, 3, 5, 8, 13];

/** Month names for plain-words dates, so the text never depends on the machine's locale. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date in plain words, "Nov 27", with the year when it is not the year of
 * `now` (or always, when `now` is not given or unreadable). An unreadable
 * date comes back as given.
 *
 * @param value - A `YYYY-MM-DD` or ISO-8601 date.
 * @param now - The moment the text is for, ISO-8601.
 * @returns The date in plain words.
 */
export function plainDate(value: string, now?: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const date = new Date(ms);
  const nowMs = typeof now === 'string' ? Date.parse(now) : NaN;
  const nowYear = Number.isNaN(nowMs) ? NaN : new Date(nowMs).getUTCFullYear();
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === nowYear ? day : `${day}, ${date.getUTCFullYear()}`;
}

/** One project being ranked, with the keys it sorts by. */
interface Ranked {
  /** The project. */
  project: ProjectInfo;
  /** Its own keys: pin, priority, target date, remaining work, created time. */
  own: number[];
  /** The keys it sorts by: its own, or a better set it inherited. */
  effective: number[];
  /** The project whose keys it inherited, when it did. */
  inheritsFrom?: ProjectInfo;
  /**
   * How many steps it stands in front of {@link inheritsFrom} (0 when it did
   * not inherit): on equal keys the deeper one goes first, so a project in the
   * way always sorts ahead of the projects waiting on it.
   */
  depth: number;
  /** Its remaining work in points, and how many unsized issues it counts. */
  remaining: Remaining;
}

/** A project's remaining work. */
interface Remaining {
  /** Points of its open issues, unsized ones counted as the largest bucket. */
  points: number;
  /** How many of its open issues have no estimate. */
  unsized: number;
}

/** Compare two numbers, two neutrals tying. */
function compareKey(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compare two key lists left to right. */
function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = compareKey(a[i] ?? NEUTRAL, b[i] ?? NEUTRAL);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Compare two strings as text. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Project priority as a sort key: 1 (Urgent) first, none last. */
function priorityKey(project: ProjectInfo): number {
  const p = project.priority;
  return typeof p === 'number' && p >= 1 && p <= 4 ? p : NEUTRAL;
}

/** A `YYYY-MM-DD` or ISO date as a sort key; none or unreadable last. */
function dateKey(value: unknown): number {
  if (typeof value !== 'string') return NEUTRAL;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}

/** Whether a project carries a label (exact, by group and name). */
function hasLabel(project: ProjectInfo, label: string): boolean {
  return project.labels.includes(label);
}

/** An item's estimate in points, or `undefined` when it has none. */
function pointsOf(size: WorkItem['size']): number | undefined {
  if (typeof size === 'number') return Number.isFinite(size) && size >= 0 ? size : undefined;
  if (typeof size !== 'string' || size.trim() === '') return undefined;
  const asNumber = Number(size.trim());
  if (!Number.isNaN(asNumber))
    return Number.isFinite(asNumber) && asNumber >= 0 ? asNumber : undefined;
  const ordinal = sizeOrdinal(size);
  return ordinal === undefined ? undefined : POINTS_OF_ORDINAL[ordinal];
}

/**
 * Each project's remaining work: the points of its open issues added up, an
 * unsized issue counting as the largest bucket (the larger of the shared
 * scale's top and the team's largest estimate).
 *
 * @param items - Every open item of the team.
 * @returns Remaining work by project id, and the bucket an unsized issue counts as.
 */
function remainingWork(items: readonly WorkItem[]): {
  byProject: Map<string, Remaining>;
  largest: number;
} {
  const seen = new Set<string>();
  const open: WorkItem[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || typeof item.identifier !== 'string') continue;
    if (!OPEN_CATEGORIES.has(item.stateCategory) || typeof item.project?.id !== 'string') continue;
    if (seen.has(item.identifier)) continue;
    seen.add(item.identifier);
    open.push(item);
  }
  let largest = POINTS_OF_ORDINAL[POINTS_OF_ORDINAL.length - 1];
  for (const item of open) {
    const points = pointsOf(item.size);
    if (points !== undefined && points > largest) largest = points;
  }
  const byProject = new Map<string, Remaining>();
  for (const item of open) {
    const id = item.project?.id as string;
    const sum = byProject.get(id) ?? { points: 0, unsized: 0 };
    const points = pointsOf(item.size);
    if (points === undefined) sum.unsized += 1;
    sum.points += points ?? largest;
    byProject.set(id, sum);
  }
  return { byProject, largest };
}

/**
 * Keep the projects the ranking can read: objects with a string id and an
 * open status, one per id (the lowest slug wins a repeat, so input order never
 * decides), with their lists made safe to read.
 */
function cleanProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  const byId = new Map<string, ProjectInfo>();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (project === null || typeof project !== 'object' || typeof project.id !== 'string') continue;
    if (!LIST_OF.has(project.statusType)) continue;
    const clean: ProjectInfo = {
      ...project,
      name: typeof project.name === 'string' ? project.name : project.id,
      slugId: typeof project.slugId === 'string' ? project.slugId : project.id,
      labels: Array.isArray(project.labels)
        ? project.labels.filter((label): label is string => typeof label === 'string')
        : [],
      blockedBy: Array.isArray(project.blockedBy)
        ? project.blockedBy.filter((id): id is string => typeof id === 'string')
        : [],
    };
    const seen = byId.get(project.id);
    if (seen === undefined || compareText(clean.slugId, seen.slugId) < 0) {
      byId.set(project.id, clean);
    }
  }
  return [...byId.values()];
}

/** The open projects a project waits on, by id, sorted. */
function openBlockers(project: ProjectInfo, open: ReadonlyMap<string, ProjectInfo>): string[] {
  return [...new Set(project.blockedBy)].filter((id) => id !== project.id && open.has(id)).sort();
}

/** The plain-words reasons for one project's place. */
function reasonsOf(
  entry: Ranked,
  dependants: readonly string[],
  largest: number,
  now: string | undefined
): OrderReason[] {
  const { project, remaining } = entry;
  const why: OrderReason[] = [];
  if (entry.inheritsFrom !== undefined) {
    why.push({ key: 'inherits', text: `inherits ${entry.inheritsFrom.name}'s place` });
  }
  if (hasLabel(project, PIN_LABEL)) why.push({ key: 'pin', text: 'pinned' });
  const p = priorityKey(project);
  if (p !== NEUTRAL) why.push({ key: 'priority', text: `priority ${PRIORITY_NAME.get(p)}` });
  if (dateKey(project.targetDate) !== NEUTRAL) {
    why.push({ key: 'targetDate', text: `target ${plainDate(project.targetDate as string, now)}` });
  }
  if (dependants.length > 0) {
    why.push({ key: 'dependencies', text: `in the way of ${dependants.join(', ')}` });
  }
  const unsized =
    remaining.unsized === 0 ? '' : `, ${remaining.unsized} unsized counted as ${largest} each`;
  why.push({
    key: 'remaining',
    text: remaining.points === 0 ? 'no open issues' : `${remaining.points} points open${unsized}`,
  });
  if (dateKey(project.createdAt) !== NEUTRAL) {
    why.push({ key: 'created', text: `created ${plainDate(project.createdAt as string, now)}` });
  }
  return why;
}

/**
 * Rank the open projects into "now", "next" and "later", and give each a rank
 * for the issue order's project key.
 *
 * @param projects - Every open project of the team.
 * @param items - Every open item of the team (for remaining work).
 * @param config - The resolved order settings (`startedCap`).
 * @param now - The moment the order is for, ISO-8601: dates in the `why` text
 *   leave out the year when it is this one. Without it they always carry it.
 * @returns The three lists, Dorian's projects, whole-list flags, the projects
 *   that wait on another, and each listed project's rank.
 */
export function rankProjects(
  projects: readonly ProjectInfo[],
  items: readonly WorkItem[],
  config: OrderConfig,
  now?: string
): ProjectRanking {
  const open = new Map(cleanProjects(projects).map((project) => [project.id, project]));
  const { byProject, largest } = remainingWork(items);
  const nameOf = (id: string): string => open.get(id)?.name ?? id;

  const ranked = new Map<string, Ranked>();
  for (const project of [...open.values()].sort((a, b) => compareText(a.id, b.id))) {
    const remaining = byProject.get(project.id) ?? { points: 0, unsized: 0 };
    const own = [
      hasLabel(project, PIN_LABEL) ? 0 : 1,
      priorityKey(project),
      dateKey(project.targetDate),
      remaining.points,
      dateKey(project.createdAt),
    ];
    ranked.set(project.id, { project, own, effective: own, remaining, depth: 0 });
  }

  // Dependencies: each Started or Planned project waiting on another hands its
  // keys to every project in its way, through any depth, visiting each once.
  // Sources go in id order and only a strictly better set replaces, so a tie
  // is settled the same way every run.
  const dependantsOf = new Map<string, string[]>();
  const waitsOn = new Map<string, string>();
  for (const source of ranked.values()) {
    const blockers = openBlockers(source.project, open);
    if (blockers.length === 0) continue;
    waitsOn.set(source.project.id, blockers.map(nameOf).sort(compareText).join(', '));
    for (const id of blockers) {
      dependantsOf.set(id, [...(dependantsOf.get(id) ?? []), source.project.name]);
    }
    if (!LIFTING_STATUSES.has(source.project.statusType)) continue;
    const seen = new Set<string>([source.project.id]);
    const stack: [string, number][] = blockers.map((id) => [id, 1]);
    while (stack.length > 0) {
      const [id, depth] = stack.pop() as [string, number];
      if (seen.has(id)) continue;
      seen.add(id);
      const target = ranked.get(id) as Ranked;
      if (compareTuples(source.own, target.effective) < 0) {
        target.effective = source.own;
        target.inheritsFrom = source.project;
        target.depth = depth;
      }
      stack.push(
        ...openBlockers(target.project, open).map((next): [string, number] => [next, depth + 1])
      );
    }
  }

  const compare = (a: Ranked, b: Ranked): number =>
    compareTuples(a.effective, b.effective) ||
    compareKey(b.depth, a.depth) ||
    compareTuples(a.own, b.own) ||
    compareText(a.project.slugId, b.project.slugId) ||
    compareText(a.project.id, b.project.id);

  const lists = { now: [] as Ranked[], next: [] as Ranked[], later: [] as Ranked[] };
  const dorian: ProjectRanking['dorian'] = [];
  for (const entry of [...ranked.values()].sort(compare)) {
    if (hasLabel(entry.project, OWNER_DORIAN_LABEL)) {
      dorian.push({ id: entry.project.id, name: entry.project.name });
      continue;
    }
    lists[LIST_OF.get(entry.project.statusType) as 'now' | 'next' | 'later'].push(entry);
  }

  const cap = config?.startedCap;
  const overCap =
    typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 && lists.now.length > cap
      ? new Set(lists.now.slice(cap).map((entry) => entry.project.id))
      : new Set<string>();

  const rankOf = new Map<string, number>();
  let rank = 0;
  const entries = (list: Ranked[]): ProjectEntry[] =>
    list.map((entry, i) => {
      rank += 1;
      const { project } = entry;
      rankOf.set(project.id, rank);
      const flags: string[] = [];
      if (priorityKey(project) === NEUTRAL) flags.push('needs a priority');
      if (dateKey(project.targetDate) === NEUTRAL) flags.push('needs a target date');
      if (overCap.has(project.id)) flags.push('over cap');
      const blockers = waitsOn.get(project.id);
      if (blockers !== undefined) flags.push(`can't start: waits on ${blockers}`);
      const dependants = [...(dependantsOf.get(project.id) ?? [])].sort(compareText);
      return {
        place: i + 1,
        id: project.id,
        name: project.name,
        status: project.statusType as ProjectEntry['status'],
        why: reasonsOf(entry, dependants, largest, now),
        flags,
        ...(dateKey(project.targetDate) === NEUTRAL
          ? {}
          : { targetDate: project.targetDate as string }),
        ...(entry.inheritsFrom === undefined ? {} : { inheritsFrom: entry.inheritsFrom.id }),
      };
    });
  const nowList = entries(lists.now);
  const next = entries(lists.next);
  const later = entries(lists.later);

  const flags: string[] = [];
  if (overCap.size > 0) {
    const lowest = nowList.filter((entry) => overCap.has(entry.id)).map((entry) => entry.name);
    flags.push(`over cap: ${nowList.length} Started, cap ${cap}; lowest: ${lowest.join(', ')}`);
  }
  return { now: nowList, next, later, dorian, flags, rankOf, waitsOn };
}
