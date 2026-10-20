import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, ROADMAP_PATH, parseExpiry, validRepo } from '../lib/github.ts';
import { sampleText } from './fixtures/roadmap.ts';

const TOKEN = 'github_pat_SECRET_do_not_leak_0123456789';
const SHA = 'a'.repeat(40);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fileBody(text: string) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text, 'utf8').toString('base64'),
    sha: 'b'.repeat(40),
    html_url: 'https://github.com/acme/plans/blob/main/roadmap/roadmap.json',
  };
}

function client(fetchImpl: typeof fetch) {
  return new GitHubClient({ fetch: fetchImpl, token: TOKEN, repo: 'acme/plans' });
}

describe('validRepo', () => {
  it('takes owner/name and nothing else', () => {
    expect(validRepo('acme/plans')).toBe(true);
    expect(validRepo('acme/plans.v2')).toBe(true);
    expect(validRepo('acme')).toBe(false);
    expect(validRepo('acme/plans/../x')).toBe(false);
    expect(validRepo('acme/..')).toBe(false);
    expect(validRepo('acme/plans?x=1')).toBe(false);
    expect(validRepo('')).toBe(false);
  });
});

describe('parseExpiry', () => {
  it('reads the header GitHub sends with a fine-grained token', () => {
    expect(parseExpiry('2030-01-20 12:00:00 UTC')).toBe('2030-01-20T12:00:00.000Z');
    expect(parseExpiry('2030-01-20 12:00:00 -0800')).toBe('2030-01-20T20:00:00.000Z');
    expect(parseExpiry('soon')).toBeNull();
    expect(parseExpiry(null)).toBeNull();
  });
});

describe('GitHubClient', () => {
  it('reads only roadmap/roadmap.json, with the token in the header', async () => {
    const fetchImpl = vi.fn(async () => json(fileBody(sampleText())));
    const result = await client(fetchImpl as unknown as typeof fetch).readFile();
    expect(ROADMAP_PATH).toBe('roadmap/roadmap.json');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/plans/contents/roadmap/roadmap.json');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
    expect(result).toMatchObject({ kind: 'ok', text: sampleText() });
  });

  it('reads an older version by commit sha, and refuses anything that is not one', async () => {
    const fetchImpl = vi.fn(async () => json(fileBody('{}')));
    const github = client(fetchImpl as unknown as typeof fetch);
    await github.readFile(SHA);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      `https://api.github.com/repos/acme/plans/contents/roadmap/roadmap.json?ref=${SHA}`
    );
    await expect(github.readFile('main;rm')).rejects.toThrow(/sha/);
  });

  it('refuses to build a client for a repo that is not owner/name', () => {
    expect(() => new GitHubClient({ fetch, token: TOKEN, repo: '../etc' })).toThrow(/repo/);
  });

  it('reports the expiry header with every answer', async () => {
    const fetchImpl = vi.fn(async () =>
      json(fileBody('{}'), 200, {
        'github-authentication-token-expiration': '2030-01-20 12:00:00 UTC',
      })
    );
    const github = client(fetchImpl as unknown as typeof fetch);
    const result = await github.readFile();
    expect(result.expiresAt).toBe('2030-01-20T12:00:00.000Z');
  });

  it('turns failures into plain statuses that carry no secret', async () => {
    const cases: [Response | Error, unknown][] = [
      [json({ message: 'Bad credentials' }, 401), { kind: 'refused', status: 401 }],
      [json({ message: 'Not Found' }, 404), { kind: 'missing' }],
      [json({ message: 'rate limit' }, 403), { kind: 'refused', status: 403 }],
      [json({}, 502), { kind: 'refused', status: 502 }],
      [new Error(`connect failed with ${TOKEN}`), { kind: 'unreachable' }],
      [json({ type: 'dir' }), { kind: 'refused', status: 200 }],
    ];
    for (const [answer, expected] of cases) {
      const fetchImpl = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const result = await client(fetchImpl as unknown as typeof fetch).readFile();
      expect(result).toMatchObject(expected as object);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it('lists the commits that touched the file, newest first, as plain data', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        {
          sha: SHA,
          html_url: `https://github.com/acme/plans/commit/${SHA}`,
          parents: [{ sha: 'c'.repeat(40) }],
          author: { login: 'octo' },
          commit: {
            message: 'Move the fridge to Now\n\nLonger body that is not shown.',
            author: { name: 'kettle-bot', date: '2030-01-10T09:00:00Z' },
          },
        },
        {
          sha: 'd'.repeat(40),
          html_url: 'javascript:alert(1)',
          parents: [],
          author: null,
          commit: { message: '', author: { name: '', date: '2030-01-09T09:00:00Z' } },
        },
      ])
    );
    const result = await client(fetchImpl as unknown as typeof fetch).listCommits();
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      'https://api.github.com/repos/acme/plans/commits?path=roadmap%2Froadmap.json&per_page=20'
    );
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.commits).toEqual([
      {
        sha: SHA,
        parentSha: 'c'.repeat(40),
        url: `https://github.com/acme/plans/commit/${SHA}`,
        author: 'kettle-bot',
        date: '2030-01-10T09:00:00.000Z',
        reason: 'Move the fridge to Now',
      },
      {
        sha: 'd'.repeat(40),
        parentSha: null,
        url: null,
        author: 'someone',
        date: '2030-01-09T09:00:00.000Z',
        reason: null,
      },
    ]);
  });
});
