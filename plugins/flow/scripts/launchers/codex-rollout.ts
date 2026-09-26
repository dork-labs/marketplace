/**
 * Reading a Codex session's rollout (RUNTIMES.md R3, R5): where it lives, and
 * the rate limits it reports.
 *
 * Codex writes one append-only JSONL rollout per thread at
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<thread id>.jsonl`. A rollout
 * for our thread id under the account's `CODEX_HOME` proves the session runs on
 * that home, and so on that home's login (the analog of a Claude Code
 * transcript under `CLAUDE_CONFIG_DIR`).
 *
 * Rate limits ride on `event_msg` lines whose payload is `token_count`, as
 * `payload.rate_limits`:
 * `{ primary|secondary: { used_percent, window_minutes, resets_at }, credits,
 * plan_type, rate_limit_reached_type }` (observed in real rollouts written by
 * codex-cli 0.147). `rate_limit_reached_type` was `null` in every rollout
 * observed; its non-null values are not confirmed, so any non-null value counts
 * as a hit, and the window comes from whichever window is at 100%.
 *
 * This module only reads. Folding these readings into the per-runtime usage
 * ledger is S1 rev 6's (`<dorkHome>/runtimes/codex/usage/<id>.json`); the
 * parser here is the seam that writer will call.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/launchers/codex-rollout
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import type { LimitHit } from '../drain/stream-log.ts';

/** How much of a rollout's tail {@link readCodexRateLimits} reads. */
export const ROLLOUT_TAIL_BYTES = 256 * 1024;

/** One rate-limit window a Codex reading names. */
export interface CodexWindow {
  /** `five_hour`, `seven_day`, or `window:<minutes>` (RUNTIMES.md R2 normalization). */
  key: string;
  /** Percent of the window used, 0-100. */
  usedPercent: number;
  /** When it resets (UTC ISO), or `null` when not reported. */
  resetsAt: string | null;
}

/** The latest rate-limit reading in a rollout or `--json` log. */
export interface CodexRateLimits {
  /** The account's plan (`plus`, `pro`, ...), or `null` when not reported. */
  planType: string | null;
  /** `rate_limit_reached_type` as reported (`null`: not reached). */
  reachedType: string | null;
  /** The primary and secondary windows that were reported. */
  windows: CodexWindow[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The window key for a Codex window length: 300 minutes is `five_hour`, 10080
 * is `seven_day`, anything else `window:<minutes>`.
 *
 * @param minutes - `window_minutes` as reported.
 * @returns The ledger key.
 */
export function codexWindowKey(minutes: number): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10_080) return 'seven_day';
  return `window:${minutes}`;
}

/**
 * The rollout of `threadId` under a Codex home, if there is one: any
 * `rollout-*<threadId>*.jsonl` below `<codexHome>/sessions`.
 *
 * @param codexHome - An absolute `CODEX_HOME`.
 * @param threadId - The thread id (already validated as a file name).
 * @returns The rollout's absolute path, or `null`.
 */
export function findCodexRollout(codexHome: string, threadId: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries.sort().reverse()) {
      const full = path.join(dir, entry);
      if (entry.startsWith('rollout-') && entry.endsWith('.jsonl') && entry.includes(threadId)) {
        try {
          if (statSync(full).isFile()) return full;
        } catch {
          // Gone between the listing and the stat.
        }
        continue;
      }
      if (depth > 0) {
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) continue;
        const found = walk(full, depth - 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  // sessions/YYYY/MM/DD/rollout-*.jsonl, with one level of slack.
  return walk(path.join(codexHome, 'sessions'), 4);
}

/** The last `bytes` of a file as text, starting at a line boundary; `''` when unreadable. */
function tail(file: string, bytes: number): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Epoch seconds to UTC ISO; `null` for anything else. */
function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The `rate_limits` object a line carries: top level, or in its `payload`. */
function rateLimitsOf(line: Record<string, unknown>): Record<string, unknown> | null {
  if (isObject(line.rate_limits)) return line.rate_limits;
  if (isObject(line.payload) && isObject(line.payload.rate_limits)) return line.payload.rate_limits;
  return null;
}

/**
 * Parse one `rate_limits` object.
 *
 * @param limits - The object as Codex wrote it.
 * @returns The reading.
 */
export function parseCodexRateLimits(limits: Record<string, unknown>): CodexRateLimits {
  const windows: CodexWindow[] = [];
  for (const name of ['primary', 'secondary']) {
    const window = limits[name];
    if (!isObject(window)) continue;
    const minutes = window.window_minutes;
    const used = window.used_percent;
    if (typeof minutes !== 'number' || typeof used !== 'number') continue;
    windows.push({
      key: codexWindowKey(minutes),
      usedPercent: used,
      resetsAt: epochIso(window.resets_at),
    });
  }
  return {
    planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
    reachedType:
      typeof limits.rate_limit_reached_type === 'string' ? limits.rate_limit_reached_type : null,
    windows,
  };
}

/**
 * The latest rate-limit reading in a rollout or a `codex exec --json` log, read
 * from its last {@link ROLLOUT_TAIL_BYTES} bytes.
 *
 * @param file - A rollout or log file.
 * @returns The latest reading, or `null` when the tail holds none (or the file is missing).
 */
export function readCodexRateLimits(file: string): CodexRateLimits | null {
  let latest: CodexRateLimits | null = null;
  for (const raw of tail(file, ROLLOUT_TAIL_BYTES).split('\n')) {
    if (!raw.includes('rate_limits')) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(line)) continue;
    const limits = rateLimitsOf(line);
    if (limits !== null) latest = parseCodexRateLimits(limits);
  }
  return latest;
}

/**
 * Whether a reading says the account is out: `rate_limit_reached_type` set, or
 * a window at 100%. The window is the fullest window at 100% (`null` when
 * Codex named a hit but no window is full).
 *
 * @param reading - A reading, or `null`.
 * @returns The hit, or `null` when the reading shows none.
 */
export function codexLimit(reading: CodexRateLimits | null): LimitHit | null {
  if (reading === null) return null;
  const full = reading.windows
    .filter((w) => w.usedPercent >= 100)
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (full !== undefined) return { window: full.key, resetsAt: full.resetsAt };
  if (reading.reachedType !== null) return { window: null, resetsAt: null };
  return null;
}
