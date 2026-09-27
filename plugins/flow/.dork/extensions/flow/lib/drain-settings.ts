/**
 * The project's drain settings: the two the advisor ranks with, so a move it
 * accepts is one `flow handoff` would make (`drain.warnMarginPct`,
 * `drain.maxLivePerAccount`), and the Flow panel's slot count (`drain.parallel`),
 * from `<main checkout>/.agents/flow/config.json` with `config.local.json` over
 * it, as flow's config loader merges them.
 *
 * flow's loader validates with zod, which this bundle cannot load, so the
 * numbers are read loosely: a missing or out-of-range value reads as the
 * schema's default.
 *
 * @module @dorkos/flow/extension/drain-settings
 */

import path from 'node:path';
import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';

/** The schema's defaults (`config-schema.ts`, `drain`). */
export const DRAIN_DEFAULTS = { warnMarginPct: 10, maxLivePerAccount: 2, parallel: 0 } as const;

/** The drain settings the extension reads. */
export interface DrainSettings {
  /** Points below a ceiling that count as near a limit (0-50). */
  warnMarginPct: number;
  /** Live sessions one account may carry (1 or more). */
  maxLivePerAccount: number;
  /** Drain workers at once; `0` is flow's sequential default. */
  parallel: number;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `drain` block of one config file, or `{}`. */
function drainOf(file: string): Record<string, unknown> {
  const { value } = readJsonFile(file);
  return isObject(value) && isObject(value.drain) ? value.drain : {};
}

/**
 * Read the project's drain settings.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The settings, defaults filled in.
 */
export function readDrainSettings(mainCheckout: string): DrainSettings {
  const dir = path.join(mainCheckout, PROJECT_CONFIG_DIR);
  const merged = {
    ...drainOf(path.join(dir, CONFIG_FILE)),
    ...drainOf(path.join(dir, LOCAL_CONFIG_FILE)),
  };
  const warn = merged.warnMarginPct;
  const live = merged.maxLivePerAccount;
  const parallel = merged.parallel;
  return {
    warnMarginPct:
      typeof warn === 'number' && warn >= 0 && warn <= 50 ? warn : DRAIN_DEFAULTS.warnMarginPct,
    maxLivePerAccount:
      typeof live === 'number' && Number.isInteger(live) && live >= 1
        ? live
        : DRAIN_DEFAULTS.maxLivePerAccount,
    parallel:
      typeof parallel === 'number' && Number.isInteger(parallel) && parallel >= 0
        ? parallel
        : DRAIN_DEFAULTS.parallel,
  };
}
