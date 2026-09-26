/**
 * One pass of the parallel drain (spec `flow-handoff-dispatch` §4.2, §4.3): all
 * the drain's I/O lives here, around the two pure reducers.
 *
 * For every drain run that is queued or running, a pass:
 *
 * 1. **Gathers facts**: each session's state from its launcher, new usage lines
 *    from a cli session's stream log, the branch head on origin, the PR (or an
 *    open PR on the branch while none is recorded), and the tracker item.
 * 2. **Decides**: the handoff reducer ({@link PassDeps.handoffStep}, a no-op
 *    until the handoff phase ships) and then `drainStep`.
 * 3. **Records the decision by compare-and-set**: re-read under the run store's
 *    lock, the run's `drain.rev` must still be the one gathered. A report that
 *    landed in between (every writer bumps `rev`) drops the decision, and no
 *    action of it is taken; the next pass decides again from the new facts. A
 *    reviewer about to start is written into its slot in the same write, as a
 *    pending intent with its minted session id and token hash ("intent before
 *    launch").
 * 4. **Acts**, in order: stop sessions, send messages, handoffs, launches,
 *    forge calls, tracker writes. A launch's handle is written by a second
 *    update that does not need an unchanged `rev`: the slot is the
 *    supervisor's, and the intent already claimed it.
 *
 * Then it fills free slots: the machine-load cap, then `flow next`'s logic with
 * account assignment, then for each pick a worktree, the worker brief, a claim
 * written as `queued` with the worker's intent, the launch, and the run marked
 * `running`. A launch that fails releases the claim.
 *
 * **Adopt before releasing.** A worker intent (or a queued claim) older than
 * the start timeout means a pass died between writing it and recording the
 * handle. The minted session is looked for first; found, it is adopted, so a
 * live session never gets a second writer. Not found, the claim is released,
 * except on DorkOS, where `session_start` may have minted another id: that run
 * parks with instructions instead. A stale reviewer intent is adopted the same
 * way, or cleared so a fresh reviewer starts (it has its own worktree).
 *
 * Report-owned fields (`pushedSha`, `verdict`, `reviewedSha`, `reviewRound`,
 * `pr`, `checkpointAt`, `checkpointSha`) are never written here, with one
 * exception: after the supervisor itself arms a PR, it records `pr.armed` so
 * `flow report pushed` knows to disarm it on the next push.
 *
 * Tracker I/O goes only through the injected deps, which the verb wires to the
 * code adapter.
 *
 * @module @dorkos/flow/drain/runner
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import { FlowError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';
import { judgeEjection } from '../forge/ejection.ts';
import type { Forge } from '../forge/types.ts';
import { launchAccountFor } from '../launchers/common.ts';
import { findTranscript } from '../launchers/prove-account.ts';
import {
  handleRuntime,
  LaunchError,
  type HostName,
  type LaunchAccount,
  type LaunchPermissionMode,
  type Launcher,
  type RuntimeName,
  type SessionHandle,
  type SessionState,
} from '../launchers/types.ts';
import { launchBudget } from './account-rank.ts';
import { renderBrief } from './briefs.ts';
import { ensureCheckpointExcludes, WORKER_BRIEF_PATH } from './checkpoint.ts';
import {
  drainStep,
  type DrainAction,
  type DrainFacts,
  type DrainStepConfig,
  type PrStatusFact,
  type SendAction,
} from './drain-step.ts';
import { render as renderMessage } from './messages.ts';
import type { DrainReviewerHandle, DrainState, DrainWorkerHandle } from './state.ts';
import { dueForSnapshot, readUsageSampleState, writeUsageSampleState } from './usage-sample.ts';
import {
  branchFor,
  provisionReviewWorktree,
  provisionWorktree,
  removeWorktree,
  reviewBase,
  reviewWorktreePath,
  workspacesDir,
} from './worktree.ts';

/** How far back merge-group failures count when judging an ejection (minutes). */
const EJECTION_WINDOW_MINUTES = 30;

/** Where a reviewer's brief is written, relative to its review worktree. */
export const REVIEWER_BRIEF_PATH = '.dork/flow/drain/briefs/reviewer.md';

/** Where a reviewer writes its findings, relative to its review worktree. */
export const REVIEWER_FINDINGS_PATH = '.dork/flow/drain/findings.md';

/** Where the supervisor writes the messages it sends, relative to the worker's worktree. */
export const MESSAGES_DIR = '.dork/flow/drain/messages';

/** What the handoff reducer returns: the run to hand `drainStep`, and its own actions. */
export interface HandoffStepResult {
  /** The run after the handoff step. */
  run: FlowRun;
  /** Actions the handoff step asks for (applied after sends, before launches). */
  actions: DrainAction[];
}

/**
 * The handoff reducer's seam (spec §5.2). It runs before `drainStep` on every
 * run, every pass. The handoff phase ships the real one; until then it is
 * {@link noHandoff}.
 */
export type HandoffStep = (run: FlowRun, facts: DrainFacts, now: Date) => HandoffStepResult;

/**
 * The handoff reducer before the handoff phase ships: the run unchanged, no actions.
 *
 * @param run - The run.
 * @returns The run, and no actions.
 */
export const noHandoff: HandoffStep = (run) => ({ run, actions: [] });

/** An account a session may bill, as the runner launches on it. */
export interface PlannedAccount {
  /** The runtime. */
  runtime: RuntimeName;
  /** The registry id (`default` for the runtime's standalone default account). */
  id: string;
  /**
   * The account's folder: a standalone `default` has its machine-wide one (spec
   * `flow-cli-core` §1.1a rev 6d). `null` only for OpenCode's ambient default.
   */
  path: string | null;
  /** True for the runtime's standalone `default` (its run records no account). */
  implicit: boolean;
  /** The operator's label for it, when set. */
  label: string | null;
}

