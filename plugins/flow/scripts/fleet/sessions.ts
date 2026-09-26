/**
 * The session registry behind `flow fleet` (spec `flow-usage` §2.6): every live
 * session on a registered account, which item it serves, and what it is doing.
 *
 * Three sources, joined on `sessionId`:
 *
 * 1. Claude Code's own session files, `<config dir>/sessions/<pid>.json`
 *    ({@link readCliSessions}).
 * 2. A DorkOS server on this machine, `GET /api/sessions` ({@link fetchDorkosSessions}).
 * 3. flow's run records, `<main checkout>/.dork/flow/flow-state.json` ({@link collectRuns}).
 *
 * {@link joinSessions} merges them and {@link sessionState} names each row's state.
 *
 * Reads only. Every outside effect (process checks, `ps`, `git`, HTTP, the run
 * store) comes in through a dependency, so tests never touch the machine. The
 * module imports no npm package.
 *
 * @module @dorkos/flow/fleet/sessions
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from '../errors.ts';
import type { ProcessRunner } from '../cli/context.ts';
import type { AccountIdentity } from './accounts.ts';
import { readWindow, type FleetWarning, type Instant } from './usage-ledger.ts';

/** A live Claude Code session read from its session file. */
export interface CliSession {
  /** The Claude Code session id. */
  sessionId: string;
  /** The process id. */
  pid: number;
  /** The registry id of the config dir the file was found in. */
  account: string;
  /** The session's working folder, or `null`. */
  cwd: string | null;
  /** Claude Code's own status word (`busy`, `idle`, ...), or `null`. */
  status: string | null;
  /** When the session started (UTC ISO), or `null`. */
  startedAt: string | null;
}

/** A session a DorkOS server reports. */
export interface DorkosSession {
  /** The session id. */
  sessionId: string;
  /** The registry id, when the server or the path told us; else `null`. */
  account: string | null;
  /** The session's working folder, or `null`. */
  cwd: string | null;
  /** DorkOS's lifecycle word, or `null` when the server holds no live status for it. */
  lifecycle: string | null;
  /** Whether the server says the session hit a usage limit. */
  limited: boolean;
  /** The item a flow run serves, per the server's own join, or `null`. */
  item: string | null;
  /** When the session was created (UTC ISO), or `null`. */
  startedAt: string | null;
}

/** What {@link fetchDorkosSessions} learned. */
export interface DorkosResult {
  /** The URL asked. */
  url: string;
  /** Whether anything answered. */
  reachable: boolean;
  /** The sessions kept (live, or serving an active run). */
  sessions: DorkosSession[];
  /** A problem worth telling the person, such as a 401. */
  warning?: string;
}

/** A run record with the checkout it came from. */
export interface ActiveRun {
  /** The tracker item's identifier (`DOR-123`). */
  identifier: string;
  /** The harness session the run's current worker uses. */
  sessionId: string;
  /** `queued`, `running` or `waiting_for_review`. */
  status: string;
  /** The spine stage, or `null`. */
  stage: string | null;
  /** The account the run bills (a registry id), or `null`. */
  account: string | null;
  /** The launcher (`cli`, `dorkos`, `cmux`, ...), or `null`. */
  host: string | null;
  /** The worker's process id, or `null`. */
  workerPid: number | null;
  /** The worktree the run works in, or `null`. */
  worktreePath: string | null;
  /** When the run started (UTC ISO), or `null`. */
  startedAt: string | null;
}

/** Which source a fleet row came from. */
export type SessionSource = 'claude-code' | 'dorkos' | 'flow-run';

/** One row of the sessions table. */
export interface FleetSession {
  /** The session id. */
  sessionId: string;
  /** The registry id, or `null` when unknown. */
  account: string | null;
  /** The tracker item, or `null`. */
  item: string | null;
  /** The run's stage, or `null`. */
  stage: string | null;
  /** See {@link sessionState}. */
  state: string;
  /** `cli`, `dorkos`, `cmux`, ... or `null` when unknown. */
  host: string | null;
  /** The process id, or `null`. */
  pid: number | null;
  /** The working folder, or `null`. */
  cwd: string | null;
  /** When the session started (UTC ISO), or `null`. */
  startedAt: string | null;
  /** Where the row came from. */
  sources: SessionSource[];
}

