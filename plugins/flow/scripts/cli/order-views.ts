/**
 * `flow order --write-order` and `flow order --check-order` (DOR-5068): the
 * work order kept in two saved tracker views, `order.views.issues` and
 * `order.views.projects`, so a person can open the tracker and see what comes
 * next.
 *
 * - `--write-order` writes the manual positions of the items whose place
 *   changed (`view-order.ts` plans the fewest), prints how many, then reads
 *   both views back and fails (exit 4) when the tracker did not keep the
 *   order. A second run writes nothing. It holds a short lock under
 *   `.dork/flow/`, so the hourly run and a drain's rewrite never interleave
 *   (exit 5 when another run holds it). It refuses `--snapshot` (a write never
 *   comes from a saved pull) and exits 7 while flow is paused, unless
 *   `--manual`.
 * - What limits the writes: the adapter's position write sends only the
 *   position field (on Linear, a `sortOrder`-only `issueUpdate` or
 *   `projectUpdate`, the fixed mutations flow allows) and refuses an issue or
 *   project outside the team; one run writes at most `order.maxWrites`
 *   positions, in place order, then stops and exits 1 (the next run writes
 *   the rest); and it pauses {@link WRITE_PAUSE_MS} after every
 *   {@link WRITE_BATCH} writes. The hourly schedule and the drain (after a
 *   claim, under ladder v2) both write through here.
 * - `--check-order` reads both views and exits 1 when either is out of order,
 *   naming the first item in the wrong place and printing
 *   {@link VIEW_DESCRIPTION}. It writes nothing to the tracker, so it runs
 *   while paused.
 *
 * Both save their result to `.dork/flow/order-views.json`
 * (`order-views-status.ts`), which `flow status` and the Flow page show. Both
 * say what to set and exit 3 when a view id is missing.
 *
 * @module @dorkos/flow/cli/order-views
 */

import path from 'node:path';

import { updateJsonFile, withHeldLock } from '../atomic-json.ts';
import {
  ConfigError,
  PausedError,
  PreconditionError,
  TrackerError,
  UsageError,
} from '../errors.ts';
import { resolveMainCheckout } from '../main-checkout.ts';
import {
  ORDER_VIEWS_FILE,
  ORDER_VIEWS_LOCK,
  readOrderViewsStatus,
  sameTrouble,
  type OrderViewsStatus,
} from '../order-views-status.ts';
import { requireCapabilities, requireContract } from '../tracker/load.ts';
import type { CodeAdapter, PositionWrite, ViewEntry, ViewKind } from '../tracker/types.ts';
import { compareView, planPositions, VIEW_DESCRIPTION, type ViewDrift } from '../view-order.ts';
import type { WorkOrder } from '../work-order.ts';
import { readBacklog, type ProjectConfig } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { orderInputOf } from './order.ts';
import { computeWorkOrder } from '../work-order.ts';

/** The first contract that can read and write a view's manual order. */
export const VIEW_CONTRACT = [3, 4] as const;

/** How long a write waits for another writing run to finish, in ms. */
export const ORDER_LOCK_WAIT_MS = 3_000;

/** Writes sent together, before a pause. */
export const WRITE_BATCH = 10;

/** The pause between two batches of writes, in ms: keeps a long run off the tracker's rate limit. */
export const WRITE_PAUSE_MS = 1_000;

/** The two views, in the order they are read and reported. */
const KINDS: readonly ViewKind[] = ['issues', 'projects'];

/** How each view is named in text. */
const LABEL: Record<ViewKind, string> = { issues: 'Issue view', projects: 'Project view' };

/** One view's result. */
interface ViewResult {
  /** The view's id. */
  viewId: string;
  /** How many ranked items the view shows (its unranked members are listed apart). */
  ranked: number;
  /** Positions written (write mode only). */
  wrote?: number;
  /** The first item out of place, or `null` (check mode only). */
  drift?: ViewDrift | null;
  /** View members the order does not rank: placed in a block after the ranked ones. */
  unranked: string[];
  /** Ranked keys the view does not show: never written. */
  notInView: string[];
}

