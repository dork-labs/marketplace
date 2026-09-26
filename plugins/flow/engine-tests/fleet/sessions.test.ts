/**
 * The session registry behind `flow fleet` (spec `flow-usage` §2.6): Claude
 * Code's session files, a loopback DorkOS and flow's run records, joined on
 * sessionId. Every outside effect is a stub, so these tests never touch the
 * machine's own sessions, processes or network.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRunner } from '../../scripts/cli/context.ts';
import { UsageError } from '../../scripts/errors.ts';
import type { AccountIdentity } from '../../scripts/fleet/accounts.ts';
import {
  assertLoopback,
  collectRuns,
  fetchDorkosSessions,
  joinSessions,
  readCliSessions,
  readRunStore,
  resolveDorkosUrl,
  sessionState,
  type CliSession,
} from '../../scripts/fleet/sessions.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/usage');
const NOW = '2026-09-26T16:00:00.000Z';

let home: string;
let identities: AccountIdentity[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'flow-sessions-'));
  cpSync(path.join(FIXTURES, 'sessions'), path.join(home, '.claude-a', 'sessions'), {
    recursive: true,
  });
  // A hand-edited row with a bad id: its sessions must never be read.
  mkdirSync(path.join(home, 'bad', 'sessions'), { recursive: true });
  writeFileSync(
    path.join(home, 'bad', 'sessions', '3001.json'),
    JSON.stringify({ pid: 3001, sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
  );
  identities = [
    { id: 'acct-a', path: path.join(home, '.claude-a'), label: null, color: null, routable: true },
    { id: 'acct-b', path: '/home/example/.claude-b', label: null, color: null, routable: true },
    { id: 'Bad_Id', path: path.join(home, 'bad'), label: null, color: null, routable: false },
  ];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** A ps that prints padded, C-locale UTC start times, like `env TZ=UTC LC_ALL=C ps` does. */
const psStub = (lines: string): ProcessRunner =>
  vi.fn(async () => ({ code: 0, stdout: lines, stderr: '' }));

// 3001 lives in the bad-id row's folder: alive, but its file must never be read.
const ALIVE = new Set([1001, 1002, 1003, 1005, 2004, 3001]);
const pidAlive = (pid: number) => ALIVE.has(pid);

describe('readCliSessions', () => {
  const psOut = [
    ' 1001 Sat Sep  5 22:57:30 2026    ',
    ' 1002 Fri Sep 25 22:00:00 2026    ',
    ' 1003 Fri Sep 25 21:00:00 2026    ',
    ' 1005 Sat Sep 26 11:00:00 2026    ',
    '',
  ].join('\n');

  it('keeps live sessions, drops dead and reused pids, and asks ps in UTC and the C locale', async () => {
    // Purpose: a local-time ps would make every live session look reused and hide them all.
    const runProcess = psStub(psOut);
    const { sessions, warnings } = await readCliSessions(identities, { pidAlive, runProcess });
    expect(sessions.map((s) => s.pid)).toEqual([1001, 1002, 1003]);
    expect(sessions[0]).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      pid: 1001,
      account: 'acct-a',
      cwd: '/work/app-wt/feature',
      status: 'busy',
      startedAt: new Date(1790377055349).toISOString(),
    });
    expect(runProcess).toHaveBeenCalledWith(
      'env',
      ['TZ=UTC', 'LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', '1001,1002,1003,1005'],
      expect.anything()
    );
    expect(warnings.map((w) => w.code)).toEqual(['session-file-invalid']);
  });

  it('trusts the existence check when ps cannot answer', async () => {
    // Purpose: a missing or broken ps must not hide every session.
    const throwing: ProcessRunner = async () => {
      throw new Error('spawn ps ENOENT');
    };
    const failing: ProcessRunner = async () => ({ code: 1, stdout: '', stderr: 'ps: bad option' });
    for (const runProcess of [throwing, failing]) {
      const { sessions } = await readCliSessions(identities, { pidAlive, runProcess });
      expect(sessions.map((s) => s.pid)).toEqual([1001, 1002, 1003, 1005]);
    }
  });

  it('drops a pid ps does not list', async () => {
    // Purpose: the process ended between the existence check and ps, even with no procStart to compare.
    writeFileSync(
      path.join(home, '.claude-a', 'sessions', '1008.json'),
      JSON.stringify({
        pid: 1008,
        sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        status: 'idle',
      })
    );
    const { sessions } = await readCliSessions(identities, {
      pidAlive: (pid) => pid === 1008 || pidAlive(pid),
      runProcess: psStub(' 1001 Sat Sep  5 22:57:30 2026\n'),
    });
    expect(sessions.map((s) => s.pid)).toEqual([1001]);
  });
});

