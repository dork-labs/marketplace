/**
 * `flow status [<identifier>] [--strict]`: one screen of what the flow loop is
 * doing (spec `flow-cli-core` §6).
 *
 * It joins four sources and only reads:
 *
 * - `flow-state.json`, the run records (`flow-state-file.ts`);
 * - `.dork/flow/auto-run.json`, the `/flow auto` drain sentinel. An active
 *   sentinel is an orphan when its pid is not alive or it started more than
 *   24 hours ago (a pid can be recycled), the same rule the Stop hook reaps by;
 * - the pause (`paused.json`);
 * - the backlog: the tracker, or a saved `flow snapshot --json` with `--snapshot`.
 *
 * Drift is where these disagree: a running run whose item is not started, a
 * claimed item with no run, a running run whose worker is gone, and any
 * `STATE-n` breach (`work-state.ts`) on an in-flight item. `--strict` exits 1
 * on any drift.
 *
 * @module @dorkos/flow/cli/status
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { findConfigRoots, pauseState } from '../config-files.ts';
import { PreconditionError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { ItemComment, WorkItem } from '../tracker/types.ts';
import { AGENT_CLAIMED, stateCoherence } from '../work-state.ts';
import { readSnapshotFile } from './backlog.ts';
import { formatColumns } from './output.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** The parked label. */
const AGENT_NEEDS_INPUT = 'agent/needs-input';

/** How long an active drain sentinel's pid is believed (the Stop hook's rule). */
const SENTINEL_STALE_MS = 24 * 60 * 60 * 1000;

/** The drain sentinel, relative to a checkout. */
const AUTO_RUN_RELATIVE_PATH = path.join('.dork', 'flow', 'auto-run.json');

/** How many recent comments to read for an item's parked question. */
const QUESTION_COMMENTS = 20;

/** The `/flow auto` drain as status reports it. */
export interface DrainStatus {
  /** Whether the sentinel says a drain is active. */
  active: boolean;
  /** Ready items the drain counted. */
  ready: number | null;
  /** Items behind the readiness gate. */
  shapeable: number | null;
  /** When the drain began. */
  startedAt: string | null;
  /** The drain owner's pid. */
  pid: number | null;
  /** The session the drain belongs to. */
  sessionId: string | null;
  /** Why an active sentinel is an orphan, or `null` when it is not one. */
  orphan: string | null;
  /** The sentinel file. */
  file: string;
}

/** One in-flight item: a run record, a claimed item, or both. */
export interface InFlightEntry {
  identifier: string;
  title: string | null;
  stateCategory: string | null;
  stage: string | null;
  status: string | null;
  worktree: string | null;
  branch: string | null;
  account: string | null;
  host: string | null;
  sessionId: string | null;
  workerPid: number | null;
  /** Whether the tracker item carries `agent/claimed`. */
  claimed: boolean;
}

/** One parked item. */
export interface ParkedEntry {
  identifier: string;
  title: string;
  /** The last question the agent posted, when the item was read with comments. */
  question: { body: string; askedAt: string } | null;
}

/** The kinds of drift status reports. */
export type DriftKind = 'run-not-started' | 'claimed-no-run' | 'worker-gone' | 'state-breach';

/** One drift line. */
export interface DriftEntry {
  identifier: string;
  kind: DriftKind;
  /** The `STATE-n` check, for `state-breach`. */
  check?: string;
  /** A plain sentence naming what disagrees. */
  detail: string;
}

/** Whether a process with this pid is alive (EPERM means alive, owned by someone else). */
function pidAlive(pid: unknown): boolean | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the drain sentinel from the first checkout that has one. */
function readDrain(checkouts: readonly string[], now: Date): DrainStatus | null {
  for (const checkout of checkouts) {
    const file = path.join(checkout, AUTO_RUN_RELATIVE_PATH);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let value: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>;
      }
    } catch {
      value = {};
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const active = value.active === true;
    const pid = num(value.pid);
    const startedAt = str(value.startedAt);
    let orphan: string | null = null;
    if (active) {
      const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
      if (pidAlive(pid) === false) {
        orphan = `stale drain sentinel (pid ${pid} gone); the next Stop in that repo reaps it`;
      } else if (Number.isFinite(started) && now.getTime() - started > SENTINEL_STALE_MS) {
        orphan = `stale drain sentinel (started ${startedAt}, over 24 hours ago); the next Stop in that repo reaps it`;
      }
    }
    return {
      active,
      ready: num(value.ready),
      shapeable: num(value.shapeable),
      startedAt,
      pid,
      sessionId: str(value.sessionId),
      orphan,
      file,
    };
  }
  return null;
}

