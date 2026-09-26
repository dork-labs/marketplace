/**
 * The real launcher for each host, wired to this machine: the verb's own
 * environment and OS home, the real process runner, spawn, clock and sleep.
 * `flow drain` and `flow status` build launchers through here unless a test
 * injects fakes (`CliDeps.createLauncher`).
 *
 * @module @dorkos/flow/launchers/real
 */

import { createCliLauncher, realCliLauncherDeps } from './cli.ts';
import { createCmuxLauncher, realCmuxLauncherDeps } from './cmux.ts';
import { createDorkosLauncher, realDorkosLauncherDeps } from './dorkos.ts';
import type { HostName, Launcher } from './types.ts';

/**
 * Build the real launcher for `host`.
 *
 * @param host - The host.
 * @param env - The environment the launcher reads (the verb's, not `process.env`).
 * @param osHome - The OS home folder.
 * @returns The launcher.
 */
export function realLauncher(
  host: HostName,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): Launcher {
  if (host === 'cli') return createCliLauncher({ ...realCliLauncherDeps(), env, osHome });
  if (host === 'cmux') return createCmuxLauncher({ ...realCmuxLauncherDeps(), env, osHome });
  return createDorkosLauncher({ ...realDorkosLauncherDeps(), env, osHome });
}
