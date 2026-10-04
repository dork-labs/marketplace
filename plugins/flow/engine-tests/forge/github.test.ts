/**
 * The GitHub forge (spec `flow-handoff-dispatch` §4.6, task 3.2): every `gh`
 * call is an argv array through the injected runner, and parsing is checked
 * against `gh` output recorded from dork-labs/marketplace and dork-labs/dorkos
 * (`engine-tests/fixtures/forge/`). Recorded verbatim: `pr-view-merged.json`
 * (#67), `pr-view-open.json` (#69), `pr-list.json`, `graphql-in-merge-queue.json`,
 * `git-ref.json`, `run-list-dorkos-failures.json`; the jobs file
 * keeps only the five job fields read. The failing, armed, queued and closed
 * views are the recorded open view with one field changed, in the shapes GitHub
 * uses for them (a `StatusContext` entry, an `autoMergeRequest` object).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ProcessOptions, ProcessResult } from '../../scripts/cli/context.ts';
import { ConfigError, EXIT } from '../../scripts/errors.ts';
import {
  createGithubForge,
  failingChecks,
  parsePrView,
  parseRequiredChecks,
  pendingChecks,
  reportedChecks,
} from '../../scripts/forge/github.ts';
import { ForgeError, forgeTargetFor } from '../../scripts/forge/types.ts';
import { parsePrView as parseForConflict } from '../../scripts/forge/github.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/forge');

/** A recorded fixture, parsed. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;
}

/** The recorded open PR view with some fields replaced. */
function openView(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(fixture('pr-view-open.json') as Record<string, unknown>), ...patch };
}

type Reply = ProcessResult | ((args: readonly string[]) => ProcessResult);

/** A fake `gh`: each call is matched by the first argv words; calls are recorded. */
function fakeGh(replies: Record<string, Reply>) {
  const calls: { cmd: string; args: readonly string[]; opts?: ProcessOptions }[] = [];
  const runProcess = async (cmd: string, args: readonly string[], opts?: ProcessOptions) => {
    calls.push({ cmd, args, opts });
    const key = Object.keys(replies)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(' ').startsWith(k));
    if (key === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    const reply = replies[key];
    return typeof reply === 'function' ? reply(args) : reply;
  };
  return { calls, runProcess };
}

