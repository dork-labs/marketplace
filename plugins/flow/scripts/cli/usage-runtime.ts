/**
 * Which module runs `flow usage record` and `flow usage scan` for each runtime
 * (spec `flow-usage` Amendment 1, A2-A4), and `--runtime` parsing.
 *
 * {@link RUNTIME_HANDLERS} is the one place a runtime's recorder and scanner are
 * wired; every runtime flow knows has an entry, which the type enforces.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/cli/usage-runtime
 */

import { UsageError } from '../errors.ts';
import { RUNTIMES, isRuntimeSlug, type RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { VerbModule } from './context.ts';

/** The sub-verbs that take `--runtime`. */
export type RuntimeSubVerb = 'record' | 'scan';

/** How to load a runtime's `record` and `scan` modules. */
type Handlers = Readonly<Record<RuntimeSubVerb, () => Promise<VerbModule>>>;

/** Each runtime's `record` and `scan` modules. */
export const RUNTIME_HANDLERS: Readonly<Record<RuntimeSlug, Handlers>> = {
  'claude-code': {
    record: () => import('./usage-record.ts'),
    scan: () => import('./usage-scan.ts'),
  },
  codex: {
    record: () => import('./usage-record-codex.ts'),
    scan: () => import('./usage-scan-codex.ts'),
  },
  opencode: {
    record: () => import('./usage-record-opencode.ts'),
    scan: () => import('./usage-scan-opencode.ts'),
  },
};

/**
 * Parse `--runtime`: absent means `claude-code`.
 *
 * @param flag - The raw flag value.
 * @returns The runtime slug.
 * @throws {UsageError} For anything but a runtime flow knows.
 */
export function parseRuntime(flag: unknown): RuntimeSlug {
  if (flag === undefined) return 'claude-code';
  if (!isRuntimeSlug(flag)) {
    throw new UsageError(`--runtime must be one of ${RUNTIMES.join(', ')} (got "${String(flag)}")`);
  }
  return flag;
}

/**
 * The loader for one sub-verb on one runtime.
 *
 * @param sub - `record` or `scan`.
 * @param runtime - The runtime.
 * @returns A function that imports the module.
 */
export function runtimeHandler(
  sub: RuntimeSubVerb,
  runtime: RuntimeSlug
): () => Promise<VerbModule> {
  return RUNTIME_HANDLERS[runtime][sub];
}