/**
 * The configured view ids.
 *
 * @param project - The loaded config.
 * @returns Both ids.
 * @throws {ConfigError} Naming each id that is missing.
 */
export function viewIds(project: ProjectConfig): Record<ViewKind, string> {
  const views = project.loaded.config.order.views;
  const missing = KINDS.filter((kind) => views[kind] === undefined).map(
    (kind) => `order.views.${kind}`
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `set ${missing.join(' and ')} in .agents/flow/config.json to the id of a saved tracker view ordered by hand, with no grouping (the tracker adapter's docs say how to make one); flow order writes the work order into it`
    );
  }
  return { issues: views.issues as string, projects: views.projects as string };
}

/** Each view's ranked keys, best first. */
export function rankedKeys(order: WorkOrder): Record<ViewKind, string[]> {
  return {
    issues: order.issues.map((issue) => issue.identifier),
    projects: [...order.projects.now, ...order.projects.next].map((project) => project.id),
  };
}

/** What a write run did. */
export interface WriteOrderResult {
  /** Positions written, both views together. */
  wrote: number;
  /** Positions the views needed, both together. */
  needed: number;
  /** True when the run stopped at `order.maxWrites` with writes left. */
  capped: boolean;
  /** Each view's result. */
  views: Record<ViewKind, ViewResult>;
}

/**
 * Send writes in batches of {@link WRITE_BATCH}, pausing
 * {@link WRITE_PAUSE_MS} between two batches (never before the first or after
 * the last).
 *
 * @param write - Sends one batch (the adapter's `setPositions`).
 * @param writes - The writes, in order.
 * @param sleep - The host's sleep.
 */
export async function writeInBatches(
  write: (batch: readonly PositionWrite[]) => Promise<void>,
  writes: readonly PositionWrite[],
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (let start = 0; start < writes.length; start += WRITE_BATCH) {
    if (start > 0) await sleep(WRITE_PAUSE_MS);
    await write(writes.slice(start, start + WRITE_BATCH));
  }
}

/**
 * Write the order into both views: the work of `--write-order`, also run by
 * the drain after each claim. Reads the backlog and both views, writes only
 * changed positions (at most `order.maxWrites`, issue view first, each in
 * place order), and reads the views back.
 *
 * @param ctx - The verb's context.
 * @param project - The loaded config and adapter handle.
 * @returns Each view's result, the total written and whether the cap stopped it.
 * @throws {TrackerError} When the tracker did not keep the order it was given.
 */
export async function writeOrderViews(
  ctx: VerbContext,
  project: ProjectConfig
): Promise<WriteOrderResult> {
  const ids = viewIds(project);
  const maxWrites = project.loaded.config.order.maxWrites;
  const adapter = await project.adapter();
  requireCapabilities(adapter, ['getBacklogSnapshot', 'getViewOrder', 'setPositions']);
  requireContract(adapter, VIEW_CONTRACT, "write a view's manual order");
  const root = mainCheckoutOf(ctx);
  const locked = await withHeldLock(
    path.join(root, ORDER_VIEWS_LOCK),
    async () => {
      const order = await currentOrder(ctx, project);
      const ranked = rankedKeys(order);
      const views = {} as Record<ViewKind, ViewResult>;
      let wrote = 0;
      let needed: number | null = null;
      let saved = false;
      try {
        // Plan both views first, so a capped run can say how many it needed.
        const plans = {} as Record<ViewKind, PositionWrite[]>;
        for (const kind of KINDS) {
          plans[kind] = planPositions(kind, await readView(adapter, kind, ids[kind]), ranked[kind]);
        }
        needed = KINDS.reduce((sum, kind) => sum + plans[kind].length, 0);
        const capped = needed > maxWrites;
        for (const kind of KINDS) {
          const writes = plans[kind].slice(0, Math.max(0, maxWrites - wrote));
          await writeInBatches(
            async (batch) => {
              await adapter.setPositions!(batch);
              wrote += batch.length;
            },
            writes,
            (ms) => ctx.io.sleep(ms)
          );
          const after = compareView(await readView(adapter, kind, ids[kind]), ranked[kind]);
          // A view the cap cut short is out of order by design; the next run
          // goes on from there.
          const complete = writes.length === plans[kind].length;
          if (complete && after.drift !== null) {
            saved = true;
            await saveStatus(ctx, root, {
              mode: 'write',
              inOrder: false,
              drift: { view: kind, ...after.drift },
              wrote,
              needed: null,
            });
            throw new TrackerError(
              `the tracker did not keep the ${kind} view's order: at place ${after.drift.place} it has ${after.drift.found}, not ${after.drift.expected}`
            );
          }
          views[kind] = {
            viewId: ids[kind],
            ranked: after.target.length - after.unranked.length,
            wrote: writes.length,
            unranked: after.unranked,
            notInView: after.notInView,
          };
        }
        await saveStatus(ctx, root, {
          mode: 'write',
          inOrder: !capped,
          drift: null,
          wrote,
          needed: capped ? needed : null,
        });
        return { wrote, needed, capped, views };
      } catch (error) {
        // Any other failure: the page says the last write failed, never a
        // stale "in order".
        if (!saved) {
          await saveStatus(ctx, root, {
            mode: 'write',
            inOrder: false,
            drift: null,
            wrote,
            needed: null,
          });
        }
        throw error;
      }
    },
    { giveUpMs: ORDER_LOCK_WAIT_MS }
  );
  if (!locked.held) {
    throw new PreconditionError(
      'another flow order --write-order is writing the views right now; this run wrote nothing, and the next one will catch up'
    );
  }
  return locked.value;
}

