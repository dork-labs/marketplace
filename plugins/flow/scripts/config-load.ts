/**
 * The config the flow CLI runs on, loaded and validated by the CLI itself (spec
 * `flow-cli-core` §3).
 *
 * Which files are read is decided only by `config-files.ts`
 * ({@link resolveConfigFiles}); this module merges and validates them. Precedence
 * follows `config/CONFIG.md`:
 *
 * ```
 * environment variable  >  config.local.json  >  config.json  >  schema defaults
 * ```
 *
 * Objects deep-merge; arrays and scalars replace. The `secrets` block is split
 * off each file before {@link FlowConfigSchema} parses the rest, because that
 * schema is `.strict()` and has no `secrets` key; secrets are returned beside the
 * config and never inside it. The only environment variables read are
 * `FLOW_TRACKER_ACCOUNT` and `FLOW_TRACKER_TOKEN`.
 *
 * An unknown top-level key is dropped with a warning rather than failing the
 * parse, matching `validate-config.ts` and CONFIG.md ("flow's config check
 * reports them as warnings; it ignores them rather than rejecting the file"): a
 * `//` note or a setting a later flow removed must not stop the CLI. Every other
 * schema failure is a {@link ConfigError} naming each path.
 *
 * Unlike `config-files.ts` this module needs `zod` (through the schema), so it
 * runs only after `npm install`.
 *
 * @module @dorkos/flow/cli/config-load
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isPlainObject } from './_shared.ts';
import {
  pauseState,
  refusalFor,
  resolveConfigFiles,
  type ConfigFiles,
  type ConfigRoots,
  type PauseState,
} from './config-files.ts';
import {
  applyAutonomy,
  autonomyCopyPath,
  readAutonomyCopy,
  type AutonomyRead,
} from './autonomy.ts';
import { FlowConfigSchema, type FlowConfig } from './config-schema.ts';
import { canonicalProjectRoot } from './main-checkout.ts';
import { ConfigError } from './errors.ts';

/** The tracker credentials, kept out of the policy config. */
export interface FlowSecrets {
  /** The account or connection handle the adapter acts as. */
  trackerAccount?: string;
  /** The tracker API token, when the host does not handle auth. */
  trackerToken?: string;
}

/** Everything {@link loadConfig} resolves. */
export interface LoadedConfig {
  /** The validated, fully defaulted policy config. */
  config: FlowConfig;
  /** The tracker credentials: env over `config.local.json` over `config.json`. */
  secrets: FlowSecrets;
  /** The settings files read, as `config-files.ts` resolved them. */
  files: ConfigFiles;
  /** This machine's pause, or `null` when flow is not paused. */
  paused: PauseState | null;
  /**
   * What reading the project's autonomy dial found, or `null` when the caller
   * gave no DorkOS home (then the dial was not applied).
   */
  autonomy: AutonomyRead | null;
  /** Plain sentences about settings that load but deserve attention. */
  warnings: string[];
}

/** What {@link loadConfig} needs beyond the files and the environment. */
export interface LoadOptions {
  /** The clock a timed pause's end is judged by. Default: the wall clock. */
  now?: () => Date;
  /**
   * The DorkOS home, where the copy of the project's autonomy dial lives
   * (`autonomy.ts`). Given, the dial is read and applied to `recovery` and
   * `involvement.calibration.stageBias`; left out, neither is touched.
   */
  dorkHome?: string;
}

/** The environment variables the loader reads, and the secret each fills. */
const SECRET_ENV: Readonly<Record<keyof FlowSecrets, string>> = {
  trackerAccount: 'FLOW_TRACKER_ACCOUNT',
  trackerToken: 'FLOW_TRACKER_TOKEN',
};

/**
 * Load, merge and validate flow's config for the CLI.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @param env - The environment to read `FLOW_TRACKER_*` from.
 * @param options - The clock.
 * @returns The config, secrets, files, pause and warnings.
 * @throws {ConfigError} When flow must not act here, is not configured, a file
 *   is not a JSON object, or the merged settings fail the schema.
 */
