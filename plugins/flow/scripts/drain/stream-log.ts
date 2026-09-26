/**
 * Reading a headless session's stream-json log and transcript for usage and
 * limits (spec `flow-handoff-dispatch` §2.3 "Ledger", "Transcript fallback").
 *
 * - {@link ingestStreamLog}: every `rate_limit_event` a cli session wrote since
 *   the handle's `logOffset` becomes an `sdk_event` ledger observation, merged
 *   through S1's locked writer. A headless session has no status line, so this
 *   is its only live usage source.
 * - {@link streamLimit}: whether the log's last turn ended on a rate limit.
 * - {@link transcriptLimit}: the same question asked of the session transcript,
 *   for a Claude Code version whose stream carries no `rate_limit_event`.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/drain/stream-log
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { fromRateLimitEvent, fromTranscriptEntry } from '../fleet/observations.ts';
import { recordUsage, type FleetWarning, type UsageObservation } from '../fleet/usage-ledger.ts';
import type { SessionHandle } from '../launchers/types.ts';

/** How much of a transcript's tail {@link transcriptLimit} reads. */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/** A rate limit a session hit: the window when known, and when it resets. */
export interface LimitHit {
  /** The window key (`five_hour`, `seven_day`, ...), or `null` when unidentified. */
  window: string | null;
  /** When the window resets (UTC ISO), or `null` when unknown. */
  resetsAt: string | null;
}

/** What {@link ingestStreamLog} needs. */
export interface IngestDeps {
  /** The resolved DorkOS home the ledger lives under. */
  dorkHome: string;
  /** The clock; the event carries no time, so this is its `observedAt`. */
  now: () => Date;
  /** The ledger writer. Default: S1's {@link recordUsage}. */
  record?: typeof recordUsage;
}

