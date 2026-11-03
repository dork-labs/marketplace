/**
 * `flow comment <identifier> (--text <text> | --text-file <file>)`: post an
 * agent's comment on an item, signed. An agent's comment must carry the marker
 * and the hidden line: on a shared tracker account they are all that tells it
 * from the person's, so a bare one reads as the person and flow acts on it.
 *
 * A retry of the same words as the item's latest comment posts nothing. A file
 * under `.dork/flow/tmp/` is removed once posted (`scratch-file.ts`).
 *
 * @module @dorkos/flow/cli/comment
 */

import { UsageError } from '../errors.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { flagText, removeScratch } from './scratch-file.ts';
import { runFor, sessionProvenance, setupWrite } from './work-write.ts';

/** How many latest comments to read: only the last is compared, for a retry. */
const RECENT_COMMENTS = 10;

/**
 * Run `flow comment`.
 *
 * @param ctx - The verb's context.
 * @returns Whether the comment was posted.
 * @throws {UsageError} When the text is missing or empty (exit 2).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const given = flagText(ctx, { inline: 'text', file: 'text-file', what: 'comment' });
  const text = given?.text.trim();
  if (text === undefined || text === '') {
    throw new UsageError('give the comment with --text or --text-file');
  }

  const { loaded, adapter, store } = await setupWrite(ctx, ['getItem', 'comment']);
  const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
  const body = signBody(
    text,
    loaded.config.identity.marker,
    sessionProvenance(ctx, runFor(store, item)?.host)
  );
  const last = (item.comments ?? []).at(-1);
  const posted = last === undefined || unsignedBody(last.body) !== unsignedBody(body);
  if (!ctx.dryRun) {
    if (posted) await adapter.comment(item, body);
    removeScratch(ctx, given?.scratch);
  }
  return {
    json: { ok: true, dryRun: ctx.dryRun, identifier, posted },
    text: posted
      ? `${ctx.dryRun ? 'Would post' : 'Posted'} a signed comment on ${identifier}.`
      : `${identifier}'s latest comment already says this, so nothing was posted.`,
  };
}
