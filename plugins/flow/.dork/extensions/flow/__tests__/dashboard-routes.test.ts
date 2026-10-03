/**
 * The dashboard's routes (spec "Flow Dashboard", M1): `GET /dashboard` lists
 * each project's pages; `GET /dashboard/issues`, `/prs` and `/releases` answer
 * the cached read with each source's age and error, reading again when it is
 * over a minute old; `POST /dashboard/refresh` reads now and only for a
 * person; a project without the block, a page switched off, an unknown name,
 * a team flow cannot read yet and a failing repository are each said plainly.
 *
 * GitHub is a fake `GithubReads`, and the tracker is flow's snapshot file as
 * the tracker reads leave it: a test never runs `gh` or a tracker.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubReads, OpenPr } from '../../../../scripts/forge/github.ts';
import type { ExecFileLike } from '../lib/advisor.ts';
import type {
  DashboardBody,
  DashboardIndex,
  DashboardIssue,
  DashboardPr,
  DashboardRelease,
} from '../lib/dashboard/types.ts';
import { projectIdOf } from '../lib/tracker-reads.ts';
import { createFlowExtension } from '../server.ts';
import {
  NOT_A_PERSON,
  REPO,
  fakeCtx,
  fakeProjects,
  fakeRouter,
  makeWorld,
  type World,
} from './fixtures.ts';

/** The real extension folder, so the project's tracker reads as the adapter flow ships. */
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let world: World;
let clock: number;

beforeEach(() => {
  world = makeWorld();
  clock = Date.parse('2026-10-03T12:00:00.000Z');
});

afterEach(() => {
  world.cleanup();
});

/** Every tracker read through flow's CLI answers "did not answer"; the rest runs for real. */
const execOrFakeRead: ExecFileLike = (file, args, opts, callback) => {
  if (args.some((arg) => arg.endsWith(`${path.sep}flow.ts`))) {
    queueMicrotask(() => callback(Object.assign(new Error('no tracker'), { code: 4 }), '', ''));
    return undefined;
  }
  return (execFile as unknown as ExecFileLike)(file, args, opts, callback);
};

/** Write the project's committed config: a Linear team ACME, and a dashboard block. */
function configure(dashboard: unknown, root = world.main): void {
  mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true });
  writeFileSync(
    path.join(root, '.agents', 'flow', 'config.json'),
    JSON.stringify({
      tracker: 'linear',
      connection: { team: { key: 'ACME' }, transport: 'cli' },
      ...(dashboard === undefined ? {} : { dashboard }),
    })
  );
}

/** Write flow's tracker snapshot for the project, as the tracker reads do. */
function writeSnapshot(fetchedAt = '2026-10-03T11:58:00.000Z'): void {
  const dir = path.join(world.dorkHome, 'flow', 'cache', projectIdOf(world.main));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'snapshot.json'),
    JSON.stringify({
      v: 1,
      tracker: 'linear',
      team: { key: 'ACME', id: 't1', url: 'https://linear.app/acme-co/team/ACME' },
      fetchedAt,
      items: [
        {
          identifier: 'ACME-12',
          title: 'Export',
          stateCategory: 'started',
          stateName: 'In Progress',
          labels: [],
        },
      ],
      closed: [],
      projects: [],
    })
  );
}

/** An open PR as the forge reads it. */
function openPr(number: number, extra: Partial<OpenPr> = {}): OpenPr {
  return {
    number,
    title: `PR ${number} for ACME-${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    author: 'octo-agent',
    draft: false,
    createdAt: '2026-10-01T09:00:00Z',
    headRefName: 'branch',
    body: '',
    reviewDecision: null,
    reviewRequests: [],
    queued: false,
    queuePosition: null,
    armed: false,
    conflicting: false,
    failing: [],
    pendingChecks: 0,
    checkCount: 1,
    ...extra,
  };
}

/** A fake `GithubReads`: `acme/app` answers, `acme/broken` fails. */
function fakeReads(): GithubReads & { [K in keyof GithubReads]: ReturnType<typeof vi.fn> } {
  const fail = (repo: string) => {
    if (repo === 'acme/broken') throw new Error('reading acme/broken: HTTP 502');
  };
  return {
    openPrs: vi.fn(async (repo: string) => {
      fail(repo);
      return {
        viewer: 'octo-person',
        total: 2,
        prs: [openPr(41, { reviewRequests: ['octo-person'] }), openPr(40)],
      };
    }),
    openIssues: vi.fn(async (repo: string) => {
      fail(repo);
      return {
        viewer: 'octo-person',
        total: 1,
        issues: [
          {
            number: 7,
            title: 'Broken',
            url: `https://github.com/${repo}/issues/7`,
            author: 'x',
            assignees: [],
            labels: [],
            createdAt: null,
            updatedAt: null,
          },
        ],
      };
    }),
    releaseState: vi.fn(async (repo: string) => {
      fail(repo);
      return {
        defaultBranch: 'main',
        branchChecks: 'SUCCESS',
        latestRelease: {
          tagName: 'v1.4.0',
          name: 'v1.4.0',
          publishedAt: '2026-09-30T12:00:00Z',
          url: `https://github.com/${repo}/releases/tag/v1.4.0`,
        },
        latestTag: 'v1.4.0',
      };
    }),
    latestRun: vi.fn(async (_repo: string, workflow: string) => {
      if (workflow === 'gone.yml') throw new Error('HTTP 404: workflow gone.yml not found');
      return {
        id: 1,
        workflow: 'Publish',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        createdAt: '2026-10-03T10:00:00Z',
        url: `https://github.com/${REPO}/actions/runs/1`,
        branch: 'v1.4.0',
        event: 'push',
      };
    }),
    repoExists: vi.fn(async () => true as const),
  };
}

