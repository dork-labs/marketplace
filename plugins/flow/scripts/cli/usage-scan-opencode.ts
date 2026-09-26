/**
 * `flow usage scan --runtime opencode` (spec `flow-usage` Amendment 1 A3): the
 * `scan` entry for OpenCode, loaded through `usage-runtime.ts`.
 *
 * @module @dorkos/flow/cli/usage-scan-opencode
 */

import type { VerbContext, VerbResult } from './context.ts';
import { scanOpenCode } from './usage-opencode.ts';

/**
 * Run `flow usage scan --runtime opencode`.
 *
 * @param ctx - The verb context.
 * @returns Spend this month and each provider's error signal.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  return scanOpenCode(ctx);
}