/** A successful gh call printing `value` as JSON. */
function ok(value: unknown): ProcessResult {
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

const target = { host: 'github.com', repo: 'dork-labs/marketplace' };
const NOW = new Date('2026-09-26T16:30:00Z');

function forgeWith(replies: Record<string, Reply>) {
  const gh = fakeGh(replies);
  return { gh, forge: createGithubForge({ target, runProcess: gh.runProcess, now: () => NOW }) };
}

const notQueued = { 'api graphql': ok(fixture('graphql-in-merge-queue.json')) };

// Found live (2026-09-27): a PR in conflict with its base runs no checks, so
// only the forge's mergeable fields can say why nothing moves. Fails if they are
// not read.
describe('parsePrView: a conflict with the base', () => {
  it('reads CONFLICTING or DIRTY as conflicting, and anything else as not', () => {
    const base = { state: 'OPEN', headRefOid: 'abc', baseRefName: 'main', statusCheckRollup: [] };
    expect(parseForConflict({ ...base, mergeable: 'CONFLICTING' }, false, 'r#1').conflicting).toBe(
      true
    );
    expect(parseForConflict({ ...base, mergeStateStatus: 'DIRTY' }, false, 'r#1').conflicting).toBe(
      true
    );
    expect(
      parseForConflict({ ...base, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, false, 'r#1')
        .conflicting
    ).toBe(false);
  });
});

describe('prStatus parses recorded gh pr view output', () => {
  // A merged PR reads as merged with nothing failing, and asks no queue question.
  it('merged', async () => {
    const { gh, forge } = forgeWith({ 'pr view': ok(fixture('pr-view-merged.json')) });
    const status = await forge.prStatus(67);
    expect(status).toMatchObject({ state: 'merged', failing: [], armed: false, queued: false });
    expect(status.headSha).toBe('814a696d7c68ea81096eba897bb46f1096deb4a9');
    expect(gh.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['pr view']);
    expect(gh.calls[0]).toMatchObject({
      cmd: 'gh',
      args: [
        'pr',
        'view',
        '67',
        '-R',
        'dork-labs/marketplace',
        '--json',
        'state,autoMergeRequest,statusCheckRollup,headRefOid,baseRefName,mergeable,mergeStateStatus',
      ],
    });
  });

  // A closed-without-merge PR reads as closed.
  it('closed', async () => {
    const { forge } = forgeWith({ 'pr view': ok(openView({ state: 'CLOSED' })) });
    expect((await forge.prStatus(69)).state).toBe('closed');
  });

  // An open, green, unarmed, unqueued PR is "neither armed nor queued".
  it('neither armed nor queued', async () => {
    const { forge } = forgeWith({ 'pr view': ok(fixture('pr-view-open.json')), ...notQueued });
    expect(await forge.prStatus(69)).toMatchObject({
      state: 'open',
      failing: [],
      armed: false,
      queued: false,
      base: 'main',
    });
  });

  // A failing check run is reported by name with its link.
  it('failing check run', async () => {
    const rollup = (fixture('pr-view-open.json') as { statusCheckRollup: object[] })
      .statusCheckRollup;
    const view = openView({
      statusCheckRollup: rollup.map((c, i) => (i === 0 ? { ...c, conclusion: 'FAILURE' } : c)),
    });
    const { forge } = forgeWith({ 'pr view': ok(view), ...notQueued });
    const status = await forge.prStatus(69);
    expect(status.failing).toEqual([
      {
        name: 'flow plugin',
        url: 'https://github.com/dork-labs/marketplace/actions/runs/36256800779/job/108445005479',
      },
    ]);
  });

  // A failing commit status (state ERROR, named by context) counts too; a pending one does not.
  it('failing commit status', () => {
    const failing = failingChecks([
      { __typename: 'StatusContext', context: 'Vercel', state: 'ERROR', targetUrl: 'https://v' },
      { __typename: 'StatusContext', context: 'Preview', state: 'PENDING', targetUrl: 'https://p' },
      { __typename: 'CheckRun', name: 'lint', conclusion: 'CANCELLED', detailsUrl: 'https://l' },
      { __typename: 'CheckRun', name: 'slow', conclusion: '', status: 'IN_PROGRESS' },
    ]);
    expect(failing).toEqual([
      { name: 'Vercel', url: 'https://v' },
      { name: 'lint', url: 'https://l' },
    ]);
  });

  // An autoMergeRequest object means armed.
  it('armed', async () => {
    const view = openView({
      autoMergeRequest: { enabledAt: '2026-09-26T16:43:35Z', mergeMethod: 'MERGE' },
    });
    const { forge } = forgeWith({ 'pr view': ok(view), ...notQueued });
    expect(await forge.prStatus(69)).toMatchObject({ armed: true, queued: false });
  });

  // isInMergeQueue true means queued, read through GraphQL with typed variables.
  it('queued', async () => {
    const { gh, forge } = forgeWith({
      'pr view': ok(fixture('pr-view-open.json')),
      'api graphql': ok({ data: { repository: { pullRequest: { isInMergeQueue: true } } } }),
    });
    expect(await forge.prStatus(69)).toMatchObject({ armed: false, queued: true });
    const graphql = gh.calls[1].args;
    expect(graphql).toContain('owner=dork-labs');
    expect(graphql).toContain('name=marketplace');
    expect(graphql).toContain('number=69');
  });

  // A read gh cannot answer, or an answer with no state, is a forge error (exit 4), never "merged".
  it('unreadable reads are errors', async () => {
    const failing = forgeWith({
      'pr view': { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a Repository' },
    });
    await expect(failing.forge.prStatus(1)).rejects.toMatchObject({
      exitCode: EXIT.tracker,
      message: expect.stringContaining('Could not resolve'),
    });
    expect(() => parsePrView({ headRefOid: 'x' }, false, 'r#1')).toThrow(ForgeError);
  });
});

describe('the other gh calls', () => {
  // prForBranch lists open PRs on the head branch and returns the first.
  it('prForBranch', async () => {
    const { gh, forge } = forgeWith({ 'pr list': ok(fixture('pr-list.json')) });
    expect(await forge.prForBranch('DOR-2391-runtime-journal')).toEqual({
      number: 67,
      url: 'https://github.com/dork-labs/marketplace/pull/67',
      headSha: '814a696d7c68ea81096eba897bb46f1096deb4a9',
    });
    expect(gh.calls[0].args).toEqual([
      'pr',
      'list',
      '-R',
      'dork-labs/marketplace',
      '--head',
      'DOR-2391-runtime-journal',
      '--state',
      'open',
      '--json',
      'number,url,headRefOid',
    ]);
    const none = forgeWith({ 'pr list': ok([]) });
    expect(await none.forge.prForBranch('x')).toBeNull();
  });

  // branchHead reads the ref; a 404 means no branch.
  it('branchHead', async () => {
    const { forge } = forgeWith({ api: ok(fixture('git-ref.json')) });
    expect(await forge.branchHead('main')).toBe('b47596a30ae2c72a5715cf5b6156fef448d5c6b1');
    const missing = forgeWith({ api: { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } });
    expect(await missing.forge.branchHead('gone')).toBeNull();
  });

  // createPr passes the body through a file and reads the number from the printed URL.
  it('createPr', async () => {
    let body = '';
    const { gh, forge } = forgeWith({
      'pr create': (args) => {
        body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        return {
          code: 0,
          stdout: 'https://github.com/dork-labs/marketplace/pull/70\n',
          stderr: '',
        };
      },
    });
    const pr = await forge.createPr({ head: 'b', base: 'main', title: 'T', body: 'Body' });
    expect(pr).toEqual({
      number: 70,
      url: 'https://github.com/dork-labs/marketplace/pull/70',
      headSha: null,
    });
    expect(body).toBe('Body');
    expect(gh.calls[0].args.slice(0, 10)).toEqual([
      'pr',
      'create',
      '-R',
      'dork-labs/marketplace',
      '--head',
      'b',
      '--base',
      'main',
      '--title',
      'T',
    ]);
  });

  // arm and disarm are gh pr merge --auto / --disable-auto; arm is tied to the
  // reviewed commit with --match-head-commit, so a later push cannot merge.
  it('arm and disarm', async () => {
    const { gh, forge } = forgeWith({ 'pr merge': ok('') });
    await forge.arm(5, 'abc123');
    await forge.disarm(5);
    expect(gh.calls.map((c) => c.args)).toEqual([
      [
        'pr',
        'merge',
        '5',
        '-R',
        'dork-labs/marketplace',
        '--auto',
        '--match-head-commit',
        'abc123',
      ],
      ['pr', 'merge', '5', '-R', 'dork-labs/marketplace', '--disable-auto'],
    ]);
  });

  // Spec flow-multiproject §7.5: a person's verdict at the review gate lands on
  // the PR, except that GitHub refuses a review of one's own PR: then an
  // approval posts nothing (the tracker comment is the record) and a request
  // for changes becomes a plain comment. The body goes through a file, never
  // the command line.
  it('review approves or requests changes, and never reviews its own PR', async () => {
    const bodies: string[] = [];
    const capture = (args: readonly string[]) => {
      bodies.push(readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'));
      return ok('');
    };
    const as = (viewer: string) =>
      forgeWith({
        'pr view': ok({ author: { login: 'author-a' } }),
        'api user': { code: 0, stdout: `${viewer}\n`, stderr: '' },
        'pr review': capture,
        'pr comment': capture,
      });

    const other = as('reviewer-b');
    expect(await other.forge.review(5, { event: 'approve', body: 'Shipped from DorkOS.' })).toBe(
      'reviewed'
    );
    expect(other.gh.calls.at(-1)?.args.slice(0, 6)).toEqual([
      'pr',
      'review',
      '5',
      '-R',
      'dork-labs/marketplace',
      '--approve',
    ]);
    expect(
      await other.forge.review(5, { event: 'request-changes', body: 'Rename the flag.' })
    ).toBe('reviewed');
    expect(other.gh.calls.at(-1)?.args).toContain('--request-changes');

    const own = as('author-a');
    expect(await own.forge.review(5, { event: 'approve', body: 'x' })).toBe('skipped');
    expect(own.gh.calls.some((c) => c.args[1] === 'review')).toBe(false);
    expect(await own.forge.review(5, { event: 'request-changes', body: 'Fix it.' })).toBe(
      'commented'
    );
    expect(own.gh.calls.at(-1)?.args.slice(0, 3)).toEqual(['pr', 'comment', '5']);
    expect(bodies).toEqual(['Shipped from DorkOS.', 'Rename the flag.', 'Fix it.']);
  });

  // Review finding 11: "the checks passed" needs the running ones counted too;
  // only a finished check run or a settled commit status is done.
  it('counts the checks that have not finished', () => {
    expect(
      pendingChecks(
        (fixture('pr-view-open.json') as { statusCheckRollup: unknown }).statusCheckRollup
      )
    ).toBe(0);
    expect(
      pendingChecks([
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', status: 'QUEUED', conclusion: '' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'PENDING' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ])
    ).toBe(3);
    // Re-review N3: no checks at all have not passed (they may not have
    // registered yet), and an unreadable rollup is no better.
    expect(pendingChecks([])).toBe(1);
    expect(pendingChecks(undefined)).toBe(1);
  });

  // recentGroupFailures reads failed merge-group runs in the window and their failing jobs.
  it('recentGroupFailures', async () => {
    const { gh, forge } = forgeWith({
      'run list': ok(fixture('run-list-dorkos-failures.json')),
      'run view': ok(fixture('run-view-jobs-failing.json')),
    });
    const groups = await forge.recentGroupFailures('main', [], 30);
    expect(groups).toEqual([
      { pr: 2148, prs: [2148], failing: ['browser-shard (2/3)', 'browser-test'] },
    ]);
    expect(gh.calls[0].args).toEqual([
      'run',
      'list',
      '-R',
      'dork-labs/marketplace',
      '--event',
      'merge_group',
      '--limit',
      '100',
      '--json',
      'databaseId,headBranch,conclusion,createdAt',
    ]);
    // Only the one run inside the 30-minute window was opened.
    expect(gh.calls.filter((c) => c.args[1] === 'view')).toHaveLength(1);
    const narrowed = await forge.recentGroupFailures('main', ['browser-test'], 30);
    expect(narrowed[0].failing).toEqual(['browser-test']);
  });

  // A group that started from the same base commit as another may hold that PR too.
  it('groups on one base commit may hold each other', async () => {
    const base = 'c353602d84ab09c20b4aad131d5b8b4d0dba38a1';
    const { forge } = forgeWith({
      'run list': ok([
        {
          databaseId: 1,
          headBranch: `gh-readonly-queue/main/pr-10-${base}`,
          conclusion: 'failure',
          createdAt: '2026-09-26T16:20:00Z',
        },
        {
          databaseId: 2,
          headBranch: `gh-readonly-queue/main/pr-11-${base}`,
          conclusion: 'success',
          createdAt: '2026-09-26T16:21:00Z',
        },
        {
          databaseId: 3,
          headBranch: 'gh-readonly-queue/release/pr-12-abc',
          conclusion: 'failure',
          createdAt: '2026-09-26T16:21:00Z',
        },
      ]),
      'run view': ok({ jobs: [{ name: 'test', conclusion: 'failure' }] }),
    });
    expect(await forge.recentGroupFailures('main', [], 30)).toEqual([
      { pr: 10, prs: [10, 11], failing: ['test'] },
    ]);
  });
});

describe('forgeTargetFor', () => {
  // Every common GitHub remote form resolves to owner/name.
  it('parses GitHub remotes', () => {
    for (const url of [
      'https://github.com/dork-labs/marketplace.git',
      'https://github.com/dork-labs/marketplace',
      'git@github.com:dork-labs/marketplace.git',
      'ssh://git@github.com/dork-labs/marketplace.git',
    ]) {
      expect(forgeTargetFor(url, {})).toEqual({
        host: 'github.com',
        repo: 'dork-labs/marketplace',
      });
    }
    expect(forgeTargetFor('git@ghe.example.com:a/b.git', { GH_HOST: 'ghe.example.com' })).toEqual({
      host: 'ghe.example.com',
      repo: 'a/b',
    });
  });

  // Anything not on GitHub is a config error (exit 3) with the spec's sentence.
  it('refuses other forges', () => {
    expect(() => forgeTargetFor('git@gitlab.com:a/b.git', {})).toThrow(ConfigError);
    expect(() => forgeTargetFor('/tmp/origin.git', {})).toThrow(
      'flow drain supports GitHub only today'
    );
  });
});

// DOR-2535: a repo with no CI reports no checks at all, and flow's reviewer
// agent may count that as passed only when the base requires none. The rules
// and branch answers are trimmed from what GitHub returned on 2026-10-03 for
// dork-labs/marketplace (a ruleset requiring three checks, classic protection
// off) and dork-labs/loop (nothing required).
describe('required checks and reported checks', () => {
  const marketplaceRules = [
    { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [
          { context: 'flow plugin', integration_id: 15368 },
          { context: 'skills and manifests', integration_id: 15368 },
          { context: 'script fixtures', integration_id: 15368 },
        ],
      },
    },
    { type: 'deletion' },
  ];
  const off = {
    protected: true,
    protection: {
      enabled: false,
      required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' },
    },
  };

  it('reads a ruleset, ignores classic protection that is off, and reads none as empty', () => {
    expect(parseRequiredChecks(marketplaceRules, off)).toEqual([
      'flow plugin',
      'script fixtures',
      'skills and manifests',
    ]);
    expect(parseRequiredChecks([], { ...off, protected: false })).toEqual([]);
  });

  it('reads classic protection when it is enforced, deduplicated with the rules', () => {
    const classic = {
      protected: true,
      protection: {
        enabled: true,
        required_status_checks: {
          enforcement_level: 'non_admins',
          contexts: ['build', 'flow plugin'],
          checks: [{ context: 'lint', app_id: 1 }],
        },
      },
    };
    expect(parseRequiredChecks(marketplaceRules, classic)).toEqual([
      'build',
      'flow plugin',
      'lint',
      'script fixtures',
      'skills and manifests',
    ]);
  });

  it('says it cannot tell when an answer is not in a shape it knows', () => {
    expect(parseRequiredChecks({ message: 'Not Found' }, off)).toBeNull();
    expect(parseRequiredChecks([], [])).toBeNull();
    expect(
      parseRequiredChecks([{ type: 'required_status_checks', parameters: {} }], off)
    ).toBeNull();
  });

  it('counts reported checks, and never reads an unreadable rollup as none', () => {
    expect(reportedChecks([])).toBe(0);
    expect(reportedChecks([{}, {}])).toBe(2);
    expect(reportedChecks(undefined)).toBeUndefined();
    const view = parsePrView(
      { state: 'OPEN', headRefOid: 'abc', baseRefName: 'main', statusCheckRollup: [] },
      false,
      'r#1'
    );
    expect(view).toMatchObject({ checksReported: 0, pendingChecks: 1 });
  });

  it('asks gh for the rules and the branch of the base', async () => {
    const { gh, forge } = forgeWith({
      'api repos/dork-labs/marketplace/rules/branches/main': ok([]),
      'api repos/dork-labs/marketplace/branches/main': ok({ ...off, protected: false }),
    });
    expect(await forge.requiredChecks?.('main')).toEqual([]);
    expect(gh.calls.map((c) => c.args.join(' '))).toEqual([
      'api repos/dork-labs/marketplace/rules/branches/main',
      'api repos/dork-labs/marketplace/branches/main',
    ]);
  });
});
