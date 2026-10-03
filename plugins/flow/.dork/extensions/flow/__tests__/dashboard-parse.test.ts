/**
 * What the dashboard makes of what it reads (spec "Flow Dashboard", M1): the
 * tracker ids a PR names, with the keys from config and never a fixed prefix;
 * whether a review is asked of you; each PR's checks, review and queue; issues
 * from flow's tracker snapshot and from GitHub; and a product's release state:
 * its last tag, the changes not yet released, the checks on its branch and its
 * watched workflows.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenPr } from '../../../../scripts/forge/github.ts';
import {
  countUnreleased,
  githubIssues,
  trackerIssues,
  linkedKeys,
  readVersion,
  releaseOf,
  reviewAskedOf,
  toDashboardPr,
} from '../lib/dashboard/parse.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp folder. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-dash-parse-'));
  dirs.push(dir);
  return dir;
}

/** An open PR as the forge reads it. */
function pr(extra: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 41,
    title: 'Add the export button',
    url: 'https://github.com/acme/app/pull/41',
    author: 'octo-agent',
    draft: false,
    createdAt: '2026-10-01T09:00:00Z',
    headRefName: 'feature',
    body: '',
    reviewDecision: null,
    reviewRequests: [],
    queued: false,
    queuePosition: null,
    armed: false,
    conflicting: false,
    failing: [],
    pendingChecks: 0,
    checkCount: 2,
    ...extra,
  };
}

describe('linkedKeys', () => {
  it('finds the configured keys in a title, body and branch, once each, in order', () => {
    expect(
      linkedKeys(['Fix export (ACME-12)', 'Closes ACME-12 and OPS-3.', 'acme-14-export'], [
        'ACME',
        'OPS',
      ])
    ).toEqual(['ACME-12', 'OPS-3', 'ACME-14']);
  });

  it('never matches a prefix nobody configured, or a key inside a longer word', () => {
    expect(linkedKeys(['DOR-1 XACME-2 ACME-3x ACME-4'], ['ACME'])).toEqual(['ACME-4']);
  });

  it('matches the longer of two keys where one starts the other', () => {
    expect(linkedKeys(['ACME-5 AC-6'], ['ACME', 'AC'])).toEqual(['ACME-5', 'AC-6']);
  });

  it('finds nothing with no keys configured', () => {
    expect(linkedKeys(['ACME-12'], [])).toEqual([]);
  });
});

describe('reviewAskedOf', () => {
  it('is true only when your own login is asked, never for a team or someone else', () => {
    expect(reviewAskedOf(pr({ reviewRequests: ['octo-person'] }), 'octo-person')).toBe(true);
    expect(reviewAskedOf(pr({ reviewRequests: ['team:octo-person'] }), 'octo-person')).toBe(false);
    expect(reviewAskedOf(pr({ reviewRequests: ['someone'] }), 'octo-person')).toBe(false);
    expect(reviewAskedOf(pr({ reviewRequests: ['octo-person'] }), null)).toBe(false);
  });

  it('compares logins without regard to case, as GitHub does', () => {
    expect(reviewAskedOf(pr({ reviewRequests: ['Octo-Person'] }), 'octo-person')).toBe(true);
  });
});

