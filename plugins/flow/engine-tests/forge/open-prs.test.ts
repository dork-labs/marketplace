/**
 * Open PRs (DOR-3341): the one fixed read, its parse (unreadable never reads
 * as fewer), the item link, the cap with its P0 exemption, and stuck PRs.
 */

import { describe, expect, it } from 'vitest';

import {
  createGithubForge,
  headArrival,
  arrivalFromChange,
  FORCE_PUSHES_QUERY,
  parseForcePushes,
  parseLabelledAt,
} from '../../scripts/forge/github.ts';
import {
  capRefusal,
  openPrListArgs,
  parseOpenPrs,
  prCap,
  prMatchesItem,
  stuckPrs,
  type OpenPr,
} from '../../scripts/forge/open-prs.ts';
import { ForgeError } from '../../scripts/forge/types.ts';

const raw = (n: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `t${n}`,
  url: `u${n}`,
  createdAt,
  author: { login: 'kai' },
  headRefName: `b${n}`,
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  isDraft: false,
  labels: [{ name: 'hold' }],
  autoMergeRequest: null,
  ...extra,
});

describe('the read', () => {
  it('is one fixed, read-only gh pr list call', () => {
    expect(openPrListArgs('acme/app')).toEqual([
      'pr',
      'list',
      '-R',
      'acme/app',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,url,createdAt,author,headRefName,headRefOid,baseRefName,isDraft,labels,autoMergeRequest',
    ]);
  });

  it('the GitHub forge runs exactly that call', async () => {
    const calls: string[][] = [];
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: JSON.stringify([raw(2, '2026-09-02T00:00:00Z')]), stderr: '' };
      },
    });
    const prs = await forge.openPrs?.();
    expect(calls).toEqual([['gh', ...openPrListArgs('acme/app')]]);
    expect(prs?.map((p) => p.number)).toEqual([2]);
  });

  it('a failed call throws, never answers an empty list', async () => {
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async () => ({ code: 1, stdout: '', stderr: 'HTTP 401' }),
    });
    await expect(forge.openPrs?.()).rejects.toThrow(ForgeError);
  });

  it('parses oldest first, with author, labels and armed', () => {
    const prs = parseOpenPrs([
      raw(9, '2026-09-09T00:00:00Z', { autoMergeRequest: { enabledAt: 'x' } }),
      raw(3, '2026-09-03T00:00:00Z'),
    ]);
    expect(prs.map((p) => p.number)).toEqual([3, 9]);
    expect(prs[0]).toMatchObject({ author: 'kai', labels: ['hold'], armed: false });
    expect(prs[1].armed).toBe(true);
  });

  it('one entry it cannot read makes the whole count unreadable', () => {
    expect(() => parseOpenPrs({})).toThrow(ForgeError);
    expect(() => parseOpenPrs([raw(1, '2026-09-01T00:00:00Z'), { number: 2 }])).toThrow(ForgeError);
    expect(() => parseOpenPrs([raw(1, 'not a date')])).toThrow(ForgeError);
  });
});

describe('the item link', () => {
  it('the identifier is a whole token of the branch or the title, in any case', () => {
    expect(prMatchesItem({ headRefName: 'dor-12-fix', title: '' }, 'DOR-12')).toBe(true);
    expect(prMatchesItem({ headRefName: 'feature/DOR-12', title: '' }, 'DOR-12')).toBe(true);
    expect(prMatchesItem({ headRefName: 'x', title: 'Fix it (DOR-12)' }, 'DOR-12')).toBe(true);
    expect(prMatchesItem({ headRefName: 'dor-123-fix', title: 'DOR-120' }, 'DOR-12')).toBe(false);
    expect(prMatchesItem({ headRefName: 'xdor-12', title: '' }, 'DOR-12')).toBe(false);
  });
});

function open(n: number, createdAt: string, author = 'kai'): OpenPr {
  return parseOpenPrs([raw(n, createdAt, { author: { login: author } })])[0];
}

