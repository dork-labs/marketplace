/**
 * The options a verb loads its project config with: the verb's clock (so a
 * timed pause ends by the same clock the verb runs on) and the DorkOS home (so
 * the project's autonomy dial is read and applied, `autonomy.ts`).
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/cli/load-options
 */

import type { LoadOptions } from '../config-load.ts';
import { resolveDorkHome } from '../fleet/accounts.ts';
import type { VerbContext } from './context.ts';

/**
 * The config-load options for a verb run.
 *
 * @param ctx - The verb's context.
 * @returns Its clock and DorkOS home.
 */
export function verbLoadOptions(ctx: VerbContext): LoadOptions {
  return { now: () => ctx.now(), dorkHome: resolveDorkHome({ ...ctx.env }, ctx.io.osHome) };
}
