/**
 * `flow order` (DOR-5063): the work order, printed. The project order and the
 * issue order, from one pull of the backlog through `computeWorkOrder`, the
 * same function `flow next` picks from under `dispatch.ladder: "v2"`. Read
 * only: it writes nothing anywhere, so it runs while flow is paused too.
 *
 * - No flags: the banners, Started and Planned projects, then the issues best
 *   first (the first 15 in text; all in `--json`), then what is in flight,
 *   held, waiting for triage and kept out by `order.personLabel`.
 * - `-n <N>`: keep the first N issues, in text and JSON.
 * - `--projects`: the project lists only: each project's place, its reasons
 *   (dates in plain words; the JSON keeps `targetDate` as `YYYY-MM-DD`), what
 *   a person should fix, the Started cap, and Dorian's projects.
 * - `--all`: also the Paused and Backlog projects.
 * - `--why <id>`: one item's reasons, and which field would move it up.
 * - `--rank-of <id>`: the item's place number, or `unranked: <reason>`.
 *
 * @module @dorkos/flow/cli/order
 */

import { UsageError } from '../errors.ts';
import type { BacklogSnapshot } from '../tracker/types.ts';
import type { ProjectInfo, ProjectStatus } from '../work-item.ts';
import {
  computeWorkOrder,
  explainIssue,
  orderConfigOf,
  rankOfIssue,
  type OrderedIssue,
  type ProjectEntry,
  type WorkOrder,
  type WorkOrderInput,
} from '../work-order.ts';
import { loadProjectConfig, readBacklog } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** How many issues the text shows when `-n` is not given. */
const TEXT_DEFAULT_COUNT = 15;

/** The longest title the text prints before cutting it. */
const TITLE_WIDTH = 56;

/** A project category as a work-order status, for a snapshot with no `projectInfo`. */
const STATUS_OF_CATEGORY = new Map<string, ProjectStatus>([
  ['started', 'started'],
  ['unstarted', 'planned'],
  ['backlog', 'backlog'],
  ['completed', 'completed'],
  ['canceled', 'canceled'],
]);

/**
 * The projects to rank: the snapshot's `projectInfo` (adapter contract 3.2.0),
 * or, from an older adapter or snapshot file, each referenced project with
 * only its status known.
 *
 * @param snapshot - The backlog pull.
 * @returns The projects.
 */
export function projectsOf(snapshot: BacklogSnapshot): ProjectInfo[] {
  if (Array.isArray(snapshot.projectInfo)) return snapshot.projectInfo;
  return (snapshot.projects ?? []).flatMap((project) => {
    const statusType = STATUS_OF_CATEGORY.get(project.stateCategory ?? '');
    if (statusType === undefined) return [];
    return [
      {
        id: project.id,
        name: project.name,
        slugId: project.id,
        statusType,
        labels: [],
        blockedBy: [],
      },
    ];
  });
}

/**
 * The work order's input for one pull.
 *
 * @param snapshot - The backlog pull.
 * @param config - The resolved flow config.
 * @param now - The time to stamp the order with.
 * @returns The input.
 */
export function orderInputOf(
  snapshot: BacklogSnapshot,
  config: ReturnType<typeof loadProjectConfig>['loaded']['config'],
  now: Date
): WorkOrderInput {
  return {
    items: snapshot.items,
    projects: projectsOf(snapshot),
    config: orderConfigOf(config),
    now: now.toISOString(),
  };
}

/** Parse `-n`: a whole number of at least 1, or `undefined` when absent. */
function parseCount(value: string | true | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError('-n (--count) needs a whole number of at least 1');
  }
  return count;
}

/** Cut a title to {@link TITLE_WIDTH}. */
function cut(title: string): string {
  return title.length <= TITLE_WIDTH ? title : `${title.slice(0, TITLE_WIDTH - 1)}…`;
}

/** Drop a row's empty trailing cells, so no line ends in padding. */
function trimRow(row: string[]): string[] {
  let end = row.length;
  while (end > 0 && row[end - 1] === '') end -= 1;
  return row.slice(0, end);
}

/** One project list as text, or `null` when it is empty. */
function projectBlock(heading: string, entries: readonly ProjectEntry[]): string | null {
  if (entries.length === 0) return null;
  const rows = entries.map((entry) =>
    trimRow([
      `  ${entry.place}`,
      entry.name,
      entry.why.map((reason) => reason.text).join(', '),
      entry.flags.join('; '),
    ])
  );
  return [heading, formatColumns(rows)].join('\n');
}

/** The project half of the text. */
export function renderProjects(order: WorkOrder, all: boolean, startedCap: number): string {
  return [
    projectBlock(
      `Projects now (Started: ${order.projects.now.length}, cap ${startedCap})`,
      order.projects.now
    ) ?? 'Projects now: none Started.',
    projectBlock('Projects next (Planned)', order.projects.next),
    all ? projectBlock('Projects later (Paused or Backlog)', order.projects.later) : null,
    order.projects.dorian.length > 0
      ? `Dorian's projects, out of the agent order: ${order.projects.dorian.map((p) => p.name).join(', ')}`
      : null,
    order.projects.flags.length > 0 ? `Project flags: ${order.projects.flags.join('; ')}` : null,
  ]
    .filter((block): block is string => block !== null)
    .join('\n\n');
}

