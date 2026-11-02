/**
 * The drain's stale-reading refresh (DOR-3704): before ranking, a Claude Code
 * account kept out only by a stale weekly reading gets one probe, at most once
 * an hour, and is ranked on what the probe saved. Anything short of a fresh
 * reading leaves it out (fail closed).
 *
 * No probe runs here: `probe` and `reread` are fakes that script what the
 * ledger holds afterwards.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { VerbContext } from '../../scripts/cli/context.ts';
import type { StreamRunner } from '../../scripts/cli/host-io.ts';
import { staleUsageRefresher } from '../../scripts/cli/usage-refresh.ts';
import { fromRateLimitEvent } from '../../scripts/fleet/observations.ts';
import { readLedger, recordUsage } from '../../scripts/fleet/usage-ledger.ts';
import { FlowConfigSchema } from '../../scripts/config-schema.ts';

import type { AssignmentInput } from '../../scripts/cli/next.ts';
import {
  refreshStaleUsage,
  REFRESH_INTERVAL_MS,
  type RefreshDeps,
} from '../../scripts/cli/usage-refresh.ts';
import { rankAccounts } from '../../scripts/drain/account-rank.ts';

const NOW = new Date('2026-09-26T16:00:00.000Z');
const POLICY = {
  role: 'rotation' as const,
  reservePct: 0,
  spendDownWindowHours: 24,
  scope: { repos: [] },
};

/** A weekly reading observed at `observedAt`, resetting well after {@link NOW}. */
function weekly(observedAt: string, usedPct = 5) {
  return {
    seven_day: {
      usedPct,
      resetsAt: '2026-10-01T16:00:00.000Z',
      status: null,
      observedAt,
      source: 'statusline',
    },
  };
}

const STALE = weekly('2026-09-24T16:00:00.000Z');
const FRESH = weekly('2026-09-26T15:59:00.000Z');

type Account = AssignmentInput['accounts'][number];

/** An account on `runtime` with `windows`. */
function account(id: string, windows: Account['windows'], over: Partial<Account> = {}): Account {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    implicit: false,
    routable: true,
    policy: POLICY,
    windows,
    label: null,
    ...over,
  } as Account;
}

/** An assignment input holding `accounts`. */
function input(accounts: Account[]): AssignmentInput {
  return {
    now: NOW,
    repo: 'acme/app',
    model: null,
    accounts,
    runtimes: ['claude-code', 'codex'],
    crossRuntimeFallback: 'off',
    runs: {},
    opts: { warnMarginPct: 10, maxLivePerAccount: 2 },
  };
}

/** Fakes: `after` is what each account's ledger holds once probed; a function throws. */
function deps(
  after: Record<string, Account['windows'] | Error>,
  tried: Record<string, string> = {}
): RefreshDeps & { probed: string[]; lines: string[]; saved: Record<string, string>[] } {
  const probed: string[] = [];
  const lines: string[] = [];
  const saved: Record<string, string>[] = [];
  const done = new Set<string>();
  return {
    probed,
    lines,
    saved,
    model: null,
    tried,
    saveTried: (state) => saved.push(state),
    async probe(a) {
      probed.push(a.id);
      const next = after[a.id];
      if (next instanceof Error) throw next;
      done.add(a.id);
    },
    reread: (a) => {
      const next = after[a.id];
      return done.has(a.id) && !(next instanceof Error) ? (next ?? null) : null;
    },
    report: (line) => lines.push(line),
  };
}

/** The ids `rankAccounts` would give work to, for a claude-code item. */
function eligible(i: AssignmentInput): string[] {
  return rankAccounts({
    now: i.now,
    repo: i.repo,
    accounts: i.accounts,
    runtime: 'claude-code',
    runtimes: i.runtimes,
    crossRuntimeFallback: i.crossRuntimeFallback,
    model: null,
    affinity: null,
    exclude: [],
    liveByAccount: {},
    opts: i.opts,
  }).ranked.map((r) => r.id);
}

