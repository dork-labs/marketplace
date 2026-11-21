/**
 * Moving "Only for these repos" into DorkOS (spec `flow-multiproject` §8.5):
 * planning writes nothing; flow never writes DorkOS's rule, so a row that
 * would set it sends the person to Settings → Runtimes; it offers that only
 * when DorkOS has no rule, naming exactly the matched projects; flow's own
 * list stays in force until every project runs flow 0.52 or newer; nothing
 * ever widens where the account may work, on either side.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RepoMigration } from '../../lib/repo-migration.ts';
import type { AccountEligibility, CoreProject } from '../api.ts';
import {
  OPEN_RUNTIMES_ACTION,
  WAITING_FOR_FLOW_TEXT,
  planMoves,
  runMove,
  type MigrationDeps,
} from '../migrate-repos.ts';
import { account, claudeGroup, fleet } from './helpers.ts';

const PROJECTS: CoreProject[] = [
  { root: '/work/client-app', name: 'client-app', originRepo: 'Acme/App' },
  { root: '/work/client-api', name: 'client-api', originRepo: 'acme/api' },
  { root: '/work/dorkos', name: 'dorkos', originRepo: 'dork-labs/dorkos' },
];

const KEY = 'claude-code:work';

/** A little world: flow's fleet, DorkOS's rules and projects, the record. */
function world(opts: {
  repos?: string[];
  role?: 'kept-out' | 'rotation';
  projects?: CoreProject[];
  record?: RepoMigration;
  onlyWork?: { root: string; name: string }[] | null;
  listed?: boolean;
  refuseFlow?: Error;
}) {
  const state = {
    role: opts.role ?? 'kept-out',
    repos: opts.repos ?? [],
    onlyWork: opts.onlyWork ?? null,
    record: opts.record ?? { accounts: {} },
    projects: opts.projects ?? PROJECTS,
  };
  const deps: MigrationDeps = {
    getFleet: async () =>
      fleet([claudeGroup([account('work', state.role, { label: 'Work', repos: state.repos })])]),
    listProjects: async () => state.projects,
    getEligibility: async (): Promise<AccountEligibility> => ({
      project: null,
      allow: null,
      accounts:
        opts.listed === false
          ? []
          : [
              {
                id: 'work',
                label: 'Work',
                color: '#000000',
                implicit: false,
                onlyProjects: state.onlyWork,
                allowedByAccount: true,
                allowedByProject: true,
                eligible: true,
              },
            ],
    }),
    putAccount: vi.fn(async (_key: string, patch: { role?: unknown; repos?: unknown }) => {
      if (opts.refuseFlow) throw opts.refuseFlow;
      state.role = patch.role as 'rotation';
      state.repos = [];
      return {};
    }),
    getRecord: async () => state.record,
    putRecord: vi.fn(async (record: RepoMigration) => {
      state.record = record;
      return record;
    }),
    now: () => new Date('2026-09-29T10:00:00.000Z'),
  };
  /** The person keeps Work to these projects in Settings → Runtimes. */
  const personLimits = (...roots: string[]) => {
    state.onlyWork = roots.map((root) => ({ root, name: root.split('/').pop()! }));
  };
  return { deps, state, personLimits };
}

/** Nothing was written to flow's fleet or to the record. */
function nothingWritten(deps: MigrationDeps) {
  expect(deps.putAccount).not.toHaveBeenCalled();
  expect(deps.putRecord).not.toHaveBeenCalled();
}

