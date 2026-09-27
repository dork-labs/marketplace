/**
 * The handoff's I/O (spec `flow-handoff-dispatch` §5.3, §4.3), against an
 * in-memory run store and a scripted launcher: `executeHandoff`'s guards (one
 * writer per worktree, a person's hold, a pass adopting the new session
 * mid-start, the re-stamped mark) and `adoptOrRevertHandoff`'s three outcomes.
 * Nothing here starts a process or touches a transcript.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptOrRevertHandoff,
  executeHandoff,
  limitLine,
  type HandoffExecDeps,
} from '../../scripts/drain/handoff-exec.ts';
import type { DrainState, RunLimit } from '../../scripts/drain/state.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { FlowStateFile } from '../../scripts/flow-state-file.ts';
import type {
  HostName,
  Launcher,
  LaunchRequest,
  SessionHandle,
  SessionState,
} from '../../scripts/launchers/types.ts';

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const TO = { runtime: 'claude-code' as const, id: 'claude4' };

let clock: number;
let worktree: string;
let runs: Record<string, FlowRun>;

/** A run store in memory, with the same update semantics as the real one. */
function memoryStore(): FlowStateFile {
  return {
    path: '/memory/flow-state.json',
    read: () => structuredClone(runs),
    async updateRun(issueId: string, update: (run: FlowRun) => FlowRun) {
      const run = runs[issueId];
      if (run !== undefined) runs[issueId] = structuredClone(update(structuredClone(run)));
      return { status: 'written', warnings: [] };
    },
  } as unknown as FlowStateFile;
}

/** What the scripted launcher saw and does. */
interface Script {
  starts: LaunchRequest[];
  stops: SessionHandle[];
  /** The old session's state after its stop. */
  after: SessionState['kind'];
  /** Throw from stop. */
  stopThrows?: boolean;
  /** Throw from start. */
  startThrows?: boolean;
  /** Called inside start, after the session "exists". */
  onStart?: (req: LaunchRequest) => void;
}

let script: Script;

/** A launcher per host that records every call. */
function launcher(host: HostName): Launcher {
  return {
    host,
    supports: () => ({ ok: true }),
    probe: async () => ({ ok: true }),
    async start(req) {
      if (script.startThrows) throw new Error('no claude binary');
      script.starts.push(req);
      script.onStart?.(req);
      return {
        host,
        runtime: req.runtime,
        sessionId: req.sessionId,
        account: 'claude4',
        cwd: req.cwd,
      };
    },
    async send(h) {
      return { result: 'delivered', handle: h };
    },
    async state() {
      return script.after === 'exited'
        ? { kind: 'exited', code: 0 }
        : script.after === 'limited'
          ? { kind: 'limited', window: null, resetsAt: null }
          : script.after === 'unknown'
            ? { kind: 'unknown', reason: 'x' }
            : { kind: script.after };
    },
    async stop(h) {
      script.stops.push(h);
      if (script.stopThrows) throw new Error('permission denied');
      return host === 'dorkos' ? 'left-idle' : 'stopped';
    },
  };
}

/** The world a handoff touches, with a finder that answers `found`. */
function deps(found: SessionHandle | null = null, parks: string[] = []): HandoffExecDeps {
  return {
    store: memoryStore(),
    launcher,
    now: () => new Date(clock),
    flow: 'flow',
    startTimeoutMs: 90_000,
    permissionMode: 'acceptEdits',
    workerModel: null,
    mintId: () => 'new-session',
    mintToken: () => 'token-1',
    ensureCheckpoint: async () => undefined,
    transcriptFor: () => null,
    park: async (_id, reason) => {
      parks.push(reason);
    },
    findSession: async () => found,
    resolveAccount: async (ref) => ({
      runtime: ref.runtime,
      id: ref.id,
      path: `/accounts/${ref.id}`,
      implicit: false,
      label: null,
    }),
    warn: () => undefined,
  };
}

/** A limited drain run on claude3 under `host`. */
function limitedRun(host: HostName = 'cli', limit: Partial<RunLimit> = {}): FlowRun {
  const drain: DrainState = {
    v: 1,
    rev: 1,
    phase: 'working',
    worker: { host, runtime: 'claude-code', sessionId: 'old', account: 'claude3', cwd: worktree },
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
  };
  return {
    issueId: 'i-1',
    identifier: 'ACME-1',
    sessionId: 'old',
    worktreePath: worktree,
    branch: 'ACME-1-x',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 10,
    startedAt: new Date(T0).toISOString(),
    account: 'claude3',
    host,
    runtime: 'claude-code',
    drain,
    limit: {
      level: 'exhausted',
      account: 'claude3',
      window: 'five_hour',
      resetsAt: null,
      cause: 'limit',
      since: new Date(T0 - 60_000).toISOString(),
      state: 'awaiting-handoff',
      handoffToken: null,
      handingOffAt: null,
      handoffSessionId: null,
      notifiedAt: null,
      ...limit,
    },
  };
}