/** The last comment the agent posted (it carries a provenance line), or `null`. */
function lastQuestion(comments: readonly ItemComment[] | undefined): ParkedEntry['question'] {
  const signed = (comments ?? []).filter((comment) =>
    /<!--\s*(agent|flow):provenance/.test(comment.body)
  );
  const last = signed.at(-1);
  if (last === undefined) return null;
  const body = last.body.replace(/\n?<!--\s*(agent|flow):provenance[\s\S]*?-->\s*$/, '').trim();
  return { body, askedAt: last.createdAt };
}

/**
 * Run `flow status`.
 *
 * @param ctx - The invocation and the injected world.
 * @returns The pane; exit 1 with `--strict` when there is drift.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [focus] = ctx.args.positionals;
  const strict = ctx.args.flags.strict === true;
  const now = ctx.now();

  const roots = findConfigRoots(ctx.projectDir, ctx.flowRoot);
  const pause = pauseState(roots);
  const store = openFlowStateFile(ctx.projectDir);
  const mainCheckout = path.dirname(path.dirname(path.dirname(store.path)));
  const drain = readDrain([...new Set([roots.checkout, mainCheckout])], now);

  let runs: FlowRun[] = Object.values(store.read());
  let items: WorkItem[];
  let question: ParkedEntry['question'] = null;
  if (ctx.snapshotPath !== undefined) {
    items = readSnapshotFile(ctx.snapshotPath).items;
    if (focus !== undefined) items = items.filter((item) => item.identifier === focus);
  } else if (focus !== undefined) {
    const adapter = await ctx.adapter();
    requireCapabilities(adapter, ['getItem']);
    const item = await adapter.getItem(focus, { comments: QUESTION_COMMENTS });
    question = lastQuestion(item.comments);
    items = [item];
  } else {
    const adapter = await ctx.adapter();
    requireCapabilities(adapter, ['getBacklogSnapshot']);
    items = (await adapter.getBacklogSnapshot()).items;
  }
  if (focus !== undefined) {
    runs = runs.filter((run) => run.identifier === focus || run.issueId === focus);
    if (items.length === 0 && runs.length === 0) {
      throw new PreconditionError(`${focus} is not in the backlog and has no run record.`);
    }
  }

  const byIdentifier = new Map(items.map((item) => [item.identifier, item]));
  const runFor = (item: WorkItem) =>
    runs.find((run) => run.identifier === item.identifier || run.issueId === item.id);
  const labels = (item: WorkItem | undefined) => (Array.isArray(item?.labels) ? item.labels : []);

  const inFlight: InFlightEntry[] = [];
  const drift: DriftEntry[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    if (run.status === 'complete') continue;
    const item = byIdentifier.get(run.identifier) ?? items.find((i) => i.id === run.issueId);
    seen.add(item?.identifier ?? run.identifier);
    inFlight.push(entry(run.identifier, item, run));
    if (run.status === 'running') {
      if (item?.stateCategory !== 'started') {
        drift.push({
          identifier: run.identifier,
          kind: 'run-not-started',
          detail:
            item === undefined
              ? 'has a running run, but the item is not open in the backlog'
              : `has a running run, but the item is ${item.stateCategory}, not started`,
        });
      }
      if (pidAlive(run.workerPid) === false) {
        drift.push({
          identifier: run.identifier,
          kind: 'worker-gone',
          detail: `has a running run, but its worker (pid ${run.workerPid}) is gone`,
        });
      }
    }
  }
  for (const item of items) {
    if (!labels(item).includes(AGENT_CLAIMED) || seen.has(item.identifier)) continue;
    seen.add(item.identifier);
    inFlight.push(entry(item.identifier, item, undefined));
    if (runFor(item) === undefined) {
      drift.push({
        identifier: item.identifier,
        kind: 'claimed-no-run',
        detail: `carries ${AGENT_CLAIMED}, but this machine has no run for it`,
      });
    }
  }
  for (const flight of inFlight) {
    const item = byIdentifier.get(flight.identifier);
    if (item === undefined) continue;
    for (const violation of stateCoherence(item)) {
      drift.push({
        identifier: flight.identifier,
        kind: 'state-breach',
        check: violation.check,
        detail: `${violation.check}: ${violation.detail}`,
      });
    }
  }

  const parked: ParkedEntry[] = items
    .filter((item) => labels(item).includes(AGENT_NEEDS_INPUT))
    .map((item) => ({
      identifier: item.identifier,
      title: item.title,
      question: focus === item.identifier ? question : null,
    }));

  const paused = pause === null ? null : { since: pause.pausedAt, file: pause.file };
  // `ok` matches the exit code: false only when --strict found drift.
  const failed = strict && drift.length > 0;
  return {
    exitCode: failed ? 1 : 0,
    json: { ok: !failed, paused, drain, inFlight, parked, drift },
    text: render({ paused, drain, inFlight, parked, drift }, now),
  };
}

/** One in-flight entry from a run record and/or a tracker item. */
function entry(
  identifier: string,
  item: WorkItem | undefined,
  run: FlowRun | undefined
): InFlightEntry {
  return {
    identifier,
    title: item?.title ?? null,
    stateCategory: item?.stateCategory ?? null,
    stage: run?.stage ?? null,
    status: run?.status ?? null,
    worktree: run?.worktreePath ?? null,
    branch: run?.branch ?? null,
    account: run?.account ?? null,
    host: run?.host ?? null,
    sessionId: run?.sessionId ?? null,
    workerPid: run?.workerPid ?? null,
    claimed: Array.isArray(item?.labels) && item.labels.includes(AGENT_CLAIMED),
  };
}

