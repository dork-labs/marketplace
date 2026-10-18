/**
 * `flow show <identifier>`: one item as the adapter reads it, description and
 * recent comments included. The stage skills read an item's `## On Completion`
 * and type from here (DONE files follow-ups from them); before this verb the
 * CLI could only list items, and an agent had no way to read one (DOR-3063).
 *
 * Read-only: it changes nothing in the tracker.
 *
 * @module @dorkos/flow/cli/show
 */

import { requireCapabilities } from '../tracker/load.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** How many of the item's latest comments to include. */
const COMMENTS = 10;

/**
 * Run `flow show`.
 *
 * @param ctx - The verb's context.
 * @returns The item as JSON, or its title, labels and description as text.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const adapter = await ctx.adapter();
  requireCapabilities(adapter, ['getItem']);
  const item = await adapter.getItem(identifier, { comments: COMMENTS });
  const text = [
    `${item.identifier}: ${item.title}`,
    `${item.type} · ${item.stateName} (${item.stateCategory})`,
    `Labels: ${item.labels.join(', ') || 'none'}`,
    '',
    item.description || '(no description)',
  ].join('\n');
  return { json: { item } as unknown as Record<string, unknown>, text };
}
