/**
 * The permission mode a verb that starts sessions passes to its launcher
 * (`drain`, `handoff`, `report … review-launch`): the configured mode when it
 * needs no grant, the configured mode when a person's grant in DorkOS still
 * holds, else `acceptEdits` and one line on stderr saying why (DOR-3062).
 *
 * @module @dorkos/flow/cli/launch-mode
 */

import { findConfigRoots, resolveAdapter } from '../config-files.ts';
import type { LoadedConfig } from '../config-load.ts';
import { effectivePermissionMode } from '../drain-bypass.ts';
import { resolveDorkHome } from '../fleet/accounts.ts';
import { assertLaunchable } from '../launch-guard.ts';
import type { LaunchPermissionMode } from '../launchers/types.ts';
import { canonicalProjectRoot } from '../main-checkout.ts';
import type { VerbContext } from './context.ts';

/** How long the project-root lookup may take. */
const ROOT_TIMEOUT_MS = 10_000;

/**
 * Refuse to start unattended sessions unless `config.json` and the project's
 * own tracker adapter are committed and unchanged (DOR-3062).
 *
 * @param ctx - The verb's context.
 * @param files - The settings files flow read.
 * @throws {PreconditionError} Naming the file and the fix.
 */
export function guardLaunch(ctx: VerbContext, files: LoadedConfig['files']): void {
  const adapter = resolveAdapter(findConfigRoots(ctx.projectDir, ctx.flowRoot), files);
  assertLaunchable({
    committedConfig: files.committed,
    adapterPath: adapter.path,
    flowRoot: ctx.flowRoot,
  });
}

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
