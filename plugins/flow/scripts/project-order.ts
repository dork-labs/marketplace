/**
 * The project layer of the work order (DOR-5067): which projects feed the
 * issue order, and in what rank.
 *
 * Started projects are "now" and feed the issue order; Planned ones are
 * "next"; Paused and Backlog ones are "later" (shown only with `--all`);
 * Completed and Canceled ones are left out. Inside each list: project
 * priority (none last), target date (none last), created time, then the
 * project's slug.
 *
 * Pure and deterministic, like `work-order.ts`: same input, same output, and
 * input order never matters.
 *
 * @see research/20261122_work-sequencing.md §3.2 (dorkos repo)
 * @module @dorkos/flow/project-order
 */

import type { OrderConfig, ProjectEntry, ProjectRanking } from './work-order.ts';
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

/** Project priority as a sort key: 1 (urgent) first, none last. */
function priorityKey(project: ProjectInfo): number {
  const p = project.priority;
  return typeof p === 'number' && p >= 1 && p <= 4 ? p : NEUTRAL;
}

/** A `YYYY-MM-DD` or ISO date as a sort key; none or unreadable last. */
function dateKey(value: string | undefined): number {
  if (typeof value !== 'string') return NEUTRAL;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}

/** Compare two keys, treating two neutrals as a tie. */
function compareKeys(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compare two projects inside one list. */
function compareProjects(a: ProjectInfo, b: ProjectInfo): number {
  return (
    compareKeys(priorityKey(a), priorityKey(b)) ||
    compareKeys(dateKey(a.targetDate), dateKey(b.targetDate)) ||
    compareKeys(dateKey(a.createdAt), dateKey(b.createdAt)) ||
    (a.slugId < b.slugId ? -1 : a.slugId > b.slugId ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The plain-words reasons for one project's place. */
function reasonsOf(project: ProjectInfo): ProjectEntry['why'] {
  const why: ProjectEntry['why'] = [];
  const p = priorityKey(project);
  if (p !== NEUTRAL) why.push({ key: 'priority', text: `priority ${p}` });
  if (typeof project.targetDate === 'string') {
    why.push({ key: 'targetDate', text: `target ${project.targetDate}` });
  }
  return why;
}

/**
 * Rank the open projects into "now", "next" and "later", and give each a rank
 * for the issue order's project key.
 *
 * @param projects - Every open project of the team.
 * @param items - Every open item of the team (for remaining work).
 * @param config - The resolved order settings.
 * @returns The three lists, whole-list flags and each project's rank.
 */
export function rankProjects(
  projects: readonly ProjectInfo[],
  items: readonly WorkItem[],
  config: OrderConfig
): ProjectRanking {
  void items;
  void config;
  const lists = { now: [] as ProjectInfo[], next: [] as ProjectInfo[], later: [] as ProjectInfo[] };
  for (const project of Array.isArray(projects) ? projects : []) {
    const list = LIST_OF.get(project?.statusType);
    if (list !== undefined && typeof project.id === 'string') lists[list].push(project);
  }
  const rankOf = new Map<string, number>();
  let rank = 0;
  const entries = (list: ProjectInfo[]): ProjectEntry[] =>
    [...list].sort(compareProjects).map((project, i) => {
      rank += 1;
      rankOf.set(project.id, rank);
      return {
        place: i + 1,
        id: project.id,
        name: project.name,
        status: project.statusType as ProjectEntry['status'],
        why: reasonsOf(project),
        flags: [],
      };
    });
  const now = entries(lists.now);
  const next = entries(lists.next);
  const later = entries(lists.later);
  return { now, next, later, flags: [], rankOf };
}
