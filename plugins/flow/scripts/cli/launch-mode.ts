/**
 * The permission mode a verb that starts sessions passes to its launcher
 * (`drain`, `handoff`, `report … review-launch`): the configured mode when it
 * needs no grant, the configured mode when a person's grant in DorkOS still
 * holds, else `acceptEdits` and one line on stderr saying why (DOR-3062).
 *
 * @module @dorkos/flow/cli/launch-mode
 */

import type { LoadedConfig } from '../config-load.ts';
import { effectivePermissionMode } from '../drain-bypass.ts';
import { resolveDorkHome } from '../fleet/accounts.ts';
import type { LaunchPermissionMode } from '../launchers/types.ts';
import { canonicalProjectRoot } from '../main-checkout.ts';
import type { VerbContext } from './context.ts';

/** How long the project-root lookup may take. */
const ROOT_TIMEOUT_MS = 10_000;

/**
 * The mode sessions start in for this project.
 *
 * @param ctx - The verb's context.
 * @param files - The settings files flow read.
 * @param configured - The configured mode, or a flag that lowered it.
 * @returns The mode to launch with.
 */
export function launchPermissionMode(
  ctx: VerbContext,
  files: Pick<LoadedConfig['files'], 'committed' | 'local'>,
  configured: string
): LaunchPermissionMode {
  let root: string | null = null;
  try {
    root = canonicalProjectRoot(ctx.projectDir, { timeoutMs: ROOT_TIMEOUT_MS });
  } catch {
    root = null;
  }
  const result = effectivePermissionMode({
    configured,
    root,
    dorkHome: resolveDorkHome({ ...ctx.env }, ctx.io.osHome),
    loadedFrom: { committed: files.committed, local: files.local },
    now: ctx.now(),
  });
  if (result.notice !== undefined) ctx.warn(result.notice);
  return result.mode as LaunchPermissionMode;
}