describe('refreshStaleUsage', () => {
  it('probes a stale account, and ranks it on the fresh reading the probe saved', async () => {
    const d = deps({ old: FRESH });
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(d.probed).toEqual(['old']);
    expect(eligible(out)).toEqual(['old']);
    expect(d.lines.join('\n')).toMatch(/refreshed the stale usage reading of old/);
  });

  it('keeps an account out when the probe saved nothing newer (still stale)', async () => {
    const d = deps({ old: STALE });
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(d.probed).toEqual(['old']);
    expect(eligible(out)).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/old.*still out of date/);
  });

  it('keeps an account out when the probe fails, and says why', async () => {
    const d = deps({ old: new Error('the probe did not finish within 90 s') });
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(eligible(out)).toEqual([]);
    expect(out.accounts[0]?.windows).toEqual(STALE);
    expect(d.lines.join('\n')).toMatch(/could not refresh.*old.*did not finish within 90 s/);
  });

  it('records the try before probing, so a failed probe still waits an hour', async () => {
    const d = deps({ old: new Error('boom') });
    await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(d.saved).toEqual([{ 'claude-code:old': NOW.toISOString() }]);
  });

  it('probes an account at most once an hour', async () => {
    const recent = new Date(NOW.getTime() - REFRESH_INTERVAL_MS + 60_000).toISOString();
    const d = deps({ old: FRESH }, { 'claude-code:old': recent });
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(d.probed).toEqual([]);
    expect(eligible(out)).toEqual([]);
    const due = new Date(NOW.getTime() - REFRESH_INTERVAL_MS).toISOString();
    const again = deps({ old: FRESH }, { 'claude-code:old': due });
    await refreshStaleUsage(input([account('old', STALE)]), again);
    expect(again.probed).toEqual(['old']);
  });

  it('never probes a fresh account, or one with no reading at all', async () => {
    const d = deps({});
    await refreshStaleUsage(input([account('fresh', FRESH), account('never', null)]), d);
    expect(d.probed).toEqual([]);
    expect(d.saved).toEqual([]);
  });

  it('never probes a stale account that is out for another reason too', async () => {
    const limited = weekly('2026-09-24T16:00:00.000Z', 100);
    const d = deps({ full: FRESH, cold: FRESH });
    await refreshStaleUsage(
      input([
        account('full', limited),
        account('cold', STALE, {
          policy: { ...POLICY, role: 'kept-out' } as unknown as Account['policy'],
        }),
      ]),
      d
    );
    expect(d.probed).toEqual([]);
  });

  it('never probes another runtime: the probe reads Claude Code only, so it stays out', async () => {
    const d = deps({ cx: FRESH });
    const out = await refreshStaleUsage(
      input([account('cx', STALE, { runtime: 'codex' } as Partial<Account>)]),
      d
    );
    expect(d.probed).toEqual([]);
    expect(out.accounts[0]?.windows).toEqual(STALE);
  });

  it.each([
    ['role main', { policy: { ...POLICY, role: 'main' } as unknown as Account['policy'] }],
    ['the account `default` names', { isDefault: true }],
    ['the implicit default id', { id: 'default' }],
    ["this computer's own sign-in", { implicit: true }],
  ])('never probes the main account (%s): it stays out while stale', async (_name, over) => {
    // Security's Must on #148: a probe would spend the owner's own sign-in unasked.
    const main = account('mine', STALE, over as Partial<Account>);
    const d = deps({ mine: FRESH, default: FRESH });
    const out = await refreshStaleUsage(input([main]), d);
    expect(d.probed).toEqual([]);
    expect(d.saved).toEqual([]);
    expect(out.accounts[0]?.windows).toEqual(STALE);
    expect(eligible(out)).toEqual([]);
  });

  it('never probes an account with no folder', async () => {
    const d = deps({ old: FRESH });
    await refreshStaleUsage(input([account('old', STALE, { path: null })]), d);
    expect(d.probed).toEqual([]);
  });

  it('probes nothing when the try cannot be recorded (the hourly limit could not hold)', async () => {
    const d = deps({ old: FRESH });
    d.saveTried = () => {
      throw new Error('disk full');
    };
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(d.probed).toEqual([]);
    expect(eligible(out)).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/could not record.*disk full/);
  });

  it('keeps an account out when its ledger cannot be read after the probe', async () => {
    const d = deps({ old: FRESH });
    d.reread = () => {
      throw new Error('EACCES');
    };
    const out = await refreshStaleUsage(input([account('old', STALE)]), d);
    expect(eligible(out)).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/could not read old.*EACCES/);
  });

  it('leaves the other accounts exactly as they were', async () => {
    const d = deps({ old: FRESH });
    const fresh = account('fresh', FRESH);
    const out = await refreshStaleUsage(input([fresh, account('old', STALE)]), d);
    expect(out.accounts[0]).toBe(fresh);
  });
});

