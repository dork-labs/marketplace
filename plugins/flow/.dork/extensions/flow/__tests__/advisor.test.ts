/**
 * Flow's account advisor (spec `claude-account-ui` §8.4): ranking for agents,
 * relay and people; the plan when a flow run runs out; the single-writer calls
 * (`claims`, `move`, `wait`, `cancelAuto`); and the carry-over seed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NODE_MESSAGE,
  TOO_SLOW_MESSAGE,
  type ExecError,
  type ExecFileLike,
  type FlowAdvisor,
} from '../lib/advisor.ts';
import { ledgerWindowsFor } from '../lib/fleet.ts';
import { SEED_CONTEXT_MAX_LENGTH, type AdvisorContext } from '../lib/host-types.ts';
import { createFlowExtension } from '../server.ts';
import {
  REPO,
  fakeCtx,
  fakeRouter,
  makeWorld,
  readStore,
  runRecord,
  storePath,
  writeFleet,
  writeLedger,
  writeRuns,
  type World,
} from './fixtures.ts';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const OBSERVED = '2026-09-27T11:00:00.000Z';
const IN_FIVE_DAYS = '2026-10-02T12:00:00.000Z';

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

/** One recorded `execFile` call. */
interface ExecCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
  callback: (error: ExecError | null, stdout: string, stderr: string) => void;
}

/**
 * A fake `execFile`: `node --version` answers `version` (or fails with
 * `versionError`); every other call is recorded and left pending unless
 * `onHandoff` settles it.
 */
function fakeExec(
  opts: {
    version?: string;
    versionError?: ExecError;
    onHandoff?: (call: ExecCall) => void;
  } = {}
) {
  const calls: ExecCall[] = [];
  const execFile: ExecFileLike = (file, args, options, callback) => {
    const call = { file, args, options: options as Record<string, unknown>, callback };
    calls.push(call);
    if (args[0] === '--version') {
      if (opts.versionError) callback(opts.versionError, '', '');
      else callback(null, `${opts.version ?? 'v22.12.0'}\n`, '');
      return;
    }
    opts.onHandoff?.(call);
  };
  return { execFile, calls, handoffs: () => calls.filter((c) => c.args[0] !== '--version') };
}

/** Build the extension and return its advisor. */
function setup(
  opts: {
    exec?: ReturnType<typeof fakeExec>;
    storage?: { data: unknown };
    origin?: string | null;
    clockMs?: () => number;
    pidAlive?: (pid: number) => boolean;
  } = {}
) {
  const exec = opts.exec ?? fakeExec();
  const host = fakeCtx(world, { storage: opts.storage });
  const log = vi.fn();
  const ext = createFlowExtension(fakeRouter(), host.ctx, {
    now: () => NOW,
    execFile: exec.execFile,
    originOf: () => (opts.origin === undefined ? `https://github.com/${REPO}.git` : opts.origin),
    log,
    clockMs: opts.clockMs,
    pidAlive: opts.pidAlive,
  });
  const advisor = ext.advisor as FlowAdvisor;
  return { advisor, host, exec, log, ext };
}

/** A ranking context. */
function rankCtx(overrides: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    purpose: 'continue',
    caller: 'person',
    cwd: world.worktree,
    runtime: 'claude-code',
    ...overrides,
  };
}

/** The candidates DorkOS offers: Claude Code's registered accounts. */
const CANDIDATES = ['work', 'personal'].map((id) => ({
  id,
  label: null,
  color: '#000000',
  usage: {} as never,
}));

/** A session on the fixture run. */
function flowSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's-old',
    cwd: world.worktree,
    runtime: 'claude-code',
    accountId: 'work',
    ...overrides,
  };
}

describe('the advisor is registered', () => {
  it('registers once and removes itself on dispose', () => {
    const { host, ext } = setup();
    expect(host.accounts.registerAdvisor).toHaveBeenCalledTimes(1);
    expect(host.registered[0]).toBe(ext.advisor);
    ext.dispose();
    expect(host.unregister).toHaveBeenCalledTimes(1);
    // The watcher's schedule and the Flow tab's model poll.
    expect(host.cancelSchedule).toHaveBeenCalledTimes(2);
  });
});

describe('rank for agents and relay', () => {
  it.each(['agent', 'relay'] as const)(
    'offers no account the operator did not opt in (%s, no fleet.json)',
    async (caller) => {
      const { advisor } = setup();
      const ranking = await advisor.rank(CANDIDATES, rankCtx({ caller, purpose: 'launch' }));
      expect(ranking.accounts.filter((a) => a.eligible)).toEqual([]);
      expect(ranking.recommendedId).toBeNull();
    }
  );

  it('makes an account in the rotation eligible', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:personal': { role: 'rotation' } } });
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx({ caller: 'agent', purpose: 'launch' }));
    expect(ranking.accounts).toEqual([
      { id: 'personal', eligible: true, reason: 'Usage unknown', badge: 'recommended' },
    ]);
    expect(ranking.recommendedId).toBe('personal');
  });
});

