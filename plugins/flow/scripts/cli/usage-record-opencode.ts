/**
 * `flow usage record --runtime opencode` (spec `flow-usage` Amendment 1 A4): the
 * `record` entry for OpenCode, loaded through `usage-runtime.ts`. The shared
 * recorder frame arms the watchdog and refuses a terminal first.
 *
 * @module @dorkos/flow/cli/usage-record-opencode
 */

import { UsageError } from '../errors.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { recordOpenCode } from './usage-opencode.ts';
import { MAX_STDIN_BYTES, WATCHDOG_MS } from './usage-record.ts';

/**
 * Run `flow usage record --runtime opencode`.
 *
 * @param ctx - The verb context.
 * @returns An empty text result, and the outcome for `--json`.
 * @throws {UsageError} When stdin is a terminal.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  ctx.io.armWatchdog(WATCHDOG_MS);
  if (ctx.io.stdin.isTTY) {
    throw new UsageError('pipe one OpenCode assistant message in; see "flow usage --help"');
  }
  return recordOpenCode(ctx, await ctx.io.stdin.read(MAX_STDIN_BYTES));
}
