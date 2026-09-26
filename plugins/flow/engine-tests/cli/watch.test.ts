/**
 * `flow watch` (spec `flow-handoff-dispatch` §4.6, task 3.3): driven through
 * `main` with a scripted fake forge (one status per round per PR) and a fake
 * sleep that records each wait instead of waiting, so rounds are the clock.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT } from '../../scripts/errors.ts';
import { main } from '../../scripts/flow.ts';
import type { Forge, GroupFailure, PrStatus } from '../../scripts/forge/types.ts';
import { defaultRunner, makeProject, type WriteProject } from './write-harness.ts';

type Step = Partial<PrStatus> | Error;

/** A forge whose prStatus answers each PR's scripted steps in order, repeating the last. */
function scriptedForge(steps: Record<string, Step[]>, groups: GroupFailure[] = []) {
  const reads: string[] = [];
  const made: string[] = [];
  const factory = (target: { repo: string }): Forge => {
    made.push(target.repo);
    const seen = new Map<number, number>();
    return {
      repo: target.repo,
      branchHead: async () => null,
      prForBranch: async () => null,
      createPr: async () => {
        throw new Error('watch never opens a PR');
      },
      async prStatus(pr) {
        const key = `${target.repo}#${pr}`;
        reads.push(key);
        const list = steps[key] ?? [];
        const i = seen.get(pr) ?? 0;
        seen.set(pr, i + 1);
        const step = list[Math.min(i, list.length - 1)];
        if (step instanceof Error) throw step;
        return {
          state: 'open',
          failing: [],
          armed: true,
          queued: false,
          headSha: 'h',
          base: 'main',
          ...step,
        };
      },
      arm: async () => {},
      disarm: async () => {},
      recentGroupFailures: async () => groups,
    };
  };
  return { factory, reads, made };
}

let project: WriteProject;
let sleeps: number[];

/** Run `flow watch <argv>` in `cwd`. */
async function watch(argv: string[], forge: ReturnType<typeof scriptedForge>, cwd = project.dir) {
  let out = '';
  let err = '';
  const code = await main(['watch', ...argv], {
    env: {},
    cwd,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => {
      throw new Error('flow watch must not need a tracker');
    },
    runProcess: defaultRunner,
    createForge: forge.factory,
    io: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  });
  return { code, out, err };
}

/** A drain with a recorded PR. */
function drainWithPr(number: number): DrainState {
  return {
    v: 1,
    rev: 1,
    phase: 'watching',
    worker: null,
    reviewer: null,
    pushedSha: 'h',
    reviewedSha: 'h',
    verdict: 'clean',
    reviewRound: 1,
    pr: { repo: 'acme/app', number, url: 'u', armed: true, disarmedForReview: false },
    rearmedFor: null,
    nudges: 0,
    wakeAfter: null,
    handoffs: [],
    parkedReason: null,
  };
}

function runRecord(identifier: string, number: number) {
  return {
    issueId: `id-${identifier}`,
    identifier,
    sessionId: 's',
    worktreePath: project.dir,
    branch: identifier.toLowerCase(),
    stage: 'verify' as const,
    status: 'running' as const,
    attemptCount: 0,
    workerPid: -1,
    startedAt: '2026-09-26T10:00:00.000Z',
    drain: drainWithPr(number),
  };
}

beforeEach(() => {
  project = makeProject();
  sleeps = [];
  project.writeRuns({
    'id-ACME-1': runRecord('ACME-1', 1),
    'id-ACME-2': runRecord('ACME-2', 2),
  });
});

afterEach(() => project.cleanup());

