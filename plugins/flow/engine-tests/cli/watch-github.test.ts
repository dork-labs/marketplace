/** Watch decisions through the real GitHub reader; only the gh process boundary is scripted. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../scripts/flow.ts';
import { createGithubForge } from '../../scripts/forge/github.ts';
import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';

const NOW = new Date('2026-11-17T12:00:00Z');
const older = '2026-11-17T10:00:00Z';
const newer = '2026-11-17T11:00:00Z';
function check(name: string, conclusion: string, startedAt = older, workflowName = 'checks') {
  return {
    name,
    conclusion,
    startedAt,
    workflowName,
    status: 'COMPLETED',
    detailsUrl: `https://example.test/${name}/${startedAt}`,
  };
}
const replaced = () => [
  check('old-failure', 'FAILURE'),
  check('old-failure', 'SUCCESS', newer),
  check('old-cancel', 'CANCELLED'),
  check('old-cancel', 'SUCCESS', newer),
];
function view(rollup: unknown[], state = 'OPEN', armed = true) {
  return {
    state,
    autoMergeRequest: armed ? {} : null,
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    statusCheckRollup: rollup,
  };
}
/** A bounded sequence: an unexpected extra read throws rather than masking an endless watch. */
function github(views: unknown[], queued = false) {
  let reads = 0;
  const calls: { command: string; args: readonly string[] }[] = [];
  const runProcess: ProcessRunner = async (command, args, options) => {
    if (command !== 'gh') return realProcessRunner(command, args, options);
    calls.push({ command, args });
    let value: unknown;
    if (args[0] === 'pr' && args[1] === 'view') {
      if (reads >= views.length) throw new Error('Unexpected extra PR read');
      value = views[reads++];
    } else if (
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args.some((arg) => arg.includes('isInMergeQueue'))
    ) {
      value = { data: { repository: { pullRequest: { isInMergeQueue: queued } } } };
    } else throw new Error(`Unexpected gh operation: ${args[0]} ${args[1]}`);
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  return { runProcess, calls, reads: () => reads };
}
async function watch(views: unknown[], flags: string[] = [], queued = false) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-watch-github-')));
  const gh = github(views, queued);
  let out = '';
  let err = '';
  const sleeps: number[] = [];
  try {
    const code = await main(['watch', '--pr', 'acme/app#1', ...flags], {
      cwd,
      env: {},
      now: () => NOW,
      runProcess: gh.runProcess,
      stdout: {
        write: (value: string) => {
          out += value;
        },
      },
      stderr: {
        write: (value: string) => {
          err += value;
        },
      },
      createAdapter: async () => {
        throw new Error('watch must not need a tracker');
      },
      io: {
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    });
    return { code, out, err, sleeps, reads: gh.reads(), calls: gh.calls };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('flow watch through the GitHub reader', () => {
  it.each(['armed', 'queued'] as const)(
    'waits past superseded failures on an %s PR in ordinary mode',
    async (kind) => {
      const result = await watch(
        [view(replaced(), 'OPEN', kind === 'armed'), view([], 'MERGED')],
        [],
        kind === 'queued'
      );
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toBe('acme/app#1 MERGED\n');
      expect(result.reads).toBe(2);
      expect(result.sleeps).toEqual([90_000]);
    }
  );
  it('follow mode reports the merge once without historical failure events', async () => {
    const result = await watch(
      [view(replaced()), view(replaced()), view([], 'MERGED')],
      ['--follow']
    );
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe('acme/app#1 MERGED\n');
    expect(result.reads).toBe(3);
    expect(result.sleeps).toEqual([90_000, 90_000]);
  });
  it('renders only genuine current failures from a mixed rollup', async () => {
    const result = await watch([view([...replaced(), check('current-lint', 'FAILURE')])]);
    expect(result.code).toBe(0);
    expect(result.out).toBe('acme/app#1 FAILING: current-lint\n');
    expect(result.reads).toBe(1);
    expect(result.sleeps).toEqual([]);
  });
  it('retains a same-name failure from a different workflow', async () => {
    const result = await watch([
      view([check('lint', 'FAILURE', older, 'first'), check('lint', 'SUCCESS', newer, 'second')]),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toBe('acme/app#1 FAILING: lint\n');
  });
  it.each([
    [
      'unreadable failure time',
      check('lint', 'FAILURE', 'unknown'),
      check('lint', 'SUCCESS', newer),
    ],
    ['tied start times', check('lint', 'FAILURE'), check('lint', 'SUCCESS')],
    [
      'unfinished replacement',
      check('lint', 'FAILURE'),
      { ...check('lint', 'SUCCESS', newer), status: 'IN_PROGRESS' },
    ],
  ])('keeps an unproven supersession failing: %s', async (_reason, failure, replacement) => {
    const result = await watch([view([failure, replacement])]);
    expect(result.code).toBe(0);
    expect(result.out).toBe('acme/app#1 FAILING: lint\n');
  });
  it.each([
    ['missing workflow', undefined],
    ['empty workflow', ''],
    ['whitespace workflow', '   '],
  ])('keeps unidentified workflows failing: %s', async (_reason, workflowName) => {
    const result = await watch([
      view([
        { ...check('lint', 'FAILURE'), workflowName },
        { ...check('lint', 'SUCCESS', newer), workflowName },
      ]),
      view([], 'MERGED'),
    ]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe('acme/app#1 FAILING: lint\n');
    expect(result.reads).toBe(1);
    expect(result.sleeps).toEqual([]);
  });
  it('preserves historical failures and their provenance in the forge result', async () => {
    const gh = github([view(replaced())]);
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      runProcess: gh.runProcess,
      now: () => NOW,
    });
    const status = await forge.prStatus(1);
    expect(status.failing).toEqual(
      ['old-failure', 'old-cancel'].map((name) => ({
        name,
        url: `https://example.test/${name}/${older}`,
        workflow: 'checks',
        superseded: true,
      }))
    );
    expect(gh.reads()).toBe(1);
    expect(gh.calls.every((call) => call.command === 'gh')).toBe(true);
  });
});