/** Collapse runs of whitespace and trim, so `ps` padding never decides a comparison. */
export function normalizeStartText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Epoch ms or an ISO string to UTC ISO; `null` for anything else. */
function toIso(value: unknown): string | null {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Whether a process exists: `kill(pid, 0)` succeeds, or fails with `EPERM` (it
 * exists but belongs to someone else).
 *
 * @param pid - A process id.
 * @returns True when the process exists.
 */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Dependencies of {@link readCliSessions}. */
export interface CliSessionDeps {
  /** Whether a pid exists. Default {@link pidExists}. */
  pidAlive?: (pid: number) => boolean;
  /** Runs `ps`. */
  runProcess: ProcessRunner;
}

/**
 * Start times of `pids` as `ps` reports them, in UTC and the C locale (the form
 * Claude Code writes as `procStart`). `null` when `ps` could not answer at all,
 * so the caller falls back to the plain existence check.
 */
async function processStarts(
  pids: readonly number[],
  runProcess: ProcessRunner
): Promise<Map<number, string> | null> {
  if (pids.length === 0) return new Map();
  let result;
  try {
    // `env` sets TZ and the locale for ps only: Claude Code writes procStart in
    // UTC and the C locale, while a bare ps prints local time in the user's.
    result = await runProcess(
      'env',
      ['TZ=UTC', 'LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', pids.join(',')],
      { timeoutMs: 5_000 }
    );
  } catch {
    return null;
  }
  const starts = new Map<number, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (match) starts.set(Number(match[1]), normalizeStartText(match[2]));
  }
  // No parsable line at all while ps failed: it did not answer, so trust the kill check.
  if (starts.size === 0 && result.code !== 0 && result.stderr.trim() !== '') return null;
  return starts;
}

/**
 * Live sessions from every registered account's `<path>/sessions/*.json`.
 *
 * A file needs a number `pid` and a string `sessionId`; anything else is skipped
 * with a warning. A session is live when its pid exists and, when both are
 * known, `ps` reports the same start time as the file's `procStart` (a
 * different one means the pid was reused). If `ps` cannot answer, existence alone decides.
 *
 * @param identities - The identities in registry order; only routable ones are read.
 * @param deps - Process checks.
 * @returns Live sessions and warnings.
 */
export async function readCliSessions(
  identities: readonly AccountIdentity[],
  deps: CliSessionDeps
): Promise<{ sessions: CliSession[]; warnings: FleetWarning[] }> {
  const pidAlive = deps.pidAlive ?? pidExists;
  const warnings: FleetWarning[] = [];
  const candidates: (CliSession & { procStart: string | null })[] = [];
  for (const identity of identities) {
    if (!identity.routable) continue;
    const dir = path.join(identity.path, 'sessions');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        warnings.push({
          code: 'session-file-unreadable',
          message: `${file} is not readable JSON; skipped it.`,
        });
        continue;
      }
      if (!isObject(raw) || typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') {
        warnings.push({
          code: 'session-file-invalid',
          message: `${file} has no pid or sessionId; skipped it.`,
        });
        continue;
      }
      candidates.push({
        sessionId: raw.sessionId,
        pid: raw.pid,
        account: identity.id,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        status: typeof raw.status === 'string' ? raw.status : null,
        startedAt: toIso(raw.startedAt),
        procStart: typeof raw.procStart === 'string' ? normalizeStartText(raw.procStart) : null,
      });
    }
  }

  const existing = candidates.filter((c) => pidAlive(c.pid));
  const starts = await processStarts([...new Set(existing.map((c) => c.pid))], deps.runProcess);
  const sessions: CliSession[] = [];
  for (const { procStart, ...session } of existing) {
    if (starts !== null) {
      const psStart = starts.get(session.pid);
      if (psStart === undefined) continue;
      if (procStart !== null && psStart !== procStart) continue;
    }
    sessions.push(session);
  }
  return { sessions, warnings };
}

/**
 * The DorkOS URL `flow fleet` asks: the flag, else `FLOW_DORKOS_URL`, else
 * `http://127.0.0.1:<DORKOS_PORT or 4242>`.
 *
 * @param flag - The `--dorkos-url` value, if any.
 * @param env - The environment.
 * @returns The URL, not yet checked.
 */
export function resolveDorkosUrl(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>
): string {
  if (flag !== undefined && flag !== '') return flag;
  if (env.FLOW_DORKOS_URL) return env.FLOW_DORKOS_URL;
  return `http://127.0.0.1:${env.DORKOS_PORT || '4242'}`;
}

/**
 * Refuse any URL whose host is not this machine, so `flow fleet` never sends a
 * request anywhere else.
 *
 * @param url - The DorkOS URL.
 * @returns The parsed URL.
 * @throws {UsageError} When the URL does not parse or its host is not 127.0.0.1, localhost or ::1.
 */
