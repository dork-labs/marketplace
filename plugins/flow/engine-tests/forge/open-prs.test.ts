/**
 * Open PRs (DOR-3341): the one fixed read, its parse (unreadable never reads
 * as fewer), the item link, the cap with its P0 exemption, and stuck PRs.
 */

import { describe, expect, it } from 'vitest';

import { createGithubForge, latestTime, parseLabelledAt } from '../../scripts/forge/github.ts';
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

describe('label history and first-seen time', () => {
  const line = (event: string, created_at: string, name: string) =>
    JSON.stringify({ event, created_at, name });

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

  it('the latest of the times is the one kept', () => {
    expect(latestTime('"2026-09-03T00:00:00Z"\n2026-09-01T00:00:00Z\n')).toBe(
      '2026-09-03T00:00:00Z'
    );
    expect(latestTime('')).toBeNull();
    expect(() => latestTime('soon')).toThrow(ForgeError);
  });

  it("a force-push back to an older commit is that head's arrival, not the commit's first suite", async () => {
    const sha = 'b'.repeat(40);
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async (_cmd, args) => {
        const url = args[args.length - 1];
        if (url.includes('/check-suites')) {
          // The commit's first suite ran days ago, when it was first pushed.
          return { code: 0, stdout: '"2026-09-01T00:00:00Z"\n', stderr: '' };
        }
        // Then the branch moved on, and was force-pushed back to it.
        return { code: 0, stdout: '"2026-09-05T00:00:00Z"\n', stderr: '' };
      },
    });
    expect(await forge.headPushedAt?.(7, sha)).toBe('2026-09-05T00:00:00Z');
  });

  it('a head no check suite ran on is unknown, never old', async () => {
    const forge = createGithubForge({
      target: { host: 'github.com', repo: 'acme/app' },
      now: () => new Date(),
      runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await forge.headPushedAt?.(7, 'b'.repeat(40))).toBeNull();
  });
});
