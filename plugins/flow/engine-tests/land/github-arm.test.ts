/**
 * The GitHub forge's arm-guard reads and the workflow dispatch (DOR-3262): the
 * exact `gh` argv, and how recorded answers are read, failing closed on
 * anything short or unknown.
 */

import { describe, expect, it } from 'vitest';

import type { ProcessRunner } from '../../scripts/cli/context.ts';
import {
  checkBucket,
  createGithubForge,
  parseArmFacts,
  parseMergeInfo,
  parseWorkflowRuns,
} from '../../scripts/forge/github.ts';

const SHA = 'a'.repeat(40);
const NONCE = '0123456789abcdef0123456789abcdef';

/** A forge over a runner that answers from `answers` by argv prefix and records each call. */
function forgeWith(
  answer: (args: readonly string[]) => { code: number; stdout: string; stderr?: string }
) {
  const calls: (readonly string[])[] = [];
  const runProcess: ProcessRunner = async (cmd, args) => {
    expect(cmd).toBe('gh');
    calls.push(args);
    const result = answer(args);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? '' };
  };
  const forge = createGithubForge({
    target: { host: 'github.com', repo: 'acme/app' },
    runProcess,
    now: () => new Date('2026-10-24T12:00:00Z'),
  });
  return { forge, calls };
}

const VIEW = {
  state: 'OPEN',
  isDraft: false,
  labels: [{ name: 'security-reviewed' }],
  reviewDecision: 'APPROVED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'flow plugin', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'security-review', state: 'PENDING' },
  ],
  headRefOid: SHA,
  headRefName: 'feature',
  baseRefName: 'main',
  isCrossRepository: false,
  changedFiles: 2,
};

describe('checkBucket', () => {
  it.each([
    [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, 'pass'],
    [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }, 'pass'],
    [{ status: 'COMPLETED', conclusion: 'SKIPPED' }, 'skipping'],
    [{ status: 'COMPLETED', conclusion: 'CANCELLED' }, 'cancel'],
    [{ status: 'COMPLETED', conclusion: 'FAILURE' }, 'fail'],
    [{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }, 'fail'],
    [{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }, 'fail'],
    [{ status: 'COMPLETED', conclusion: '' }, 'fail'],
    [{ status: 'QUEUED' }, 'pending'],
    [{ status: 'IN_PROGRESS' }, 'pending'],
    [{ state: 'SUCCESS' }, 'pass'],
    [{ state: 'PENDING' }, 'pending'],
    [{ state: 'EXPECTED' }, 'pending'],
    [{ state: 'FAILURE' }, 'fail'],
    [{ state: 'ERROR' }, 'fail'],
    [{}, 'fail'],
  ])('%j is %s', (entry, bucket) => {
    expect(checkBucket(entry)).toBe(bucket);
  });
});

describe('parseArmFacts', () => {
  const files = [
    { filename: 'src/new.ts', previous_filename: 'scripts/release/old.ts' },
    { filename: 'README.md' },
  ];

  it('reads a PR, with both names of a rename', () => {
    expect(parseArmFacts(VIEW, files, 'acme/app#7')).toEqual({
      state: 'OPEN',
      isDraft: false,
      labels: [{ name: 'security-reviewed' }],
      reviewDecision: 'APPROVED',
      checks: [
        { name: 'flow plugin', bucket: 'pass' },
        { name: 'lint', bucket: 'pending' },
        { name: 'security-review', bucket: 'pending' },
      ],
      headRefOid: SHA,
      headRefName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false,
      files: ['src/new.ts', 'scripts/release/old.ts', 'README.md'],
    });
  });

  it('a file list shorter than changedFiles is unknown, not partial', () => {
    expect(parseArmFacts({ ...VIEW, changedFiles: 3000 }, files, 'x').files).toBeNull();
    expect(parseArmFacts({ ...VIEW, changedFiles: undefined }, files, 'x').files).toBeNull();
    expect(parseArmFacts(VIEW, null, 'x').files).toBeNull();
    expect(parseArmFacts(VIEW, [{ filename: 'a' }, { nope: 1 }], 'x').files).toBeNull();
  });

  it('a count of 0 changed files is unknown: GitHub reports it while a new diff is computed', () => {
    expect(parseArmFacts({ ...VIEW, changedFiles: 0 }, [], 'x').files).toBeNull();
  });

  it('only an explicit false is "not a fork"', () => {
    expect(
      parseArmFacts({ ...VIEW, isCrossRepository: undefined }, files, 'x').isCrossRepository
    ).toBe(true);
    expect(
      parseArmFacts({ ...VIEW, isCrossRepository: 'false' }, files, 'x').isCrossRepository
    ).toBe(true);
  });

  it('a PR with no state or head is an error', () => {
    expect(() => parseArmFacts({ ...VIEW, headRefOid: undefined }, files, 'x')).toThrow(
      /unreadable/
    );
    expect(() => parseArmFacts([], files, 'x')).toThrow(/unreadable/);
  });
});