export function assertLoopback(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`"${url}" is not a URL.`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(host)
  ) {
    throw new UsageError(
      `flow fleet only asks a DorkOS on this machine (127.0.0.1, localhost or ::1), not "${url}".`
    );
  }
  return parsed;
}

/** Run statuses a fleet row cares about. */
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting_for_review']);

/** Dependencies of {@link fetchDorkosSessions}. */
export interface DorkosDeps {
  /** The fetch implementation. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Give up after this many ms. Default 1500. */
  timeoutMs?: number;
}

/**
 * Ask a loopback DorkOS for its sessions (`GET /api/sessions?limit=500`) and
 * keep the ones it holds live (they carry a `status`) or that serve an active
 * flow run (`trackerItem.runStatus`). A DorkOS release without those fields
 * contributes nothing, exactly like one with nothing live.
 *
 * @param url - The DorkOS base URL; must be loopback.
 * @param identities - The identities, to name an account from its path.
 * @param deps - The fetch implementation and timeout.
 * @returns What the server said.
 * @throws {UsageError} When the URL is not loopback.
 */
export async function fetchDorkosSessions(
  url: string,
  identities: readonly AccountIdentity[],
  deps: DorkosDeps = {}
): Promise<DorkosResult> {
  const base = assertLoopback(url);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = new URL('/api/sessions?limit=500', base);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 1_500),
      // A redirect could send the request off this machine; refuse to follow one.
      redirect: 'error',
    });
  } catch {
    return { url, reachable: false, sessions: [] };
  }
  if (!response.ok) {
    return {
      url,
      reachable: true,
      sessions: [],
      warning: `DorkOS answered ${response.status}; its sessions are not shown. Sign in, or pass --no-dorkos.`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      url,
      reachable: true,
      sessions: [],
      warning: 'DorkOS sent a session list flow could not read.',
    };
  }
  const rows = isObject(body) && Array.isArray(body.sessions) ? body.sessions : [];
  const byPath = new Map(identities.map((identity) => [path.resolve(identity.path), identity.id]));
  const sessions: DorkosSession[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.id !== 'string') continue;
    const status = isObject(row.status) ? row.status : null;
    const tracker = isObject(row.trackerItem) ? row.trackerItem : null;
    const activeRun =
      tracker !== null &&
      typeof tracker.runStatus === 'string' &&
      ACTIVE_RUN_STATUSES.has(tracker.runStatus);
    if (status === null && !activeRun) continue;
    let account: string | null = typeof row.accountId === 'string' ? row.accountId : null;
    if (account === null && typeof row.account === 'string') {
      account = byPath.get(path.resolve(row.account)) ?? null;
    }
    sessions.push({
      sessionId: row.id,
      account,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      lifecycle: status !== null && typeof status.lifecycle === 'string' ? status.lifecycle : null,
      limited: status !== null && status.limit !== null && status.limit !== undefined,
      item: tracker !== null && typeof tracker.id === 'string' ? tracker.id : null,
      startedAt: toIso(row.createdAt),
    });
  }
  return { url, reachable: true, sessions };
}

/**
 * Read `<mainCheckout>/.dork/flow/flow-state.json` for the fleet view, without a
 * lock and without the run-store schema: `{}` when the file is missing, `null`
 * when it exists but is not a JSON object (so the caller can say so instead of
 * silently showing fewer runs). {@link collectRuns} checks each run's fields
 * itself, leniently, so one odd record never hides the others.
 *
 * @param mainCheckout - The main checkout folder.
 * @returns The raw store, `{}`, or `null`.
 */