describe('rank for a person', () => {
  it('hides nothing on a person’s own session with no fleet.json', async () => {
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx({ sessionId: 'someone-else' }));
    expect(ranking.accounts.map((a) => [a.id, a.eligible])).toEqual([
      ['personal', true],
      ['work', true],
    ]);
  });

  it('hides an account explicitly kept out of this repo, but not one scoped to it', async () => {
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'kept-out', scope: { repos: ['other/repo'] } },
        'claude-code:personal': { role: 'kept-out', scope: { repos: [REPO] } },
      },
    });
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx());
    expect(ranking.accounts.map((a) => a.id)).toEqual(['personal']);
  });

  it('hides every account flow could not move a flow run to', async () => {
    writeRuns(world, { i1: runRecord(world) });
    writeFleet(world.dorkHome, { accounts: { 'claude-code:personal': { role: 'rotation' } } });
    const { advisor } = setup();
    // work has no fleet.json entry: kept out for flow, so hidden on its run.
    const ranking = await advisor.rank(CANDIDATES, rankCtx({ sessionId: 's-old' }));
    expect(ranking.accounts.map((a) => a.id)).toEqual(['personal']);
  });

  it('keeps main in reserve outside its spend-down window, with its reserve', async () => {
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'main' },
        'claude-code:personal': { role: 'rotation' },
      },
    });
    writeLedger(
      world.dorkHome,
      'claude-code',
      'work',
      { seven_day: { usedPct: 10, resetsAt: IN_FIVE_DAYS } },
      OBSERVED
    );
    writeLedger(
      world.dorkHome,
      'claude-code',
      'personal',
      { seven_day: { usedPct: 42, resetsAt: IN_FIVE_DAYS } },
      OBSERVED
    );
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx());
    expect(ranking.accounts).toEqual([
      { id: 'personal', eligible: true, reason: '58% of the week left', badge: 'recommended' },
      { id: 'work', eligible: false, reason: 'kept in reserve (50%)', badge: 'reserved' },
    ]);
    expect(ranking.recommendedId).toBe('personal');
  });

  it('offers main when it is the only account with room', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:work': { role: 'main' } } });
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx({ caller: 'agent' }));
    expect(ranking.accounts).toEqual([
      { id: 'work', eligible: true, reason: 'Usage unknown', badge: 'recommended' },
    ]);
  });

  it('says in plain words when an account is out', async () => {
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'rotation' },
        'claude-code:personal': { role: 'rotation' },
      },
    });
    writeLedger(
      world.dorkHome,
      'claude-code',
      'work',
      { five_hour: { usedPct: 100, resetsAt: '2026-09-27T15:00:00.000Z', status: 'rejected' } },
      OBSERVED
    );
    const { advisor } = setup();
    const ranking = await advisor.rank(CANDIDATES, rankCtx());
    const work = ranking.accounts.find((a) => a.id === 'work');
    expect(work?.eligible).toBe(false);
    expect(work?.reason).toMatch(
      /^Out until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}(:\d{2})?(am|pm)$/
    );
    expect(ranking.accounts[0]).toMatchObject({ id: 'personal', badge: 'recommended' });
  });

  it('adds other runtimes after its own only when cross-runtime fallback is on', async () => {
    const { advisor } = setup();
    const off = await advisor.rank(CANDIDATES, rankCtx());
    expect(off.accounts.some((a) => a.runtime === 'codex')).toBe(false);
    writeFleet(world.dorkHome, { crossRuntimeFallback: 'on' });
    const on = await advisor.rank(CANDIDATES, rankCtx());
    expect(on.accounts.map((a) => [a.runtime ?? 'claude-code', a.id])).toEqual([
      ['claude-code', 'personal'],
      ['claude-code', 'work'],
      ['codex', 'default'],
    ]);
  });
});

