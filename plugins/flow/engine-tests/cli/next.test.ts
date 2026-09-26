/**
 * `flow next` (spec `flow-cli-core` §6, task 3.2): the dispatch pick with no
 * hand-built input. The parity cases are the contract: for the same backlog,
 * `flow next --json` must pick exactly what `dispatch.ts` picks when an agent
 * hand-builds its input (ownership per item, WIP counts) the way the old prose
 * told it to.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { findConfigRoots } from '../../scripts/config-files.ts';
import { loadConfig } from '../../scripts/config-load.ts';
import { liveByAccount } from '../../scripts/cli/next.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import type { OwnershipClass } from '../../scripts/work-item.ts';
import type { FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_SCRIPT = path.resolve(here, '..', '..', 'scripts', 'dispatch.ts');

const AGENT = 'flow-bot';
const HUMAN = 'dorian';

let temp: TempProject | undefined;

afterEach(() => temp?.cleanup());

const widgets = { id: 'proj-1', name: 'Widgets', stateCategory: 'started' as const };
const gadgets = { id: 'proj-2', name: 'Gadgets', stateCategory: 'started' as const };
const shelved = { id: 'proj-3', name: 'Shelved', stateCategory: 'canceled' as const };

/** A started item an agent is working on: counts toward the WIP load. */
function inFlight(identifier: string, project = widgets): WorkItem {
  return readyItem(identifier, {
    stateCategory: 'started',
    labels: ['type/task', 'agent/claimed'],
    agentDisposition: 'claimed',
    project,
  });
}

/**
 * One parity fixture: the backlog, plus the dispatch input an agent would have
 * built by hand from it (ownership per item and the WIP counts), written out
 * literally so the test does not reuse the code under test to build it.
 */
interface ParityCase {
  name: string;
  items: WorkItem[];
  ownershipOf: Record<string, OwnershipClass>;
  inProgressByProject: Record<string, number>;
  inProgressTotal: number;
}

