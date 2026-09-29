/**
 * Moving "Only for these repos" into DorkOS (spec `flow-multiproject` §8.5):
 * planning writes nothing; a move runs only on a person's click; DorkOS is
 * written only when it has no rule, and then to exactly the matched projects;
 * flow's own list stays in force until every project runs flow 0.52 or newer;
 * nothing ever widens where the account may work, on either side.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RepoMigration } from '../../lib/repo-migration.ts';
import type { AccountEligibility, CoreProject } from '../core-api.ts';
import {
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
  routes?: boolean | null;
  refuseCore?: Error;
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
    hasEligibilityRoutes: async () => (opts.routes === undefined ? true : opts.routes),
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
    putOnlyProjects: vi.fn(async (_id: string, roots: string[]) => {
      if (opts.refuseCore) throw opts.refuseCore;
      state.onlyWork = roots.map((root) => ({ root, name: root.split('/').pop()! }));
      return {};
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
  return { deps, state };
}

/** Nothing was written to DorkOS, to flow's fleet or to the record. */
function nothingWritten(deps: MigrationDeps) {
  expect(deps.putOnlyProjects).not.toHaveBeenCalled();
  expect(deps.putAccount).not.toHaveBeenCalled();
  expect(deps.putRecord).not.toHaveBeenCalled();
}

describe('planning a move', () => {
  it('writes nothing: opening Settings → Flow only says what could move', async () => {
    const { deps } = world({ repos: ['acme/app', 'acme/web'] });
    expect(await planMoves(deps, true)).toEqual([
      {
        key: KEY,
        kind: 'ready',
        text: 'Move "Only for these repos" into DorkOS? DorkOS will keep Work to client-app. acme/web isn\'t on this computer yet.',
        action: 'Move it',
      },
    ]);
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
      },
    ]);
  });

  it('offers nothing when none of the repos is here, or on a DorkOS without the rules, or one it could not ask', async () => {
    expect(await planMoves(world({ repos: ['acme/elsewhere'] }).deps, true)).toEqual([]);
    expect(await planMoves(world({ repos: ['acme/app'], routes: false }).deps, true)).toEqual([]);
    expect(await planMoves(world({ repos: ['acme/app'], routes: null }).deps, true)).toEqual([]);
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
    });
    const result = await runMove(deps, KEY, true);
    expect(result.ok).toBe(false);
    nothingWritten(deps);
    expect(state.onlyWork).toEqual([{ root: '/work/dorkos', name: 'dorkos' }]);
    expect(state.role).toBe('kept-out');
    expect(state.repos).toEqual(['acme/app']);
  });

  it('with no rule in DorkOS, sets exactly the matched projects and keeps flow’s list while an older flow runs', async () => {
    const { deps, state } = world({ repos: ['acme/app', 'acme/web'] });
    const result = await runMove(deps, KEY, false);
    expect(result).toEqual({
      ok: true,
      text: `DorkOS now keeps Work to client-app, and flow's own repo list stays too. ${WAITING_FOR_FLOW_TEXT}`,
    });
    // DorkOS: exactly client-app, nothing merged in.
    expect(deps.putOnlyProjects).toHaveBeenCalledWith('work', ['/work/client-app']);
    // flow: still kept out except its own repos, so both rules apply.
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(state.role).toBe('kept-out');
    expect(state.repos).toEqual(['acme/app', 'acme/web']);
    expect(state.record.accounts[KEY]).toMatchObject({ movedRoots: ['/work/client-app'], held: true });

    // Still an older flow somewhere: it says so, and offers nothing.
    const [held] = await planMoves(deps, false);
    expect(held).toMatchObject({ kind: 'held', action: null });
    expect(held.text).toBe(`DorkOS keeps Work to client-app. ${WAITING_FOR_FLOW_TEXT}`);
  });
});

describe('running a move', () => {
  it('with every project current, moves exactly the matched projects, DorkOS first, then Rotation', async () => {
    const { deps, state } = world({ repos: ['acme/app', 'acme/api'] });
    const order: string[] = [];
    vi.mocked(deps.putOnlyProjects).mockImplementation(async (_id, roots) => {
      order.push('dorkos');
      state.onlyWork = roots.map((root) => ({ root, name: root.split('/').pop()! }));
      return {};
    });
    vi.mocked(deps.putAccount).mockImplementation(async () => {
      order.push('flow');
      state.role = 'rotation';
      state.repos = [];
      return {};
    });
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: true,
      text: 'Moved to DorkOS: Work is now only for client-app and client-api.',
    });
    expect(order).toEqual(['dorkos', 'flow']);
    expect(deps.putAccount).toHaveBeenCalledWith(KEY, { role: 'rotation', repos: null });
    // A second visit has nothing to offer.
    expect(await planMoves(deps, true)).toEqual([]);
  });

  it('finishes a held move with a second click once every project is current', async () => {
    const { deps, state } = world({ repos: ['acme/app'] });
    await runMove(deps, KEY, false);
    const [finish] = await planMoves(deps, true);
    expect(finish).toMatchObject({ kind: 'finish', action: 'Switch to DorkOS’s rule' });
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: true,
      text: 'Moved to DorkOS: Work is now only for client-app.',
    });
    expect(state.role).toBe('rotation');
    expect(vi.mocked(deps.putOnlyProjects).mock.calls).toHaveLength(1);
  });

  it('a held move whose DorkOS rule a person changed since is left alone', async () => {
    const { deps, state } = world({ repos: ['acme/app'] });
    await runMove(deps, KEY, false);
    state.onlyWork = [{ root: '/work/dorkos', name: 'dorkos' }];
    const [plan] = await planMoves(deps, true);
    expect(plan.kind).toBe('core-has-rule');
  });

  it('offers a remembered repo once it is here, only while DorkOS still holds flow’s rule', async () => {
    const { deps, state } = world({ repos: ['acme/app', 'acme/web'], projects: PROJECTS.slice(0, 1) });
    await runMove(deps, KEY, true);
    expect(await planMoves(deps, true)).toEqual([]);
    state.projects = [...PROJECTS, { root: '/work/web', name: 'web', originRepo: 'acme/web' }];
    const [add] = await planMoves(deps, true);
    expect(add).toMatchObject({ kind: 'add', action: 'Add it' });
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: true,
      text: 'Added to DorkOS: Work may now also work in web.',
    });
    expect(deps.putOnlyProjects).toHaveBeenLastCalledWith('work', ['/work/client-app', '/work/web']);
    // If a person changed DorkOS's rule since, nothing is offered.
    state.record.accounts[KEY].pendingRepos = ['acme/api'];
    state.onlyWork = [{ root: '/work/dorkos', name: 'dorkos' }];
    expect(await planMoves(deps, true)).toEqual([]);
  });

  it('a DorkOS refusal changes nothing and says so in DorkOS’s words', async () => {
    const refusal = new Error('Only a person can change where an account may be used.');
    const { deps, state } = world({ repos: ['acme/app'], refuseCore: refusal });
    expect(await runMove(deps, KEY, true)).toEqual({
      ok: false,
      text: "Couldn't move Work's repo limits to DorkOS. Nothing changed. Only a person can change where an account may be used.",
    });
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(state.role).toBe('kept-out');
  });

  it('when flow’s half fails, both rules still apply and it says so', async () => {
    const { deps, state } = world({ repos: ['acme/app'], refuseFlow: new Error('') });
    const result = await runMove(deps, KEY, true);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/both rules still apply/);
    expect(state.repos).toEqual(['acme/app']);
    expect(state.record.accounts[KEY]).toMatchObject({ held: true });
  });
});