describe('onLimited', () => {
  const limited = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's-old',
    cwd: world.worktree,
    accountId: 'work',
    window: 'seven_day',
    resetsAt: null as string | null,
    scope: 'account' as const,
    model: null,
    ...overrides,
  });

  it('hands a flow run off after 10 seconds when handoff is auto', async () => {
    writeRuns(world, { i1: runRecord(world) });
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'rotation' },
        'claude-code:personal': { role: 'rotation' },
      },
    });
    const { advisor } = setup();
    expect(await advisor.onLimited!(limited())).toEqual({
      mode: 'auto',
      target: 'personal',
      delaySeconds: 10,
    });
  });

  it('waits when the reset is under an hour away and nothing may take it', async () => {
    writeRuns(world, { i1: runRecord(world) });
    writeFleet(world.dorkHome, { handoff: 'ask' });
    const { advisor } = setup();
    expect(await advisor.onLimited!(limited({ resetsAt: '2026-09-27T12:30:00.000Z' }))).toEqual({
      mode: 'wait',
    });
    expect(await advisor.onLimited!(limited({ resetsAt: '2026-09-27T15:00:00.000Z' }))).toEqual({
      mode: 'ask',
    });
  });

  it('asks for a session that is not a flow run', async () => {
    writeFleet(world.dorkHome, {
      accounts: { 'claude-code:personal': { role: 'rotation' } },
    });
    const { advisor } = setup();
    expect(await advisor.onLimited!(limited({ sessionId: 'not-flow' }))).toEqual({ mode: 'ask' });
  });
});

describe('claims', () => {
  it('claims a flow run and nothing else', async () => {
    writeRuns(world, { i1: runRecord(world) });
    const { advisor } = setup();
    expect(await advisor.claims!(flowSession())).toBe(true);
    expect(await advisor.claims!(flowSession({ sessionId: 'not-flow' }))).toBe(false);
    expect(await advisor.claims!(flowSession({ cwd: world.root }))).toBe(false);
  });

  it('leaves an interactive flow run (no drain) to DorkOS like any session', async () => {
    // `flow claim` in a person's own session: flow's supervisor never moves it.
    writeRuns(world, { i1: runRecord(world, { drain: undefined }) });
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'rotation' },
        'claude-code:personal': { role: 'rotation' },
      },
    });
    const { advisor } = setup();
    expect(await advisor.claims!(flowSession())).toBe(false);
    expect(
      await advisor.onLimited!({
        sessionId: 's-old',
        cwd: world.worktree,
        accountId: 'work',
        window: 'seven_day',
        resetsAt: null,
        scope: 'account',
        model: null,
      })
    ).toEqual({ mode: 'ask' });
    await expect(advisor.wait!(flowSession(), null, true)).rejects.toThrow(/not a flow drain run/);
  });
});

