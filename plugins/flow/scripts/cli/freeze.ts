/**
 * `flow freeze [on|off] [--reason <text>]` (DOR-3262): the release freeze.
 * While it is on, flow arms auto-merge on nothing in this project; the release
 * step turns it on before it cuts a release and off after. With no action it
 * says whether a freeze is on. Local to this machine and never committed
 * (`land/freeze.ts`).
 *
 * @module @dorkos/flow/cli/freeze
 */

import { UsageError } from '../errors.ts';
import { clearFreeze, readFreeze, setFreeze } from '../land/freeze.ts';
import { resolveMainCheckout } from '../main-checkout.ts';
import type { VerbContext, VerbResult } from './context.ts';

/**
 * Run `flow freeze`.
 *
 * @param ctx - The verb's context.
 * @returns The freeze after the change.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [action = 'status'] = ctx.args.positionals;
  const main = resolveMainCheckout(ctx.projectDir);
  const reasonFlag = ctx.args.flags.reason;
  if (action === 'on') {
    const reason = typeof reasonFlag === 'string' ? reasonFlag.trim() : '';
    if (reason === '') throw new UsageError('flow freeze on needs --reason <text>');
    if (ctx.dryRun) {
      return {
        json: { ok: true, dryRun: true, frozen: true, reason },
        text: `Would freeze arming: ${reason}.`,
      };
    }
    const marker = setFreeze(main, reason, ctx.now());
    return {
      json: { ok: true, frozen: true, since: marker.since, reason: marker.reason },
      text: `Frozen: flow arms nothing here until "flow freeze off" (${marker.reason}).`,
    };
  }
  if (action === 'off') {
    if (typeof reasonFlag === 'string') throw new UsageError('--reason goes with flow freeze on');
    const was = ctx.dryRun ? readFreeze(main) !== null : clearFreeze(main);
    return {
      json: { ok: true, ...(ctx.dryRun ? { dryRun: true } : {}), frozen: false, wasFrozen: was },
      text: was ? 'Unfrozen: flow may arm again.' : 'No freeze was on.',
    };
  }
  if (action === 'status') {
    const marker = readFreeze(main);
    return {
      json: { ok: true, frozen: marker !== null, ...(marker ?? {}) },
      text:
        marker === null
          ? 'No freeze is on.'
          : `Frozen since ${marker.since}: ${marker.reason}. "flow freeze off" lifts it.`,
    };
  }
  throw new UsageError(`flow freeze takes on, off or nothing, not "${action}"`);
}