describe('toDashboardPr', () => {
  const keys = ['ACME'];

  it('reads checks as failing, pending, passing or none', () => {
    const failing = { name: 'test', url: null };
    expect(toDashboardPr(pr({ failing: [failing] }), 'acme/app', null, keys).checks.state).toBe(
      'failing'
    );
    expect(toDashboardPr(pr({ pendingChecks: 1 }), 'acme/app', null, keys).checks.state).toBe(
      'pending'
    );
    expect(toDashboardPr(pr(), 'acme/app', null, keys).checks.state).toBe('passing');
    expect(toDashboardPr(pr({ checkCount: 0 }), 'acme/app', null, keys).checks.state).toBe('none');
  });

  it('says a review asked of you is waiting on you, and so is your own PR that is stuck', () => {
    const asked = toDashboardPr(pr({ reviewRequests: ['me'] }), 'acme/app', 'me', keys);
    expect([asked.reviewRequestedFromYou, asked.waitingOnYou]).toEqual([true, true]);
    const mine = (extra: Partial<OpenPr>) =>
      toDashboardPr(pr({ author: 'me', ...extra }), 'acme/app', 'me', keys).waitingOnYou;
    expect(mine({})).toBe(false);
    expect(mine({ reviewDecision: 'CHANGES_REQUESTED' })).toBe(true);
    expect(mine({ conflicting: true })).toBe(true);
    expect(mine({ failing: [{ name: 'test', url: null }] })).toBe(true);
    expect(mine({ draft: true, failing: [{ name: 'test', url: null }] })).toBe(false);
  });

  it('carries the queue, the review, the links and an id, but never the body', () => {
    const read = toDashboardPr(
      pr({
        queued: true,
        queuePosition: 2,
        armed: true,
        reviewDecision: 'APPROVED',
        body: 'Closes ACME-9',
      }),
      'acme/app',
      null,
      keys
    );
    expect(read).toMatchObject({
      id: 'acme/app#41',
      source: 'github:acme/app',
      repo: 'acme/app',
      review: 'approved',
      queue: { queued: true, position: 2, armed: true },
      linked: ['ACME-9'],
    });
    expect(JSON.stringify(read)).not.toContain('Closes');
  });

  it('keeps only a web address it can open', () => {
    expect(toDashboardPr(pr({ url: 'javascript:alert(1)' }), 'acme/app', null, keys).url).toBeNull();
  });
});

describe('trackerIssues', () => {
  /** A snapshot as `flow snapshot --json` writes it. */
  const snapshot = {
    v: 1,
    tracker: 'linear',
    team: { key: 'ACME', id: 't1', url: 'https://linear.app/acme-co/team/ACME' },
    fetchedAt: '2026-10-03T11:00:00.000Z',
    items: [
      {
        identifier: 'ACME-12',
        title: 'Export <b>bold</b>',
        stateCategory: 'started',
        stateName: 'In Progress',
        labels: ['type/task', 'agent/needs-input'],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        identifier: 'ACME-13',
        title: 'Later',
        stateCategory: 'backlog',
        stateName: 'Backlog',
        labels: [],
      },
      { identifier: 'OPS-1', title: "Another team's", stateCategory: 'unstarted', labels: [] },
      { title: 'no identifier' },
    ],
    closed: [],
    projects: [],
  };

  it("lists the team's open items with an address built from the team's page", () => {
    const { fetchedAt, items } = trackerIssues(snapshot, 'ACME');
    expect(fetchedAt).toBe('2026-10-03T11:00:00.000Z');
    expect(items.map((item) => [item.key, item.state, item.waitingOnYou, item.url])).toEqual([
      ['ACME-12', 'in-progress', true, 'https://linear.app/acme-co/issue/ACME-12'],
      ['ACME-13', 'backlog', false, 'https://linear.app/acme-co/issue/ACME-13'],
    ]);
    expect(items[0].title).toBe('Export <b>bold</b>');
    expect(items[0].labels).toEqual(['type/task', 'agent/needs-input']);
  });

  it('refuses a snapshot of another team', () => {
    expect(() => trackerIssues(snapshot, 'OPS')).toThrow(/ACME, not OPS/);
  });
});

describe('githubIssues', () => {
  it('marks an issue assigned to you as waiting on you', () => {
    const items = githubIssues(
      {
        viewer: 'me',
        total: 2,
        issues: [
          {
            number: 7,
            title: 'Broken',
            url: 'https://github.com/acme/app/issues/7',
            author: 'x',
            assignees: ['me'],
            labels: ['bug'],
            createdAt: null,
            updatedAt: null,
          },
          {
            number: 6,
            title: 'Typo',
            url: 'https://github.com/acme/app/issues/6',
            author: null,
            assignees: [],
            labels: [],
            createdAt: null,
            updatedAt: null,
          },
        ],
      },
      'acme/app'
    );
    expect(items.map((item) => [item.key, item.waitingOnYou, item.assignee, item.state])).toEqual([
      ['acme/app#7', true, 'me', 'todo'],
      ['acme/app#6', false, null, 'todo'],
    ]);
  });
});