describe('move', () => {
  beforeEach(() => {
    writeRuns(world, { i1: runRecord(world) });
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:work': { role: 'rotation' },
        'claude-code:personal': { role: 'rotation' },
      },
    });
  });

  const target = { runtime: 'claude-code', accountId: 'personal' };

  it('accepts within 2 s and runs flow handoff in the background, with no shell', async () => {
    const exec = fakeExec();
    const { advisor } = setup({ exec });
    const started = Date.now();
    await advisor.move!(flowSession(), target);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exec.handoffs()).toHaveLength(1);
    const call = exec.handoffs()[0];
    const flowRoot = path.join(world.root, 'plugins', 'flow');
    expect(call.file).toBe('node');
    expect(call.args).toEqual([
      '--experimental-strip-types',
      path.join(flowRoot, 'scripts', 'flow.ts'),
      'handoff',
      'ACME-1',
      '--to',
      'claude-code:personal',
      '--project',
      world.main,
      '--json',
    ]);
    expect(call.options).toMatchObject({ timeout: 120_000, shell: false });
    expect(advisor.inFlight.has('s-old')).toBe(true);
  });

  it.each([
    ['at the first check', 1],
    ['only at the last moment before starting', 4],
  ])(
    'never starts the handoff once its checks ran past the deadline (%s)',
    async (_name, onTime) => {
      // DorkOS answers 503 at 2 s; a move started after that would be a second writer.
      // The clock reads 0 for the first `onTime` reads, then 5 s.
      const exec = fakeExec();
      let reads = 0;
      const { advisor } = setup({ exec, clockMs: () => (reads++ < onTime ? 0 : 5_000) });
      await expect(advisor.move!(flowSession(), target)).rejects.toThrow(TOO_SLOW_MESSAGE);
      expect(exec.handoffs()).toHaveLength(0);
      expect(advisor.inFlight.size).toBe(0);
    }
  );

  it('refuses, as flow handoff does, while a drain runs and the run is not limited', async () => {
    mkdirSync(path.join(world.main, '.dork', 'flow'), { recursive: true });
    writeFileSync(
      path.join(world.main, '.dork', 'flow', 'drain.lock'),
      JSON.stringify({ pid: 4242 })
    );
    const exec = fakeExec();
    const { advisor } = setup({ exec, pidAlive: (pid) => pid === 4242 });
    await expect(advisor.move!(flowSession(), target)).rejects.toThrow(
      'a flow drain (pid 4242) is running and ACME-1 is not limited'
    );
    expect(exec.handoffs()).toHaveLength(0);
  });

  it("ranks with the project's drain settings (an account at its live cap)", async () => {
    mkdirSync(path.join(world.main, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(world.main, '.agents', 'flow', 'config.json'),
      JSON.stringify({ drain: { maxLivePerAccount: 1 } })
    );
    writeRuns(world, {
      i1: runRecord(world),
      i2: {
        ...runRecord(world),
        issueId: 'i2',
        identifier: 'ACME-2',
        sessionId: 's-2',
        account: 'personal',
      },
    });
    const exec = fakeExec();
    const { advisor } = setup({ exec });
    await expect(advisor.move!(flowSession(), target)).rejects.toThrow(
      'claude-code:personal may not take ACME-1: at-capacity'
    );
    expect(exec.handoffs()).toHaveLength(0);
  });

  it('refuses an unknown run before starting anything', async () => {
    const exec = fakeExec();
    const { advisor } = setup({ exec });
    await expect(advisor.move!(flowSession({ sessionId: 'nope' }), target)).rejects.toThrow(
      /not a flow run/
    );
    expect(exec.handoffs()).toHaveLength(0);
  });

  it('refuses a target flow may not use, with flow’s reason', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:work': { role: 'rotation' } } });
    const exec = fakeExec();
    const { advisor } = setup({ exec });
    await expect(advisor.move!(flowSession(), target)).rejects.toThrow(
      'claude-code:personal may not take ACME-1: out-of-scope'
    );
    expect(exec.handoffs()).toHaveLength(0);
  });

  it.each([
    [
      'missing',
      { versionError: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) },
    ],
    ['too old', { version: 'v22.5.1' }],
  ])('refuses when node is %s, before starting anything', async (_name, opts) => {
    const exec = fakeExec(opts);
    const { advisor } = setup({ exec });
    await expect(advisor.move!(flowSession(), target)).rejects.toThrow(NODE_MESSAGE);
    expect(exec.handoffs()).toHaveLength(0);
  });

  it('reports the new session exactly once when flow handoff exits 0', async () => {
    const exec = fakeExec({
      onHandoff: (call) => {
        writeRuns(world, { i1: runRecord(world, { sessionId: 's-new', account: 'personal' }) });
        call.callback(null, '{"v":1}', '');
      },
    });
    const { advisor, host, ext } = setup({ exec });
    await advisor.move!(flowSession(), target);
    await advisor.inFlight.get('s-old');
    await ext.watcher!.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(1);
    expect(host.accounts.markContinued).toHaveBeenCalledWith('s-old', {
      sessionId: 's-new',
      runtime: 'claude-code',
      accountId: 'personal',
    });
  });

  it('reports a session a timed-out handoff still wrote, once the move ends', async () => {
    // The watcher must not settle on the store while the move is in flight.
    let pending: ExecCall | undefined;
    const exec = fakeExec({ onHandoff: (call) => (pending = call) });
    const { advisor, host, ext } = setup({ exec });
    await advisor.move!(flowSession(), target);
    writeRuns(world, { i1: runRecord(world, { sessionId: 's-new', account: 'personal' }) });
    await ext.watcher!.check();
    expect(host.accounts.markContinued).not.toHaveBeenCalled();
    pending!.callback(Object.assign(new Error('killed'), { killed: true }), '', '');
    await advisor.inFlight.get('s-old');
    await ext.watcher!.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(1);
    expect(host.accounts.markContinued).toHaveBeenCalledWith('s-old', {
      sessionId: 's-new',
      runtime: 'claude-code',
      accountId: 'personal',
    });
  });

  it.each([
    ['a non-zero exit', Object.assign(new Error('exit 5: no account may take it'), { code: 5 })],
    ['a timeout', Object.assign(new Error('killed'), { killed: true })],
  ])('reports nothing after %s', async (_name, error) => {
    const exec = fakeExec({ onHandoff: (call) => call.callback(error, '', '') });
    const { advisor, host, log } = setup({ exec });
    await advisor.move!(flowSession(), target);
    await advisor.inFlight.get('s-old');
    expect(host.accounts.markContinued).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not move ACME-1'));
  });
});

