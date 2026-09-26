/**
 * Host resolution (spec `flow-handoff-dispatch` §2.2): which host a drain starts
 * its sessions under.
 *
 * Pure over the probe results the caller already has, and runtime-aware: a host
 * that cannot run the requested runtime (`support.ts`) is never picked. A host
 * the person named that is not there, or cannot run the runtime, is an error
 * with the reason; flow never falls back to another host or runtime, because a
 * missing host is reported, not guessed.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/launchers/resolve
 */

import { ConfigError, UsageError } from '../errors.ts';
import { supportFor } from './support.ts';
import { HOST_NAMES, type HostName, type ProbeResult, type RuntimeName } from './types.ts';

/** A host preference: one host by name, or `auto`. */
export type HostPreference = HostName | 'auto';

/** The chosen host and a plain sentence saying why, printed once at drain start. */
export interface HostChoice {
  /** The host sessions start under. */
  host: HostName;
  /** Why this host, for the drain's first line of output. */
  why: string;
}

/**
 * The preference in force: `--host`, else `drain.host` in config, else `auto`.
 *
 * @param flag - The `--host` value, if given.
 * @param configured - The `drain.host` config value, if set.
 * @returns The preference.
 * @throws {UsageError} When the flag names no known host.
 * @throws {ConfigError} When the config value names no known host.
 */
export function hostPreference(flag?: string, configured?: string): HostPreference {
  const valid = (value: string): value is HostPreference =>
    value === 'auto' || (HOST_NAMES as readonly string[]).includes(value);
  if (flag !== undefined) {
    if (!valid(flag)) {
      throw new UsageError(`--host must be auto, cli, cmux or dorkos, not "${flag}".`);
    }
    return flag;
  }
  if (configured !== undefined) {
    if (!valid(configured)) {
      throw new ConfigError(`drain.host must be auto, cli, cmux or dorkos, not "${configured}".`);
    }
    return configured;
  }
  return 'auto';
}

/**
 * Pick the host for a session on `runtime`.
 *
 * - A named host that supports the runtime and whose probe passed is used; one
 *   that does not support the runtime, or whose probe failed, is an error
 *   carrying that reason, with no fallback.
 * - `auto` tries, in order, skipping any host that cannot run the runtime:
 *   `cmux` when `CMUX_SURFACE_ID` is set (the supervisor itself runs inside
 *   cmux) and its probe passed; `dorkos` when its probe passed; `cli` when its
 *   probe passed. None: an error listing every host's reason.
 *
 * @param pref - The preference (see {@link hostPreference}).
 * @param env - The supervisor's environment.
 * @param probes - Each host's probe result (the cli probe run for `runtime`).
 * @param runtime - The runtime the session runs on.
 * @returns The host and why.
 * @throws {ConfigError} When no host can be used (exit 3).
 */
export function resolveHost(
  pref: HostPreference,
  env: Readonly<Record<string, string | undefined>>,
  probes: Readonly<Record<HostName, ProbeResult>>,
  runtime: RuntimeName
): HostChoice {
  if (pref !== 'auto') {
    const support = supportFor(pref, runtime);
    if (!support.ok) {
      throw new ConfigError(
        `The ${pref} host was asked for but cannot run ${runtime}: ${support.reason}.`
      );
    }
    const probe = probes[pref];
    if (!probe.ok) {
      throw new ConfigError(
        `The ${pref} host was asked for but cannot start sessions: ${probe.reason}.`
      );
    }
    return { host: pref, why: `${pref} was asked for` };
  }

  const reasons: string[] = [];
  /** Whether `host` can run the runtime; records why not. */
  const runs = (host: HostName): boolean => {
    const support = supportFor(host, runtime);
    if (!support.ok) reasons.push(`${host}: ${support.reason}`);
    return support.ok;
  };

  if (runs('cmux')) {
    const inCmux = env.CMUX_SURFACE_ID !== undefined && env.CMUX_SURFACE_ID !== '';
    const cmux = probes.cmux;
    if (!inCmux) reasons.push('cmux: flow is not running inside cmux (CMUX_SURFACE_ID is not set)');
    else if (!cmux.ok) reasons.push(`cmux: ${cmux.reason}`);
    else return { host: 'cmux', why: 'flow is running inside cmux' };
  }

  if (runs('dorkos')) {
    const dorkos = probes.dorkos;
    if (dorkos.ok) return { host: 'dorkos', why: 'DorkOS is running on this machine' };
    reasons.push(`dorkos: ${dorkos.reason}`);
  }

  if (runs('cli')) {
    const cli = probes.cli;
    const binary = runtime === 'claude-code' ? 'claude' : runtime;
    if (cli.ok)
      return { host: 'cli', why: `neither cmux nor DorkOS is available, so plain ${binary}` };
    reasons.push(`cli: ${cli.reason}`);
  }

  throw new ConfigError(`No host can start ${runtime} sessions. ${reasons.join('; ')}.`);
}