/** The main checkout, where flow's own files live; the project folder outside git. */
function mainCheckoutOf(ctx: VerbContext): string {
  try {
    return resolveMainCheckout(ctx.projectDir);
  } catch {
    return ctx.projectDir;
  }
}

/**
 * Save a run's result for `flow status` and the Flow page, keeping when the
 * trouble began while the same first drift (or failed write) persists. A
 * failed save only warns.
 */
async function saveStatus(
  ctx: VerbContext,
  root: string,
  result: Omit<OrderViewsStatus, 'v' | 'at' | 'driftSince'>
): Promise<void> {
  const at = ctx.now().toISOString();
  const file = path.join(root, ORDER_VIEWS_FILE);
  try {
    const saved = await updateJsonFile(file, () => {
      const before = readOrderViewsStatus(root);
      const driftSince = result.inOrder
        ? null
        : before !== null && before.driftSince !== null && sameTrouble(before, result)
          ? before.driftSince
          : at;
      const status: OrderViewsStatus = { v: 1, at, ...result, driftSince };
      return status;
    });
    for (const warning of saved.warnings) ctx.warn(warning.message);
  } catch (error) {
    ctx.warn(`could not save the work order views' status: ${(error as Error).message}`);
  }
}

/**
 * After a drain claim: rewrite the views, best-effort. Runs only under
 * `dispatch.ladder: "v2"` with both view ids set; any failure becomes a
 * warning, so a claim never fails on it.
 *
 * @param ctx - The drain's context.
 * @param project - The drain's loaded config and adapter handle.
 */
export async function rewriteOrderAfterClaim(
  ctx: VerbContext,
  project: ProjectConfig
): Promise<void> {
  const { config } = project.loaded;
  if (config.dispatch.ladder !== 'v2') return;
  if (config.order.views.issues === undefined || config.order.views.projects === undefined) return;
  try {
    const result = await writeOrderViews(ctx, project);
    if (result.capped) {
      ctx.warn(
        `the work order views were rewritten in part after the claim: ${result.wrote} of ${result.needed} positions (order.maxWrites); the next flow order --write-order writes the rest`
      );
    }
  } catch (error) {
    ctx.warn(
      `the work order views were not rewritten after the claim: ${(error as Error).message}; the next flow order --write-order puts them back`
    );
  }
}

/** The work order from a fresh pull (or `--snapshot`, for the check). */
async function currentOrder(ctx: VerbContext, project: ProjectConfig): Promise<WorkOrder> {
  const snapshot = await readBacklog(ctx, project.adapter);
  project.flushWarnings();
  return computeWorkOrder(orderInputOf(snapshot, project.loaded.config, ctx.now()));
}

