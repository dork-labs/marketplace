/**
 * `flow next [-n N] [--for-project <name|id>]` (spec `flow-cli-core` §6): what
 * to work on next, from the same dispatch oracle `dispatch.ts` runs, with every
 * input built here instead of by hand.
 *
 * - Config, snapshot (tracker or `--snapshot`), and identity: `identity.agent`,
 *   or the tracker's current user when it is `auto`; `identity.reviewer` as set.
 * - Ownership: `classifyOwnership` per item. With `issues` in `ownership.scope`
 *   an item is classified by its assignee (the claim is per item); with only
 *   `projects`, by its project's lead.
 * - WIP load: open items that are `started` and carry `agent/claimed`, counted
 *   by project id and in total, over the whole snapshot.
 * - `--for-project` narrows the candidates (project id, else case-insensitive
 *   name) before dispatch; the WIP load still counts every project.
 * - `-n` (default 1) keeps the first N picks, already capped by WIP.
 * - Paused: exit 7 unless `--manual`. Nothing eligible is still exit 0, with
 *   `starved` saying whether a triage pass would help.
 *
 * @module @dorkos/flow/cli/next
 */

import { classifyDispatchOutcome } from '../dispatch-policy.ts';
import { PausedError, PreconditionError, UsageError } from '../errors.ts';
import { classifyOwnership, type Identity, type OwnershipScope } from '../identity.ts';
import type { BacklogSnapshot, WorkItem, WorkItemProject } from '../tracker/types.ts';
import { AGENT_CLAIMED } from '../work-state.ts';
import { loadProjectConfig, readBacklog, resolveAgentId } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** The live in-progress load the WIP cap measures. */
export interface WipLoad {
  /** Claimed, started items across every project. */
  total: number;
  /** Claimed, started items per project id. */
  byProject: Record<string, number>;
}

/**
 * Count the WIP load: open items that are `started` and carry `agent/claimed`.
 *
 * @param items - Every open item of the snapshot.
 * @returns The total and the per-project counts.
 */
export function wipLoad(items: readonly WorkItem[]): WipLoad {
  const load: WipLoad = { total: 0, byProject: {} };
  for (const item of items) {
    if (item.stateCategory !== 'started' || !item.labels.includes(AGENT_CLAIMED)) continue;
    load.total += 1;
    if (item.project) load.byProject[item.project.id] = (load.byProject[item.project.id] ?? 0) + 1;
  }
  return load;
}

/**
 * Find the project `--for-project` names: by id first, else by name ignoring case.
 *
 * @param snapshot - The pulled snapshot.
 * @param wanted - The flag's value.
 * @returns The project id to keep.
 * @throws {PreconditionError} When no open item's project matches, or the name
 *   matches more than one project.
 */
export function resolveProjectFilter(snapshot: BacklogSnapshot, wanted: string): string {
  const known = new Map<string, WorkItemProject>();
  for (const project of snapshot.projects) known.set(project.id, project);
  for (const item of snapshot.items) if (item.project) known.set(item.project.id, item.project);

  if (known.has(wanted)) return wanted;
  const byName = [...known.values()].filter(
    (project) => project.name.toLowerCase() === wanted.toLowerCase()
  );
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new PreconditionError(
      `more than one project is named "${wanted}"; pass one id: ${byName.map((p) => p.id).join(', ')}`
    );
  }
  throw new PreconditionError(`no open item belongs to a project with the id or name "${wanted}"`);
}

/**
 * Parse `-n`: a whole number of at least 1.
 *
 * @param value - The flag's value, if given.
 * @returns The count, 1 by default.
 * @throws {UsageError} On anything but a positive whole number.
 */
function parseCount(value: string | true | undefined): number {
  if (value === undefined) return 1;
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError('-n (--count) needs a whole number of at least 1');
  }
  return count;
}

/** The fields of an outcome the human text needs. */
interface NextSummary {
  picked: WorkItem[];
  eligibleCount: number;
  starved: boolean;
  shapeableCount: number;
  wip: WipLoad;
  wipCap: { global: number; perProject: number };
}

/**
 * Render the human text: the picks as `KEY - Title` with priority and size, or
 * why nothing is eligible.
 *
 * @param summary - The outcome, the WIP load and the cap.
 * @returns The text.
 */
export function renderNext(summary: NextSummary): string {
  const wipLine = `In progress: ${summary.wip.total} (cap ${summary.wipCap.global} in total, ${summary.wipCap.perProject} per project).`;
  if (summary.picked.length === 0) {
    const why = summary.starved
      ? `Nothing is eligible, but ${summary.shapeableCount} item(s) wait behind the agent/ready gate: a triage pass would ready them.`
      : 'Nothing is eligible, and nothing waits behind the agent/ready gate: the queue is drained.';
    return [why, wipLine].join('\n');
  }
  const rows = summary.picked.map((item) => [
    `  ${item.identifier} - ${item.title}`,
    item.priority === undefined || item.priority === 0
      ? 'no priority'
      : `priority ${item.priority}`,
    item.size === undefined ? 'no size' : `size ${item.size}`,
  ]);
  return [
    `Next (${summary.picked.length} of ${summary.eligibleCount} eligible):`,
    formatColumns(rows),
    wipLine,
  ].join('\n');
}

/**
 * Run `flow next`.
 *
 * @param ctx - The verb's context.
 * @returns The picks and the starvation signals.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const count = parseCount(ctx.args.flags.count);
  const project = loadProjectConfig(ctx);
  const { config, paused } = project.loaded;
  if (paused !== null && !ctx.manual) {
    project.flushWarnings();
    throw new PausedError(
      `flow is paused${paused.pausedAt ? ` (since ${paused.pausedAt})` : ''}; /flow:resume lifts it, or pass --manual when a person is driving`
    );
  }

  const snapshot = await readBacklog(ctx, project.adapter);
  const identity: Identity = {
    agent: await resolveAgentId(project),
    reviewer: config.identity.reviewer,
    marker: config.identity.marker,
  };
  project.flushWarnings();

  const scope: OwnershipScope = config.ownership.scope.includes('issues') ? 'issues' : 'projects';
  const wip = wipLoad(snapshot.items);
  const forProject = ctx.args.flags['for-project'];
  const projectId =
    typeof forProject === 'string' ? resolveProjectFilter(snapshot, forProject) : undefined;
  const candidates =
    projectId === undefined
      ? snapshot.items
      : snapshot.items.filter((item) => item.project?.id === projectId);

  const outcome = classifyDispatchOutcome(
    candidates,
    { dispatch: config.dispatch, ownership: config.ownership, wipCap: config.autonomy.wipCap },
    {
      ownershipOf: Object.fromEntries(
        candidates.map((item) => [item.identifier, classifyOwnership(item, identity, scope)])
      ),
      inProgressByProject: wip.byProject,
      inProgressTotal: wip.total,
    }
  );

  const picked = outcome.picked.slice(0, count);
  return {
    json: {
      picked,
      eligibleCount: outcome.eligibleCount,
      starved: outcome.starved,
      shapeableCount: outcome.shapeableCount,
      wip,
    },
    text: renderNext({ ...outcome, picked, wip, wipCap: config.autonomy.wipCap }),
  };
}