describe('planning a move', () => {
  it('writes nothing: opening Settings → Flow only says what could move, and where to move it', async () => {
    const { deps } = world({ repos: ['acme/app', 'acme/web'] });
    expect(await planMoves(deps, true)).toEqual([
      {
        key: KEY,
        kind: 'ready',
        text: 'Move "Only for these repos" into DorkOS: limit Work to client-app in Settings → Runtimes. Flow picks it up when you come back. acme/web isn\'t on this computer yet.',
        action: OPEN_RUNTIMES_ACTION,
        opens: '?settings=runtimes',
      },
    ]);
    nothingWritten(deps);
  });

  it('a click on a row that opens Settings → Runtimes writes nothing', async () => {
    const { deps } = world({ repos: ['acme/app'] });
    const result = await runMove(deps, KEY, true);
    expect(result.ok).toBe(false);
    nothingWritten(deps);
  });

  it('says flow will switch later while an older flow runs somewhere', async () => {
    const { deps } = world({ repos: ['acme/app'] });
    const [plan] = await planMoves(deps, false);
    expect(plan.text).toContain(WAITING_FOR_FLOW_TEXT);
  });

  it('says once, plainly, why an account DorkOS does not list stays as it is', async () => {
    const { deps } = world({ repos: ['acme/app'], listed: false });
    expect(await planMoves(deps, true)).toEqual([
      {
        key: KEY,
        kind: 'not-in-dorkos',
        text: "DorkOS doesn't list Work as a Claude account, so flow keeps its own repo list as it is.",
        action: null,
        opens: null,
      },
    ]);
  });

  it('offers nothing when none of the repos is here', async () => {
    expect(await planMoves(world({ repos: ['acme/elsewhere'] }).deps, true)).toEqual([]);
  });

  it('leaves an account kept out with no repos alone: flow never uses it', async () => {
    expect(await planMoves(world({ repos: [] }).deps, true)).toEqual([]);
  });
});

describe('never widening (the reviewer’s scenario)', () => {
  // Work is kept to dorkos in DorkOS by a person, and kept out by flow except
  // acme/app. Merging would let DorkOS launch Work in client-app, and make flow
  // spend it in dorkos: somewhere each side had refused. So nothing moves.
  it('does not touch an account DorkOS already limits, on either side, and says why', async () => {
    const { deps, state } = world({
      repos: ['acme/app'],
      onlyWork: [{ root: '/work/dorkos', name: 'dorkos' }],
    });
    const [plan] = await planMoves(deps, true);
    expect(plan).toEqual({
      key: KEY,
      kind: 'core-has-rule',
      text: 'Work already has project limits in DorkOS, so flow keeps its own repo list as it is.',
      action: null,
      opens: null,
    });
    const result = await runMove(deps, KEY, true);
    expect(result.ok).toBe(false);
    nothingWritten(deps);
    expect(state.onlyWork).toEqual([{ root: '/work/dorkos', name: 'dorkos' }]);
    expect(state.role).toBe('kept-out');
    expect(state.repos).toEqual(['acme/app']);
  });

  it('once the person limits it to exactly the matched projects, notes the move and keeps flow’s list while an older flow runs', async () => {
    const { deps, state, personLimits } = world({ repos: ['acme/app', 'acme/web'] });
    personLimits('/work/client-app');
    const [plan] = await planMoves(deps, false);
    expect(plan).toMatchObject({ kind: 'unrecorded', action: 'Keep both for now', opens: null });
    expect(await runMove(deps, KEY, false)).toEqual({
      ok: true,
      text: `DorkOS keeps Work to client-app. ${WAITING_FOR_FLOW_TEXT}`,
    });
    // flow: still kept out except its own repos, so both rules apply.
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(state.role).toBe('kept-out');
    expect(state.repos).toEqual(['acme/app', 'acme/web']);
    expect(state.record.accounts[KEY]).toMatchObject({
      movedRoots: ['/work/client-app'],
      held: true,
    });

    // Still an older flow somewhere: it says so, and offers nothing.
    const [held] = await planMoves(deps, false);
    expect(held).toMatchObject({ kind: 'held', action: null });
    expect(held.text).toBe(`DorkOS keeps Work to client-app. ${WAITING_FOR_FLOW_TEXT}`);
  });

  it('a limit the person set wider than the matched projects is theirs: nothing moves', async () => {
    const { deps, personLimits } = world({ repos: ['acme/app'] });
    personLimits('/work/client-app', '/work/dorkos');
    const [plan] = await planMoves(deps, true);
    expect(plan.kind).toBe('core-has-rule');
  });
});