/** One view's entries. */
function readView(adapter: CodeAdapter, kind: ViewKind, id: string): Promise<ViewEntry[]> {
  return adapter.getViewOrder!(kind, id);
}

/** A key with its name, for a person: `ABC-1 (Title)`. */
function named(key: string, entries: readonly ViewEntry[]): string {
  const entry = entries.find((candidate) => candidate.key === key);
  return entry === undefined || entry.name === key ? key : `${key} (${entry.name})`;
}

/** `1 position` / `2 positions`. */
function positions(count: number): string {
  return `${count} position${count === 1 ? '' : 's'}`;
}

/**
 * Run `flow order --write-order` or `--check-order`.
 *
 * @param ctx - The verb's context.
 * @param project - The loaded config and adapter handle.
 * @param mode - Which flag was given.
 * @returns The result.
 */
export async function runViews(
  ctx: VerbContext,
  project: ProjectConfig,
  mode: 'write' | 'check'
): Promise<VerbResult> {
  if (mode === 'write') {
    if (ctx.snapshotPath !== undefined) {
      throw new UsageError(
        '--write-order reads the tracker itself; a saved --snapshot never drives a write'
      );
    }
    const { paused } = project.loaded;
    if (paused !== null && !ctx.manual) {
      project.flushWarnings();
      throw new PausedError(
        'flow is paused; /flow:resume lifts it, or pass --manual when a person is driving'
      );
    }
    const result = await writeOrderViews(ctx, project);
    const { issues, projects } = result.views;
    const split = `${issues.wrote} in the issue view, ${projects.wrote} in the project view.`;
    return {
      // Exit 1 on a capped run: not a failure, but the views are not in
      // order yet. The hourly run reads it as "go on next hour".
      ...(result.capped ? { exitCode: 1 } : {}),
      json: {
        wrote: result.wrote,
        needed: result.needed,
        capped: result.capped,
        views: result.views,
      },
      text: result.capped
        ? `Wrote ${result.wrote} of ${positions(result.needed)}, the most one run writes (order.maxWrites): ${split} Run it again to write the rest; the hourly run does.`
        : `Wrote ${positions(result.wrote)}: ${split}`,
    };
  }

  const ids = viewIds(project);
  const adapter = await project.adapter();
  requireCapabilities(adapter, ['getViewOrder']);
  requireContract(adapter, VIEW_CONTRACT, "read a view's manual order");
  const ranked = rankedKeys(await currentOrder(ctx, project));
  const views = {} as Record<ViewKind, ViewResult>;
  const lines: string[] = [];
  let firstDrift: OrderViewsStatus['drift'] = null;
  let drifted = false;
  for (const kind of KINDS) {
    const entries = await readView(adapter, kind, ids[kind]);
    const comparison = compareView(entries, ranked[kind]);
    const rankedCount = comparison.target.length - comparison.unranked.length;
    views[kind] = {
      viewId: ids[kind],
      ranked: rankedCount,
      drift: comparison.drift,
      unranked: comparison.unranked,
      notInView: comparison.notInView,
    };
    const { drift } = comparison;
    if (drift === null) {
      lines.push(`${LABEL[kind]}: in order (${rankedCount} ranked).`);
    } else {
      drifted = true;
      firstDrift ??= { view: kind, ...drift };
      lines.push(
        `${LABEL[kind]}: out of order at place ${drift.place}: the order has ${named(drift.expected, entries)}, the view has ${named(drift.found, entries)}.`
      );
    }
  }
  if (drifted) lines.push('', VIEW_DESCRIPTION, 'Run flow order --write-order to put it back.');
  await saveStatus(ctx, mainCheckoutOf(ctx), {
    mode: 'check',
    inOrder: !drifted,
    drift: firstDrift,
    wrote: null,
    needed: null,
  });
  return {
    exitCode: drifted ? 1 : 0,
    json: { inOrder: !drifted, views, ...(drifted ? { description: VIEW_DESCRIPTION } : {}) },
    text: lines.join('\n'),
  };
}
