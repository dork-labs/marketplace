/**
 * Find a tracker adapter's code and build it for one CLI run (spec
 * `flow-cli-core` §4, adapter contract 1.4.0 "The code realization").
 *
 * - The code is `adapter.ts` in the same folder as the adapter `SKILL.md` that
 *   `config-files.ts` resolves (a project adapter under
 *   `.agents/flow/adapters/<tracker>/`, or a shipped one under
 *   `<flow-root>/skills/<tracker>-adapter/`). Nothing else decides where it is.
 * - It must export `CONTRACT_VERSION` (a version string) and
 *   `createAdapter(ctx)`.
 * - `connection.transport` picks the transport. Only `cli` can serve the CLI;
 *   `mcp` exists only inside an agent session and is refused (Decision D3).
 * - The adapter is wrapped so that anything it throws that is not already a
 *   typed flow error becomes a `TrackerError` (exit 4): a read that cannot reach
 *   the tracker must never read as a bug in flow (exit 70) or as an empty
 *   result.
 *
 * This module needs zod (through `config-load.ts`), so `flow.ts` imports it
 * only when a verb asks for the adapter.
 *
 * @module @dorkos/flow/tracker/load
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AdapterFactory } from '../cli/context.ts';
import { findConfigRoots, resolveAdapter, type ConfigRoots } from '../config-files.ts';
import { loadConfig, type LoadedConfig } from '../config-load.ts';
import { ConfigError, FlowError, TrackerError } from '../errors.ts';
import { createExternalCliTransport } from './external-cli.ts';
import {
  ALL_CAPABILITIES,
  type Capability,
  type CodeAdapter,
  type CodeAdapterModule,
  type TrackerTransport,
} from './types.ts';

/** The file an adapter's code lives in, beside its `SKILL.md`. */
export const ADAPTER_CODE_FILE = 'adapter.ts';

/** What {@link loadCodeAdapter} needs. */
export interface LoadCodeAdapterOptions {
  /** The folders config and the adapter are looked up from. */
  roots: ConfigRoots;
  /** The loaded, validated config and secrets. */
  loaded: LoadedConfig;
  /** Print a warning to stderr. */
  warn(message: string): void;
  /** The transport to hand the adapter. Default: the real `cli` transport. */
  transport?: TrackerTransport;
}

/** Whether an error is Node failing to find the `zod` package, which must surface as exit 6. */
function isMissingZod(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    code === 'ERR_MODULE_NOT_FOUND' &&
    error instanceof Error &&
    /'zod(\/[^']*)?'/.test(error.message)
  );
}

/**
 * Find, import and build the tracker adapter's code.
 *
 * @param options - Roots, loaded config, warning sink and optional transport.
 * @returns The adapter, wrapped so untyped throws become `TrackerError`s.
 * @throws {ConfigError} When the transport is `mcp`, no adapter or no
 *   `adapter.ts` exists, or the module does not export what the contract asks.
 */
export async function loadCodeAdapter(options: LoadCodeAdapterOptions): Promise<CodeAdapter> {
  const { roots, loaded, warn } = options;
  const { config, secrets } = loaded;

  if (config.connection.transport !== 'cli') {
    throw new ConfigError(
      'the mcp transport exists only inside an agent session; set connection.transport to cli to use the flow CLI'
    );
  }

  const adapterFiles = resolveAdapter(roots, loaded.files);
  const tracker = adapterFiles.tracker ?? config.tracker;
  if (adapterFiles.path === null) {
    throw new ConfigError(
      `flow found no adapter for the ${tracker} tracker; run /flow:init to generate one`
    );
  }
  if (adapterFiles.shared) {
    throw new ConfigError(
      `the ${tracker} adapter in ${path.dirname(adapterFiles.path)} may belong to another project; run /flow in this project to confirm it`
    );
  }

  const file = path.join(path.dirname(adapterFiles.path), ADAPTER_CODE_FILE);
  if (!existsSync(file)) {
    throw new ConfigError(
      `the ${tracker} adapter has no code; the flow CLI cannot reach the tracker. The skill still works through the adapter's prose`
    );
  }

  let module: Partial<CodeAdapterModule>;
  try {
    module = (await import(pathToFileURL(file).href)) as Partial<CodeAdapterModule>;
  } catch (error) {
    if (isMissingZod(error)) throw error;
    throw new ConfigError(
      `the ${tracker} adapter code at ${file} could not be loaded: ${(error as Error).message}`
    );
  }
  if (
    typeof module.CONTRACT_VERSION !== 'string' ||
    !/^\d+\.\d+\.\d+/.test(module.CONTRACT_VERSION)
  ) {
    throw new ConfigError(
      `the ${tracker} adapter code at ${file} must export CONTRACT_VERSION, the adapter contract version it targets (for example "1.4.0")`
    );
  }
  if (typeof module.createAdapter !== 'function') {
    throw new ConfigError(`the ${tracker} adapter code at ${file} must export createAdapter(ctx)`);
  }

  const adapter = module.createAdapter({
    config,
    secrets: { ...secrets },
    transport: options.transport ?? createExternalCliTransport(),
    warn,
  });
  return guardAdapter(checkShape(adapter, tracker, file), tracker);
}