describe('running a move', () => {
  it('with every project current, one click after the person’s limit lets flow follow DorkOS’s rule', async () => {
    const { deps, state, personLimits } = world({ repos: ['acme/app', 'acme/api'] });
    personLimits('/work/client-app', '/work/client-api');
    const [plan] = await planMoves(deps, true);
    expect(plan).toMatchObject({ kind: 'unrecorded', action: 'Switch to DorkOS’s rule' });
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: true,
      text: 'Moved to DorkOS: Work is now only for client-app and client-api.',
    });
    expect(deps.putAccount).toHaveBeenCalledWith(KEY, { role: 'rotation', repos: null });
    expect(state.role).toBe('rotation');
    // A second visit has nothing to offer.
    expect(await planMoves(deps, true)).toEqual([]);
  });

  it('finishes a held move with a second click once every project is current', async () => {
    const { deps, state, personLimits } = world({ repos: ['acme/app'] });
    personLimits('/work/client-app');
    await runMove(deps, KEY, false);
    const [finish] = await planMoves(deps, true);
    expect(finish).toMatchObject({ kind: 'finish', action: 'Switch to DorkOS’s rule' });
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: true,
      text: 'Moved to DorkOS: Work is now only for client-app.',
    });
    expect(state.role).toBe('rotation');
  });

  it('a held move whose DorkOS rule a person changed since is left alone', async () => {
    const { deps, personLimits } = world({ repos: ['acme/app'] });
    personLimits('/work/client-app');
    await runMove(deps, KEY, false);
    personLimits('/work/dorkos');
    const [plan] = await planMoves(deps, true);
    expect(plan.kind).toBe('core-has-rule');
  });

  it('offers a remembered repo once it is here, by sending the person to add it, only while DorkOS still holds the moved rule', async () => {
    const { deps, state, personLimits } = world({
      repos: ['acme/app', 'acme/web'],
      projects: PROJECTS.slice(0, 1),
    });
    personLimits('/work/client-app');
    await runMove(deps, KEY, true);
    expect(await planMoves(deps, true)).toEqual([]);
    state.projects = [...PROJECTS, { root: '/work/web', name: 'web', originRepo: 'acme/web' }];
    const [add] = await planMoves(deps, true);
    expect(add).toEqual({
      key: KEY,
      kind: 'add',
      text: 'acme/web is on this computer now. To let Work work in web too, add it to its limit in Settings → Runtimes.',
      action: OPEN_RUNTIMES_ACTION,
      opens: '?settings=runtimes',
    });
    expect((await runMove(deps, KEY, true)).ok).toBe(false);
    expect(vi.mocked(deps.putRecord).mock.calls).toHaveLength(1);
    // Once the person adds it, or changes DorkOS's rule any other way, nothing is offered.
    personLimits('/work/client-app', '/work/web');
    expect(await planMoves(deps, true)).toEqual([]);
  });

  it('if flow can’t note the move, it says so and offers Try again', async () => {
    const { deps, state, personLimits } = world({ repos: ['acme/app'] });
    personLimits('/work/client-app');
    vi.mocked(deps.putRecord).mockRejectedValueOnce(new Error('busy'));
    expect(await runMove(deps, KEY, false)).toEqual({
      ok: false,
      text: "DorkOS now keeps Work to client-app, but flow couldn't note the move. Try again so flow can finish it later.",
    });
    const [retry] = await planMoves(deps, false);
    expect(retry).toMatchObject({ kind: 'unrecorded', action: 'Keep both for now' });
    expect(await runMove(deps, KEY, false)).toEqual({
      ok: true,
      text: `DorkOS keeps Work to client-app. ${WAITING_FOR_FLOW_TEXT}`,
    });
    expect(state.record.accounts[KEY]).toMatchObject({
      movedRoots: ['/work/client-app'],
      held: true,
    });
    expect(deps.putAccount).not.toHaveBeenCalled();
    const [held] = await planMoves(deps, false);
    expect(held.kind).toBe('held');
  });

  it('when flow’s half fails, both rules still apply and it says so', async () => {
    const { deps, state, personLimits } = world({
      repos: ['acme/app'],
      refuseFlow: new Error(''),
    });
    personLimits('/work/client-app');
    const result = await runMove(deps, KEY, true);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/both rules still apply/);
    expect(state.repos).toEqual(['acme/app']);
    expect(state.record.accounts[KEY]).toMatchObject({ held: true });
  });
});