/** Build the extension over the fixture world, with `app` as core's one project. */
function setup(opts: { personGuard?: boolean } = {}) {
  const router = fakeRouter();
  const projects = fakeProjects([
    { root: world.main, name: 'app', originRepo: REPO, lastSeenAt: new Date(clock).toISOString() },
  ]);
  const host = fakeCtx(world, {
    extensionDir: EXTENSION_DIR,
    projects: projects.api,
    personGuard: opts.personGuard,
  });
  const reads = fakeReads();
  createFlowExtension(router, host.ctx, {
    now: () => new Date(clock),
    originOf: (cwd) => (cwd === world.main ? `https://github.com/${REPO}.git` : null),
    log: () => {},
    execFile: execOrFakeRead,
    pidAlive: () => true,
    githubReads: reads,
  });
  return { router, host, reads };
}

/** A dashboard route's body. */
async function get<T>(
  router: ReturnType<typeof fakeRouter>,
  kind: 'issues' | 'prs' | 'releases',
  query: Record<string, unknown> = {}
): Promise<DashboardBody<T>> {
  const sent = await router.call('get', `/dashboard/${kind}`, { query });
  expect(sent.status).toBe(200);
  return sent.body as DashboardBody<T>;
}

const BLOCK = {
  teams: ['ACME', 'OPS'],
  repos: ['acme/app', 'acme/broken'],
  products: [
    {
      id: 'app',
      repo: 'acme/app',
      versionFile: 'package.json',
      unreleased: 'changelog/unreleased',
      watchWorkflows: ['publish.yml', 'gone.yml'],
    },
    {
      id: 'site',
      repo: 'acme/site',
      versionFile: 'VERSION',
      unreleased: 'changes',
    },
  ],
};

describe('GET /dashboard', () => {
  it("lists each project's pages, and a project without the block as not set up", async () => {
    configure({ views: ['issues', 'prs'] });
    const { router } = setup();
    const sent = await router.call('get', '/dashboard');
    expect(sent.body as DashboardIndex).toEqual({
      projects: [{ name: 'app', configured: true, views: ['issues', 'prs'] }],
    });
    configure(undefined);
    expect(((await router.call('get', '/dashboard')).body as DashboardIndex).projects).toEqual([
      { name: 'app', configured: false, views: ['next', 'roadmap', 'issues', 'prs', 'releases'] },
    ]);
  });
});

describe('GET /dashboard/issues', () => {
  it("serves the project's own team from flow's snapshot and each repo, failing ones apart", async () => {
    configure(BLOCK);
    writeSnapshot();
    const { router } = setup();
    const body = await get<DashboardIssue>(router, 'issues');
    expect(body).toMatchObject({
      project: 'app',
      projects: ['app'],
      configured: true,
      problems: [],
      viewer: 'octo-person',
      teams: ['ACME', 'OPS'],
      repos: ['acme/app', 'acme/broken'],
      canRefresh: true,
    });
    expect(body.sources.map((s) => [s.id, s.fetchedAt, s.error])).toEqual([
      ['tracker:ACME', '2026-10-03T11:58:00.000Z', null],
      ['tracker:OPS', null, "Flow reads only this project's own team (ACME) so far."],
      ['github:acme/app', '2026-10-03T12:00:00.000Z', null],
      ['github:acme/broken', null, 'reading acme/broken: HTTP 502'],
    ]);
    expect(body.items.map((item) => item.key)).toEqual(['ACME-12', 'acme/app#7']);
  });

  it('says so when the tracker has not been read yet', async () => {
    configure({ teams: [] });
    const { router } = setup();
    const body = await get<DashboardIssue>(router, 'issues');
    expect(body.sources).toEqual([
      expect.objectContaining({
        id: 'tracker:ACME',
        error: "Flow hasn't read the tracker yet. Try again in a minute.",
      }),
    ]);
  });

  it('reads again only once the last read is over a minute old', async () => {
    configure({ teams: [], repos: ['acme/app'] });
    const { router, reads } = setup();
    await get(router, 'issues');
    clock += 30_000;
    await get(router, 'issues');
    expect(reads.openIssues).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await get(router, 'issues');
    expect(reads.openIssues).toHaveBeenCalledTimes(2);
  });
});