/** One pick of `flow next`'s logic, as the runner launches it. */
export interface PlannedPick {
  /** The item, e.g. `ACME-12`. */
  identifier: string;
  /** Its title. */
  title: string;
  /** Its account, or `null` when no account may take it. */
  account: PlannedAccount | null;
}

/** What a pass's plan step found. */
export interface PassPlan {
  /** The picks, in order (at most the free slots). */
  picks: PlannedPick[];
  /** The stderr block naming why no account may take work, when a pick has none. */
  noAccount: string | null;
  /** Every account the plan ranked, as `<runtime>:<id>`. */
  considered: string[];
}

/** What {@link PassDeps.claim} records. */
export interface DrainClaim {
  /** The item. */
  identifier: string;
  /** The minted session id. */
  sessionId: string;
  /** The worktree. */
  worktreePath: string;
  /** Its branch. */
  branch: string;
  /** The account id, absent for the implicit account. */
  account?: string;
  /** The host. */
  host: HostName;
  /** The runtime. */
  runtime: RuntimeName;
  /** The drain state, holding the worker's intent. */
  drain: DrainState;
}

/** The item facts a pass reads from the tracker. */
export interface ItemFacts {
  /** Completed or canceled. */
  closed: boolean;
  /** Still carries the agent's claim. */
  claimed: boolean;
  /** Carries `agent/needs-input`: a person has not answered yet. */
  needsInput: boolean;
  /** For a parked run: a pointer to the reply that answered it (needs-input already lifted), when found. */
  answer?: string | null;
  /** Its title. */
  title: string;
}

/** The drain settings a pass reads. */
export interface PassSettings {
  /** Workers and reviewers at once. */
  parallel: number;
  /** No new launch while load per CPU is at or above this. */
  maxLoadPerCpu: number;
  /** Review verdicts before a run parks. */
  maxReviewRounds: number;
  /** How long a claim or intent may wait before adopt-or-release (ms). */
  startTimeoutMs: number;
  /** The permission mode sessions start in. */
  permissionMode: LaunchPermissionMode;
  /** The model a worker runs (`models.bindings[models.tiers.implementation]`), or `null`. */
  workerModel: string | null;
  /** The model a reviewer runs (`models.bindings[models.tiers.review]`), or `null`. */
  reviewerModel: string | null;
  /** The review rubric's path (`review.rubric`). */
  rubric: string;
}

/** Everything one pass touches. The verb wires the real ones; tests inject fakes. */
export interface PassDeps {
  /** The run store. */
  store: FlowStateFile;
  /** The project's main checkout. */
  mainCheckout: string;
  /** The resolved DorkOS home. */
  dorkHome: string;
  /** The repository's name, for the worktree folder. */
  repoName: string;
  /** The plugin folder. */
  flowRoot: string;
  /** The full flow command prefix messages and briefs spell verbs with. */
  flow: string;
  /** The drain settings. */
  settings: PassSettings;
  /** `--dry-run`: decide and report, but write, start and send nothing. */
  dryRun: boolean;
  /** The clock. */
  now(): Date;
  /** The 1-minute load average and CPU count. */
  load(): { load1: number; cpus: number };
  /** Runs git (no shell). */
  runProcess: ProcessRunner;
  /** The launcher for a host. */
  launcher(host: HostName): Launcher;
  /** The host a new session on `runtime` starts under. */
  hostFor(runtime: RuntimeName): Promise<HostName>;
  /** The project's forge. */
  forge: Forge;
  /** The tracker item's facts (one `getItem`). */
  /**
   * The tracker item's facts (one `getItem`). For a parked run (`parked`), it
   * also looks for a reply newer than `since` and, finding one, lifts
   * needs-input through the adapter and returns the answer's pointer.
   */
  item(identifier: string, parked?: { since: string | null }): Promise<ItemFacts>;
  /** `flow next`'s logic with account assignment, for `slots` picks. */
  plan(slots: number): Promise<PassPlan>;
  /** The account a reviewer of a `runtime` run bills (ranked with no affinity), or `null`. */
  reviewerAccount(runtime: RuntimeName): Promise<PlannedAccount | null>;
  /** Claim an item with `status: "queued"`. Throws a `PreconditionError` when it cannot. */
  claim(input: DrainClaim): Promise<void>;
  /** Release a claim to ready at its resume stage, deleting the run. */
  release(identifier: string): Promise<void>;
  /** The tracker half of a park: the needs-input projection and one signed comment. */
  park(identifier: string, reason: string): Promise<void>;
  /** Look for a session a dead pass may have started; its handle when found. */
  findSession(probe: DrainWorkerHandle): Promise<SessionHandle | null>;
  /** Fold a cli session's new stream-log lines into its ledger; the new offset. */
  ingest(handle: SessionHandle): Promise<number | null>;
  /** Journal a usage snapshot for these `<runtime>:<id>` accounts. */
  journalUsage(keys: readonly string[]): void;
  /** The handoff reducer (default {@link noHandoff}). */
  handoffStep?: HandoffStep;
  /** Mint a session id (default `randomUUID`). */
  mintId?(): string;
  /** Mint a reviewer token (default 128 random bits, hex). */
  mintToken?(): string;
  /** Print a warning. */
  warn(message: string): void;
}