export function readRunStore(mainCheckout: string): Record<string, unknown> | null {
  const file = path.join(mainCheckout, '.dork', 'flow', 'flow-state.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Dependencies of {@link collectRuns}. */
export interface RunDeps {
  /** Runs `git`. */
  runProcess: ProcessRunner;
  /**
   * Reads a main checkout's run store: `{}` when the file is missing, `null`
   * when it exists but cannot be read as a run store (then a warning names it).
   */
  readRuns(mainCheckout: string): Record<string, unknown> | null;
  /** At most this many `git` calls at once. Default 8. */
  concurrency?: number;
}

/** The main checkout of `cwd` (parent of the git common dir), or `null`. */
async function mainCheckoutOf(cwd: string, runProcess: ProcessRunner): Promise<string | null> {
  try {
    const result = await runProcess(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeoutMs: 2_000 }
    );
    if (result.code !== 0) return null;
    const commonDir = result.stdout.trim();
    return commonDir === '' ? null : path.dirname(path.resolve(cwd, commonDir));
  } catch {
    return null;
  }
}

/**
 * Active flow runs (`queued`, `running`, `waiting_for_review`) from the run store
 * of every distinct main checkout behind `cwds`.
 *
 * @param cwds - Working folders (the project, and every session's cwd).
 * @param deps - `git` and the run-store reader.
 * @returns The runs, each at most once, and a warning per unreadable run store.
 */
export async function collectRuns(
  cwds: readonly string[],
  deps: RunDeps
): Promise<{ runs: ActiveRun[]; warnings: FleetWarning[] }> {
  const unique = [...new Set(cwds)];
  const limit = Math.max(1, deps.concurrency ?? 8);
  const checkouts = new Set<string>();
  for (let i = 0; i < unique.length; i += limit) {
    const batch = await Promise.all(
      unique.slice(i, i + limit).map((cwd) => mainCheckoutOf(cwd, deps.runProcess))
    );
    for (const checkout of batch) if (checkout !== null) checkouts.add(checkout);
  }
  const runs: ActiveRun[] = [];
  const warnings: FleetWarning[] = [];
  const seen = new Set<string>();
  for (const checkout of [...checkouts].sort()) {
    const store = deps.readRuns(checkout);
    if (store === null) {
      warnings.push({
        code: 'run-store-unreadable',
        message: `${path.join(checkout, '.dork', 'flow', 'flow-state.json')} is not a readable run store; its runs are not shown.`,
      });
      continue;
    }
    for (const run of Object.values(store)) {
      if (!isObject(run) || typeof run.identifier !== 'string' || typeof run.sessionId !== 'string')
        continue;
      if (typeof run.status !== 'string' || !ACTIVE_RUN_STATUSES.has(run.status)) continue;
      const key = `${checkout}\0${run.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      runs.push({
        identifier: run.identifier,
        sessionId: run.sessionId,
        status: run.status,
        stage: typeof run.stage === 'string' ? run.stage : null,
        account: typeof run.account === 'string' ? run.account : null,
        host: typeof run.host === 'string' ? run.host : null,
        workerPid: typeof run.workerPid === 'number' ? run.workerPid : null,
        worktreePath: typeof run.worktreePath === 'string' ? run.worktreePath : null,
        startedAt: toIso(run.startedAt),
      });
    }
  }
  return { runs, warnings };
}

/** The inputs one row's state is decided from. */
export interface StateInput {
  /** The DorkOS side of the row, if any. */
  dorkos?: Pick<DorkosSession, 'lifecycle' | 'limited'>;
  /** The Claude Code side of the row, if any. */
  cli?: Pick<CliSession, 'status'>;
  /** The run, when the row is a run with no live session. */
  runOnly?: Pick<ActiveRun, 'status' | 'workerPid'>;
  /** Whether the account's 5-hour or weekly window reads `rejected` right now. */
  accountLimited: boolean;
  /** Whether a pid exists. */
  pidAlive(pid: number): boolean;
}

const DORKOS_STATES: Readonly<Record<string, string>> = {
  streaming: 'busy',
  blocked: 'parked',
  idle: 'idle',
};

/**
 * Name a row's state (spec §2.6 "State"): `busy`, `idle`, `parked`, `limited`,
 * `stale`, `unseen`, or a source's own word when flow has no mapping for it.
 * An `idle` row whose account is limited right now reads `limited`; a `busy`
 * one does not (the reading must be out of date).
 *
 * @param input - The row's sources.
 * @returns The state word.
 */
export function sessionState(input: StateInput): string {
  let state: string;
  if (input.dorkos !== undefined) {
    if (input.dorkos.limited) return 'limited';
    const lifecycle = input.dorkos.lifecycle;
    // No live status means DorkOS holds no projector for it, which DorkOS itself reads as idle.
    state = lifecycle === null ? 'idle' : (DORKOS_STATES[lifecycle] ?? lifecycle);
  } else if (input.cli !== undefined) {
    state = input.cli.status ?? 'unknown';
  } else if (input.runOnly !== undefined) {
    if (input.runOnly.status === 'waiting_for_review') return 'parked';
    const pid = input.runOnly.workerPid;
    return pid !== null && !input.pidAlive(pid) ? 'stale' : 'unseen';
  } else {
    state = 'unknown';
  }
  return state === 'idle' && input.accountLimited ? 'limited' : state;
}

/**
 * Whether an account's 5-hour or weekly window reads `rejected` at `now`.
 *
 * @param windows - The account's ledger windows, or `null`.
 * @param now - The moment to judge at.
 * @returns True when either window is limited and has not reset.
 */
export function accountLimitedNow(windows: Record<string, unknown> | null, now: Instant): boolean {
  if (windows === null) return false;
  return ['five_hour', 'seven_day'].some(
    (key) => readWindow(windows[key], now, key)?.status === 'rejected'
  );
}

/** Inputs of {@link joinSessions}. */
export interface JoinInput {
  /** The identities in registry order (decides sort order). */
  identities: readonly Pick<AccountIdentity, 'id'>[];
  /** Live Claude Code sessions. */
  cli: readonly CliSession[];
  /** Sessions a loopback DorkOS reported. */
  dorkos: readonly DorkosSession[];
  /** Active flow runs. */
  runs: readonly ActiveRun[];
  /** Each account's ledger windows, by registry id. */
  windowsByAccount: Readonly<Record<string, Record<string, unknown> | null>>;
  /** The moment to judge limits at. */
  now: Instant;
  /** Whether a pid exists. */
  pidAlive(pid: number): boolean;
}

/**
 * Join the three sources on `sessionId` into one row per session (spec §2.6
 * "Joining"), name each row's state, and sort by account registry order
 * (unknown last), then item, then start time (unknown items and times last).
 *
 * @param input - The sources and what state needs.
 * @returns The rows.
 */
export function joinSessions(input: JoinInput): FleetSession[] {
  const runBySession = new Map<string, ActiveRun>();
  for (const run of input.runs)
    if (!runBySession.has(run.sessionId)) runBySession.set(run.sessionId, run);
  const dorkosById = new Map(input.dorkos.map((s) => [s.sessionId, s]));
  const limited = (account: string | null): boolean =>
    account !== null && accountLimitedNow(input.windowsByAccount[account] ?? null, input.now);

  const rows: FleetSession[] = [];
  const done = new Set<string>();
  const usedRuns = new Set<ActiveRun>();

  const fromLive = (sessionId: string, cli?: CliSession, dork?: DorkosSession): FleetSession => {
    const run = runBySession.get(sessionId);
    if (run) usedRuns.add(run);
    const account = dork?.account ?? cli?.account ?? run?.account ?? null;
    const sources: SessionSource[] = [];
    if (cli) sources.push('claude-code');
    if (dork) sources.push('dorkos');
    if (run) sources.push('flow-run');
    return {
      sessionId,
      account,
      item: run?.identifier ?? dork?.item ?? null,
      stage: run?.stage ?? null,
      state: sessionState({
        dorkos: dork,
        cli: dork ? undefined : cli,
        accountLimited: limited(account),
        pidAlive: input.pidAlive,
      }),
      host: run?.host ?? (dork ? 'dorkos' : 'cli'),
      pid: cli?.pid ?? null,
      cwd: dork?.cwd ?? cli?.cwd ?? null,
      startedAt: dork?.startedAt ?? cli?.startedAt ?? null,
      sources,
    };
  };

  for (const cli of input.cli) {
    if (done.has(cli.sessionId)) continue;
    done.add(cli.sessionId);
    rows.push(fromLive(cli.sessionId, cli, dorkosById.get(cli.sessionId)));
  }
  for (const dork of input.dorkos) {
    if (done.has(dork.sessionId)) continue;
    done.add(dork.sessionId);
    rows.push(fromLive(dork.sessionId, undefined, dork));
  }
  for (const run of input.runs) {
    if (usedRuns.has(run) || done.has(run.sessionId)) continue;
    done.add(run.sessionId);
    rows.push({
      sessionId: run.sessionId,
      account: run.account,
      item: run.identifier,
      stage: run.stage,
      state: sessionState({ runOnly: run, accountLimited: false, pidAlive: input.pidAlive }),
      host: run.host,
      pid: run.workerPid,
      cwd: run.worktreePath,
      startedAt: run.startedAt,
      sources: ['flow-run'],
    });
  }

  const order = new Map(input.identities.map((identity, index) => [identity.id, index]));
  const rank = (account: string | null): number =>
    account !== null && order.has(account)
      ? (order.get(account) as number)
      : Number.MAX_SAFE_INTEGER;
  return rows.sort(
    (a, b) =>
      rank(a.account) - rank(b.account) ||
      (a.item ?? '\uffff').localeCompare(b.item ?? '\uffff') ||
      (a.startedAt ?? '\uffff').localeCompare(b.startedAt ?? '\uffff')
  );
}