export function loadConfig(
  roots: ConfigRoots,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadOptions = {}
): LoadedConfig {
  const refusal = refusalFor(roots);
  if (refusal !== null) throw new ConfigError(refusal);

  const files = resolveConfigFiles(roots);
  const warnings: string[] = [];
  if (files.origin === 'none' || files.committed === null) {
    throw new ConfigError(
      `flow is not configured in this project: no ${path.join('.agents', 'flow', 'config.json')} was found; run /flow:init`
    );
  }
  if (files.origin === 'legacy') {
    const folder = path.dirname(files.committed);
    if (files.shared) {
      // Fail closed, as `config-files.ts resolve` does: settings nobody has
      // confirmed are this project's must not drive it.
      throw new ConfigError(
        `the settings in ${folder} may belong to another project, because other projects may share that plugin folder; run /flow in this project to confirm them`
      );
    }
    warnings.push(
      `flow's settings are still inside the plugin at ${folder}, where a plugin update can erase them; run config-files.ts migrate to copy them into ${files.committedDir}`
    );
  }
  for (const moved of files.moved) {
    warnings.push(
      `the settings in ${moved.folder} were moved to ${moved.movedTo} and belong to that project; flow did not use them here`
    );
  }

  const committed = splitSecrets(readSettings(files.committed));
  if (Object.keys(committed.secrets).length > 0) {
    warnings.push(
      `${files.committed} holds "secrets", and that file is committed; move them to config.local.json`
    );
  }
  const local = splitSecrets(files.local === null ? {} : readSettings(files.local));

  const secrets: FlowSecrets = { ...committed.secrets, ...local.secrets };
  for (const [key, name] of Object.entries(SECRET_ENV) as [keyof FlowSecrets, string][]) {
    const value = env[name];
    if (value !== undefined && value !== '') secrets[key] = value;
  }

  const merged = deepMerge(committed.policy, local.policy);
  const parsed = parsePolicy(merged, warnings);
  const autonomy = options.dorkHome === undefined ? null : readDial(roots, options.dorkHome);
  return {
    config: autonomy === null ? parsed : withDial(parsed, autonomy),
    secrets,
    files,
    paused: pauseState(roots, options.now?.() ?? new Date()),
    autonomy,
    warnings,
  };
}

/** Read the copy of the project's dial; a folder outside git has none. */
function readDial(roots: ConfigRoots, dorkHome: string): AutonomyRead {
  let root: string;
  try {
    root = canonicalProjectRoot(roots.checkout);
  } catch {
    return { state: 'missing', file: '' };
  }
  return readAutonomyCopy(autonomyCopyPath(dorkHome, root));
}

/** The config as the dial reads it: `recovery` and `stageBias` per `applyAutonomy`. */
function withDial(config: FlowConfig, read: AutonomyRead): FlowConfig {
  const calibration = config.involvement.calibration;
  const tuned = applyAutonomy(
    { recovery: config.recovery, stageBias: calibration.stageBias },
    read
  );
  if (tuned.recovery === config.recovery && tuned.stageBias === calibration.stageBias) {
    return config;
  }
  return {
    ...config,
    recovery: tuned.recovery,
    involvement: {
      ...config.involvement,
      calibration: { ...calibration, stageBias: tuned.stageBias },
    },
  };
}

/** Read a settings file as a JSON object, or raise a {@link ConfigError} naming it. */
function readSettings(file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} could not be read as JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(value)) throw new ConfigError(`${file} must hold a JSON object`);
  return value;
}

/** Split a file's `secrets` block (string values only) from its policy keys. */
function splitSecrets(settings: Record<string, unknown>): {
  secrets: FlowSecrets;
  policy: Record<string, unknown>;
} {
  const { secrets: block, ...policy } = settings;
  const secrets: FlowSecrets = {};
  if (isPlainObject(block)) {
    for (const key of Object.keys(SECRET_ENV) as (keyof FlowSecrets)[]) {
      const value = block[key];
      if (typeof value === 'string') secrets[key] = value;
    }
  }
  return { secrets, policy };
}

/** Merge `over` onto `under`: plain objects merge key by key; anything else replaces. */
function deepMerge(
  under: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * Parse the merged policy. Unknown top-level keys are dropped with a warning and
 * the rest parsed again; any other failure is a {@link ConfigError}.
 */
function parsePolicy(policy: Record<string, unknown>, warnings: string[]): FlowConfig {
  let result = FlowConfigSchema.safeParse(policy);
  if (!result.success) {
    const unknown = result.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' && issue.path.length === 0 ? issue.keys : []
    );
    if (unknown.length > 0) {
      const known = { ...policy };
      for (const key of unknown) delete known[key];
      warnings.push(
        `flow does not know ${unknown.map((key) => `"${key}"`).join(', ')} and ignored ${unknown.length === 1 ? 'it' : 'them'}`
      );
      result = FlowConfigSchema.safeParse(known);
    }
  }
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (issue) => `  ${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`
  );
  throw new ConfigError(`flow's settings are not valid:\n${lines.join('\n')}`);
}