describe('the DorkOS source', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('keeps live sessions and active runs, and names accounts', async () => {
    // Purpose: DorkOS lists all history; only what it holds live belongs on the screen.
    const fetchImpl = respond(200, fixture('dorkos/sessions-d7.json'));
    const ids = [
      ...identities,
      { id: 'acct-a2', path: '/home/example/.claude-a', label: null, color: null, routable: true },
    ];
    const result = await fetchDorkosSessions('http://127.0.0.1:4242', ids, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.reachable).toBe(true);
    expect(
      result.sessions.map((s) => [
        s.sessionId.slice(0, 2),
        s.account,
        s.lifecycle,
        s.limited,
        s.item,
      ])
    ).toEqual([
      ['66', 'acct-b', 'streaming', false, 'DOR-9001'],
      ['77', 'acct-a2', 'blocked', false, null],
      ['88', 'acct-b', 'error', true, null],
      ['22', 'acct-a', 'idle', false, null],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4242/api/sessions?limit=500');
    expect(init.method).toBe('GET');
  });

  it('gets nothing from a release without live status', async () => {
    // Purpose: a pre-D7 DorkOS must add no rows rather than all of its history.
    const result = await fetchDorkosSessions('http://localhost:4242', identities, {
      fetchImpl: respond(200, fixture('dorkos/sessions-pre-d7.json')) as unknown as typeof fetch,
    });
    expect(result).toEqual({ url: 'http://localhost:4242', reachable: true, sessions: [] });
  });

  it('warns on a refusal and reports an unreachable server', async () => {
    // Purpose: sign-in on, or no server at all, each say so plainly.
    const denied = await fetchDorkosSessions('http://[::1]:4242', identities, {
      fetchImpl: respond(401, { error: 'unauthorized' }) as unknown as typeof fetch,
    });
    expect(denied.warning).toMatch(/401/);
    const down = await fetchDorkosSessions('http://127.0.0.1:4242', identities, {
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(down).toEqual({ url: 'http://127.0.0.1:4242', reachable: false, sessions: [] });
  });

  it('never follows a redirect', async () => {
    // Purpose: something else on the port could redirect the request off this machine.
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } })
    );
    const result = await fetchDorkosSessions('http://127.0.0.1:4242', identities, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe('manual');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reachable: true, sessions: [] });
    expect(result.warning).toMatch(/redirect/);
  });

  it('refuses a URL that is not on this machine', async () => {
    // Purpose: fleet never sends a request off the machine.
    const fetchImpl = vi.fn();
    await expect(
      fetchDorkosSessions('http://example.com:4242', identities, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(UsageError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertLoopback('file:///etc/passwd')).toThrow(UsageError);
    expect(() => assertLoopback('http://127.0.0.2')).toThrow(UsageError);
    expect(assertLoopback('http://localhost:6242').port).toBe('6242');
  });

  it('resolves the URL from the flag, the environment, then the port', () => {
    // Purpose: a dev server on another port is reachable without a flag.
    expect(resolveDorkosUrl('http://127.0.0.1:1', { FLOW_DORKOS_URL: 'http://localhost:2' })).toBe(
      'http://127.0.0.1:1'
    );
    expect(resolveDorkosUrl(undefined, { FLOW_DORKOS_URL: 'http://localhost:2' })).toBe(
      'http://localhost:2'
    );
    expect(resolveDorkosUrl(undefined, { DORKOS_PORT: '6242' })).toBe('http://127.0.0.1:6242');
    expect(resolveDorkosUrl(undefined, {})).toBe('http://127.0.0.1:4242');
  });
});

describe('collectRuns', () => {
  it('reads each main checkout once and keeps only active runs', async () => {
    // Purpose: worktrees share one run store, and finished runs are not sessions.
    const git: ProcessRunner = vi.fn(async (_cmd, args) => {
      const cwd = args[1];
      if (cwd === '/nowhere') return { code: 128, stdout: '', stderr: 'not a git repository' };
      const common = cwd.startsWith('/work/app') ? '/work/app/.git' : '/work/other/.git';
      return { code: 0, stdout: `${common}\n`, stderr: '' };
    });
    const readRuns = vi.fn((checkout: string) =>
      checkout === '/work/app' ? (fixture('flow-state.json') as Record<string, unknown>) : {}
    );
    const { runs, warnings } = await collectRuns(
      ['/work/app', '/work/app-wt/feature', '/work/app', '/work/other', '/nowhere'],
      { runProcess: git, readRuns, concurrency: 2 }
    );
    expect(runs.map((r) => [r.identifier, r.status, r.host])).toEqual([
      ['DOR-9101', 'running', 'cmux'],
      ['DOR-9102', 'waiting_for_review', 'cli'],
      ['DOR-9103', 'running', 'cli'],
      ['DOR-9104', 'running', 'dorkos'],
    ]);
    expect(readRuns.mock.calls.map((c) => c[0])).toEqual(['/work/app', '/work/other']);
    expect(warnings).toEqual([]);
    expect(git).toHaveBeenCalledTimes(4);
  });
});

