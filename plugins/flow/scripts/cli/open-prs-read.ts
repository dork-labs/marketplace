/**
 * Read a checkout's open pull requests (DOR-3341), for `flow next`, `flow prs`,
 * `flow pr` and the drain: find the forge from `origin`, then list its open PRs
 * with the one fixed call in `forge/open-prs.ts`.
 *
 * Three answers, kept apart on purpose:
 *
 * - `none` — the checkout has no forge flow knows (no `origin`, or not on
 *   GitHub). There is nothing to count, and nothing refuses.
 * - `read` — the list, oldest first.
 * - `unreadable` — there is a forge, but the list could not be read. Callers
 *   fail closed: the cap counts as reached.
 *
 * @module @dorkos/flow/cli/open-prs-read
 */

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { ConfigError } from '../errors.ts';
import { capRefusal, prCap, type OpenPr, type PrCap } from '../forge/open-prs.ts';
import { requireCapabilities } from '../tracker/load.ts';
import { forgeTargetFor, type Forge } from '../forge/types.ts';
import type { VerbContext } from './context.ts';

/** What {@link prCapGate} decided. */
export type PrCapGate = { ok: true; cap: PrCap | null } | { ok: false; cap: PrCap; detail: string };

/**
 * Whether a new PR may open for `identifier`: under `pr.maxOpen`, or the item
 * is urgent (P0). The item's priority is read from the tracker only at the cap;
 * a priority that cannot be read is not urgent. A count that cannot be read is
 * the cap (fails closed). A checkout with no forge has no cap.
 *
 * @param ctx - The verb's context.
 * @param opts - The checkout, the item, and the forge when the caller has it.
 * @returns `ok`, or the refusal naming the PRs that hold the slots.
 */
export async function prCapGate(
  ctx: VerbContext,
  opts: { dir: string; identifier: string; forge?: Forge }
): Promise<PrCapGate> {
  const { config } = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env);
  let read: OpenPrRead;
  if (opts.forge === undefined) {
    read = await readOpenPrs(ctx, opts.dir);
  } else if (opts.forge.openPrs === undefined) {
    read = {
      kind: 'unreadable',
      forge: opts.forge,
      error: `the forge for ${opts.forge.repo} cannot list open PRs`,
    };
  } else {
    try {
      read = { kind: 'read', forge: opts.forge, prs: await opts.forge.openPrs() };
    } catch (error) {
      read = { kind: 'unreadable', forge: opts.forge, error: (error as Error).message };
    }
  }
  if (read.kind === 'none') return { ok: true, cap: null };
  const cap = prCap(read.kind === 'read' ? read.prs : read.error, config.pr.maxOpen);
  if (!cap.atCap) return { ok: true, cap };
  let priority: number | undefined;
  try {
    const tracker = await ctx.adapter();
    requireCapabilities(tracker, ['getItem']);
    priority = (await tracker.getItem(opts.identifier)).priority;
  } catch {
    priority = undefined;
  }
  const detail = capRefusal(cap, priority);
  return detail === null ? { ok: true, cap } : { ok: false, cap, detail };
}

/** What {@link readOpenPrs} found. */
export type OpenPrRead =
  | { kind: 'none'; why: string }
  | { kind: 'read'; forge: Forge; prs: OpenPr[] }
  | { kind: 'unreadable'; forge: Forge | null; error: string };

/**
 * Find the checkout's forge and list its open PRs.
 *
 * @param ctx - The verb's context.
 * @param dir - The checkout.
 * @returns The answer; never throws for a forge that cannot be read.
 */
export async function readOpenPrs(ctx: VerbContext, dir: string): Promise<OpenPrRead> {
  let origin;
  try {
    origin = await ctx.runProcess('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  } catch (error) {
    return {
      kind: 'unreadable',
      forge: null,
      error: `could not run git (${(error as Error).message})`,
    };
  }
  if (origin.code !== 0 || origin.stdout.trim() === '') {
    return { kind: 'none', why: 'the checkout has no origin remote' };
  }
  let forge: Forge;
  try {
    forge = ctx.forge(forgeTargetFor(origin.stdout.trim(), ctx.env));
  } catch (error) {
    if (error instanceof ConfigError) return { kind: 'none', why: error.message };
    throw error;
  }
  if (forge.openPrs === undefined) {
    return { kind: 'unreadable', forge, error: `the forge for ${forge.repo} cannot list open PRs` };
  }
  try {
    return { kind: 'read', forge, prs: await forge.openPrs() };
  } catch (error) {
    return { kind: 'unreadable', forge, error: (error as Error).message };
  }
}