beforeEach(() => {
  clock = T0;
  worktree = mkdtempSync(path.join(os.tmpdir(), 'flow-handoff-exec-'));
  script = { starts: [], stops: [], after: 'exited' };
  runs = { 'i-1': limitedRun() };
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('executeHandoff: one writer per worktree', () => {
  it('moves a stopped session: stops it, sees it exited, starts the new one', async () => {
    // Purpose: the baseline every guard below departs from.
    const out = await executeHandoff(deps(), runs['i-1'], TO, 'rejected');
    expect(out.status).toBe('moved');
    expect(script.starts).toHaveLength(1);
    expect(runs['i-1']).toMatchObject({ sessionId: 'new-session', account: 'claude4' });
    expect(runs['i-1'].limit).toBeUndefined();
  });

  it.each([
    ['cli, still busy after stop', 'cli', 'busy', false],
    ['a stop that threw', 'cli', 'exited', true],
    ['DorkOS still busy (stop only leaves it idle)', 'dorkos', 'busy', false],
    ['DorkOS in an unknown state', 'dorkos', 'unknown', false],
    ['cli in an unknown state after stop', 'cli', 'unknown', false],
  ] as const)(
    '%s: reverts to awaiting-handoff and starts nothing',
    async (_n, host, after, throws) => {
      // Purpose: a second session must never start beside a live one.
      runs = { 'i-1': limitedRun(host) };
      script.after = after;
      script.stopThrows = throws;
      const out = await executeHandoff(deps(), runs['i-1'], TO, 'rejected');
      expect(out.status).toBe('failed');
      expect(script.starts).toEqual([]);
      expect(runs['i-1'].limit).toMatchObject({ state: 'awaiting-handoff', handoffToken: null });
      expect(runs['i-1'].sessionId).toBe('old');
    }
  );

  it('DorkOS idle or limited after the stop may move', async () => {
    // Purpose: DorkOS leaves the old session idle; that is stopped enough.
    for (const after of ['idle', 'limited'] as const) {
      runs = { 'i-1': limitedRun('dorkos') };
      script = { starts: [], stops: [], after };
      expect((await executeHandoff(deps(), runs['i-1'], TO, 'rejected')).status).toBe('moved');
    }
  });
});

describe("executeHandoff: a person's hold", () => {
  it('refuses an automatic move once a --wait landed after the decision, and allows --to', async () => {
    // Purpose: a person's wait outranks auto, even in the gap between decide and apply.
    const decided = limitedRun();
    runs = {
      'i-1': limitedRun('cli', { state: 'waiting-reset', heldBy: 'person', heldUntil: null }),
    };
    const auto = await executeHandoff(deps(), decided, TO, 'rejected');
    expect(auto.status).toBe('lost');
    expect(auto.line).toContain('holding it');
    expect(script.stops).toEqual([]);
    expect(script.starts).toEqual([]);
    const manual = await executeHandoff(deps(), decided, TO, 'manual');
    expect(manual.status).toBe('moved');
  });

  it('a failed --to leaves no hold behind', async () => {
    // Purpose: reverted() drops heldBy, heldUntil and resumeOnReset, so the run is not held forever.
    runs = {
      'i-1': limitedRun('cli', {
        state: 'waiting-reset',
        heldBy: 'person',
        heldUntil: null,
        resumeOnReset: false,
      }),
    };
    script.startThrows = true;
    const out = await executeHandoff(deps(), runs['i-1'], TO, 'manual');
    expect(out.status).toBe('failed');
    expect(runs['i-1'].limit?.heldBy).toBeUndefined();
    expect(runs['i-1'].limit?.heldUntil).toBeUndefined();
    expect(runs['i-1'].limit?.resumeOnReset).toBeUndefined();
    expect(runs['i-1'].limit?.state).toBe('awaiting-handoff');
  });
});

describe("limitLine for a person's hold", () => {
  const held = (extra: Partial<RunLimit>) =>
    limitedRun('cli', { state: 'waiting-reset', heldBy: 'person', heldUntil: null, ...extra })
      .limit;

  it('says a hold with automatic continue off lasts until someone continues it', () => {
    expect(limitLine(held({ resumeOnReset: false }), null)).toBe(
      'held by a person until they continue it'
    );
  });

  it.each([true, undefined])('keeps the reset wording when resumeOnReset is %s', (value) => {
    expect(limitLine(held({ resumeOnReset: value }), null)).toMatch(
      /^held by a person until the account resets/
    );
  });
});

describe('executeHandoff: the mark and a pass that adopts', () => {
  it('re-stamps handingOffAt right before the start', async () => {
    // Purpose: a slow checkpoint or stop must not make a live mover look dead.
    let seen: string | null = null;
    const d = deps();
    d.ensureCheckpoint = async () => {
      clock += 5 * 60_000;
    };
    script.onStart = () => {
      seen = runs['i-1'].limit?.handingOffAt ?? null;
    };
    await executeHandoff(d, runs['i-1'], TO, 'rejected');
    expect(seen).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });

  it('leaves a session a pass adopted mid-start running, and does not claim the move', async () => {
    // Purpose: the race path; the mover must never stop the run's own worker.
    script.onStart = (req) => {
      const r = runs['i-1'];
      runs['i-1'] = {
        ...r,
        sessionId: req.sessionId,
        account: 'claude4',
        drain: {
          ...(r.drain as DrainState),
          worker: { host: 'cli', sessionId: req.sessionId, account: 'claude4', cwd: worktree },
        },
      };
      delete runs['i-1'].limit;
    };
    const out = await executeHandoff(deps(), runs['i-1'], TO, 'rejected');
    expect(out.status).toBe('lost');
    expect(out.line).toContain('adopted');
    expect(script.stops.map((h) => h.sessionId)).toEqual(['old']);
    expect(runs['i-1'].sessionId).toBe('new-session');
  });

  it('stops the new session when the run changed hands to someone else', async () => {
    // Purpose: a session nobody points at would be a second writer later.
    script.onStart = () => {
      runs['i-1'] = { ...runs['i-1'], sessionId: 'someone-else' };
      delete runs['i-1'].limit;
    };
    const out = await executeHandoff(deps(), runs['i-1'], TO, 'rejected');
    expect(out.status).toBe('lost');
    expect(script.stops.map((h) => h.sessionId)).toEqual(['old', 'new-session']);
  });
});

describe('adoptOrRevertHandoff', () => {
  const stale = (host: HostName) =>
    limitedRun(host, {
      state: 'handing-off',
      handoffToken: 'tok',
      handingOffAt: new Date(T0 - 10 * 60_000).toISOString(),
      handoffSessionId: 'minted',
      handoffTo: 'claude-code:claude4',
      handoffReason: 'rejected',
    });

  it('adopts the session the dead mover minted and finishes the move', async () => {
    // Purpose: a started session is adopted, never orphaned into a second writer.
    runs = { 'i-1': stale('cli') };
    const found: SessionHandle = {
      host: 'cli',
      runtime: 'claude-code',
      sessionId: 'minted',
      account: 'claude4',
      cwd: worktree,
      pid: 77,
    };
    const line = await adoptOrRevertHandoff(deps(found), runs['i-1']);
    expect(line).toContain('adopted');
    expect(runs['i-1']).toMatchObject({ sessionId: 'minted', account: 'claude4', workerPid: 77 });
    expect(runs['i-1'].limit).toBeUndefined();
    expect(runs['i-1'].drain?.handoffs).toEqual([
      { from: 'claude3', to: 'claude4', at: new Date(T0).toISOString(), reason: 'rejected' },
    ]);
  });

  it('reverts to awaiting-handoff when nothing was started', async () => {
    // Purpose: the next pass may move it again.
    runs = { 'i-1': stale('cli') };
    await adoptOrRevertHandoff(deps(null), runs['i-1']);
    expect(runs['i-1'].sessionId).toBe('old');
    expect(runs['i-1'].limit).toMatchObject({ state: 'awaiting-handoff', handoffToken: null });
    expect(runs['i-1'].limit?.handoffTo).toBeUndefined();
  });

  it('parks on DorkOS, where session_start may have minted another id', async () => {
    // Purpose: "not found" proves nothing there, so a person checks.
    runs = { 'i-1': stale('dorkos') };
    const parks: string[] = [];
    const line = await adoptOrRevertHandoff(deps(null, parks), runs['i-1']);
    expect(line).toContain('parked');
    expect(parks).toHaveLength(1);
    expect(runs['i-1'].drain?.phase).toBe('parked');
    expect(runs['i-1'].limit?.handoffToken).toBeNull();
  });
});
