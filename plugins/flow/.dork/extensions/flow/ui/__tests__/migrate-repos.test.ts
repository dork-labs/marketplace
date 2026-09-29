/**
 * Moving "Only for these repos" into DorkOS (spec `flow-multiproject` §8.5):
 * DorkOS's rule first, flow's role after; partial matches remembered and added
 * later; nothing moves without a match; a second visit changes nothing; a
 * refusal changes nothing and says so; a DorkOS without the routes is left
 * alone.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RepoMigration } from '../../lib/repo-migration.ts';
import type { AccountEligibility, CoreProject } from '../core-api.ts';
import { migrateRepos, type MigrationDeps } from '../migrate-repos.ts';
import { account, claudeGroup, fleet } from './helpers.ts';

const PROJECTS: CoreProject[] = [
  { root: '/work/client-app', name: 'client-app', originRepo: 'Acme/App' },
  { root: '/work/client-api', name: 'client-api', originRepo: 'acme/api' },
  { root: '/work/dorkos', name: 'dorkos', originRepo: 'dork-labs/dorkos' },
];

/** A little world: flow's fleet, DorkOS's rules and projects, the record. */
function world(opts: {
  repos?: string[];
  role?: 'kept-out' | 'rotation';
  projects?: CoreProject[];
  record?: RepoMigration;
  onlyWork?: { root: string; name: string }[] | null;
  routes?: boolean;
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
  const order: string[] = [];
  const deps: MigrationDeps = {
    hasEligibilityRoutes: async () => opts.routes ?? true,
    getFleet: async () =>
      fleet([claudeGroup([account('work', state.role, { label: 'Work', repos: state.repos })])]),
    listProjects: async () => state.projects,
    getEligibility: async (): Promise<AccountEligibility> => ({
      project: null,
      allow: null,
      accounts: [
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
      order.push('dorkos');
      if (opts.refuseCore) throw opts.refuseCore;
      state.onlyWork = roots.map((root) => ({ root, name: root.split('/').pop()! }));
      return {};
    }),
    putAccount: vi.fn(async (_key: string, patch: { role?: unknown; repos?: unknown }) => {
      order.push('flow');
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
  return { deps, state, order };
}

describe('moving "Only for these repos" into DorkOS', () => {
  it('moves every matched repo, DorkOS first, then makes the account Rotation, and says what moved', async () => {
    const { deps, state, order } = world({ repos: ['acme/app', 'acme/api'] });
    const lines = await migrateRepos(deps);
    expect(order).toEqual(['dorkos', 'flow']);
    expect(deps.putOnlyProjects).toHaveBeenCalledWith('work', [
      '/work/client-app',
      '/work/client-api',
    ]);
    expect(deps.putAccount).toHaveBeenCalledWith('claude-code:work', {
      role: 'rotation',
      repos: null,
    });
    expect(lines).toEqual([
      { kind: 'moved', text: 'Moved to DorkOS: Work is now only for client-app and client-api.' },
    ]);
    expect(state.record.accounts['claude-code:work']).toEqual({
      movedRoots: ['/work/client-app', '/work/client-api'],
      pendingRepos: [],
      at: '2026-09-29T10:00:00.000Z',
    });
  });

  it('moves the matched part, remembers the rest, and adds it on a later visit once it is here', async () => {
    const { deps, state } = world({
      repos: ['acme/app', 'acme/web'],
      projects: PROJECTS.slice(0, 1),
    });
    expect(await migrateRepos(deps)).toEqual([
      {
        kind: 'moved',
        text: "Moved to DorkOS: Work is now only for client-app. acme/web isn't on this computer yet; it will be added when it is.",
      },
    ]);
    expect(state.record.accounts['claude-code:work'].pendingRepos).toEqual(['acme/web']);

    // Nothing new yet: a visit changes nothing.
    expect(await migrateRepos(deps)).toEqual([]);

    state.projects = [...PROJECTS, { root: '/work/web', name: 'web', originRepo: 'acme/web' }];
    expect(await migrateRepos(deps)).toEqual([
      { kind: 'added', text: 'Added to DorkOS: Work may now also work in web.' },
    ]);
    expect(deps.putOnlyProjects).toHaveBeenLastCalledWith('work', [
      '/work/client-app',
      '/work/web',
    ]);
    expect(state.record.accounts['claude-code:work'].pendingRepos).toEqual([]);
  });

  it('changes nothing when none of the repos is on this computer', async () => {
    const { deps, state } = world({ repos: ['acme/elsewhere'] });
    expect(await migrateRepos(deps)).toEqual([]);
    expect(deps.putOnlyProjects).not.toHaveBeenCalled();
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(state.role).toBe('kept-out');
  });

  it('leaves an account kept out with no repos kept out: flow never uses it', async () => {
    const { deps } = world({ repos: [] });
    expect(await migrateRepos(deps)).toEqual([]);
    expect(deps.putAccount).not.toHaveBeenCalled();
  });

  it('is idempotent: a second visit after a full move changes nothing', async () => {
    const { deps } = world({ repos: ['acme/app'] });
    await migrateRepos(deps);
    const calls = vi.mocked(deps.putOnlyProjects).mock.calls.length;
    expect(await migrateRepos(deps)).toEqual([]);
    expect(vi.mocked(deps.putOnlyProjects).mock.calls.length).toBe(calls);
  });

  it('adds to the projects DorkOS already kept the account to, never dropping one', async () => {
    const { deps } = world({
      repos: ['acme/app'],
      onlyWork: [{ root: '/work/dorkos', name: 'dorkos' }],
    });
    await migrateRepos(deps);
    expect(deps.putOnlyProjects).toHaveBeenCalledWith('work', ['/work/dorkos', '/work/client-app']);
  });

  it('a DorkOS refusal changes nothing, says so in DorkOS’s words, and is tried again next visit', async () => {
    const refusal = new Error('Only a person can change where an account may be used.');
    const { deps, state } = world({ repos: ['acme/app'], refuseCore: refusal });
    expect(await migrateRepos(deps)).toEqual([
      {
        kind: 'failed',
        text: "Couldn't move Work's repo limits to DorkOS. Nothing changed. Only a person can change where an account may be used.",
      },
    ]);
    expect(deps.putAccount).not.toHaveBeenCalled();
    expect(state.role).toBe('kept-out');
    expect(deps.putRecord).not.toHaveBeenCalled();
  });

  it('when flow’s half fails, says DorkOS already narrowed it, and finishes next time', async () => {
    const { deps, state } = world({ repos: ['acme/app'], refuseFlow: new Error('') });
    const [line] = await migrateRepos(deps);
    expect(line.kind).toBe('failed');
    expect(line.text).toMatch(/DorkOS keeps it to client-app now; flow will finish next time\.$/);
    expect(state.onlyWork).toEqual([{ root: '/work/client-app', name: 'client-app' }]);
  });

  it('does nothing on a DorkOS without the account rules', async () => {
    const { deps } = world({ repos: ['acme/app'], routes: false });
    expect(await migrateRepos(deps)).toEqual([]);
    expect(deps.putOnlyProjects).not.toHaveBeenCalled();
  });

  it('drops a remembered repo when a person freed the account in Settings → Runtimes since', async () => {
    const { deps, state } = world({
      role: 'rotation',
      record: {
        accounts: {
          'claude-code:work': {
            movedRoots: ['/work/client-app'],
            pendingRepos: ['acme/api'],
            at: '2026-09-01T00:00:00.000Z',
          },
        },
      },
      onlyWork: null,
    });
    expect(await migrateRepos(deps)).toEqual([]);
    expect(deps.putOnlyProjects).not.toHaveBeenCalled();
    expect(state.record.accounts['claude-code:work'].pendingRepos).toEqual([]);
  });
});