/** One ranked issue as a row. */
function issueRow(issue: OrderedIssue): string[] {
  return trimRow([
    `  ${issue.place}`,
    issue.identifier,
    cut(issue.title),
    issue.why.map((reason) => reason.text).join(' · '),
    issue.readiness.ready ? '' : `not ready: ${issue.readiness.reasons.join(', ')}`,
  ]);
}

/** A list of unranked items with one reason column, or `null` when empty. */
function unrankedBlock(heading: string, rows: readonly (readonly string[])[]): string | null {
  if (rows.length === 0) return null;
  return [
    `${heading} (${rows.length})`,
    formatColumns(rows.map((row) => [`  ${row[0]}`, ...row.slice(1)])),
  ].join('\n');
}

/**
 * The whole order as text a tired person can read top to bottom.
 *
 * @param order - The work order.
 * @param shown - How many issues to show.
 * @param all - Whether to show Paused and Backlog projects.
 * @param startedCap - `projects.startedCap`, for the heading.
 * @param personLabel - `order.personLabel`, for the heading of the items it keeps out.
 * @returns The text.
 */
export function renderOrder(
  order: WorkOrder,
  shown: number,
  all: boolean,
  startedCap: number,
  personLabel?: string
): string {
  const issues = order.issues.slice(0, shown);
  const more = order.issues.length - issues.length;
  const issueBlock =
    order.issues.length === 0
      ? 'Issues: nothing ranks. See "Needs triage" and "Held" below.'
      : [
          `Issues, best first (${order.issues.length} ranked${more > 0 ? `; first ${issues.length}, -n ${order.issues.length} for all` : ''})`,
          formatColumns(issues.map(issueRow)),
        ].join('\n');
  return [
    ...order.banners,
    renderProjects(order, all, startedCap),
    issueBlock,
    unrankedBlock(
      'In flight',
      order.inFlight.map((item) => [item.identifier, cut(item.title), item.stateName])
    ),
    unrankedBlock(
      'Held',
      order.held.map((item) => [item.identifier, cut(item.title), item.reason])
    ),
    unrankedBlock(
      'Needs triage',
      order.needsTriage.map((item) => [
        item.identifier,
        cut(item.title),
        `missing: ${item.missing.join(', ')}`,
      ])
    ),
    unrankedBlock(
      personLabel === undefined
        ? 'Out of the agent order'
        : `Out of the agent order (label ${personLabel})`,
      order.personal.map((item) => [item.identifier, cut(item.title)])
    ),
    `Computed ${order.generatedAt}.`,
  ]
    .filter((block): block is string => block !== null)
    .join('\n\n');
}

/**
 * Run `flow order`.
 *
 * @param ctx - The verb's context.
 * @returns The order, or one item's place or reasons.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const count = parseCount(ctx.args.flags.count);
  const why = ctx.args.flags.why;
  const rankOf = ctx.args.flags['rank-of'];
  const all = ctx.args.flags.all === true;
  if (typeof why === 'string' && typeof rankOf === 'string') {
    throw new UsageError('--why and --rank-of each ask about one item; pass one of them');
  }
  const project = loadProjectConfig(ctx);
  const { config } = project.loaded;
  const snapshot = await readBacklog(ctx, project.adapter);
  project.flushWarnings();
  const input = orderInputOf(snapshot, config, ctx.now());
  const order = computeWorkOrder(input);

  if (typeof rankOf === 'string') {
    const rank = rankOfIssue(order, rankOf, input.config.personLabel);
    const place = /^\d+$/.test(rank) ? Number(rank) : null;
    return {
      json: {
        identifier: rankOf,
        place,
        ...(place === null ? { unranked: rank.replace(/^unranked: /, '') } : {}),
      },
      text: rank,
    };
  }
  if (typeof why === 'string') {
    const lines = explainIssue(input, why);
    return {
      json: {
        identifier: why,
        issue: order.issues.find((issue) => issue.identifier === why) ?? null,
        lines,
      },
      text: lines.join('\n'),
    };
  }

  const projects = {
    now: order.projects.now,
    next: order.projects.next,
    ...(all ? { later: order.projects.later } : {}),
    dorian: order.projects.dorian,
    flags: order.projects.flags,
  };
  if (ctx.args.flags.projects === true) {
    return {
      json: { generatedAt: order.generatedAt, projects },
      text: renderProjects(order, all, config.projects.startedCap),
    };
  }
  return {
    json: {
      ...order,
      projects,
      issues: count === undefined ? order.issues : order.issues.slice(0, count),
    },
    text: renderOrder(
      order,
      count ?? TEXT_DEFAULT_COUNT,
      all,
      config.projects.startedCap,
      config.order.personLabel
    ),
  };
}