describe('wait and cancelAuto hold the run for the person', () => {
  const limit = {
    level: 'exhausted',
    account: 'work',
    window: 'seven_day',
    resetsAt: '2026-09-28T00:00:00.000Z',
    cause: 'limit',
    since: '2026-09-27T11:00:00.000Z',
    state: 'awaiting-handoff',
    handoffToken: null,
    handingOffAt: null,
    handoffSessionId: null,
    notifiedAt: null,
  };

  beforeEach(() => {
    writeRuns(world, {
      i1: runRecord(world, { limit }),
      i2: { ...runRecord(world), issueId: 'i2', identifier: 'ACME-2', sessionId: 's-2' },
    });
  });

  it('wait writes waiting-reset and resumeOnReset under the lock', async () => {
    const { advisor } = setup();
    await advisor.wait!(flowSession(), '2026-09-28T00:00:00.000Z', true);
    const store = readStore(world);
    expect(store.i1.limit).toEqual({
      ...limit,
      state: 'waiting-reset',
      heldBy: 'person',
      heldUntil: '2026-09-28T00:00:00.000Z',
      resumeOnReset: true,
    });
    expect(store.i1.drain).toEqual({
      v: 1,
      rev: 4,
      wakeAfter: '2026-09-28T00:00:00.000Z',
      keepMe: true,
    });
    expect(store.i2.sessionId).toBe('s-2');
    // Every writer stamps the write time (spec flow-multiproject §6.3), and
    // only on the run it wrote.
    expect(typeof store.i1.updatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(store.i1.updatedAt as string))).toBe(true);
    expect(store.i2.updatedAt).toBeUndefined();
  });

  it('cancelAuto holds the run with no resume', async () => {
    const { advisor } = setup();
    await advisor.cancelAuto!(flowSession());
    expect(readStore(world).i1.limit).toMatchObject({
      state: 'waiting-reset',
      heldBy: 'person',
      heldUntil: null,
      resumeOnReset: false,
    });
  });

  it.each(['wait', 'cancelAuto'] as const)('%s throws when the lock never frees', async (verb) => {
    writeFileSync(`${storePath(world)}.lock`, 'someone-else');
    const { advisor } = setup();
    const call =
      verb === 'wait'
        ? advisor.wait!(flowSession(), null, false)
        : advisor.cancelAuto!(flowSession());
    await expect(call).rejects.toThrow(/Could not lock/);
    expect(readStore(world).i1.limit).toEqual(limit);
  });
});

describe('carryOver', () => {
  const info = (sessionId = 's-old') => ({
    sessionId,
    cwd: world.worktree,
    accountId: 'work',
    window: 'seven_day',
    resetsAt: null,
    scope: 'account' as const,
    model: null,
  });

  /** Write the run's HANDOFF.md. */
  function checkpoint(body: string): void {
    mkdirSync(path.join(world.worktree, '.dork', 'flow'), { recursive: true });
    writeFileSync(path.join(world.worktree, '.dork', 'flow', 'HANDOFF.md'), body);
  }

  beforeEach(() => {
    writeRuns(world, { i1: runRecord(world) });
  });

  it('seeds from HANDOFF.md with the item, and resumes from the handoff', async () => {
    checkpoint('## Done\nThe parser.\n');
    const { advisor } = setup();
    const seed = await advisor.carryOver!(info(), 'personal');
    expect(seed.seedContext).toContain('Flow item ACME-1');
    expect(seed.seedContext).toContain('## Done\nThe parser.');
    expect(seed.prompt).toContain(`You are continuing ACME-1 in this worktree (${world.worktree})`);
  });

  it('bounds the seed to the host’s limit', async () => {
    checkpoint('x'.repeat(SEED_CONTEXT_MAX_LENGTH * 2));
    const { advisor } = setup();
    const seed = await advisor.carryOver!(info(), 'personal');
    expect(seed.seedContext.length).toBe(SEED_CONTEXT_MAX_LENGTH);
  });

  it('throws without a checkpoint, and for a session that is not a flow run', async () => {
    const { advisor } = setup();
    expect(() => advisor.carryOver!(info(), 'personal')).toThrow(/has no checkpoint/);
    expect(() => advisor.carryOver!(info('not-flow'), 'personal')).toThrow(/not a flow run/);
  });
});

describe('ledgerWindowsFor', () => {
  it('reads a ledger from the DorkOS home, and null when there is none', () => {
    writeLedger(
      world.dorkHome,
      'codex',
      'default',
      { five_hour: { usedPct: 5, resetsAt: null } },
      OBSERVED
    );
    expect(ledgerWindowsFor(world.dorkHome, 'codex', 'default')).toMatchObject({
      five_hour: { usedPct: 5 },
    });
    expect(ledgerWindowsFor(world.dorkHome, 'claude-code', 'work')).toBeNull();
  });
});