describe('reading a run store', () => {
  it('warns about an unreadable store instead of hiding its runs silently', async () => {
    // Purpose: one corrupt run file must be visible, not a quietly shorter list.
    const { runs, warnings } = await collectRuns(['/work/app'], {
      runProcess: async () => ({ code: 0, stdout: '/work/app/.git\n', stderr: '' }),
      readRuns: () => null,
    });
    expect(runs).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['run-store-unreadable']);
  });

  it('reads a missing store as empty and a broken one as unreadable', () => {
    // Purpose: missing is normal; broken must be told apart from empty.
    const checkout = path.join(home, 'repo');
    expect(readRunStore(checkout)).toEqual({});
    mkdirSync(path.join(checkout, '.dork', 'flow'), { recursive: true });
    const file = path.join(checkout, '.dork', 'flow', 'flow-state.json');
    writeFileSync(file, '{ torn');
    expect(readRunStore(checkout)).toBeNull();
    writeFileSync(file, '[]');
    expect(readRunStore(checkout)).toBeNull();
    writeFileSync(file, JSON.stringify(fixture('flow-state.json')));
    expect(Object.keys(readRunStore(checkout) ?? {})).toHaveLength(5);
  });
});

describe('sessionState', () => {
  const base = { accountLimited: false, pidAlive };
  it.each([
    [{ dorkos: { lifecycle: 'streaming', limited: false } }, 'busy'],
    [{ dorkos: { lifecycle: 'blocked', limited: false } }, 'parked'],
    [{ dorkos: { lifecycle: 'idle', limited: false } }, 'idle'],
    [{ dorkos: { lifecycle: null, limited: false } }, 'idle'],
    [{ dorkos: { lifecycle: 'error', limited: false } }, 'error'],
    [{ dorkos: { lifecycle: 'interrupted', limited: false } }, 'interrupted'],
    [{ dorkos: { lifecycle: 'streaming', limited: true } }, 'limited'],
    [{ cli: { status: 'busy' } }, 'busy'],
    [{ cli: { status: 'idle' } }, 'idle'],
    [{ cli: { status: 'shell' } }, 'shell'],
    [{ cli: { status: null } }, 'unknown'],
    [{ runOnly: { status: 'waiting_for_review', workerPid: 9 } }, 'parked'],
    [{ runOnly: { status: 'running', workerPid: 9 } }, 'stale'],
    [{ runOnly: { status: 'running', workerPid: 2004 } }, 'unseen'],
    [{ runOnly: { status: 'queued', workerPid: null } }, 'unseen'],
  ] as const)('%j reads %s', (input, expected) => {
    // Purpose: every row of the spec's state table.
    expect(sessionState({ ...base, ...input } as never)).toBe(expected);
  });

  it('turns only idle into limited when the account is out', () => {
    // Purpose: a busy session on a "limited" account means the reading is out of date.
    expect(sessionState({ ...base, accountLimited: true, cli: { status: 'idle' } })).toBe(
      'limited'
    );
    expect(sessionState({ ...base, accountLimited: true, cli: { status: 'busy' } })).toBe('busy');
    expect(
      sessionState({
        ...base,
        accountLimited: true,
        dorkos: { lifecycle: 'blocked', limited: false },
      })
    ).toBe('parked');
  });
});

