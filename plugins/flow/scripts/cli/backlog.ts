/**
 * What the read verbs (`snapshot`, `audit`, `next`) share (spec `flow-cli-core`
 * §6): the project's own config, one backlog pull from the tracker or a saved
 * `--snapshot` file, and the agent's resolved account id.
 *
 * The adapter factory loads config too, to build the adapter; a verb that needs
 * the policy itself (`identity`, `dispatch`, `ownership`, `autonomy`) loads it
 * here. Config warnings are printed once: by the factory when the verb builds
 * the adapter, else by {@link ProjectConfig.flushWarnings}.
 *
 * Needs `zod` (through `config-load.ts`), so only verb modules import it.
 *
 * @module @dorkos/flow/cli/backlog
 */

import { readFileSync } from 'node:fs';

import { isPlainObject } from '../_shared.ts';
import { findConfigRoots } from '../config-files.ts';
import { loadConfig, type LoadedConfig } from '../config-load.ts';
import { UsageError } from '../errors.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { BacklogSnapshot, CodeAdapter } from '../tracker/types.ts';
import type { VerbContext } from './context.ts';

/** The project's loaded config, plus an adapter handle that remembers whether it was used. */
export interface ProjectConfig {
  /** The merged, validated config, secrets, pause and warnings. */
  loaded: LoadedConfig;
  /** The tracker adapter (the context's, built on first call). */
  adapter(): Promise<CodeAdapter>;
  /** Print the config warnings, unless building the adapter already printed them. */
  flushWarnings(): void;
}

/**
 * Load the project's config for a verb that reads its policy.
 *
 * @param ctx - The verb's context.
 * @returns The config and a tracked adapter handle.
 * @throws {ConfigError} When flow is not configured here or its config is invalid.
 */
export function loadProjectConfig(ctx: VerbContext): ProjectConfig {
  const loaded = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env);
  let adapterUsed = false;
  return {
    loaded,
    adapter: () => {
      adapterUsed = true;
      return ctx.adapter();
    },
    flushWarnings: () => {
      if (adapterUsed) return;
      for (const warning of loaded.warnings) ctx.warn(warning);
    },
  };
}

/**
 * Read a saved `flow snapshot --json` file.
 *
 * @param file - The absolute path.
 * @returns The snapshot, with `closed` and `projects` defaulted to empty.
 * @throws {UsageError} When the file cannot be read or is not a flow snapshot.
 */
export function readSnapshotFile(file: string): BacklogSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`could not read --snapshot ${file}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.items)) {
    throw new UsageError(
      `--snapshot ${file} is not the output of "flow snapshot --json" (it needs "v": 1 and an "items" list)`
    );
  }
  const snapshot = parsed as unknown as BacklogSnapshot;
  return {
    ...snapshot,
    closed: Array.isArray(snapshot.closed) ? snapshot.closed : [],
    projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
  };
}

/**
 * One backlog pull: the `--snapshot` file when given (the tracker is never
 * touched), else the adapter's `getBacklogSnapshot`.
 *
 * @param ctx - The verb's context (for `snapshotPath`).
 * @param adapter - Builds the adapter; called only when there is no `--snapshot`.
 * @param opts - `includeClosed` asks the tracker for closed titles too.
 * @returns The snapshot.
 */
export async function readBacklog(
  ctx: VerbContext,
  adapter: () => Promise<CodeAdapter>,
  opts: { includeClosed?: boolean } = {}
): Promise<BacklogSnapshot> {
  if (ctx.snapshotPath !== undefined) return readSnapshotFile(ctx.snapshotPath);
  const tracker = await adapter();
  requireCapabilities(tracker, ['getBacklogSnapshot']);
  return tracker.getBacklogSnapshot(opts);
}

/**
 * The agent's account id: `identity.agent`, or the tracker's current user when
 * it is `auto` (the only case that reaches the tracker).
 *
 * @param project - The loaded project config and adapter handle.
 * @returns The concrete account id, never `auto`.
 */
export async function resolveAgentId(project: ProjectConfig): Promise<string> {
  const configured = project.loaded.config.identity.agent;
  if (configured !== 'auto') return configured;
  const tracker = await project.adapter();
  requireCapabilities(tracker, ['getCurrentUser']);
  return (await tracker.getCurrentUser()).id;
}
