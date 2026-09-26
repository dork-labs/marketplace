/**
 * The live tier's gate and credential (spec `specs/flow-self-improvement` §1,
 * tier `live`, DOR-2390).
 *
 * The live tier runs a real model, so it spends money. Two rules keep that a
 * decision somebody made, on the model of DorkOS's `packages/evals`:
 *
 * - **A credential alone arms nothing.** Plenty of people leave a key exported,
 *   and having one is not the same as deciding to spend. The run needs
 *   {@link LIVE_FLAG}`=1` as well.
 * - **Never in CI.** When `CI` is set the tier refuses whatever else is set,
 *   so no workflow can spend by accident.
 *
 * Both are checked before anything starts; a refusal names the missing piece
 * and the run exits 2.
 *
 * The credential is resolved in a fixed order, and the report records which
 * one paid: `ANTHROPIC_API_KEY` (billed to that API account), then
 * `CLAUDE_CODE_OAUTH_TOKEN` (billed to the Claude subscription that made it),
 * then the `claude` CLI signed in on this machine (billed to that person's
 * own subscription). No credential is never a pass or a skip: every case fails.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/selftest/live/gate
 */

import { spawnSync } from 'node:child_process';

/** The environment variable that arms the live tier. Only the exact value `1` does. */
export const LIVE_FLAG = 'FLOW_SELFTEST_LIVE';

/** The first credential tried: an Anthropic API key. */
export const API_KEY_VAR = 'ANTHROPIC_API_KEY';

/** The second credential tried: a token from `claude setup-token`. */
export const OAUTH_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Which credential a live run used, and so which bill it reached. */
export type CredentialSource = 'anthropic-api-key' | 'claude-oauth-token' | 'local-claude-login';

/** A resolved credential. */
export interface LiveCredential {
  /** Which of the three sources answered. */
  source: CredentialSource;
  /**
   * The variables the child needs to use it. Empty for the local sign-in,
   * which travels as the inherited `HOME` (and `CLAUDE_CONFIG_DIR`), not as a value.
   */
  env: Record<string, string>;
}

/** Whether a variable is set to something other than blank. */
function isSet(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== '';
}

/**
 * Whether the live tier may run: `undefined` when it may, otherwise the
 * refusal, naming what is missing or what is in the way.
 *
 * @param env - The environment of the run.
 * @returns The refusal message, or `undefined`.
 */
export function liveRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (isSet(env, 'CI')) {
    return `the live tier never runs in CI, and CI is set here; it spends money, so it runs only on a person's machine`;
  }
  if (env[LIVE_FLAG] !== '1') {
    return `the live tier runs a real model and spends money; set ${LIVE_FLAG}=1 to run it (a credential alone is not enough)`;
  }
  return undefined;
}

/**
 * Whether the `claude` CLI on `PATH` is signed in: `claude auth status --json`
 * exits 0 and says `loggedIn: true`. Free: it makes no model call.
 *
 * @param env - The environment to run it with (its `PATH` finds `claude`).
 * @returns `true` when signed in.
 */
export function probeLocalLogin(env: Readonly<Record<string, string | undefined>>): boolean {
  const result = spawnSync('claude', ['auth', 'status', '--json'], {
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return false;
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the credential in the documented order. The sign-in probe runs last,
 * and only when neither variable is set.
 *
 * @param env - The environment of the run.
 * @param probe - Checks the local sign-in (a test seam).
 * @returns The credential, or `undefined` when none answered.
 */
export function resolveCredential(
  env: Readonly<Record<string, string | undefined>>,
  probe: (env: Readonly<Record<string, string | undefined>>) => boolean = probeLocalLogin
): LiveCredential | undefined {
  if (isSet(env, API_KEY_VAR)) {
    return { source: 'anthropic-api-key', env: { [API_KEY_VAR]: env[API_KEY_VAR] as string } };
  }
  if (isSet(env, OAUTH_TOKEN_VAR)) {
    return {
      source: 'claude-oauth-token',
      env: { [OAUTH_TOKEN_VAR]: env[OAUTH_TOKEN_VAR] as string },
    };
  }
  if (probe(env)) return { source: 'local-claude-login', env: {} };
  return undefined;
}

/** What a case reports when no credential answered. Names every fix, in the order they are tried. */
export const NO_CREDENTIAL =
  `no credential: sign in with "claude auth login" (billed to your own Claude subscription), ` +
  `or set ${OAUTH_TOKEN_VAR} (from "claude setup-token") or ${API_KEY_VAR}`;
