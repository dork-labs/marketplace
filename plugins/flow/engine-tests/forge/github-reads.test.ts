/**
 * The GitHub reads behind Flow's dashboard (spec "Flow Dashboard", M1): open
 * pull requests and issues in one GraphQL call per repository, a repository's
 * release state in one more, and the latest run of a workflow. Every call is an
 * argv array with a timeout through the injected runner. The fixtures under
 * `engine-tests/fixtures/forge/` keep the exact shapes `gh api graphql` and
 * `gh run list --json` returned live (checked 2026-10-03), with placeholder
 * names and values.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ProcessOptions, ProcessResult } from '../../scripts/cli/context.ts';
import {
  createGithubReads,
  parseLatestRun,
  parseOpenIssues,
  parseOpenPrs,
  parseReleaseState,
} from '../../scripts/forge/github.ts';
import { ForgeError } from '../../scripts/forge/types.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/forge');

/** A recorded-shape fixture, parsed. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;
}

/** A fake `gh` that answers by the first argv words and records each call. */
function fakeGh(replies: Record<string, ProcessResult>) {
  const calls: { cmd: string; args: readonly string[]; opts?: ProcessOptions }[] = [];
  const runProcess = async (cmd: string, args: readonly string[], opts?: ProcessOptions) => {
    calls.push({ cmd, args, opts });
    const key = Object.keys(replies)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(' ').startsWith(k));
    if (key === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    return replies[key];
  };
  return { calls, runProcess };
}