describe('joinSessions across runtimes', () => {
  it("groups rows by runtime, keeps two runtimes' default accounts apart, and names each row's runtime", () => {
    // Purpose: flow runs from Codex and OpenCode too; a limited Codex default must not mark OpenCode's.
    const rows = joinSessions({
      identities: [
        { runtime: 'codex', id: 'default' },
        { runtime: 'opencode', id: 'default' },
        { id: 'acct-a' },
      ],
      cli: [
        { sessionId: 'c1', pid: 1, account: 'acct-a', cwd: null, status: 'idle', startedAt: null },
      ],
      dorkos: [
        {
          sessionId: 'o1',
          account: 'default',
          cwd: null,
          lifecycle: 'idle',
          limited: false,
          item: null,
          startedAt: null,
          runtime: 'opencode',
        },
        {
          // A runtime flow does not know sorts after the three it does, whatever its name.
          sessionId: 'z1',
          account: null,
          cwd: null,
          lifecycle: 'idle',
          limited: false,
          item: null,
          startedAt: null,
          runtime: 'aardvark',
        },
        {
          sessionId: 'x1',
          account: 'default',
          cwd: null,
          lifecycle: 'idle',
          limited: false,
          item: null,
          startedAt: null,
          runtime: 'codex',
        },
      ],
      runs: [
        {
          identifier: 'DOR-1',
          sessionId: 'r1',
          status: 'running',
          stage: null,
          account: null,
          host: 'cli',
          workerPid: null,
          worktreePath: null,
          startedAt: null,
          runtime: 'opencode',
        },
      ],
      windowsByAccount: {
        'codex:default': {
          seven_day: {
            usedPct: 100,
            resetsAt: '2026-09-30T00:00:00.000Z',
            status: 'rejected',
            observedAt: '2026-09-26T15:00:00.000Z',
            source: 'rollout',
          },
        },
      },
      now: NOW,
      pidAlive,
    });
    expect(rows.map((r) => [r.sessionId, r.runtime, r.state])).toEqual([
      ['c1', 'claude-code', 'idle'],
      ['x1', 'codex', 'limited'],
      ['o1', 'opencode', 'idle'],
      ['r1', 'opencode', 'unseen'],
      ['z1', 'aardvark', 'idle'],
    ]);
  });
});

describe('joinSessions', () => {
  const cli: CliSession[] = [
    {
      sessionId: '11111111-1111-4111-8111-111111111111',
      pid: 1001,
      account: 'acct-a',
      cwd: '/work/app-wt/feature',
      status: 'busy',
      startedAt: '2026-09-26T10:00:00.000Z',
    },
    {
      sessionId: '22222222-2222-4222-8222-222222222222',
      pid: 1002,
      account: 'acct-a',
      cwd: '/work/app',
      status: 'idle',
      startedAt: '2026-09-26T11:00:00.000Z',
    },
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      pid: 1003,
      account: 'acct-a',
      cwd: '/work/other',
      status: 'shell',
      startedAt: null,
    },
  ];

  it('joins the three sources so a session serving an item shows it (DOR-2370 validations 1, 2)', async () => {
    // Purpose: one screen, CLI + DorkOS + flow runs, with the item on each linked session.
    const dorkos = (
      await fetchDorkosSessions('http://127.0.0.1:4242', identities, {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify(fixture('dorkos/sessions-d7.json'))
          )) as unknown as typeof fetch,
      })
    ).sessions;
    const { runs } = await collectRuns(['/work/app'], {
      runProcess: async () => ({ code: 0, stdout: '/work/app/.git\n', stderr: '' }),
      readRuns: () => fixture('flow-state.json') as Record<string, unknown>,
    });
    const rows = joinSessions({
      identities,
      cli,
      dorkos,
      runs,
      windowsByAccount: {
        'claude-code:acct-a': {
          five_hour: {
            usedPct: null,
            resetsAt: '2026-09-26T19:00:00.000Z',
            status: 'rejected',
            observedAt: '2026-09-26T15:00:00.000Z',
            source: 'transcript',
          },
        },
      } as never,
      now: NOW,
      pidAlive,
    });
    expect(
      rows.map((r) => [
        r.sessionId.slice(0, 2),
        r.account,
        r.item,
        r.state,
        r.host,
        r.sources.join('+'),
      ])
    ).toEqual([
      ['11', 'acct-a', 'DOR-9101', 'busy', 'cmux', 'claude-code+flow-run'],
      ['aa', 'acct-a', 'DOR-9102', 'parked', 'cli', 'flow-run'],
      ['22', 'acct-a', null, 'limited', 'dorkos', 'claude-code+dorkos'],
      ['33', 'acct-a', null, 'shell', 'cli', 'claude-code'],
      ['66', 'acct-b', 'DOR-9001', 'busy', 'dorkos', 'dorkos'],
      ['bb', 'acct-b', 'DOR-9103', 'stale', 'cli', 'flow-run'],
      ['cc', 'acct-b', 'DOR-9104', 'unseen', 'dorkos', 'flow-run'],
      ['88', 'acct-b', null, 'limited', 'dorkos', 'dorkos'],
      ['77', null, null, 'parked', 'dorkos', 'dorkos'],
    ]);
    // DorkOS fields win for a session both sources report.
    expect(rows.find((r) => r.sessionId.startsWith('22'))?.startedAt).toBe(
      '2026-09-26T12:00:00.000Z'
    );
  });
});