/** One line of a pass's report. */
export interface PassEvent {
  /** The item. */
  identifier: string;
  /** Its drain phase after the pass, or `null` when it has no run any more. */
  phase: string | null;
  /** The account its worker bills, or `null` for the ambient account. */
  account: string | null;
  /** The host its worker runs under. */
  host: string | null;
  /** What happened, in plain words. */
  event: string;
}

/** What one pass did. */
export interface PassReport {
  /** One line per run that changed. */
  events: PassEvent[];
  /** Drain runs still active after the pass. */
  active: number;
  /** Whether the plan ran and found nothing eligible. */
  nothingEligible: boolean;
  /** Why no new session started, when load held them back. */
  held: 'machine-busy' | null;
  /** The accounts a usage snapshot was asked for this pass. */
  usageSampled: string[];
}

/** The SHA-256 of a reviewer token, hex: the only form the run store keeps. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A version-1 drain this runner can write. */
type DrainRun = FlowRun & { drain: DrainState };

/** Whether a run carries a drain this version understands. */
function writable(run: FlowRun | undefined): run is DrainRun {
  return run?.drain?.v === 1 && typeof run.drain.rev === 'number';
}

/**
 * Whether a pass looks at this run: a writable drain, queued or running (a
 * parked one too, to notice an answer), or complete with a session still to
 * stop in `closing`.
 */
function isTracked(run: FlowRun): run is DrainRun {
  if (!writable(run)) return false;
  if (run.drain.phase === 'parked') return run.status === 'queued' || run.status === 'running';
  return isActive(run);
}

/**
 * Whether a run is live: tracked and not parked. A parked run holds no live
 * session, so it takes no slot and does not keep a drain loop going.
 */
function isActive(run: FlowRun): run is DrainRun {
  if (!writable(run) || run.drain.phase === 'parked') return false;
  if (run.status === 'queued' || run.status === 'running') return true;
  return (
    run.status === 'complete' &&
    run.drain.phase === 'closing' &&
    (run.drain.worker !== null || run.drain.reviewer !== null)
  );
}

/** A stored handle as a launcher takes it. */
function launchHandle(handle: DrainWorkerHandle): SessionHandle {
  const { pending: _pending, pendingSince: _since, ...rest } = handle;
  return { ...rest, runtime: handleRuntime(handle) };
}

/** Same JSON, for "did anything change". */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The first seven characters of a SHA. */
function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'nothing';
}

/** The order actions are applied in (§4.2 step 3): stop, send, handoffs, launches, forge, tracker. */
function actionRank(action: DrainAction): number {
  switch (action.kind) {
    case 'stop':
      return 0;
    case 'send':
      return 1;
    case 'start-reviewer':
      return 3;
    case 'arm':
    case 'disarm':
      return 4;
    case 'park':
      return 5;
    default:
      return 2; // a handoff reducer's own actions
  }
}

/** A plain phrase for one action, for the report line. */
function describe(action: DrainAction, reviewerAccount: string | null): string {
  switch (action.kind) {
    case 'start-reviewer':
      return `reviewer started at ${short(action.sha)} on ${reviewerAccount ?? 'the ambient account'}${action.deltaFrom ? ` (delta from ${short(action.deltaFrom)})` : ''}`;
    case 'stop':
      return `${action.which} stopped`;
    case 'send':
      return `sent ${action.message}`;
    case 'arm':
      return `armed #${action.pr.number}`;
    case 'disarm':
      return `disarmed #${action.pr.number}`;
    case 'park':
      return `parked: ${action.reason}`;
    case 'adopt-or-release':
      return 'checked a start that never confirmed';
    default:
      return (action as { kind: string }).kind;
  }
}

/**
 * Look for a session a dead pass may have started (§4.3 "adopt before
 * releasing"), on this machine's files or DorkOS:
 *
 * - cli and cmux: a `sessions/*.json` under the account's config dir naming the
 *   session (it gives the pid), or its transcript, or (cli) its stream log.
 * - dorkos: `GET /api/sessions/<id>` answers 2xx; the handle takes the `id` it returns.
 *
 * @param probe - The intent: host, runtime, minted session id, account, cwd and config dir.
 * @param io - The DorkOS base URL and `fetch`.
 * @returns The handle to adopt, or `null` when nothing was found.
 */
