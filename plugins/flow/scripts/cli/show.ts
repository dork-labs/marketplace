/**
 * `flow show <identifier>`: one item as the adapter reads it, description and
 * recent comments included. The stage skills read an item's `## On Completion`
 * and type from here (DONE files follow-ups from them); before this verb the
 * CLI could only list items, and an agent had no way to read one (DOR-3063).
 *
 * A comment's text comes through only when its author is a team member
 * (`isTrustedAuthor`, the rule `flow inbox` keeps): a resumed agent reads its
 * answer here, so a guest's words must not reach it this way either (DOR-3677).
 * Every other comment keeps its id, author and time, marked `withheld`.
 *
 * Read-only: it changes nothing in the tracker.
 *
 * @module @dorkos/flow/cli/show
 */

import { requireCapabilities } from '../tracker/load.ts';
import type { ItemComment } from '../tracker/types.ts';
import { isTrustedAuthor } from '../work-item.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** How many of the item's latest comments to include. */
const COMMENTS = 10;

/** What stands in for the text of a comment not from a team member. */
export const WITHHELD_BODY = '(withheld: not from a team member)';

/** A comment as `flow show` prints it: the text only from a team member. */
function shown(comment: ItemComment): ItemComment & { withheld?: true } {
  return isTrustedAuthor({ ...comment, mentions: [] })
    ? comment
    : { ...comment, body: WITHHELD_BODY, withheld: true };
}

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
  const read = await adapter.getItem(identifier, { comments: COMMENTS });
  const item = read.comments === undefined ? read : { ...read, comments: read.comments.map(shown) };
  const text = [
    `${item.identifier}: ${item.title}`,
    `${item.type} · ${item.stateName} (${item.stateCategory})`,
    `Labels: ${item.labels.join(', ') || 'none'}`,
    '',
    item.description || '(no description)',
  ].join('\n');
  return { json: { item } as unknown as Record<string, unknown>, text };
}