/** How long ago an ISO time was, in plain words. */
function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** The human pane. */
function render(
  pane: {
    paused: { since: string | null } | null;
    drain: DrainStatus | null;
    inFlight: InFlightEntry[];
    parked: ParkedEntry[];
    drift: DriftEntry[];
  },
  now: Date
): string {
  const sections: string[] = [];
  if (pane.paused !== null) {
    sections.push(
      `Paused since ${pane.paused.since ?? 'an unknown time'}: scheduled ticks, /flow continue and /flow auto stop at their first step; /flow:resume lifts it.`
    );
  }
  const drain = pane.drain;
  if (drain !== null && drain.active) {
    sections.push(
      drain.orphan !== null
        ? `Drain: ${drain.orphan}.`
        : `Drain: live, ${drain.ready ?? '?'} ready, ${drain.shapeable ?? '?'} behind the readiness gate (pid ${drain.pid ?? '?'}, started ${drain.startedAt ?? '?'}).`
    );
  }
  if (pane.inFlight.length > 0) {
    const rows = pane.inFlight.map((f) => [
      `  ${f.identifier}`,
      f.title ?? '(not in the backlog)',
      f.stage ?? '-',
      f.status ?? (f.claimed ? 'claimed, no run' : '-'),
      f.account ?? '-',
      f.host ?? '-',
      [f.worktree, f.branch].filter(Boolean).join(' @ ') || '-',
    ]);
    sections.push(
      `In flight:\n${formatColumns([['  ITEM', 'TITLE', 'STAGE', 'STATUS', 'ACCOUNT', 'HOST', 'WORKTREE @ BRANCH'], ...rows])}`
    );
  }
  if (pane.parked.length > 0) {
    const lines = pane.parked.map((p) => {
      const head = `  ${p.identifier} - ${p.title}`;
      return p.question === null
        ? head
        : `${head}\n    asked ${ago(p.question.askedAt, now)}: ${p.question.body}`;
    });
    sections.push(`Parked:\n${lines.join('\n')}`);
  }
  if (pane.drift.length > 0) {
    sections.push(`Drift:\n${pane.drift.map((d) => `  ${d.identifier} ${d.detail}`).join('\n')}`);
  }
  if (pane.inFlight.length === 0 && pane.parked.length === 0 && !(drain?.active ?? false)) {
    sections.push('Nothing is in flight and no drain is live.');
  }
  return sections.join('\n\n');
}