describe('a release', () => {
  it('reads a version from a JSON file, and from text', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.4.0' }));
    writeFileSync(path.join(dir, 'VERSION'), 'release 2.0.0-rc.1\n');
    expect(readVersion(path.join(dir, 'package.json'))).toBe('1.4.0');
    expect(readVersion(path.join(dir, 'VERSION'))).toBe('2.0.0-rc.1');
    expect(readVersion(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('counts the changes waiting in the unreleased folder, not its README or hidden files', () => {
    const dir = tempDir();
    const unreleased = path.join(dir, 'changelog', 'unreleased');
    mkdirSync(path.join(unreleased, 'sub'), { recursive: true });
    for (const name of ['a.md', 'b.md', 'README.md', '.gitkeep']) {
      writeFileSync(path.join(unreleased, name), 'x');
    }
    expect(countUnreleased(unreleased)).toBe(2);
    expect(countUnreleased(path.join(dir, 'nope'))).toBeNull();
  });

  it('puts the tag, the local version, the count, the branch checks and each workflow together', () => {
    const release = releaseOf({
      product: {
        id: 'app',
        repo: 'acme/app',
        versionFile: 'package.json',
        unreleased: 'changelog/unreleased',
        watchWorkflows: ['publish.yml', 'gone.yml'],
      },
      state: {
        defaultBranch: 'main',
        branchChecks: 'FAILURE',
        latestRelease: {
          tagName: 'v1.4.0',
          name: 'v1.4.0',
          publishedAt: '2026-09-30T12:00:00Z',
          url: 'https://github.com/acme/app/releases/tag/v1.4.0',
        },
        latestTag: 'v1.4.1-rc.1',
      },
      local: { checkout: true, fileVersion: '1.5.0', unreleased: 3, unreleasedNote: null },
      workflows: [
        {
          name: 'publish.yml',
          run: {
            id: 900,
            workflow: 'Publish',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            createdAt: '2026-10-03T12:22:26Z',
            url: 'https://github.com/acme/app/actions/runs/900',
            branch: 'v1.4.0',
            event: 'push',
          },
          error: null,
        },
        { name: 'gone.yml', run: null, error: 'HTTP 404: workflow gone.yml not found' },
      ],
    });
    expect(release).toMatchObject({
      id: 'app',
      source: 'product:app',
      repo: 'acme/app',
      lastRelease: { tag: 'v1.4.0', publishedAt: '2026-09-30T12:00:00Z' },
      lastTag: 'v1.4.1-rc.1',
      version: '1.4.0',
      fileVersion: '1.5.0',
      checkout: true,
      unreleased: 3,
      ci: { branch: 'main', state: 'failing' },
    });
    expect(release.workflows).toEqual([
      {
        name: 'Publish',
        state: 'passing',
        url: 'https://github.com/acme/app/actions/runs/900',
        at: '2026-10-03T12:22:26Z',
        error: null,
      },
      {
        name: 'gone.yml',
        state: 'error',
        url: null,
        at: null,
        error: 'HTTP 404: workflow gone.yml not found',
      },
    ]);
  });

  it('reads a running workflow, one that never ran, and a repository with no release', () => {
    const release = releaseOf({
      product: {
        id: 'site',
        repo: 'acme/site',
        versionFile: 'VERSION',
        unreleased: 'changes',
        watchWorkflows: [],
      },
      state: { defaultBranch: 'main', branchChecks: 'PENDING', latestRelease: null, latestTag: null },
      local: { checkout: false, fileVersion: null, unreleased: null, unreleasedNote: 'No local checkout' },
      workflows: [
        {
          name: 'deploy.yml',
          run: {
            id: 1,
            workflow: 'Deploy',
            status: 'IN_PROGRESS',
            conclusion: null,
            createdAt: null,
            url: null,
            branch: 'main',
            event: 'push',
          },
          error: null,
        },
        { name: 'never.yml', run: null, error: null },
      ],
    });
    expect([release.version, release.ci.state, release.unreleasedNote]).toEqual([
      null,
      'pending',
      'No local checkout',
    ]);
    expect(release.workflows.map((w) => w.state)).toEqual(['running', 'never']);
  });
});