/** A successful gh call printing `value` as JSON. */
function ok(value: unknown): ProcessResult {
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

describe('parseOpenPrs', () => {
  const list = parseOpenPrs(fixture('graphql-open-prs.json'), 'acme/app');

  it('reads who is signed in and how many PRs are open', () => {
    expect(list.viewer).toBe('octo-person');
    expect(list.total).toBe(4);
    expect(list.prs.map((pr) => pr.number)).toEqual([41, 40, 39, 38]);
  });

  it('reads checks with the forge rule: failing by conclusion, pending by status', () => {
    const [failing, pending, none, green] = list.prs;
    expect(failing.failing).toEqual([
      { name: 'test', url: 'https://github.com/acme/app/actions/runs/1/job/2' },
    ]);
    expect(pending.failing).toEqual([]);
    expect(pending.pendingChecks).toBe(1);
    expect(none.checkCount).toBe(0);
    expect(green.failing).toEqual([]);
    expect(green.pendingChecks).toBe(0);
  });

  it('reads review requests by login, a team as team:<slug>, and the review decision', () => {
    const [first, second, third, fourth] = list.prs;
    expect(first.reviewRequests).toEqual(['octo-person', 'team:maintainers']);
    expect([first, second, third, fourth].map((pr) => pr.reviewDecision)).toEqual([
      'REVIEW_REQUIRED',
      'APPROVED',
      null,
      'CHANGES_REQUESTED',
    ]);
  });

  it('reads the merge queue, auto-merge, drafts, conflicts and a missing author', () => {
    const [first, queued, draft] = list.prs;
    expect([queued.queued, queued.queuePosition, queued.armed]).toEqual([true, 2, true]);
    expect([first.queued, first.queuePosition, first.armed]).toEqual([false, null, false]);
    expect([draft.draft, draft.conflicting, draft.author]).toEqual([true, true, null]);
    expect(first.body).toBe('Closes ACME-12. Also touches OPS-3.');
    expect(first.headRefName).toBe('acme-12-export');
  });

  it('refuses an answer with no repository rather than reading it as no PRs', () => {
    expect(() => parseOpenPrs({ data: { repository: null } }, 'acme/gone')).toThrow(ForgeError);
    expect(() => parseOpenPrs({ errors: [{ message: 'x' }] }, 'acme/app')).toThrow(/acme\/app/);
  });
});

describe('parseOpenIssues', () => {
  it('reads each issue with its assignees and labels, as written', () => {
    const list = parseOpenIssues(fixture('graphql-open-issues.json'), 'acme/app');
    expect(list.viewer).toBe('octo-person');
    expect(list.total).toBe(2);
    expect(list.issues[0]).toEqual({
      number: 7,
      title: 'Export fails on <script>alert(1)</script> names',
      url: 'https://github.com/acme/app/issues/7',
      author: 'a-reporter',
      assignees: ['octo-person'],
      labels: ['bug'],
      createdAt: '2026-09-29T09:00:00Z',
      updatedAt: '2026-10-01T09:00:00Z',
    });
    expect(list.issues[1].author).toBeNull();
  });

  it('refuses an answer with no repository', () => {
    expect(() => parseOpenIssues({ data: { repository: null } }, 'acme/gone')).toThrow(ForgeError);
  });
});

describe('parseReleaseState', () => {
  it('reads the default branch and its checks, the latest release and the newest tag', () => {
    expect(parseReleaseState(fixture('graphql-release-state.json'), 'acme/app')).toEqual({
      defaultBranch: 'main',
      branchChecks: 'FAILURE',
      latestRelease: {
        tagName: 'v1.4.0',
        name: 'v1.4.0',
        publishedAt: '2026-09-30T12:00:00Z',
        url: 'https://github.com/acme/app/releases/tag/v1.4.0',
      },
      latestTag: 'v1.4.1-rc.1',
    });
  });

  it('reads a repository with no releases, tags or checks', () => {
    const empty = {
      data: {
        repository: {
          defaultBranchRef: { name: 'main', target: { oid: 'a', statusCheckRollup: null } },
          latestRelease: null,
          refs: { nodes: [] },
        },
      },
    };
    expect(parseReleaseState(empty, 'acme/app')).toEqual({
      defaultBranch: 'main',
      branchChecks: null,
      latestRelease: null,
      latestTag: null,
    });
  });
});

describe('parseLatestRun', () => {
  it('reads the newest run, with its state in capitals as the rest of the forge has it', () => {
    expect(parseLatestRun(fixture('run-list-workflow.json'))).toEqual({
      id: 900,
      workflow: 'Publish',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      createdAt: '2026-10-03T12:22:26Z',
      url: 'https://github.com/acme/app/actions/runs/900',
      branch: 'v1.4.0',
      event: 'push',
    });
  });

  it('reads a workflow that never ran as null', () => {
    expect(parseLatestRun([])).toBeNull();
  });
});

describe('createGithubReads', () => {
  it('reads open PRs in one GraphQL call with a timeout, never through a shell string', async () => {
    const gh = fakeGh({ 'api graphql': ok(fixture('graphql-open-prs.json')) });
    const reads = createGithubReads({ runProcess: gh.runProcess });
    const list = await reads.openPrs('acme/app');
    expect(list.prs).toHaveLength(4);
    expect(gh.calls).toHaveLength(1);
    const [call] = gh.calls;
    expect(call.cmd).toBe('gh');
    expect(call.opts?.timeoutMs).toBeGreaterThan(0);
    expect(call.args).toEqual(
      expect.arrayContaining(['-f', 'owner=acme', '-f', 'name=app', '-F', 'first=50'])
    );
    expect(call.args.find((arg) => arg.startsWith('query='))).toMatch(/pullRequests\(states:OPEN/);
  });

  it('reads open issues and the release state in one call each', async () => {
    const gh = fakeGh({ 'api graphql': ok(fixture('graphql-open-issues.json')) });
    const reads = createGithubReads({ runProcess: gh.runProcess });
    expect((await reads.openIssues('acme/app')).issues).toHaveLength(2);
    const release = fakeGh({ 'api graphql': ok(fixture('graphql-release-state.json')) });
    expect(
      (await createGithubReads({ runProcess: release.runProcess }).releaseState('acme/app'))
        .defaultBranch
    ).toBe('main');
    expect(gh.calls.length + release.calls.length).toBe(2);
  });

  it('asks gh run list for one run of the named workflow', async () => {
    const gh = fakeGh({ 'run list': ok(fixture('run-list-workflow.json')) });
    const run = await createGithubReads({ runProcess: gh.runProcess }).latestRun(
      'acme/app',
      'publish.yml'
    );
    expect(run?.conclusion).toBe('SUCCESS');
    expect(gh.calls[0].args).toEqual([
      'run',
      'list',
      '-R',
      'acme/app',
      '--workflow',
      'publish.yml',
      '--limit',
      '1',
      '--json',
      'databaseId,workflowName,status,conclusion,createdAt,url,headBranch,event',
    ]);
  });

  it("says what gh said when a read fails, and how to fix gh when it can't run", async () => {
    const failing = fakeGh({
      'run list': { code: 1, stdout: '', stderr: 'HTTP 404: workflow nope.yml not found\n' },
    });
    await expect(
      createGithubReads({ runProcess: failing.runProcess }).latestRun('acme/app', 'nope.yml')
    ).rejects.toThrow(/HTTP 404: workflow nope.yml not found/);
    const missing = createGithubReads({
      runProcess: async () => {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(missing.openPrs('acme/app')).rejects.toThrow(/gh auth login/);
  });

  it('says whether a repository exists, from gh repo view', async () => {
    const gh = fakeGh({
      'repo view acme/app': ok({ nameWithOwner: 'acme/app' }),
      'repo view acme/gone': {
        code: 1,
        stdout: '',
        stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'.",
      },
    });
    const reads = createGithubReads({ runProcess: gh.runProcess });
    await expect(reads.repoExists('acme/app')).resolves.toBe(true);
    await expect(reads.repoExists('acme/gone')).rejects.toThrow(/Could not resolve/);
  });
});