/**
 * Check that what `createAdapter` returned declares its capabilities and
 * implements each one it declares.
 *
 * @param adapter - The value `createAdapter` returned.
 * @param tracker - The tracker, for the message.
 * @param file - The adapter code file, for the message.
 * @returns The adapter, typed.
 * @throws {ConfigError} When the shape is wrong.
 */
function checkShape(adapter: unknown, tracker: string, file: string): CodeAdapter {
  const candidate = adapter as Partial<CodeAdapter> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !Array.isArray(candidate.capabilities)
  ) {
    throw new ConfigError(
      `the ${tracker} adapter code at ${file} must return an adapter with a capabilities list from createAdapter`
    );
  }
  for (const capability of candidate.capabilities as unknown[]) {
    if (!ALL_CAPABILITIES.includes(capability as Capability)) {
      throw new ConfigError(
        `the ${tracker} adapter declares "${String(capability)}", which is not a code-adapter capability; use: ${ALL_CAPABILITIES.join(', ')}`
      );
    }
    if (typeof candidate[capability as Capability] !== 'function') {
      throw new ConfigError(
        `the ${tracker} adapter declares ${capability} but does not implement it`
      );
    }
  }
  return candidate as CodeAdapter;
}

/**
 * Wrap each declared method so an untyped throw becomes a `TrackerError`. A
 * typed flow error (a `PreconditionError` for an item that does not exist, a
 * `ConfigError` for a missing account) keeps its own exit code.
 *
 * @param adapter - The adapter to wrap.
 * @param tracker - The tracker, for the message.
 * @returns A new adapter object with the same capabilities.
 */
function guardAdapter(adapter: CodeAdapter, tracker: string): CodeAdapter {
  const guarded: Record<string, unknown> = { capabilities: [...adapter.capabilities] };
  for (const capability of adapter.capabilities) {
    const method = adapter[capability] as (...args: unknown[]) => Promise<unknown>;
    guarded[capability] = async (...args: unknown[]) => {
      try {
        return await method.apply(adapter, args);
      } catch (error) {
        if (error instanceof FlowError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new TrackerError(
          `the ${tracker} adapter could not complete ${capability}: ${message}`
        );
      }
    };
  }
  return guarded as unknown as CodeAdapter;
}

/**
 * Refuse, before anything runs, when the adapter lacks a method a verb needs.
 *
 * @param adapter - The loaded adapter.
 * @param needed - The capabilities the verb calls.
 * @throws {ConfigError} Naming the first missing capability.
 */
export function requireCapabilities(adapter: CodeAdapter, needed: readonly Capability[]): void {
  for (const capability of needed) {
    if (!adapter.capabilities.includes(capability)) {
      throw new ConfigError(
        `the tracker adapter does not support ${capability}, which this command needs; update the adapter's code to add it`
      );
    }
  }
}

/**
 * The real adapter factory the `flow` script wires: find the project's roots,
 * load and validate its config, then load the adapter's code over the `cli`
 * transport. Config warnings go to stderr.
 *
 * @param request - The project, plugin folder, env, process runner and warning sink.
 * @returns The adapter.
 */
export const createCodeAdapter: AdapterFactory = async (request) => {
  const roots = findConfigRoots(request.projectDir, request.flowRoot);
  const loaded = loadConfig(roots, request.env);
  for (const warning of loaded.warnings) request.warn(warning);
  return loadCodeAdapter({
    roots,
    loaded,
    warn: request.warn,
    transport: createExternalCliTransport(request.runProcess),
  });
};
