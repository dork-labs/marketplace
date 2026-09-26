/**
 * Which host can run which runtime (RUNTIMES.md R5): one static table, read by
 * every launcher's `supports`, by host resolution, and by reports.
 *
 * An unsupported (host, runtime) pair is reported with its reason, never
 * guessed around: a launcher asked for one throws `unsupported` and starts
 * nothing, and resolution never swaps in another host or runtime.
 *
 * Dependency-free and pure.
 *
 * @module @dorkos/flow/launchers/support
 */

import { HOST_NAMES, LaunchError, RUNTIME_NAMES } from './types.ts';
import type { HostName, RuntimeName, SupportResult } from './types.ts';

/** Why cmux runs Claude Code only. */
export const CMUX_CLAUDE_ONLY_REASON =
  'cmux starts interactive Claude Code sessions only today; use --host cli for codex/opencode';

const OK: SupportResult = { ok: true };

/** The table: every host × every runtime. */
const SUPPORT: Readonly<Record<HostName, Readonly<Record<RuntimeName, SupportResult>>>> = {
  cli: { 'claude-code': OK, codex: OK, opencode: OK },
  cmux: {
    'claude-code': OK,
    codex: { ok: false, reason: CMUX_CLAUDE_ONLY_REASON },
    opencode: { ok: false, reason: CMUX_CLAUDE_ONLY_REASON },
  },
  dorkos: { 'claude-code': OK, codex: OK, opencode: OK },
};

/** One row of {@link supportMatrix}. */
export interface SupportRow {
  /** The host. */
  host: HostName;
  /** The runtime. */
  runtime: RuntimeName;
  /** Whether the host can run it. */
  ok: boolean;
  /** Why not, when it cannot. */
  reason?: string;
}

/**
 * Whether `host` can run `runtime` at all. Says nothing about whether the host
 * is up right now (that is the probe's job).
 *
 * @param host - The host.
 * @param runtime - The runtime.
 * @returns `{ ok: true }`, or `{ ok: false, reason }`.
 */
export function supportFor(host: HostName, runtime: RuntimeName): SupportResult {
  const row = SUPPORT[host]?.[runtime];
  return (
    row ?? { ok: false, reason: `flow does not know the ${host} host or the ${runtime} runtime` }
  );
}

/**
 * Every (host, runtime) pair and whether it is supported, hosts in `auto`
 * order, runtimes in {@link RUNTIME_NAMES} order. For reports and `--help`.
 *
 * @returns One row per pair.
 */
export function supportMatrix(): SupportRow[] {
  const rows: SupportRow[] = [];
  for (const host of HOST_NAMES) {
    for (const runtime of RUNTIME_NAMES) {
      const result = supportFor(host, runtime);
      rows.push(
        result.ok
          ? { host, runtime, ok: true }
          : { host, runtime, ok: false, reason: result.reason }
      );
    }
  }
  return rows;
}

/**
 * Throw `unsupported` when `host` cannot run `runtime`; every launcher's
 * `start` calls this before it touches anything.
 *
 * @param host - The launcher's host.
 * @param runtime - The requested runtime.
 * @throws {LaunchError} `bad-request` for a runtime flow does not know;
 *   `unsupported` with the table's reason for a pair the host cannot run.
 */
export function requireSupported(host: HostName, runtime: unknown): asserts runtime is RuntimeName {
  if (typeof runtime !== 'string' || !(RUNTIME_NAMES as readonly string[]).includes(runtime)) {
    throw new LaunchError(
      'bad-request',
      `runtime must be claude-code, codex or opencode, not ${JSON.stringify(runtime)}.`
    );
  }
  const result = supportFor(host, runtime as RuntimeName);
  if (!result.ok) {
    throw new LaunchError(
      'unsupported',
      `The ${host} host cannot run ${runtime}: ${result.reason}.`
    );
  }
}

/**
 * Whether a session on `host` and `runtime` can be moved to another model for
 * its next turn (spec §5.2a model fallback): cli resumes with `--model`/`-m`,
 * cmux types `/model <m>` or resumes with `--model`, DorkOS writes the
 * session's model setting. Every supported pair can today; a pair the host
 * cannot run cannot. DorkOS may still refuse a particular session at send
 * time, which `send` reports as `unsupported`.
 *
 * @param host - The session's host.
 * @param runtime - The session's runtime.
 * @returns Whether the handoff machine may try the model fallback.
 */
export function canSwitchModel(host: HostName, runtime: RuntimeName): boolean {
  return supportFor(host, runtime).ok;
}