describe('the GitHub forge', () => {
  it('armFacts reads the PR and every page of its files', async () => {
    const { forge, calls } = forgeWith((args) =>
      args[0] === 'pr'
        ? { code: 0, stdout: JSON.stringify(VIEW) }
        : { code: 0, stdout: '{"filename":"a.ts","previous_filename":null}\n{"filename":"b.ts"}\n' }
    );
    const facts = await forge.armFacts(7);
    expect(facts.files).toEqual(['a.ts', 'b.ts']);
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '7',
      '-R',
      'acme/app',
      '--json',
      'state,isDraft,labels,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName,isCrossRepository,changedFiles',
    ]);
    expect(calls[1]).toEqual([
      'api',
      '--paginate',
      '--jq',
      '.[] | {filename, previous_filename}',
      'repos/acme/app/pulls/7/files?per_page=100',
    ]);
  });

  it('armFacts reports an unknown file list when the head moved while it was read', async () => {
    let views = 0;
    const { forge } = forgeWith((args) => {
      if (args[0] !== 'pr')
        return { code: 0, stdout: '{"filename":"a.ts"}\n{"filename":"b.ts"}\n' };
      views += 1;
      return {
        code: 0,
        stdout: JSON.stringify(views === 1 ? VIEW : { headRefOid: 'b'.repeat(40) }),
      };
    });
    expect((await forge.armFacts(7)).files).toBeNull();
  });

  it('armFacts reports an unknown file list when the files read fails', async () => {
    const { forge } = forgeWith((args) =>
      args[0] === 'pr'
        ? { code: 0, stdout: JSON.stringify(VIEW) }
        : { code: 1, stdout: '', stderr: 'HTTP 502' }
    );
    expect((await forge.armFacts(7)).files).toBeNull();
  });

  it('dispatchWorkflow runs exactly gh workflow run <workflow> --ref <branch> -f sha= -f nonce=', async () => {
    const { forge, calls } = forgeWith(() => ({ code: 0, stdout: '' }));
    await forge.dispatchWorkflow('shards.yml', 'feature', { sha: SHA, nonce: NONCE });
    expect(calls).toEqual([
      [
        'workflow',
        'run',
        'shards.yml',
        '--ref',
        'feature',
        '-f',
        `sha=${SHA}`,
        '-f',
        `nonce=${NONCE}`,
        '-R',
        'acme/app',
      ],
    ]);
  });

  it.each([
    ['--repo=x', 'feature', SHA, NONCE],
    ['shards.yml', '-f', SHA, NONCE],
    ['shards.yml', 'feature', 'abc', NONCE],
    ['shards.yml', 'feature', SHA, 'not-a-nonce'],
    ['shards.yml', 'feature', SHA.toUpperCase(), NONCE],
  ])('dispatchWorkflow refuses %s on %s before running gh', async (workflow, ref, sha, nonce) => {
    const { forge, calls } = forgeWith(() => ({ code: 0, stdout: '' }));
    await expect(forge.dispatchWorkflow(workflow, ref, { sha, nonce })).rejects.toThrow(/refusing/);
    expect(calls).toEqual([]);
  });

  it('workflowRuns lists dispatched runs of that workflow on that branch', async () => {
    const { forge, calls } = forgeWith(() => ({
      code: 0,
      stdout: JSON.stringify([
        {
          databaseId: 9,
          displayTitle: `preArm ${NONCE}`,
          headSha: SHA.toUpperCase(),
          status: 'completed',
          conclusion: 'success',
          url: 'u',
        },
        { displayTitle: 'no id' },
      ]),
    }));
    expect(await forge.workflowRuns('shards.yml', 'feature')).toEqual([
      {
        id: 9,
        title: `preArm ${NONCE}`,
        headSha: SHA,
        completed: true,
        conclusion: 'success',
        url: 'u',
      },
    ]);
    expect(calls[0]).toEqual([
      'run',
      'list',
      '-R',
      'acme/app',
      '--workflow',
      'shards.yml',
      '--branch',
      'feature',
      '--event',
      'workflow_dispatch',
      '--limit',
      '50',
      '--json',
      'databaseId,displayTitle,headSha,status,conclusion,url',
    ]);
    await expect(forge.workflowRuns('-x', 'feature')).rejects.toThrow(/refusing/);
  });

  it('parseWorkflowRuns refuses something that is not a list', () => {
    expect(() => parseWorkflowRuns({})).toThrow(/not.*list|other than a list/);
  });

  it('comment posts a body file', async () => {
    const { forge, calls } = forgeWith(() => ({ code: 0, stdout: '' }));
    await forge.comment(7, '@sec please look');
    expect(calls[0].slice(0, 6)).toEqual(['pr', 'comment', '7', '-R', 'acme/app', '--body-file']);
  });
});

describe('parseMergeInfo', () => {
  it('reads the merge commit only as a full SHA, and the author', () => {
    expect(
      parseMergeInfo(
        { state: 'MERGED', mergeCommit: { oid: SHA.toUpperCase() }, author: { login: 'octocat' } },
        'x'
      )
    ).toEqual({ state: 'merged', mergeCommit: SHA, author: 'octocat' });
    expect(parseMergeInfo({ state: 'OPEN', mergeCommit: null }, 'x')).toEqual({
      state: 'open',
      mergeCommit: null,
      author: null,
    });
    expect(
      parseMergeInfo({ state: 'MERGED', mergeCommit: { oid: 'abc' } }, 'x').mergeCommit
    ).toBeNull();
    expect(() => parseMergeInfo({}, 'x')).toThrow(/unreadable/);
  });

  it('the forge reads state, mergeCommit and author', async () => {
    const { forge, calls } = forgeWith(() => ({
      code: 0,
      stdout: JSON.stringify({
        state: 'MERGED',
        mergeCommit: { oid: SHA },
        author: { login: 'a' },
      }),
    }));
    expect((await forge.mergeInfo?.(7))?.mergeCommit).toBe(SHA);
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '7',
      '-R',
      'acme/app',
      '--json',
      'state,mergeCommit,author',
    ]);
  });
});