describe('flow watch', () => {
  // Without --follow it waits out quiet rounds and exits 0 on the first event (watch.sh's contract).
  it('exits on the first event', async () => {
    const forge = scriptedForge({
      'acme/app#1': [{}, {}, { state: 'merged' }],
      'acme/app#2': [{}],
    });
    const r = await watch([], forge);
    expect(r.code).toBe(0);
    expect(r.out).toBe('ACME-1 MERGED\n');
    expect(sleeps).toEqual([90_000, 90_000]);
  });

  // Named identifiers limit the watch to their PRs; --interval sets the wait.
  it('watches only the named runs, at --interval', async () => {
    const forge = scriptedForge({ 'acme/app#2': [{}, { failing: [{ name: 'lint', url: null }] }] });
    const r = await watch(['ACME-2', '--interval', '5'], forge);
    expect(r.out).toBe('ACME-2 FAILING: lint\n');
    expect(forge.reads).toEqual(['acme/app#2', 'acme/app#2']);
    expect(sleeps).toEqual([5000]);
  });

  // Several identifiers are all watched, and one round can report more than one event.
  it('takes several identifiers', async () => {
    const forge = scriptedForge({
      'acme/app#1': [{ state: 'merged' }],
      'acme/app#2': [{ state: 'closed' }],
    });
    const r = await watch(['ACME-1', 'ACME-2'], forge);
    expect(r.out).toBe('ACME-1 MERGED\nACME-2 CLOSED\n');
  });

  // --follow keeps going, prints each change once, and stops when every PR merged or closed.
  it('--follow continues until every PR is done', async () => {
    const red = { failing: [{ name: 'test', url: null }] };
    const forge = scriptedForge({
      'acme/app#1': [red, red, {}, { state: 'merged' }],
      'acme/app#2': [{}, { state: 'closed' }],
    });
    const r = await watch(['--follow'], forge);
    expect(r.code).toBe(0);
    expect(r.out).toBe('ACME-1 FAILING: test\nACME-2 CLOSED\nACME-1 MERGED\n');
  });

  // --json prints one { v, events } object per round that had events.
  it('--follow --json prints one object per round', async () => {
    const forge = scriptedForge({
      'acme/app#1': [{ armed: false, queued: false }, { state: 'merged' }],
      'acme/app#2': [{ state: 'merged' }],
    });
    const r = await watch(['--follow', '--json'], forge);
    expect(
      r.out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    ).toEqual([
      {
        v: 1,
        events: [
          { target: 'ACME-1', event: 'NOT-ARMED-NOT-QUEUED' },
          { target: 'ACME-2', event: 'MERGED' },
        ],
      },
      { v: 1, events: [{ target: 'ACME-1', event: 'MERGED' }] },
    ]);
  });

  // Neither armed nor queued with its own failed merge group is an ejection, judged against the others.
  it('reports an ejection with its verdict', async () => {
    const forge = scriptedForge({ 'acme/app#1': [{ armed: false, queued: false }] }, [
      { pr: 1, prs: [1], failing: ['browser-test'] },
      { pr: 9, prs: [9], failing: ['browser-test'] },
    ]);
    const r = await watch(['ACME-1'], forge);
    expect(r.out).toBe('ACME-1 EJECTED (innocent)\n');
  });

  // Five failed reads in a row for one PR exit 4 naming it; a success in between resets the count.
  it('exits 4 after five failed reads in a row', async () => {
    const boom = new Error('HTTP 404');
    const forge = scriptedForge({
      'acme/app#1': [boom, boom, {}, boom, boom, boom, boom, boom],
    });
    const r = await watch(['ACME-1'], forge);
    expect(r.code).toBe(EXIT.tracker);
    expect(r.err).toContain('ACME-1: 5 reads in a row failed (HTTP 404)');
    expect(sleeps).toHaveLength(7);
  });

  // A raw --pr works outside any flow project, and --pr repeats.
  it('raw --pr needs no flow project', async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-watch-')));
    try {
      const forge = scriptedForge({
        'acme/other#5': [{ state: 'merged' }],
        'acme/app#6': [{}],
      });
      const r = await watch(['--pr', 'acme/other#5', '--pr', 'acme/app:6'], forge, outside);
      expect(r.code).toBe(0);
      expect(r.out).toBe('acme/other#5 MERGED\n');
      expect(forge.made).toEqual(['acme/other', 'acme/app']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Nothing to watch, or a named run with no PR, is a precondition failure.
  it('refuses with nothing to watch', async () => {
    project.writeRuns({});
    const r = await watch([], scriptedForge({}));
    expect(r.code).toBe(EXIT.precondition);
    const named = await watch(['ACME-9'], scriptedForge({}));
    expect(named.code).toBe(EXIT.precondition);
    const bad = await watch(['--pr', 'nonsense'], scriptedForge({}));
    expect(bad.code).toBe(EXIT.usage);
  });
});