const PARITY: ParityCase[] = [
  {
    name: 'a mixed queue: priorities, sizes, owners, a blocker and a dead project',
    items: [
      readyItem('P-1', { priority: 3, size: 5, project: widgets }),
      readyItem('P-2', { priority: 1, size: 8, project: gadgets }),
      readyItem('P-3', { priority: 2, size: 1, assignee: AGENT, project: widgets }),
      readyItem('P-4', { priority: 1, assignee: HUMAN, project: gadgets }),
      readyItem('P-5', { priority: 2, assignee: 'someone-else', project: widgets }),
      readyItem('P-6', {
        priority: 1,
        project: gadgets,
        relations: { blocks: [], blockedBy: ['P-7'], children: [], relatedTo: [] },
      }),
      readyItem('P-7', { stateCategory: 'backlog', labels: ['type/task'], project: gadgets }),
      readyItem('P-8', { priority: 1, project: shelved }),
      readyItem('P-9', {
        priority: 4,
        size: 2,
        project: gadgets,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ],
    ownershipOf: {
      'P-1': 'unassigned',
      'P-2': 'unassigned',
      'P-3': 'mine',
      'P-4': 'reviewer',
      'P-5': 'other',
      'P-6': 'unassigned',
      'P-7': 'unassigned',
      'P-8': 'unassigned',
      'P-9': 'unassigned',
    },
    inProgressByProject: {},
    inProgressTotal: 0,
  },
  {
    name: 'a WIP-capped queue: Widgets already has claimed work in flight',
    items: [
      inFlight('W-1', widgets),
      readyItem('W-2', { priority: 1, project: widgets }),
      readyItem('W-3', { priority: 2, project: gadgets }),
      readyItem('W-4', { priority: 3, project: gadgets }),
      // Started but not claimed: not part of the WIP load.
      readyItem('W-5', { stateCategory: 'started', labels: ['type/task'], project: gadgets }),
    ],
    ownershipOf: {
      'W-1': 'unassigned',
      'W-2': 'unassigned',
      'W-3': 'unassigned',
      'W-4': 'unassigned',
      'W-5': 'unassigned',
    },
    inProgressByProject: { 'proj-1': 1 },
    inProgressTotal: 1,
  },
  {
    name: 'a starved queue: nothing ready, shapeable work waiting',
    items: [
      readyItem('S-1', { stateCategory: 'backlog', labels: ['type/idea'] }),
      readyItem('S-2', { stateCategory: 'unstarted', labels: ['type/task'] }),
      inFlight('S-3', gadgets),
    ],
    ownershipOf: { 'S-1': 'unassigned', 'S-2': 'unassigned', 'S-3': 'unassigned' },
    inProgressByProject: { 'proj-2': 1 },
    inProgressTotal: 1,
  },
];

/** Run the real dispatch.ts on a hand-built input, as the old prose did. */
function dispatchByHand(input: unknown): {
  picked: WorkItem[];
  eligibleCount: number;
  starved: boolean;
  shapeableCount: number;
} {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', DISPATCH_SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`dispatch.ts failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function config(extra: Record<string, unknown> = {}) {
  return { tracker: 'fake', identity: { agent: AGENT, reviewer: HUMAN }, ...extra };
}

describe('flow next: parity with dispatch.ts', () => {
  for (const parity of PARITY) {
    it(`picks what dispatch.ts picks for ${parity.name}`, async () => {
      // Purpose: `flow next` replaces the hand-built dispatch input; if its
      // ownership or WIP counts differ from what the prose built, it would
      // quietly pick different work.
      temp = tempProject(config());
      const resolved = loadConfig(findConfigRoots(temp.project, temp.plugin), {}).config;
      const expected = dispatchByHand({
        items: parity.items,
        config: {
          dispatch: resolved.dispatch,
          ownership: resolved.ownership,
          wipCap: resolved.autonomy.wipCap,
        },
        opts: {
          ownershipOf: parity.ownershipOf,
          inProgressByProject: parity.inProgressByProject,
          inProgressTotal: parity.inProgressTotal,
        },
      });

      const result = await runFlow(['next', '--json', '-n', '100'], temp, { items: parity.items });
      expect(result.code).toBe(EXIT.ok);
      const next = JSON.parse(result.stdout);
      expect(next.picked.map((item: WorkItem) => item.identifier)).toEqual(
        expected.picked.map((item) => item.identifier)
      );
      expect(next).toMatchObject({
        eligibleCount: expected.eligibleCount,
        starved: expected.starved,
        shapeableCount: expected.shapeableCount,
        wip: { total: parity.inProgressTotal, byProject: parity.inProgressByProject },
      });
    });
  }

  it('the parity fixtures are not trivial', () => {
    // Purpose: parity over empty picks would prove nothing; each fixture must
    // exercise a different outcome (several picks, a WIP cut, starvation).
    const outcomes = PARITY.map((parity) =>
      dispatchByHand({
        items: parity.items,
        config: {
          dispatch: loadDefaults().dispatch,
          ownership: loadDefaults().ownership,
          wipCap: loadDefaults().autonomy.wipCap,
        },
        opts: {
          ownershipOf: parity.ownershipOf,
          inProgressByProject: parity.inProgressByProject,
          inProgressTotal: parity.inProgressTotal,
        },
      })
    );
    expect(outcomes[0].eligibleCount).toBeGreaterThan(1);
    expect(outcomes[1].picked.map((item) => item.identifier)).not.toContain('W-2');
    expect(outcomes[2]).toMatchObject({ eligibleCount: 0, starved: true });
  });
});

function loadDefaults() {
  const project = tempProject(config());
  try {
    return loadConfig(findConfigRoots(project.project, project.plugin), {}).config;
  } finally {
    project.cleanup();
  }
}

describe('flow next', () => {
  function backlog(): FakeBacklog {
    return { user: { id: AGENT }, items: PARITY[0].items };
  }

  it('shows one pick by default and N with -n', async () => {
    // Purpose: -n bounds how many picks come back; the default is the one
    // item a drain tick claims.
    temp = tempProject(config());
    const one = JSON.parse((await runFlow(['next', '--json'], temp, backlog())).stdout);
    expect(one.picked).toHaveLength(1);
    expect(one.eligibleCount).toBeGreaterThan(1);
    const two = JSON.parse((await runFlow(['next', '--json', '-n', '2'], temp, backlog())).stdout);
    expect(two.picked).toHaveLength(2);
    expect(two.picked[0].identifier).toBe(one.picked[0].identifier);
  });

  it('rejects an -n that is not a positive whole number', async () => {
    // Purpose: "-n 0" or "-n x" is a typo, never "no picks".
    temp = tempProject(config());
    expect((await runFlow(['next', '-n', '0'], temp, backlog())).code).toBe(EXIT.usage);
    expect((await runFlow(['next', '-n', 'x'], temp, backlog())).code).toBe(EXIT.usage);
  });

  it('narrows to one project with --for-project, by id or by name in any case', async () => {
    // Purpose: project-scoped dispatch (`/flow <project>`) needs only that
    // project's work, however the operator typed its name.
    temp = tempProject(config());
    for (const wanted of ['proj-2', 'gadgets', 'GADGETS']) {
      const result = await runFlow(
        ['next', '--json', '-n', '100', '--for-project', wanted],
        temp,
        backlog()
      );
      const picked = JSON.parse(result.stdout).picked as WorkItem[];
      expect(picked.length, wanted).toBeGreaterThan(0);
      expect(
        picked.every((item) => item.project?.id === 'proj-2'),
        wanted
      ).toBe(true);
    }
  });

  it('exits 5 when --for-project matches no project', async () => {
    // Purpose: a mistyped project must not read as "nothing to do".
    temp = tempProject(config());
    const result = await runFlow(['next', '--json', '--for-project', 'nope'], temp, backlog());
    expect(result.code).toBe(EXIT.precondition);
    expect(JSON.parse(result.stdout).error.message).toMatch(/"nope"/);
  });

  it('keeps the common --project flag meaning the checkout', async () => {
    // Purpose: the project filter has its own flag so --project <dir> still
    // picks the checkout whose config is read.
    temp = tempProject(config());
    const elsewhere = path.dirname(temp.project);
    const result = await runFlow(
      ['next', '--json', '--project', temp.project],
      { ...temp, project: elsewhere },
      backlog()
    );
    expect(result.code).toBe(EXIT.ok);
  });

  it('exits 7 while paused, and runs with --manual', async () => {
    // Purpose: a pause stops the loop, never the operator; the tracker is not
    // read before the pause is checked.
    temp = tempProject(config());
    writeFileSync(
      path.join(temp.project, '.agents', 'flow', 'paused.json'),
      JSON.stringify({ pausedAt: '2026-09-26T10:00:00.000Z' })
    );
    const paused = await runFlow(['next', '--json'], temp, backlog());
    expect(paused.code).toBe(EXIT.paused);
    expect(paused.adapterBuilds).toBe(0);
    expect(JSON.parse(paused.stdout).error.message).toMatch(/since 2026-09-26T10:00:00.000Z/);

    const manual = await runFlow(['next', '--json', '--manual'], temp, backlog());
    expect(manual.code).toBe(EXIT.ok);
  });

  it('resolves identity.agent "auto" to the current user for ownership', async () => {
    // Purpose: an item assigned to the agent is claimable as "mine"; with
    // "auto" that account must come from getCurrentUser, or the item would
    // read as someone else's and never be picked.
    temp = tempProject({ tracker: 'fake' });
    const items = [readyItem('A-1', { assignee: AGENT })];
    const mine = await runFlow(['next', '--json'], temp, { user: { id: AGENT }, items });
    expect(JSON.parse(mine.stdout).eligibleCount).toBe(1);
    const theirs = await runFlow(['next', '--json'], temp, { user: { id: 'x' }, items });
    expect(JSON.parse(theirs.stdout).eligibleCount).toBe(0);
  });

  it('reads a --snapshot file without calling the adapter', async () => {
    // Purpose: one pull serves a whole tick; --snapshot must not touch the tracker.
    temp = tempProject(config());
    const saved = path.join(temp.project, 'snap.json');
    writeFileSync(saved, (await runFlow(['snapshot', '--json'], temp, backlog())).stdout);
    const result = await runFlow(['next', '--json', '--snapshot', saved], temp, {
      items: [],
      failReads: 'the tracker must not be read',
    });
    expect(result.adapterBuilds).toBe(0);
    expect(JSON.parse(result.stdout).picked).toHaveLength(1);
  });

  it('prints picks as KEY - Title with priority and size, or why nothing is eligible', async () => {
    // Purpose: a person reads the human text; it must name the item the way
    // the tracker shows it, and say "starved" versus "drained" plainly.
    temp = tempProject(config());
    const picks = await runFlow(['next', '-n', '2'], temp, backlog());
    expect(picks.stdout).toMatch(/^Next \(2 of \d+ eligible\):/);
    expect(picks.stdout).toMatch(/P-\d - Title of P-\d\s+priority \d\s+(size \d|no size)/);

    const starved = await runFlow(['next'], temp, { user: { id: AGENT }, items: PARITY[2].items });
    expect(starved.code).toBe(EXIT.ok);
    expect(starved.stdout).toContain('3 item(s) wait behind the agent/ready gate');

    const drained = await runFlow(['next'], temp, { user: { id: AGENT }, items: [] });
    expect(drained.stdout).toContain('the queue is drained');
  });

  it('says the WIP cap is full, not that triage would help, when only the cap blocks', async () => {
    // Purpose: claimed work in flight counts as shapeable, so a full cap reads
    // as "starved"; telling the loop to triage would ready more work it still
    // cannot take. The cap, not the gate, is what is blocking.
    temp = tempProject(config({ autonomy: { wipCap: { global: 1, perProject: 1 } } }));
    const items = [inFlight('C-1', widgets), readyItem('C-2', { project: gadgets })];
    const capped = await runFlow(['next'], temp, { user: { id: AGENT }, items });
    expect(capped.stdout).toContain('work in progress is at its cap');
    expect(capped.stdout).not.toContain('triage');
    const json = JSON.parse((await runFlow(['next', '--json'], temp, { items })).stdout);
    expect(json).toMatchObject({ eligibleCount: 0, atWipCap: true });

    temp.cleanup();
    temp = tempProject(config());
    const open = JSON.parse((await runFlow(['next', '--json'], temp, { items })).stdout);
    expect(open).toMatchObject({ eligibleCount: 1, atWipCap: false });
  });
});

describe('flow next: the account each pick runs on (flow-handoff-dispatch §3.5)', () => {
  const NOW = '2026-09-26T12:00:00.000Z';
  // One project each, so the per-project WIP cap never trims the picks.
  const items = ['A-1', 'A-2', 'A-3'].map((id, i) =>
    readyItem(id, {
      priority: ([1, 2, 3] as const)[i],
      project: { id: `p-${id}`, name: id, stateCategory: 'started' },
    })
  );
  const backlog = (): FakeBacklog => ({ user: { id: AGENT }, items });

  /** Write `<dorkHome>/<rel>`: a string as it is, anything else as JSON. */
  function put(rel: string, value: unknown): void {
    const file = path.join(temp!.dorkHome, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }

  /** Register Claude Code accounts and give each a fleet policy. */
  function fleet(accounts: Record<string, Record<string, unknown>>, extra = {}): void {
    put('config.json', {
      runtimes: {
        claudeCode: {
          accounts: Object.keys(accounts).map((id) => ({
            id,
            path: path.join(temp!.dorkHome, 'claude', id),
            label: `Label ${id}`,
          })),
        },
      },
    });
    put('flow/fleet.json', {
      v: 1,
      ...extra,
      accounts: Object.fromEntries(
        Object.entries(accounts).map(([id, entry]) => [`claude-code:${id}`, entry])
      ),
    });
  }

  /** Store a weekly reading for one account. */
  function weekly(runtime: string, id: string, usedPct: number, resetsAt: string): void {
    put(`runtimes/${runtime}/usage/${id}.json`, {
      v: 1,
      runtime,
      accountId: id,
      updatedAt: NOW,
      windows: {
        seven_day: { usedPct, resetsAt, status: 'allowed', observedAt: NOW, source: 'statusline' },
      },
    });
  }

  /** A run record in the project's (git) checkout. */
  function runs(records: FlowRun[]): void {
    execFileSync('git', ['init', '-q'], { cwd: temp!.project });
    const file = path.join(temp!.project, '.dork', 'flow', 'flow-state.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(records.map((r) => [r.issueId, r]))));
  }

  function run(identifier: string, overrides: Partial<FlowRun>): FlowRun {
    return {
      issueId: `id-${identifier}`,
      identifier,
      sessionId: 's',
      worktreePath: temp!.project,
      branch: identifier,
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: 1,
      startedAt: NOW,
      ...overrides,
    };
  }

  async function next(argv: string[], options = {}) {
    const result = await runFlow(['next', ...argv], temp!, backlog(), options);
    return { ...result, json: argv.includes('--json') ? JSON.parse(result.stdout) : null };
  }

  it("with no registry, picks the runtime's implicit default: the ambient account", async () => {
    // Purpose: a one-account user needs no fleet setup; the implicit default is
    // the ambient environment and is named that way.
    temp = tempProject(config());
    const { json } = await next(['--json']);
    expect(json.picked[0].account).toMatchObject({
      runtime: 'claude-code',
      pick: { runtime: 'claude-code', id: 'default' },
      reason: 'ambient',
    });
    expect((await next([])).stdout).toMatch(/A-1 - Title of A-1 .* -> ambient account$/m);
  });

  it('DOR-2373: an account resetting sooner with less left beats one resetting later with more', async () => {
    // Purpose: spend what expires soonest; the ranking must reach flow next.
    temp = tempProject(config());
    fleet({ later: { role: 'rotation' }, sooner: { role: 'rotation' } });
    weekly('claude-code', 'later', 40, '2026-10-02T12:00:00.000Z');
    weekly('claude-code', 'sooner', 60, '2026-09-27T12:00:00.000Z');
    const { json } = await next(['--json']);
    expect(json.picked[0].account.pick).toEqual({ runtime: 'claude-code', id: 'sooner' });
    expect(json.picked[0].account.ranked.map((r: { id: string }) => r.id)).toEqual([
      'sooner',
      'later',
    ]);
    expect((await next([])).stdout).toMatch(/A-1 .* -> Label sooner$/m);
  });

  it('-n spreads picks over accounts when maxLivePerAccount is 1, then runs out', async () => {
    // Purpose: each assignment counts as live, so later picks go elsewhere.
    temp = tempProject(
      config({
        drain: { maxLivePerAccount: 1 },
        autonomy: { wipCap: { global: 10, perProject: 10 } },
      })
    );
    fleet({ a: { role: 'rotation' }, b: { role: 'rotation' } });
    weekly('claude-code', 'a', 10, '2026-09-27T12:00:00.000Z');
    const { json } = await next(['--json', '-n', '3']);
    const picks = json.picked.map((p: { account: { pick: unknown } }) => p.account.pick);
    expect(picks).toEqual([
      { runtime: 'claude-code', id: 'a' },
      { runtime: 'claude-code', id: 'b' },
      null,
    ]);
    expect(json.picked[2].account.ineligible).toEqual([
      { runtime: 'claude-code', id: 'a', reasons: ['at-capacity'] },
      { runtime: 'claude-code', id: 'b', reasons: ['at-capacity'] },
    ]);
  });

  it('counts running and queued runs and their drain reviewers as live, by <runtime>:<id>', async () => {
    // Purpose: work already running on an account fills it; a reviewer bills too.
    temp = tempProject(config({ drain: { maxLivePerAccount: 1 } }));
    fleet({ a: { role: 'rotation' }, b: { role: 'rotation' }, c: { role: 'rotation' } });
    runs([
      run('X-1', { account: 'a', status: 'queued' }),
      run('X-2', {
        account: 'c',
        status: 'complete',
      }),
      run('X-3', {
        runtime: 'claude-code',
        account: 'c',
        status: 'running',
        drain: {
          v: 1,
          rev: 1,
          phase: 'reviewing',
          worker: null,
          reviewer: {
            host: 'cli',
            runtime: 'claude-code',
            sessionId: 'r',
            account: 'b',
            cwd: temp.project,
            sha: 'abc',
            worktree: temp.project,
            tokenHash: 'h',
          },
          pushedSha: null,
          reviewedSha: null,
          verdict: null,
          reviewRound: 1,
          pr: null,
          rearmedFor: null,
          nudges: 0,
          wakeAfter: null,
          handoffs: [],
          parkedReason: null,
        },
      }),
    ]);
    const { json, stderr } = await next(['--json']);
    expect(json.picked[0].account.pick).toBeNull();
    expect(json.picked[0].account.ineligible.map((e: { reasons: string[] }) => e.reasons)).toEqual([
      ['at-capacity'],
      ['at-capacity'],
      ['at-capacity'],
    ]);
    expect(stderr).not.toMatch(/not a valid flow run store/);
  });

  it('keeps the affinity account when it is eligible', async () => {
    // Purpose: a follow-up step on the same account resumes a warm prompt cache.
    temp = tempProject(config());
    fleet({ warm: { role: 'rotation' }, cold: { role: 'rotation' } });
    weekly('claude-code', 'warm', 80, '2026-10-02T12:00:00.000Z');
    weekly('claude-code', 'cold', 0, '2026-09-27T12:00:00.000Z');
    runs([run('A-1', { account: 'warm', status: 'waiting_for_review' })]);
    const { json } = await next(['--json']);
    expect(json.picked[0].account.pick).toEqual({ runtime: 'claude-code', id: 'warm' });
    expect(json.picked[0].account.ranked[0].tier).toBe(0);
  });

  it('all accounts kept out: no account, and one stderr block naming the command', async () => {
    // Purpose: a registered kept-out account is never spent by a fallback; the
    // operator is told how to allow one.
    temp = tempProject(config());
    fleet({ client: {} });
    const human = await next(['-n', '2']);
    expect(human.code).toBe(EXIT.ok);
    expect(human.stdout).toMatch(/A-1 .* -> no account$/m);
    const blocks = human.stderr.match(/No account may take work/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(human.stderr).toContain(
      'No account may take work for this checkout (no origin repo): claude-code:client: out-of-scope. Run `flow accounts set <id> --role rotation` to allow one.'
    );
    const { json } = await next(['--json']);
    expect(json.picked[0].account).toMatchObject({ pick: null, reason: 'none' });
  });

  it("scopes a kept-out account by the checkout's origin repo", async () => {
    // Purpose: repo comes from the --project checkout's origin, parsed as S1 does.
    temp = tempProject(config());
    fleet({ client: { role: 'kept-out', scope: { repos: ['Acme/App'] } } });
    const origin = async (cmd: string, args: readonly string[]) =>
      cmd === 'git' && args.join(' ') === 'remote get-url origin'
        ? { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    const { json } = await next(['--json'], { runProcess: origin });
    expect(json.picked[0].account.pick).toEqual({ runtime: 'claude-code', id: 'client' });
  });

  it('ranks for the first of fleet.runtimes when the item has no run', async () => {
    // Purpose: the item's runtime decides which registry it draws from.
    temp = tempProject(config());
    put('flow/fleet.json', { v: 1, runtimes: ['codex'] });
    const { json, stdout } = await next(['--json']);
    expect(json.picked[0].account).toMatchObject({
      runtime: 'codex',
      pick: { runtime: 'codex', id: 'default' },
      reason: 'ambient',
    });
    expect(stdout).toBeTruthy();
  });

  it('falls to another runtime only with crossRuntimeFallback on, and says so', async () => {
    // Purpose: a fully spent runtime blocks work unless the operator allowed a fallback.
    temp = tempProject(config());
    fleet({ a: { role: 'rotation' } });
    put('runtimes/claude-code/usage/a.json', {
      v: 1,
      runtime: 'claude-code',
      accountId: 'a',
      updatedAt: NOW,
      windows: {
        five_hour: {
          usedPct: 100,
          resetsAt: '2026-09-26T14:00:00.000Z',
          status: 'rejected',
          observedAt: NOW,
          source: 'statusline',
        },
      },
    });
    const off = await next(['--json']);
    expect(off.json.picked[0].account).toMatchObject({ pick: null, reason: 'none' });

    fleet(
      { a: { role: 'rotation' } },
      { crossRuntimeFallback: 'on', runtimes: ['claude-code', 'opencode'] }
    );
    const on = await next(['--json']);
    expect(on.json.picked[0].account).toMatchObject({
      runtime: 'claude-code',
      pick: { runtime: 'opencode', id: 'default' },
      reason: 'cross-runtime',
    });
    expect((await next([])).stdout).toMatch(/-> opencode ambient account$/m);
  });

  it('--no-account prints exactly what flow next printed before accounts', async () => {
    // Purpose: S1's output stays available unchanged, and nothing under DORK_HOME is read.
    temp = tempProject(config());
    put('config.json', '{not json');
    const json = await next(['--json', '-n', '2', '--no-account']);
    expect(json.json.picked).toEqual(items.slice(0, 2));
    expect(json.stderr).toBe('');
    const human = await next(['-n', '2', '--no-account']);
    expect(human.stdout).not.toContain('->');
    expect(human.stderr).toBe('');
  });
});

describe('liveByAccount', () => {
  // Purpose: a parked drain run holds no live session, so it must not use up
  // its account's room; a working one, and its reviewer, still count.
  it('counts running runs and their reviewers, but not a parked drain run', () => {
    const base = {
      identifier: 'X',
      sessionId: 's',
      worktreePath: '/w',
      branch: 'b',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: -1,
      startedAt: '2026-09-26T00:00:00.000Z',
      account: 'a',
    } as const;
    const drain = (phase: DrainState['phase']) =>
      ({ v: 1, rev: 1, phase, worker: null, reviewer: null }) as unknown as DrainState;
    const runs: Record<string, FlowRun> = {
      one: { ...base, issueId: 'one', drain: drain('working') },
      two: { ...base, issueId: 'two', drain: drain('parked') },
      three: { ...base, issueId: 'three' },
    };
    expect(liveByAccount(runs)).toEqual({ 'claude-code:a': 2 });
  });
});
