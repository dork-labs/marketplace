/**
 * Host resolution (spec `flow-handoff-dispatch` §2.2): which host a drain starts
 * its sessions under.
 *
 * Pure over the probe results the caller already has. A host the person named
 * that is not there is an error with the probe's reason; flow never falls back
 * to another host, because a missing host is reported, not guessed.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/launchers/resolve
 */

import { ConfigError, UsageError } from '../errors.ts';
import { HOST_NAMES, type HostName, type ProbeResult } from './types.ts';

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
 * Pick the host.
 *
 * - A named host whose probe passed is used; one whose probe failed is an error
 *   carrying the probe's reason, with no fallback.
 * - `auto` tries, in order: `cmux` when `CMUX_SURFACE_ID` is set (the supervisor
 *   itself runs inside cmux) and its probe passed; `dorkos` when its probe
 *   passed; `cli` when its probe passed. None: an error listing all three reasons.
 *
 * @param pref - The preference (see {@link hostPreference}).
 * @param env - The supervisor's environment.
 * @param probes - Each host's probe result.
 * @returns The host and why.
 * @throws {ConfigError} When no host can be used (exit 3).
 */
export function resolveHost(
  pref: HostPreference,
  env: Readonly<Record<string, string | undefined>>,
  probes: Readonly<Record<HostName, ProbeResult>>
): HostChoice {
  if (pref !== 'auto') {
    const probe = probes[pref];
    if (!probe.ok) {
      throw new ConfigError(
        `The ${pref} host was asked for but cannot start sessions: ${probe.reason}.`
      );
    }
    return { host: pref, why: `${pref} was asked for` };
  }

  const reasons: string[] = [];
  const inCmux = env.CMUX_SURFACE_ID !== undefined && env.CMUX_SURFACE_ID !== '';
  const cmux = probes.cmux;
  if (!inCmux) reasons.push('cmux: flow is not running inside cmux (CMUX_SURFACE_ID is not set)');
  else if (!cmux.ok) reasons.push(`cmux: ${cmux.reason}`);
  else return { host: 'cmux', why: 'flow is running inside cmux' };

  const dorkos = probes.dorkos;
  if (dorkos.ok) return { host: 'dorkos', why: 'DorkOS is running on this machine' };
  reasons.push(`dorkos: ${dorkos.reason}`);

  const cli = probes.cli;
  if (cli.ok) return { host: 'cli', why: 'neither cmux nor DorkOS is available, so plain claude' };
  reasons.push(`cli: ${cli.reason}`);

  throw new ConfigError(`No host can start sessions. ${reasons.join('; ')}.`);
}
