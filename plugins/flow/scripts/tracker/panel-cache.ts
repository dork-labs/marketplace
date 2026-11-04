/** Machine-local panel snapshots. Account locks serialize projects; no tracker text in cooldowns. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireLock, releaseLock } from '../atomic-json.ts';
import { TrackerError, type TrackerErrorKind } from '../errors.ts';
import type { BacklogSnapshot } from './types.ts';

export const PANEL_TTL_MS = 5 * 60_000;
export const PANEL_BASELINE_MS = 24 * 60 * 60_000;
export const PANEL_REBUILD_WAIT_MS = 30 * 60_000;
export const RATE_LIMIT_WAIT_MS = 15 * 60_000;
interface Saved {
  snapshot: BacklogSnapshot;
  checkedAt: number;
  baselineAt: number;
  watermark: number;
}
interface Failure {
  kind: TrackerErrorKind;
  retryAt: string;
}
function read<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
function write(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Cache reads for display only. Failures are fixed categories, never upstream messages. */
export async function panelSnapshot(opts: {
  dir: string;
  account: string;
  team: string;
  now: () => number;
  resolveTeam?: () => Promise<string>;
  refresh: (previous: BacklogSnapshot | null, since: string | null) => Promise<BacklogSnapshot>;
}): Promise<BacklogSnapshot> {
  const folder = path.join(opts.dir, hash(opts.account));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = path.join(folder, 'read.lock');
  const held = await acquireLock(lock, { giveUpMs: 0, staleMs: 4 * 60_000 });
  if (held === null)
    throw new TrackerError('Another panel read is in progress; waiting for its cache.');
  try {
    const now = opts.now();
    const cooldownFile = path.join(folder, 'cooldown.json');
    const cooldown = read<Failure>(cooldownFile);
    if (cooldown && Date.parse(cooldown.retryAt) > now) {
      throw new TrackerError('Panel tracker reads are cooling down.', cooldown);
    }
    let reservedUntil = now + PANEL_TTL_MS;
    try {
      const aliasesFile = path.join(folder, 'teams.json');
      const aliases = read<Record<string, string>>(aliasesFile) ?? {};
      const alias = hash(opts.team);
      let team = opts.team;
      if (opts.resolveTeam) {
        team = typeof aliases[alias] === 'string' ? aliases[alias] : await opts.resolveTeam();
        if (aliases[alias] !== team) {
          aliases[alias] = team;
          write(aliasesFile, aliases);
        }
      }
      const file = path.join(folder, `${hash(team)}.json`);
      const raw = read<Saved>(file);
      const saved =
        raw &&
        raw.snapshot?.v === 1 &&
        raw.snapshot.panelOnly === true &&
        Array.isArray(raw.snapshot.items) &&
        Number.isFinite(raw.checkedAt) &&
        Number.isFinite(raw.baselineAt) &&
        Number.isFinite(raw.watermark)
          ? raw
          : null;
      if (saved && now >= saved.checkedAt && now - saved.checkedAt < PANEL_TTL_MS)
        return saved.snapshot;
      const full =
        saved === null || now < saved.baselineAt || now - saved.baselineAt >= PANEL_BASELINE_MS;
      reservedUntil = now + (full ? PANEL_REBUILD_WAIT_MS : PANEL_TTL_MS);
      // Reserve before any remote read: a killed child cannot lose its cooldown.
      write(cooldownFile, { kind: 'unreachable', retryAt: new Date(reservedUntil).toISOString() });
      const snapshot = {
        ...(await opts.refresh(
          full ? null : saved.snapshot,
          full ? null : new Date(saved.watermark - 60_000).toISOString()
        )),
        panelOnly: true as const,
      };
      write(file, {
        snapshot,
        checkedAt: now,
        baselineAt: full ? now : saved.baselineAt,
        watermark: now,
      });
      write(cooldownFile, { kind: 'unreachable', retryAt: new Date(now).toISOString() });
      return snapshot;
    } catch (error) {
      const kind = error instanceof TrackerError ? error.kind : 'unreachable';
      const supplied = error instanceof TrackerError ? Date.parse(error.retryAt ?? '') : NaN;
      const until = Math.max(
        opts.now() + (kind === 'rate-limited' ? RATE_LIMIT_WAIT_MS : PANEL_TTL_MS),
        Number.isFinite(supplied) ? supplied : 0,
        reservedUntil
      );
      const failure = { kind, retryAt: new Date(until).toISOString() };
      write(cooldownFile, failure);
      throw new TrackerError('Panel tracker read failed; keeping the previous list.', failure);
    }
  } finally {
    releaseLock(lock, held.token);
  }
}