describe('GET /dashboard/prs', () => {
  it('answers each PR with its links from the configured keys and who it waits on', async () => {
    configure({ teams: ['ACME'], repos: ['acme/app'] });
    const { router, reads } = setup();
    const body = await get<DashboardPr>(router, 'prs', { project: 'app' });
    expect(body.items.map((pr) => [pr.id, pr.linked, pr.waitingOnYou])).toEqual([
      ['acme/app#41', ['ACME-41'], true],
      ['acme/app#40', ['ACME-40'], false],
    ]);
    expect(reads.openPrs).toHaveBeenCalledTimes(1);
  });
});

describe('GET /dashboard/releases', () => {
  it('maps the repo of this checkout to it, and says when a repo has none here', async () => {
    configure(BLOCK);
    mkdirSync(path.join(world.main, 'changelog', 'unreleased'), { recursive: true });
    writeFileSync(path.join(world.main, 'changelog', 'unreleased', 'a.md'), 'x');
    writeFileSync(path.join(world.main, 'package.json'), JSON.stringify({ version: '1.5.0' }));
    const { router, reads } = setup();
    const body = await get<DashboardRelease>(router, 'releases');
    const [app, site] = body.items;
    expect(app).toMatchObject({
      id: 'app',
      version: '1.4.0',
      fileVersion: '1.5.0',
      checkout: true,
      unreleased: 1,
      ci: { branch: 'main', state: 'passing' },
    });
    expect(app.workflows.map((w) => [w.name, w.state])).toEqual([
      ['Publish', 'passing'],
      ['gone.yml', 'error'],
    ]);
    expect(site).toMatchObject({
      checkout: false,
      unreleased: null,
      unreleasedNote: 'No local checkout of acme/site here.',
    });
    expect(reads.latestRun).toHaveBeenCalledTimes(2);
    expect(body.sources.map((s) => s.error)).toEqual([null, null]);
  });
});

describe('a project without a dashboard, a page switched off, and an unknown project', () => {
  it('answers no items and reads nothing', async () => {
    configure(undefined);
    const { router, reads } = setup();
    const body = await get(router, 'prs', { project: 'app' });
    expect([body.project, body.configured, body.items, body.sources]).toEqual([
      'app',
      false,
      [],
      [],
    ]);
    configure({ repos: ['acme/app'], views: ['issues'] });
    const off = await get(router, 'prs', { project: 'app' });
    expect([off.configured, off.views, off.items]).toEqual([true, ['issues'], []]);
    expect(reads.openPrs).not.toHaveBeenCalled();
  });

  it('refuses a project flow does not know, in words', async () => {
    configure(BLOCK);
    const { router } = setup();
    const sent = await router.call('get', '/dashboard/prs', { query: { project: 'gone' } });
    expect(sent).toEqual({
      status: 404,
      body: { error: 'No flow project is called gone on this computer.', refusedBy: 'flow' },
    });
  });

  it('names a wrong entry in the block and shows the rest', async () => {
    configure({ repos: ['acme/app', 'not a repo'] });
    const { router } = setup();
    const body = await get<DashboardPr>(router, 'prs');
    expect(body.problems).toEqual([
      'dashboard.repos[1] must be a GitHub repository as owner/name',
    ]);
    expect(body.items).toHaveLength(2);
  });
});

describe('POST /dashboard/refresh', () => {
  it('reads again at once for a person, and refuses an agent', async () => {
    configure({ teams: [], repos: ['acme/app'] });
    const { router, reads } = setup();
    await get(router, 'prs');
    const refused = await router.call('post', '/dashboard/refresh', {
      body: { project: 'app', kind: 'prs' },
      agent: true,
    });
    expect(refused).toEqual({ status: 403, body: { error: NOT_A_PERSON } });
    expect(reads.openPrs).toHaveBeenCalledTimes(1);
    const sent = await router.call('post', '/dashboard/refresh', {
      body: { project: 'app', kind: 'prs' },
    });
    expect(sent.status).toBe(200);
    expect((sent.body as DashboardBody<DashboardPr>).items).toHaveLength(2);
    expect(reads.openPrs).toHaveBeenCalledTimes(2);
  });

  it('refuses a page that does not exist', async () => {
    configure({ repos: ['acme/app'] });
    const { router } = setup();
    const sent = await router.call('post', '/dashboard/refresh', {
      body: { project: 'app', kind: 'roadmap' },
    });
    expect(sent.status).toBe(400);
  });

  it('is not registered on a DorkOS without the person guard, and the pages say so', async () => {
    configure({ repos: ['acme/app'] });
    const { router } = setup({ personGuard: false });
    expect(router.has('post', '/dashboard/refresh')).toBe(false);
    expect((await get(router, 'prs')).canRefresh).toBe(false);
  });
});

describe('an older DorkOS', () => {
  it('answers 501 host-too-old on every dashboard route', async () => {
    const router = fakeRouter();
    const host = fakeCtx(world, { dorkHome: false });
    createFlowExtension(router, host.ctx, { log: () => {} });
    for (const route of ['/dashboard', '/dashboard/issues', '/dashboard/prs', '/dashboard/releases']) {
      expect(await router.call('get', route)).toEqual({
        status: 501,
        body: { reason: 'host-too-old' },
      });
    }
    expect((await router.call('post', '/dashboard/refresh')).status).toBe(501);
  });
});