describe('staleUsageRefresher (the real probe, ledger and tries file)', () => {
  const WIRE_NOW = new Date('2026-09-20T00:00:00.000Z');
  const RESETS = 1790400000; // 2026-09-26T05:20Z, after WIRE_NOW
  let root = '';

  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** A temp DorkOS home with account `two`, whose weekly reading is two days old. */
  async function setup() {
    root = mkdtempSync(path.join(tmpdir(), 'flow-usage-refresh-'));
    const dorkHome = path.join(root, 'dork');
    const osHome = path.join(root, 'home');
    const checkout = path.join(root, 'checkout');
    const accountDir = path.join(root, 'accounts', 'two');
    for (const dir of [dorkHome, path.join(osHome, '.claude'), checkout, accountDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const claude = path.join(root, 'claude');
    writeFileSync(claude, '');
    chmodSync(claude, 0o755);
    writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({
        runtimes: { claudeCode: { accounts: [{ id: 'two', path: accountDir, label: 'Second' }] } },
      })
    );
    const old = new Date(WIRE_NOW.getTime() - 2 * 24 * 3600_000);
    const observation = fromRateLimitEvent(
      { status: 'allowed', resetsAt: RESETS, rateLimitType: 'seven_day', utilization: 0.1 },
      old
    );
    await recordUsage(dorkHome, 'claude-code', 'two', [observation], old);
    return { dorkHome, osHome, checkout, accountDir, claude };
  }

  /** A context whose stream runner answers like a probe turn; `calls` counts the turns. */
  function context(env: Record<string, string>, osHome: string, checkout: string) {
    const calls: string[] = [];
    const warnings: string[] = [];
    const spawnStream: StreamRunner = async (cmd, _args, opts) => {
      calls.push(cmd);
      opts.onLine(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }));
      opts.onLine(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed',
            resetsAt: RESETS,
            rateLimitType: 'seven_day',
            utilization: 0.3,
          },
        })
      );
      return { code: 0, stopped: false, timedOut: false };
    };
    const ctx = {
      env,
      io: { osHome, spawnStream },
      now: () => WIRE_NOW,
      warn: (line: string) => warnings.push(line),
      projectDir: checkout,
      flowRoot: path.resolve(checkout, 'no-flow-here'),
      sessionId: null,
      json: false,
      args: { positionals: [], flags: {} },
    } as unknown as VerbContext;
    return { ctx, calls, warnings };
  }

  it('is off when drain.refreshStaleUsage is false', async () => {
    const { dorkHome, osHome, checkout } = await setup();
    const { ctx } = context({ DORK_HOME: dorkHome }, osHome, checkout);
    const config = FlowConfigSchema.parse({ drain: { refreshStaleUsage: false } });
    expect(staleUsageRefresher(ctx, config, checkout)).toBeNull();
  });

  it('runs one probe turn on the account, saves its reading, and ranks it fresh', async () => {
    const { dorkHome, osHome, checkout, accountDir, claude } = await setup();
    const { ctx, calls, warnings } = context(
      { DORK_HOME: dorkHome, FLOW_CLAUDE_BIN: claude },
      osHome,
      checkout
    );
    const refresh = staleUsageRefresher(ctx, FlowConfigSchema.parse({}), checkout);
    const windows = readLedger(dorkHome, 'claude-code', 'two').ledger?.windows ?? null;
    const before = { ...input([account('two', windows, { path: accountDir })]), now: WIRE_NOW };
    const after = await refresh!(before);
    expect(calls).toEqual([claude]);
    expect(warnings.join('\n')).toMatch(/refreshed the stale usage reading of two/);
    const weeklyRead = (after.accounts[0]?.windows as Record<string, { observedAt: string }>)
      .seven_day;
    expect(weeklyRead?.observedAt).toBe(WIRE_NOW.toISOString());
    // A second pass inside the hour runs no turn.
    await refresh!(before);
    expect(calls).toHaveLength(1);
  });
});