describe('the cap', () => {
  const prs = [open(1, '2026-09-01T00:00:00Z'), open(2, '2026-09-02T00:00:00Z')];

  it('at the cap refuses a new PR and names the PRs holding the slots', () => {
    const cap = prCap(prs, 2);
    expect(cap).toEqual({ readable: true, open: 2, max: 2, atCap: true, holding: [1, 2] });
    expect(capRefusal(cap, 2)).toMatch(/2 pull requests are open, at the cap of 2.*#1, #2/);
    expect(capRefusal(cap, undefined)).not.toBeNull();
  });

  it('an urgent (P0) item is exempt', () => {
    expect(capRefusal(prCap(prs, 2), 1)).toBeNull();
  });

  it('under the cap, nothing refuses', () => {
    expect(capRefusal(prCap(prs, 3), 3)).toBeNull();
  });

  it('an unreadable count refuses (fails closed), and P0 is still exempt', () => {
    const cap = prCap('gh: HTTP 502', 8);
    expect(cap).toMatchObject({ readable: false, atCap: true });
    expect(capRefusal(cap, 2)).toMatch(/could not count the open pull requests \(gh: HTTP 502\)/);
    expect(capRefusal(cap, 1)).toBeNull();
  });
});

describe('stuck PRs', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const limits = { staleDays: 3, maxBehind: 20 };

  it('flags a PR older than staleDays, naming its owner', () => {
    const old = open(1, '2026-09-06T00:00:00Z', 'priya');
    const [stuck] = stuckPrs([old], new Map([[1, 0]]), limits, now);
    expect(stuck).toMatchObject({ ageDays: 4, stale: true, farBehind: false, owner: 'priya' });
  });

  it('flags a PR more than maxBehind commits behind main', () => {
    const fresh = open(2, '2026-09-10T00:00:00Z');
    const [stuck] = stuckPrs([fresh], new Map([[2, 21]]), limits, now);
    expect(stuck).toMatchObject({ stale: false, farBehind: true, behind: 21 });
  });

  it('a fresh PR within the limits is not stuck; exactly at the limits is not either', () => {
    const fresh = open(3, '2026-09-07T12:00:00Z');
    expect(stuckPrs([fresh], new Map([[3, 20]]), limits, now)).toEqual([]);
  });

  it('a behind count that could not be read flags the PR', () => {
    const fresh = open(4, '2026-09-10T00:00:00Z');
    expect(stuckPrs([fresh], new Map([[4, null]]), limits, now)[0]).toMatchObject({
      farBehind: true,
      behind: null,
    });
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('label history and when the head arrived', () => {
  const line = (event: string, created_at: string, name: string, actor = 'User') =>
    JSON.stringify({ event, created_at, name, actor });

  it('the label is on since its latest add, and off after a removal', () => {
    const out = [
      line('labeled', '2026-09-01T00:00:00Z', 'security-reviewed'),
      line('unlabeled', '2026-09-02T00:00:00Z', 'security-reviewed'),
      line('labeled', '2026-09-03T00:00:00Z', 'Security-Reviewed'),
      line('labeled', '2026-09-04T00:00:00Z', 'qa-go'),
    ].join('\n');
    expect(parseLabelledAt(out, 'security-reviewed')).toBe('2026-09-03T00:00:00Z');
    expect(
      parseLabelledAt(out + '\n' + line('unlabeled', '2026-09-05T00:00:00Z', 'qa-go'), 'qa-go')
    ).toBeNull();
    expect(parseLabelledAt('', 'qa-go')).toBeNull();
    expect(() => parseLabelledAt('{"event":"labeled"}', 'qa-go')).toThrow(ForgeError);
  });

  // SECURITY-GATE.md: a label counts only if a person added it, and only the
  // newest add counts, so a bot cannot revive a label a person removed.
  it('reads no time when the newest add is not a person', () => {
    const person = line('labeled', '2026-09-01T00:00:00Z', 'security-reviewed');
    const bot = line('labeled', '2026-09-02T00:00:00Z', 'security-reviewed', 'Bot');
    const off = line('unlabeled', '2026-09-01T12:00:00Z', 'security-reviewed');
    expect(parseLabelledAt(bot, 'security-reviewed')).toBeNull();
    expect(parseLabelledAt([person, off, bot].join('\n'), 'security-reviewed')).toBeNull();
    expect(parseLabelledAt([person, bot].join('\n'), 'security-reviewed')).toBeNull();
    expect(
      parseLabelledAt(
        '{"event":"labeled","created_at":"2026-09-01T00:00:00Z","name":"security-reviewed"}',
        'security-reviewed'
      )
    ).toBeNull();
  });

  it('the GitHub forge asks for the actor, or no label would ever count', async () => {
    const seen: string[][] = [];
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async (_cmd, args) => {
        seen.push([...args]);
        return { code: 0, stdout: line('labeled', '2026-09-01T00:00:00Z', 'qa-go'), stderr: '' };
      },
    });
    expect(await forge.labelledAt?.(7, 'qa-go')).toBe('2026-09-01T00:00:00Z');
    expect(seen[0].join(' ')).toContain('actor: .actor.type');
  });

  it('a bot and a person in the same second read as no person', () => {
    const at = '2026-09-02T00:00:00Z';
    const out = [
      line('labeled', at, 'security-reviewed', 'Bot'),
      line('labeled', at, 'security-reviewed'),
    ].join('\n');
    expect(parseLabelledAt(out, 'security-reviewed')).toBeNull();
  });

  it('a suite a labeled workflow makes after the label does not move the arrival', () => {
    // Pushed at 10:00 (first suite), labelled at 11:00, and the label itself
    // started another workflow run at 11:00:05: the head still arrived at 10:00.
    const suites = [
      { createdAt: '2026-09-05T10:00:00Z', headBranch: 'acme-1-fix' },
      { createdAt: '2026-09-05T11:00:05Z', headBranch: 'acme-1-fix' },
    ];
    expect(headArrival(suites, [], SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:00Z');
  });

  it('a force-push back to an older commit is when that head arrived', () => {
    const suites = [{ createdAt: '2026-09-01T00:00:00Z', headBranch: 'acme-1-fix' }];
    const pushes = [
      { createdAt: '2026-09-03T00:00:00Z', after: SHA_B },
      { createdAt: '2026-09-05T00:00:00Z', after: SHA_A },
    ];
    expect(headArrival(suites, pushes, SHA_A, 'acme-1-fix')).toBe('2026-09-05T00:00:00Z');
  });

  it('a head that came back by fast-forward after a force-push away is unknown', () => {
    // A was pushed, the branch was force-pushed to an older C, then fast-forwarded back to A.
    const suites = [{ createdAt: '2026-09-01T00:00:00Z', headBranch: 'acme-1-fix' }];
    const pushes = [{ createdAt: '2026-09-03T00:00:00Z', after: SHA_B }];
    expect(headArrival(suites, pushes, SHA_A, 'acme-1-fix')).toBeNull();
  });

  it('a commit first pushed to another branch counts from its push to this one', () => {
    const suites = [
      { createdAt: '2026-09-01T00:00:00Z', headBranch: 'elsewhere' },
      { createdAt: '2026-09-06T00:00:00Z', headBranch: 'acme-1-fix' },
    ];
    expect(headArrival(suites, [], SHA_A, 'acme-1-fix')).toBe('2026-09-06T00:00:00Z');
    expect(headArrival(suites.slice(0, 1), [], SHA_A, 'acme-1-fix')).toBeNull();
  });

  it('force-pushes that cannot be read in full are unknown', () => {
    expect(
      headArrival([{ createdAt: '2026-09-06T00:00:00Z', headBranch: 'b' }], null, SHA_A, 'b')
    ).toBeNull();
    const page = (filteredCount: number) => ({
      data: {
        repository: {
          pullRequest: {
            timelineItems: {
              filteredCount,
              nodes: [{ createdAt: '2026-09-03T00:00:00Z', afterCommit: { oid: SHA_B } }],
            },
          },
        },
      },
    });
    expect(parseForcePushes(page(1))).toEqual([
      { createdAt: '2026-09-03T00:00:00Z', after: SHA_B },
    ]);
    expect(parseForcePushes(page(101))).toBeNull();
    expect(parseForcePushes({})).toBeNull();
  });

  it('counts force-pushes by filteredCount: totalCount counts the whole timeline', () => {
    // GitHub's answer for a labelled PR that was never force-pushed (DOR-3793).
    const never = {
      data: {
        repository: {
          pullRequest: { timelineItems: { totalCount: 2, filteredCount: 0, nodes: [] } },
        },
      },
    };
    expect(parseForcePushes(never)).toEqual([]);
    expect(FORCE_PUSHES_QUERY).toContain('filteredCount');
    // An answer without the count is unknown, never "none".
    expect(
      parseForcePushes({
        data: { repository: { pullRequest: { timelineItems: { totalCount: 0, nodes: [] } } } },
      })
    ).toBeNull();
  });

  it('the GitHub forge reads the suites, the force-pushes and the feed, and judges from them', async () => {
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async (_cmd, args) => {
        if (args.includes('graphql')) {
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: { timelineItems: { totalCount: 3, filteredCount: 0, nodes: [] } },
                },
              },
            }),
            stderr: '',
          };
        }
        if (args.some((a) => a.includes('/activity?'))) {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                activity_type: 'push',
                ref: 'refs/heads/acme-1-fix',
                after: SHA_A,
                timestamp: '2026-09-05T09:59:59Z',
              },
            ]),
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout:
            JSON.stringify({ created_at: '2026-09-05T10:00:00Z', head_branch: 'acme-1-fix' }) +
            '\n' +
            JSON.stringify({ created_at: '2026-09-05T11:00:05Z', head_branch: 'acme-1-fix' }) +
            '\n',
          stderr: '',
        };
      },
    });
    expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:00Z');
  });

  describe('the branch activity feed dates every head', () => {
    const graphql = {
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: { timelineItems: { totalCount: 3, filteredCount: 0, nodes: [] } },
          },
        },
      }),
      stderr: '',
    };
    const entry = (over: Record<string, unknown> = {}) => ({
      activity_type: 'push',
      ref: 'refs/heads/acme-1-fix',
      after: SHA_A,
      timestamp: '2026-09-05T10:00:00Z',
      ...over,
    });
    const forgeWith = (activity: unknown, suites = '') => {
      const asked: string[][] = [];
      const forge = createGithubForge({
        target: { host: 'github.com', repo: 'acme/app' },
        now: () => new Date(),
        runProcess: async (_cmd, args) => {
          asked.push([...args]);
          if (args.includes('graphql')) return graphql;
          if (args.some((a) => a.includes('/activity?'))) {
            return activity === 'fail'
              ? { code: 1, stdout: '', stderr: 'HTTP 404' }
              : { code: 0, stdout: JSON.stringify(activity), stderr: '' };
          }
          return { code: 0, stdout: suites, stderr: '' };
        },
      });
      return { forge, asked };
    };

    it('takes the time of the newest change to the branch when it left this head', async () => {
      const { forge, asked } = forgeWith([entry()]);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:00Z');
      const url = asked.flat().find((a) => a.includes('/activity?')) as string;
      expect(url).toContain('repos/acme/app/activity?');
      expect(url).toContain(`ref=${encodeURIComponent('refs/heads/acme-1-fix')}`);
      expect(url).toContain('direction=desc');
    });

    it('counts a new branch and a force-push as arriving', async () => {
      for (const activity_type of ['branch_creation', 'force_push']) {
        const { forge } = forgeWith([entry({ activity_type })]);
        expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:00Z');
      }
    });

    it('is unknown when the newest change left another commit', async () => {
      const { forge } = forgeWith([entry({ after: SHA_B })]);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
    });

    it('is unknown when the feed answers about another branch', async () => {
      const { forge } = forgeWith([entry({ ref: 'refs/heads/other' })]);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
    });

    it('is unknown when the newest change is not a push to the branch', async () => {
      for (const activity_type of ['branch_deletion', 'pr_merge', 'merge_queue_merge', undefined]) {
        const { forge } = forgeWith([entry({ activity_type })]);
        expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
      }
    });

    it('is unknown on an empty feed, a bad time, or an answer in another shape', async () => {
      for (const activity of [
        [],
        [entry({ timestamp: 'soon' })],
        [entry({ timestamp: undefined })],
        {},
        [null],
      ]) {
        const { forge } = forgeWith(activity);
        expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
      }
    });

    it('a feed that cannot be read throws, and the guard reads that as unknown', async () => {
      const { forge } = forgeWith('fail');
      await expect(forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).rejects.toThrow(/404/);
    });

    // Seen live on a throwaway repo: push S0 and S1, force back to S0 before any
    // PR exists (no timeline event), open the PR, a person labels S0, then
    // fast-forward to S1. S1's old suite predates the label; its push doesn't.
    it('a commit that came back after the label is dated by that push, not its old suite', async () => {
      const suites = JSON.stringify({
        created_at: '2026-09-05T09:00:00Z',
        head_branch: 'acme-1-fix',
      });
      const { forge } = forgeWith([entry({ timestamp: '2026-09-05T12:00:00Z' })], suites);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T12:00:00Z');
    });

    it('keeps the suite when it is the later time', async () => {
      const suites = JSON.stringify({
        created_at: '2026-09-05T10:00:01Z',
        head_branch: 'acme-1-fix',
      });
      const { forge } = forgeWith([entry()], suites);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:01Z');
    });

    it('a suite on this branch never stands in for a feed that disagrees or cannot be read', async () => {
      const suites = JSON.stringify({
        created_at: '2026-09-05T09:00:00Z',
        head_branch: 'acme-1-fix',
      });
      expect(
        await forgeWith([entry({ after: SHA_B })], suites).forge.headPushedAt?.(
          7,
          SHA_A,
          'acme-1-fix'
        )
      ).toBeNull();
      expect(await forgeWith([], suites).forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
      await expect(
        forgeWith('fail', suites).forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')
      ).rejects.toThrow(/404/);
    });

    it('a suite made only by a push to another branch does not stop the feed being asked', async () => {
      const suites = JSON.stringify({ created_at: '2026-09-05T09:00:00Z', head_branch: 'other' });
      const { forge } = forgeWith([entry()], suites);
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBe('2026-09-05T10:00:00Z');
    });

    it('never asks the feed when the force-pushes could not be read in full', async () => {
      const asked: string[][] = [];
      const forge = createGithubForge({
        target: { host: 'github.com', repo: 'acme/app' },
        now: () => new Date(),
        runProcess: async (_cmd, args) => {
          asked.push([...args]);
          return args.includes('graphql')
            ? { code: 0, stdout: '{}', stderr: '' }
            : { code: 0, stdout: '', stderr: '' };
        },
      });
      expect(await forge.headPushedAt?.(7, SHA_A, 'acme-1-fix')).toBeNull();
      expect(asked.flat().some((a) => a.includes('/activity?'))).toBe(false);
    });

    it('is unknown when the change is no later than the last force-push', () => {
      const pushes = [{ createdAt: '2026-09-05T10:00:00Z', after: SHA_B }];
      const change = {
        type: 'push',
        ref: 'refs/heads/b',
        after: SHA_A,
        at: '2026-09-05T10:00:00Z',
      };
      expect(arrivalFromChange(change, pushes, SHA_A, 'b')).toBeNull();
      expect(arrivalFromChange({ ...change, at: '2026-09-05T10:00:01Z' }, pushes, SHA_A, 'b')).toBe(
        '2026-09-05T10:00:01Z'
      );
      expect(arrivalFromChange(null, pushes, SHA_A, 'b')).toBeNull();
    });

    it('a force-push that left this head does not count against its own feed entry', () => {
      // The feed and the timeline stamped one force-push a second apart, live.
      const pushes = [{ createdAt: '2026-09-05T10:00:01Z', after: SHA_A }];
      const change = {
        type: 'force_push',
        ref: 'refs/heads/b',
        after: SHA_A,
        at: '2026-09-05T10:00:00Z',
      };
      expect(arrivalFromChange(change, pushes, SHA_A, 'b')).toBe('2026-09-05T10:00:00Z');
    });
  });
});
