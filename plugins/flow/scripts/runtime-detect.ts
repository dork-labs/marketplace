/**
 * Which agent runtime and which harness this flow process runs under: the one
 * place flow decides it, so the journal, the usage ledger, dispatch and the
 * launchers all agree (fleet decision R4, "runs are runtime-aware").
 *
 * flow runs from Claude Code, Codex and OpenCode. Each sets an environment
 * variable in the shell its agent runs commands in, checked against the
 * shipped binaries on 2026-09-26:
 *
 * | Runtime       | Marker it sets                                                  |
 * | ------------- | --------------------------------------------------------------- |
 * | `claude-code` | `CLAUDECODE=1` (and `CLAUDE_CODE_ENTRYPOINT`)                   |
 * | `codex`       | `CODEX_THREAD_ID`, `CODEX_SANDBOX` or `CODEX_SANDBOX_NETWORK_DISABLED` |
 * | `opencode`    | `OPENCODE=1` (with `OPENCODE_PID`)                              |
 *
 * `FLOW_RUNTIME` and `FLOW_HARNESS` override everything: a launcher that
 * knows what it started (DorkOS, a scheduler) says so, and flow never guesses
 * over it.
 *
 * A child inherits its parent's environment, so a Codex or OpenCode session
 * started from inside Claude Code carries both runtimes' markers. The most
 * specific one wins: Codex, then OpenCode, then Claude Code. A runtime is far
 * more often launched FROM Claude Code (flow's launchers, DorkOS) than the
 * other way round, and the markers that remain are listed in `markers` so a
 * reader can see the ambiguity.
 *
 * Dependency-free (no imports at all), so any script, before `npm install`,
 * can call it.
 *
 * @module @dorkos/flow/runtime-detect
 */

/** The agent runtimes flow knows. */
export const RUNTIMES = ['claude-code', 'codex', 'opencode'] as const;

/** An agent runtime, or `unknown` when nothing identifies one. */
export type Runtime = (typeof RUNTIMES)[number] | 'unknown';

/** Where the answer came from. */
export type RuntimeSource =
  /** `FLOW_RUNTIME` named it. */
  | 'override'
  /** A runtime's own environment marker. */
  | 'env'
  /** Nothing identified a runtime. */
  | 'none';

/** What {@link detectRuntime} returns. */
export interface DetectedRuntime {
  /** The agent runtime. */
  runtime: Runtime;
  /**
   * What hosts the session: `FLOW_HARNESS` when set, else `cmux` inside a cmux
   * panel, else the runtime's own CLI (the runtime slug), else `shell`.
   */
  harness: string;
  /** How {@link DetectedRuntime.runtime} was decided. */
  source: RuntimeSource;
  /** Every runtime whose marker was present, most specific first. */
  markers: Array<(typeof RUNTIMES)[number]>;
  /** Set when `FLOW_RUNTIME` held a value that is not a runtime; it was ignored. */
  invalidOverride?: string;
}

/** A harness name: short, and safe to print and to store. */
const HARNESS_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Whether an environment variable is set to something. */
function has(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== '';
}

/**
 * The runtimes whose markers are present, most specific first.
 *
 * @param env - The environment to read.
 * @returns The runtimes, in precedence order.
 */
function markersIn(env: Readonly<Record<string, string | undefined>>): DetectedRuntime['markers'] {
  const found: DetectedRuntime['markers'] = [];
  if (
    has(env, 'CODEX_THREAD_ID') ||
    has(env, 'CODEX_SANDBOX') ||
    has(env, 'CODEX_SANDBOX_NETWORK_DISABLED')
  ) {
    found.push('codex');
  }
  if (env.OPENCODE === '1') found.push('opencode');
  if (env.CLAUDECODE === '1' || has(env, 'CLAUDE_CODE_ENTRYPOINT')) found.push('claude-code');
  return found;
}

/**
 * Detect the agent runtime and harness from the environment.
 *
 * @param env - The environment to read (default: this process's).
 * @returns The runtime, the harness, how the runtime was decided, and every
 *   marker that was present.
 */
export function detectRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env
): DetectedRuntime {
  const markers = markersIn(env);
  const override = env.FLOW_RUNTIME?.trim();
  let runtime: Runtime;
  let source: RuntimeSource;
  let invalidOverride: string | undefined;

  if (
    override !== undefined &&
    override !== '' &&
    (RUNTIMES as readonly string[]).includes(override)
  ) {
    runtime = override as Runtime;
    source = 'override';
  } else {
    if (override !== undefined && override !== '') invalidOverride = override.slice(0, 40);
    runtime = markers[0] ?? 'unknown';
    source = markers.length > 0 ? 'env' : 'none';
  }

  const harnessOverride = env.FLOW_HARNESS?.trim().toLowerCase();
  let harness: string;
  if (harnessOverride !== undefined && HARNESS_NAME.test(harnessOverride))
    harness = harnessOverride;
  else if (has(env, 'CMUX_PANEL_ID')) harness = 'cmux';
  else harness = runtime === 'unknown' ? 'shell' : runtime;

  const result: DetectedRuntime = { runtime, harness, source, markers };
  if (invalidOverride !== undefined) result.invalidOverride = invalidOverride;
  return result;
}