export async function findMintedSession(
  probe: DrainWorkerHandle,
  io: { dorkosUrl: string; fetch: typeof fetch }
): Promise<SessionHandle | null> {
  const base: SessionHandle = { ...launchHandle(probe) };
  if (probe.host === 'dorkos') {
    try {
      const response = await io.fetch(
        `${io.dorkosUrl}/api/sessions/${encodeURIComponent(probe.sessionId)}`
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { id?: unknown };
      return { ...base, sessionId: typeof body.id === 'string' ? body.id : probe.sessionId };
    } catch {
      return null;
    }
  }
  let pid: number | undefined;
  const configDir = probe.configDir;
  if (configDir !== undefined) {
    const sessions = path.join(configDir, 'sessions');
    let names: string[] = [];
    try {
      names = readdirSync(sessions).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }
    for (const name of names) {
      try {
        const file = JSON.parse(readFileSync(path.join(sessions, name), 'utf8')) as {
          sessionId?: unknown;
          pid?: unknown;
        };
        if (file.sessionId === probe.sessionId) {
          pid = typeof file.pid === 'number' ? file.pid : Number(name.replace(/\.json$/, ''));
          break;
        }
      } catch {
        // an unreadable session file names nothing
      }
    }
  }
  const transcript = configDir === undefined ? null : findTranscript(configDir, probe.sessionId);
  const logFile = path.join(
    probe.cwd,
    '.dork',
    'flow',
    'drain',
    'logs',
    `${probe.sessionId}.jsonl`
  );
  const hasLog = probe.host === 'cli' && existsSync(logFile);
  if (pid === undefined && transcript === null && !hasLog) return null;
  return {
    ...base,
    ...(pid !== undefined && Number.isInteger(pid) ? { pid } : {}),
    ...(probe.host === 'cli' ? { logFile, logOffset: 0 } : {}),
  };
}

/** Write one message file in the worker's worktree; the path. */
function writeMessage(worktree: string, kind: string, text: string): string {
  const dir = path.join(worktree, MESSAGES_DIR);
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  for (const name of readdirSync(dir)) {
    const n = Number(/^(\d+)-/.exec(name)?.[1]);
    if (Number.isFinite(n)) seq = Math.max(seq, n);
  }
  const file = path.join(dir, `${String(seq + 1).padStart(3, '0')}-${kind}.md`);
  writeFileSync(file, text);
  return file;
}

/**
 * The launch account for a planned one (`launchAccountFor`): a standalone
 * `default` launches in its machine-wide folder, never in the supervisor's own
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (rev 6d). Only a folder-less account
 * (OpenCode's ambient default) is `null`, the ambient environment.
 */
function launchAccount(account: PlannedAccount): LaunchAccount | null {
  return account.path === null ? null : launchAccountFor(account);
}

/**
 * Run one pass.
 *
 * @param deps - The world the pass touches.
 * @returns What changed, what is still active, and whether anything was eligible.
 */
export async function runPass(deps: PassDeps): Promise<PassReport> {
  const events: PassEvent[] = [];
  const considered = new Set<string>();
  const now = deps.now();
  const handoffStep = deps.handoffStep ?? noHandoff;
  const mintId = deps.mintId ?? (() => randomUUID());
  const mintToken = deps.mintToken ?? (() => randomBytes(16).toString('hex'));
  const stepCfg: DrainStepConfig = {
    maxReviewRounds: deps.settings.maxReviewRounds,
    startTimeoutMs: deps.settings.startTimeoutMs,
    flow: deps.flow,
  };

  /** Record one line for a run. */
  const note = (run: FlowRun | undefined, identifier: string, event: string): void => {
    events.push({
      identifier,
      phase: run?.drain?.phase ?? null,
      account: run?.account ?? null,
      host: run?.host ?? null,
      event,
    });
  };

  /** A run as it is on disk now. */
  const current = (issueId: string): FlowRun | undefined => deps.store.read()[issueId];

  /**
   * Update a supervisor-owned part of a run without the compare-and-set (the
   * second write of a launch, a new handle after a resume). `update` returns
   * `undefined` to write nothing. Bumps `rev`.
   */
  const supervisorWrite = async (
    issueId: string,
    update: (run: DrainRun) => DrainRun | undefined
  ): Promise<boolean> => {
    let wrote = false;
    await deps.store.updateRun(issueId, (run) => {
      wrote = false;
      if (!writable(run)) return run;
      const next = update(run);
      if (next === undefined) return run;
      wrote = true;
      return { ...next, drain: { ...next.drain, rev: run.drain.rev + 1 } };
    });
    return wrote;
  };

  /** A session's state, never throwing. */
  const stateOf = async (handle: DrainWorkerHandle | null): Promise<SessionState | null> => {
    if (handle === null || handle.pending) return null;
    try {
      return await deps.launcher(handle.host).state(launchHandle(handle));
    } catch (error) {
      return { kind: 'unknown', reason: (error as Error).message };
    }
  };

  /** Resolve a reviewer intent a dead pass left: adopt its session, or clear the slot. */
  const settleReviewerIntent = async (run: DrainRun): Promise<void> => {
    const intent = run.drain.reviewer;
    if (intent === null || !intent.pending) return;
    const since = Date.parse(intent.pendingSince ?? '');
    if (Number.isFinite(since) && now.getTime() - since <= deps.settings.startTimeoutMs) return;
    if (deps.dryRun) {
      note(
        run,
        run.identifier,
        `would resolve a reviewer start that never confirmed (${intent.sessionId})`
      );
      return;
    }
    const found = await deps.findSession(intent);
    const matches = (r: DrainRun) =>
      r.drain.reviewer?.sessionId === intent.sessionId && r.drain.reviewer.pending === true;
    if (found !== null) {
      await supervisorWrite(run.issueId, (r) =>
        matches(r)
          ? {
              ...r,
              drain: {
                ...r.drain,
                reviewer: {
                  ...found,
                  sha: intent.sha,
                  worktree: intent.worktree,
                  tokenHash: intent.tokenHash,
                },
              },
            }
          : undefined
      );
      note(
        run,
        run.identifier,
        `adopted the reviewer session ${found.sessionId} a stopped pass started`
      );
      return;
    }
    await supervisorWrite(run.issueId, (r) =>
      matches(r) ? { ...r, drain: { ...r.drain, reviewer: null } } : undefined
    );
    await removeWorktree(deps.runProcess, deps.mainCheckout, intent.worktree);
    note(
      run,
      run.identifier,
      'cleared a reviewer start that never confirmed; a fresh reviewer starts'
    );
  };

  /** Gather one run's facts (§4.2 step 1), and the new log offsets for cli handles. */
  const gather = async (
    run: DrainRun
  ): Promise<{ facts: DrainFacts; offsets: { worker?: number; reviewer?: number } }> => {
    const drain = run.drain;
    const [worker, reviewer] = await Promise.all([stateOf(drain.worker), stateOf(drain.reviewer)]);
    const offsets: { worker?: number; reviewer?: number } = {};
    if (!deps.dryRun) {
      for (const which of ['worker', 'reviewer'] as const) {
        const handle = drain[which];
        if (handle === null || handle.pending || handle.logFile === undefined) continue;
        const offset = await deps.ingest(launchHandle(handle));
        if (offset !== null && offset !== (handle.logOffset ?? 0)) offsets[which] = offset;
      }
    }

    let originHead: string | null = null;
    try {
      const result = await deps.runProcess(
        'git',
        ['ls-remote', 'origin', `refs/heads/${run.branch}`],
        { cwd: deps.mainCheckout, timeoutMs: 30_000 }
      );
      if (result.code === 0) originHead = result.stdout.trim().split(/\s+/)[0] || null;
    } catch {
      originHead = null;
    }

    let pr: PrStatusFact | null = null;
    let ejection: DrainFacts['ejection'] = null;
    let prForBranch: DrainFacts['prForBranch'] = null;
    if (drain.pr !== null) {
      const status = await deps.forge.prStatus(drain.pr.number);
      pr = {
        state: status.state,
        failing: status.failing.map((check) => ({ name: check.name, url: check.url ?? '' })),
        armed: status.armed,
        queued: status.queued,
        headSha: status.headSha,
      };
      if (status.state === 'open' && drain.pr.armed && !status.armed && !status.queued) {
        const groups = await deps.forge.recentGroupFailures(
          status.base,
          [],
          EJECTION_WINDOW_MINUTES
        );
        const own = [
          ...new Set(
            groups.filter((group) => group.pr === drain.pr?.number).flatMap((g) => g.failing)
          ),
        ];
        ejection = judgeEjection({
          failing: own.length > 0 ? own : status.failing.map((check) => check.name),
          otherGroups: groups,
          pr: drain.pr.number,
        });
      }
    } else {
      const open = await deps.forge.prForBranch(run.branch);
      prForBranch =
        open === null
          ? null
          : { repo: deps.forge.repo, number: open.number, url: open.url, headSha: open.headSha };
    }

    const item = await deps.item(
      run.identifier,
      drain.phase === 'parked' ? { since: drain.parkedAt ?? null } : undefined
    );
    const pendingSince = Date.parse(drain.worker?.pendingSince ?? run.startedAt);
    const unstarted =
      (run.status === 'queued' && drain.worker === null) || drain.worker?.pending === true;
    return {
      facts: {
        prForBranch,
        queuedAgeMs:
          unstarted && Number.isFinite(pendingSince) ? now.getTime() - pendingSince : null,
        worker,
        reviewer,
        reports: {
          pushedSha: drain.pushedSha,
          verdict: drain.verdict,
          reviewedSha: drain.reviewedSha,
          reviewRound: drain.reviewRound,
          pr: drain.pr,
        },
        originHead,
        pr,
        ejection,
        item,
        runComplete: run.status === 'complete',
      },
      offsets,
    };
  };

  /** A worker start that never confirmed: adopt its session, park (DorkOS), or release (§4.3). */
  const adoptOrRelease = async (run: DrainRun): Promise<void> => {
    const probe: DrainWorkerHandle = run.drain.worker ?? {
      host: (run.host ?? 'cli') as HostName,
      runtime: (run.runtime ?? 'claude-code') as RuntimeName,
      sessionId: run.sessionId,
      account: run.account ?? null,
      cwd: run.worktreePath,
    };
    if (deps.dryRun) {
      note(
        run,
        run.identifier,
        `would look for the session ${probe.sessionId} a stopped pass started`
      );
      return;
    }
    const found = await deps.findSession(probe);
    if (found !== null) {
      await supervisorWrite(run.issueId, (r) =>
        r.sessionId === run.sessionId
          ? {
              ...r,
              status: 'running',
              sessionId: found.sessionId,
              workerPid: found.pid ?? -1,
              drain: { ...r.drain, worker: found },
            }
          : undefined
      );
      note(
        current(run.issueId),
        run.identifier,
        `adopted the worker session ${found.sessionId} a stopped pass started`
      );
      return;
    }
    if (probe.host === 'dorkos') {
      const reason = `the supervisor stopped while starting a DorkOS session; check DorkOS for a session in ${run.worktreePath} whose context names flow id ${probe.sessionId}, then flow release or re-run`;
      await supervisorWrite(run.issueId, (r) => ({
        ...r,
        drain: {
          ...r.drain,
          phase: 'parked',
          parkedReason: reason,
          parkedFrom: r.drain.phase === 'parked' ? (r.drain.parkedFrom ?? null) : r.drain.phase,
          parkedAt: now.toISOString(),
        },
      }));
      await deps.park(run.identifier, reason);
      note(current(run.issueId), run.identifier, `parked: ${reason}`);
      return;
    }
    await deps.release(run.identifier);
    note(undefined, run.identifier, 'released to ready: its worker never started');
  };

  /** Mint a reviewer intent for a start-reviewer action; `null` when no account may take it. */
  const reviewerIntent = async (
    run: DrainRun,
    sha: string
  ): Promise<{ handle: DrainReviewerHandle; token: string; account: PlannedAccount } | null> => {
    const runtime = handleRuntime({ runtime: run.runtime as RuntimeName | undefined });
    const account = await deps.reviewerAccount(runtime);
    if (account === null) return null;
    considered.add(`${account.runtime}:${account.id}`);
    const token = mintToken();
    const worktree = reviewWorktreePath(deps.dorkHome, deps.repoName, run.identifier, sha);
    return {
      token,
      account,
      handle: {
        host: await deps.hostFor(account.runtime),
        runtime: account.runtime,
        sessionId: mintId(),
        account: account.implicit ? null : account.id,
        cwd: worktree,
        sha,
        worktree,
        tokenHash: hashToken(token),
        pending: true,
        pendingSince: now.toISOString(),
      },
    };
  };

  /** Start the reviewer whose intent is recorded; write its handle, or clear the slot. */
  const startReviewer = async (
    run: DrainRun,
    intent: { handle: DrainReviewerHandle; token: string; account: PlannedAccount },
    deltaFrom: string | null
  ): Promise<string> => {
    const { handle, token, account } = intent;
    const matches = (r: DrainRun) =>
      r.drain.reviewer?.sessionId === handle.sessionId && r.drain.reviewer.pending === true;
    try {
      await provisionReviewWorktree(deps.runProcess, {
        mainCheckout: deps.mainCheckout,
        branch: run.branch,
        sha: handle.sha,
        target: handle.worktree,
      });
      const base = await reviewBase(deps.runProcess, handle.worktree, handle.sha);
      const brief = renderBrief(deps.flowRoot, 'reviewer', {
        identifier: run.identifier,
        sha: handle.sha,
        base,
        deltaFrom: deltaFrom
          ? `This is a re-review. Also read \`git diff ${deltaFrom} ${handle.sha}\` first: it is what changed since the last review.`
          : 'This is the first review of this branch.',
        rubric: deps.settings.rubric,
        flow: deps.flow,
        findingsFile: path.join(handle.worktree, REVIEWER_FINDINGS_PATH),
        token,
      });
      const promptFile = path.join(handle.worktree, REVIEWER_BRIEF_PATH);
      mkdirSync(path.dirname(promptFile), { recursive: true });
      writeFileSync(promptFile, brief);
      const started = await deps.launcher(handle.host).start({
        role: 'reviewer',
        runtime: account.runtime,
        identifier: run.identifier,
        account: launchAccount(account),
        cwd: handle.worktree,
        promptFile,
        sessionId: handle.sessionId,
        ...(deps.settings.reviewerModel ? { model: deps.settings.reviewerModel } : {}),
        permissionMode: deps.settings.permissionMode,
        title: `${run.identifier} reviewer`,
      });
      // The second write: no unchanged rev needed; the intent holds the slot.
      await supervisorWrite(run.issueId, (r) =>
        matches(r)
          ? {
              ...r,
              drain: {
                ...r.drain,
                reviewer: {
                  ...started,
                  sha: handle.sha,
                  worktree: handle.worktree,
                  tokenHash: handle.tokenHash,
                },
              },
            }
          : undefined
      );
      return `reviewer started at ${short(handle.sha)} on ${account.label ?? account.id} (${handle.host})`;
    } catch (error) {
      if (!(error instanceof LaunchError) && !(error instanceof FlowError)) {
        throw error;
      }
      await supervisorWrite(run.issueId, (r) =>
        matches(r) ? { ...r, drain: { ...r.drain, reviewer: null } } : undefined
      );
      await removeWorktree(deps.runProcess, deps.mainCheckout, handle.worktree);
      return `the reviewer did not start (${(error as Error).message}); the next pass tries again`;
    }
  };

  /** Apply one action after the decision was recorded; a phrase for the report. */
  const apply = async (
    run: DrainRun,
    action: DrainAction,
    intent: { handle: DrainReviewerHandle; token: string; account: PlannedAccount } | null
  ): Promise<string> => {
    switch (action.kind) {
      case 'stop': {
        try {
          await deps.launcher(action.handle.host).stop(action.handle);
        } catch (error) {
          deps.warn(
            `${run.identifier}: could not stop the ${action.which}: ${(error as Error).message}`
          );
        }
        const old = run.drain.reviewer;
        if (
          action.which === 'reviewer' &&
          old !== null &&
          old.sessionId === action.handle.sessionId
        ) {
          const problem = await removeWorktree(deps.runProcess, deps.mainCheckout, old.worktree);
          if (problem !== null)
            deps.warn(`${run.identifier}: could not remove ${old.worktree}: ${problem}`);
        }
        return describe(action, null);
      }
      case 'send': {
        const worker = current(run.issueId)?.drain?.worker ?? null;
        if (worker === null || worker.pending) {
          return `could not send ${action.message}: no started worker`;
        }
        const text = renderMessage(action.message, (action as SendAction).ctx as never);
        const file = writeMessage(run.worktreePath, action.message, text);
        const sent = await deps.launcher(worker.host).send(launchHandle(worker), file);
        if (!same(sent.handle, launchHandle(worker))) {
          await supervisorWrite(run.issueId, (r) =>
            r.drain.worker?.sessionId === worker.sessionId
              ? {
                  ...r,
                  sessionId: sent.handle.sessionId,
                  workerPid: sent.handle.pid ?? -1,
                  drain: { ...r.drain, worker: sent.handle },
                }
              : undefined
          );
        }
        return `sent ${action.message}${sent.result === 'queued' ? ' (queued until the worker stops)' : ''}`;
      }
      case 'start-reviewer':
        if (intent === null) return 'no account may take the review; the next pass tries again';
        return startReviewer(run, intent, action.deltaFrom);
      case 'arm': {
        // Arm only the reviewed commit, re-checked now: the forge's head, then
        // under the lock the last reported push and the verdict, so a push
        // reported since the decision refuses the arm. The forge refuses it
        // too once the head is any other commit (--match-head-commit).
        const n = action.pr.number;
        const status = await deps.forge.prStatus(n);
        let reserved = false;
        if (status.state === 'open' && status.headSha === action.sha) {
          reserved = await supervisorWrite(run.issueId, (r) =>
            r.drain.pr?.number === n &&
            r.drain.verdict === 'clean' &&
            r.drain.reviewedSha === action.sha &&
            r.drain.pushedSha === action.sha
              ? {
                  ...r,
                  drain: {
                    ...r.drain,
                    pr: { ...r.drain.pr, armed: true, disarmedForReview: false },
                  },
                }
              : undefined
          );
        }
        if (!reserved) {
          return `did not arm #${n}: ${short(action.sha)} is no longer the reviewed head`;
        }
        try {
          await deps.forge.arm(n, action.sha);
        } catch (error) {
          await supervisorWrite(run.issueId, (r) =>
            r.drain.pr?.number === n
              ? {
                  ...r,
                  drain: {
                    ...r.drain,
                    pr: { ...r.drain.pr, armed: false, disarmedForReview: true },
                  },
                }
              : undefined
          );
          return `did not arm #${n} at ${short(action.sha)}: ${(error as Error).message}`;
        }
        return `armed #${n} at ${short(action.sha)}`;
      }
      case 'disarm': {
        await deps.forge.disarm(action.pr.number);
        // Recorded, so a clean review of what comes next re-arms it.
        await supervisorWrite(run.issueId, (r) =>
          r.drain.pr?.number === action.pr.number
            ? {
                ...r,
                drain: {
                  ...r.drain,
                  pr: { ...r.drain.pr, armed: false, disarmedForReview: true },
                },
              }
            : undefined
        );
        return describe(action, null);
      }
      case 'park':
        if (action.trackerWrite) await deps.park(run.identifier, action.reason);
        return describe(action, null);
      default:
        deps.warn(
          `${run.identifier}: flow does not know the action "${(action as { kind: string }).kind}" yet`
        );
        return (action as { kind: string }).kind;
    }
  };

  /** One run's whole pass: settle, gather, decide, record, act. */
  const passRun = async (initial: DrainRun): Promise<void> => {
    await settleReviewerIntent(initial);
    const fresh = current(initial.issueId);
    if (!fresh || !isTracked(fresh)) return;
    const run = fresh;
    considered.add(`${run.runtime ?? 'claude-code'}:${run.account ?? 'default'}`);

    const { facts, offsets } = await gather(run);
    const handed = handoffStep(run, facts, now);
    const step = drainStep(handed.run, facts, stepCfg, now);
    const actions = [...handed.actions, ...step.actions].sort(
      (a, b) => actionRank(a) - actionRank(b)
    );

    if (actions.some((action) => action.kind === 'adopt-or-release')) {
      await adoptOrRelease(run);
      return;
    }
    const decided = step.run.drain as DrainState;
    const offsetsChanged = offsets.worker !== undefined || offsets.reviewer !== undefined;
    if (
      actions.length === 0 &&
      !offsetsChanged &&
      same(decided, run.drain) &&
      same(step.run.limit, run.limit)
    ) {
      return;
    }
    if (deps.dryRun) {
      note(
        { ...run, drain: decided },
        run.identifier,
        `would: ${actions.map((a) => describe(a, null)).join('; ') || 'record the new state'}`
      );
      return;
    }

    const start = actions.find(
      (action): action is Extract<DrainAction, { kind: 'start-reviewer' }> =>
        action.kind === 'start-reviewer'
    );
    const intent = start === undefined ? null : await reviewerIntent(run, start.sha);

    // The compare-and-set: the decision stands only if no report landed since the gather.
    const gathered = run.drain.rev;
    let outcome = 'gone' as 'written' | 'dropped' | 'gone';
    const result = await deps.store.updateRun(run.issueId, (latest) => {
      if (!writable(latest)) {
        outcome = 'gone';
        return latest;
      }
      if (latest.drain.rev !== gathered) {
        outcome = 'dropped';
        return latest;
      }
      outcome = 'written';
      const drain: DrainState = {
        ...decided,
        // Report-owned fields come from disk (equal, since rev did not move).
        pushedSha: latest.drain.pushedSha,
        verdict: latest.drain.verdict,
        reviewedSha: latest.drain.reviewedSha,
        reviewRound: latest.drain.reviewRound,
        pr: latest.drain.pr,
        worker:
          decided.worker !== null && offsets.worker !== undefined
            ? { ...decided.worker, logOffset: offsets.worker }
            : decided.worker,
        reviewer:
          intent !== null
            ? intent.handle
            : decided.reviewer !== null && offsets.reviewer !== undefined
              ? { ...decided.reviewer, logOffset: offsets.reviewer }
              : decided.reviewer,
        rev: latest.drain.rev + 1,
        // A new park is timed, so only a reply after it answers it.
        ...(decided.phase === 'parked' && latest.drain.phase !== 'parked'
          ? { parkedAt: now.toISOString() }
          : {}),
      };
      const next: FlowRun = { ...latest, drain };
      if (step.run.limit === undefined) delete next.limit;
      else next.limit = step.run.limit;
      return next;
    });
    if (result.status === 'dropped') outcome = 'dropped';
    if (outcome !== 'written') {
      if (outcome === 'dropped') {
        note(run, run.identifier, 'a report landed during the pass; deciding again next pass');
      }
      return;
    }

    const phrases: string[] = [];
    for (const action of actions) {
      try {
        phrases.push(await apply(run, action, intent));
      } catch (error) {
        phrases.push(`${action.kind} failed: ${(error as Error).message}`);
      }
    }
    if (phrases.length > 0) note(current(run.issueId), run.identifier, phrases.join('; '));
  };

  // 1-3: every active drain run.
  for (const run of Object.values(deps.store.read())) {
    if (!isTracked(run)) continue;
    try {
      await passRun(run);
    } catch (error) {
      deps.warn(`${run.identifier}: this pass skipped it: ${(error as Error).message}`);
    }
  }

  // 4: fill slots.
  const runs = Object.values(deps.store.read());
  const liveRuns = runs.filter(isActive);
  let live = 0;
  for (const run of liveRuns) {
    for (const handle of [run.drain.worker, run.drain.reviewer]) {
      if (handle === null) continue;
      const state = handle.pending ? null : await stateOf(handle);
      if (state?.kind !== 'exited') live += 1;
    }
  }
  const budget = launchBudget({
    ...deps.load(),
    live,
    parallel: deps.settings.parallel,
    maxLoadPerCpu: deps.settings.maxLoadPerCpu,
  });
  let nothingEligible = false;
  if (budget.slots > 0) {
    const plan = await deps.plan(budget.slots);
    for (const key of plan.considered) considered.add(key);
    nothingEligible = plan.picks.length === 0;
    if (plan.noAccount !== null) deps.warn(plan.noAccount);
    for (const pick of plan.picks) {
      if (pick.account === null) {
        note(undefined, pick.identifier, 'skipped: no account may take work');
        continue;
      }
      if (deps.dryRun) {
        note(
          undefined,
          pick.identifier,
          `would claim on ${pick.account.label ?? pick.account.id} (${await deps.hostFor(pick.account.runtime)})`
        );
        continue;
      }
      try {
        await launchWorker(pick, pick.account);
      } catch (error) {
        note(undefined, pick.identifier, `not started: ${(error as Error).message}`);
      }
    }
  }

  // Usage snapshots, at most once per interval per account.
  let usageSampled: string[] = [];
  if (!deps.dryRun && considered.size > 0) {
    const { due, next } = dueForSnapshot(
      readUsageSampleState(deps.mainCheckout),
      [...considered],
      now
    );
    if (due.length > 0) {
      deps.journalUsage(due);
      writeUsageSampleState(deps.mainCheckout, next);
    }
    usageSampled = due;
  }

  const after = Object.values(deps.store.read()).filter(isActive).length;
  return {
    events,
    active: after,
    nothingEligible,
    held: budget.reason === 'machine-busy' ? 'machine-busy' : null,
    usageSampled,
  };

  /** Provision, brief, claim queued, start, record running (§4.2 step 4). */
  async function launchWorker(pick: PlannedPick, account: PlannedAccount): Promise<void> {
    const host = await deps.hostFor(account.runtime);
    const sessionId = mintId();
    const branch = branchFor(pick.identifier, pick.title);
    const { path: worktree } = await provisionWorktree(deps.runProcess, {
      mainCheckout: deps.mainCheckout,
      target: path.join(workspacesDir(deps.dorkHome, deps.repoName), branch),
      branch,
    });
    ensureCheckpointExcludes(worktree);
    const promptFile = path.join(worktree, WORKER_BRIEF_PATH);
    mkdirSync(path.dirname(promptFile), { recursive: true });
    writeFileSync(
      promptFile,
      renderBrief(deps.flowRoot, 'worker', {
        identifier: pick.identifier,
        title: pick.title,
        worktree,
        branch,
        flow: deps.flow,
        accountLabel: account.label ?? (account.path === null ? 'the ambient account' : account.id),
        rubric: deps.settings.rubric,
      })
    );
    const intent: DrainWorkerHandle = {
      host,
      runtime: account.runtime,
      sessionId,
      account: account.implicit ? null : account.id,
      cwd: worktree,
      pending: true,
      pendingSince: now.toISOString(),
    };
    await deps.claim({
      identifier: pick.identifier,
      sessionId,
      worktreePath: worktree,
      branch,
      ...(account.implicit ? {} : { account: account.id }),
      host,
      runtime: account.runtime,
      drain: {
        v: 1,
        rev: 0,
        phase: 'working',
        worker: intent,
        reviewer: null,
        pushedSha: null,
        reviewedSha: null,
        verdict: null,
        reviewRound: 0,
        pr: null,
        rearmedFor: null,
        nudges: 0,
        wakeAfter: null,
        handoffs: [],
        parkedReason: null,
      },
    });
    const issueId = Object.values(deps.store.read()).find(
      (run) => run.identifier === pick.identifier && run.sessionId === sessionId
    )?.issueId;
    let handle: SessionHandle;
    try {
      handle = await deps.launcher(host).start({
        role: 'worker',
        runtime: account.runtime,
        identifier: pick.identifier,
        account: launchAccount(account),
        cwd: worktree,
        promptFile,
        sessionId,
        ...(deps.settings.workerModel ? { model: deps.settings.workerModel } : {}),
        permissionMode: deps.settings.permissionMode,
        title: `${pick.identifier} worker`,
      });
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      await deps.release(pick.identifier);
      note(
        undefined,
        pick.identifier,
        `did not start (${error.code}: ${error.message}); released to ready`
      );
      return;
    }
    if (issueId !== undefined) {
      await supervisorWrite(issueId, (r) =>
        r.drain.worker?.sessionId === sessionId
          ? {
              ...r,
              status: 'running',
              sessionId: handle.sessionId,
              workerPid: handle.pid ?? -1,
              host,
              runtime: account.runtime,
              ...(account.implicit ? {} : { account: account.id }),
              drain: { ...r.drain, worker: handle },
            }
          : undefined
      );
    }
    note(
      issueId === undefined ? undefined : current(issueId),
      pick.identifier,
      `claimed on ${account.label ?? account.id} (${host})`
    );
  }
}