/** What {@link ingestStreamLog} did. */
export interface IngestResult {
  /** The new `logOffset`: the byte after the last complete line read. */
  offset: number;
  /** The observations the new lines held (recorded only for a registered account). */
  observations: UsageObservation[];
  /** Whether the ledger was written, left as it was, dropped, or not touched (ambient account, nothing new). */
  status: 'written' | 'unchanged' | 'dropped' | 'skipped';
  /** The writer's warnings. */
  warnings: FleetWarning[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `length` bytes of `file` from `start`; an empty buffer when the file is missing. */
function readRange(file: string, start: number, length?: number): Buffer {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.min(Math.max(0, start), size);
    const count = Math.min(length ?? size - from, size - from);
    const buffer = Buffer.alloc(count);
    let read = 0;
    while (read < count) {
      const n = readSync(fd, buffer, read, count - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The size of `file`, or 0 when it is missing. */
function fileSize(file: string): number {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return 0;
  }
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

/** Parse JSON lines, skipping blanks and anything that is not a JSON object. */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isObject(value)) out.push(value);
    } catch {
      // A torn or foreign line; the stream is read again from a line boundary.
    }
  }
  return out;
}

/**
 * Fold the `rate_limit_event`s a cli session wrote since `handle.logOffset` into
 * its account's ledger, per S1's `sdk_event` row (`utilization` × 100, `resetsAt`
 * epoch seconds to ISO, `rateLimitType` as the window key, `status` as given,
 * `observedAt` = `deps.now()`). Only complete lines are read, so a line the
 * session is still writing is read whole on the next call.
 *
 * The ambient account has no registry id and so no ledger: its observations are
 * returned but nothing is written. A codex or opencode handle is `skipped`: its
 * ledger is per runtime (RUNTIMES.md R2) and not written by this function.
 *
 * @param handle - A cli session handle with `logFile` (and `logOffset`, default 0).
 * @param deps - The DorkOS home, the clock and the writer.
 * @returns The new offset, what was read, and what happened to the ledger.
 */
export async function ingestStreamLog(
  handle: SessionHandle,
  deps: IngestDeps
): Promise<IngestResult> {
  const start = handle.logOffset ?? 0;
  // Only a Claude Code stream carries `rate_limit_event`s. A Codex session's
  // readings live in its rollout file, which `flow usage scan --runtime codex`
  // records into the per-runtime ledger; the drain does not duplicate that.
  if (handle.logFile === undefined || handle.runtime !== 'claude-code') {
    return { offset: start, observations: [], status: 'skipped', warnings: [] };
  }
  const chunk = readRange(handle.logFile, start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { offset: start, observations: [], status: 'skipped', warnings: [] };
  }
  const complete = chunk.subarray(0, lastNewline + 1);
  const offset = start + complete.length;
  const observedAt = deps.now();
  const observations: UsageObservation[] = [];
  for (const line of parseJsonLines(complete.toString('utf8'))) {
    if (line.type !== 'rate_limit_event') continue;
    const observation = fromRateLimitEvent(line.rate_limit_info, observedAt);
    if (observation !== null) observations.push(observation);
  }
  if (handle.account === null || observations.length === 0) {
    return { offset, observations, status: 'skipped', warnings: [] };
  }
  const record = deps.record ?? recordUsage;
  const written = await record(
    deps.dorkHome,
    'claude-code',
    handle.account,
    observations,
    observedAt
  );
  return { offset, observations, status: written.status, warnings: written.warnings };
}

/** Epoch seconds to UTC ISO; `null` for anything else. */
function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Whether a stream-json log's last run ended on a rate limit. Only lines after
 * the last `system`/`init` count (a resume starts a new run in the same log).
 * A limit is a `rate_limit_event` with `status: "rejected"`, an `assistant`
 * message whose `error` is `rate_limit`, or a `result` with `is_error` and HTTP
 * status 429. The window and reset come from the latest rejected event; a hit
 * with no such event has an unknown window.
 *
 * @param logFile - The session's stream-json log.
 * @returns The hit, or `null` when the last run did not end on a limit.
 */
export function streamLimit(logFile: string): LimitHit | null {
  const lines = parseJsonLines(readRange(logFile, 0).toString('utf8'));
  let from = 0;
  lines.forEach((line, index) => {
    if (line.type === 'system' && line.subtype === 'init') from = index + 1;
  });
  let rejected: LimitHit | null = null;
  let hit = false;
  for (const line of lines.slice(from)) {
    if (line.type === 'rate_limit_event' && isObject(line.rate_limit_info)) {
      const info = line.rate_limit_info;
      if (info.status === 'rejected') {
        hit = true;
        rejected = {
          window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
          resetsAt: epochIso(info.resetsAt),
        };
      }
    } else if (line.type === 'assistant' && line.error === 'rate_limit') {
      hit = true;
    } else if (line.type === 'result' && line.is_error === true && line.api_error_status === 429) {
      hit = true;
    }
  }
  if (!hit) return null;
  return rejected ?? { window: null, resetsAt: null };
}

/**
 * Whether a session transcript's tail shows the session stopped on a rate limit:
 * the latest structured `"error":"rate_limit"` entry after the last user
 * message, read from the last {@link TRANSCRIPT_TAIL_BYTES} bytes. The window
 * and reset come from S1's `transcript` row (the structured `quotaLimits`, else
 * the message text); a hit naming no window has `window: null`.
 *
 * @param transcriptPath - The session transcript (`<config dir>/projects/*\/<id>.jsonl`).
 * @returns The hit, or `null` when the tail shows none (or the file is missing).
 */
export function transcriptLimit(transcriptPath: string): LimitHit | null {
  const size = fileSize(transcriptPath);
  if (size === 0) return null;
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  let text = readRange(transcriptPath, start, TRANSCRIPT_TAIL_BYTES).toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  let found: LimitHit | null = null;
  for (const entry of parseJsonLines(text)) {
    if (entry.type === 'user') {
      found = null;
      continue;
    }
    const finding = fromTranscriptEntry(entry);
    if (finding === null) continue;
    found =
      finding.kind === 'hit'
        ? { window: finding.observation.key, resetsAt: finding.observation.resetsAt ?? null }
        : { window: null, resetsAt: null };
  }
  return found;
}
