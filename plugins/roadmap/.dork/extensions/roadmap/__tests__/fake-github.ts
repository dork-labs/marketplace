/**
 * A stand-in for api.github.com: one repo, one file, its commits, and switches
 * for the failures the board has to survive.
 */

import { vi } from 'vitest';

/** One version of the file, as a commit. */
export interface FakeCommit {
  sha: string;
  /** The file's text at this commit. */
  text: string;
  author?: string;
  message?: string;
  date?: string;
}

/** A fake GitHub. Newest commit first, like GitHub lists them. */
export function fakeGitHub(commits: FakeCommit[]) {
  const state = {
    commits,
    /** Answer every request with this status instead. */
    status: null as number | null,
    /** Throw like an unreachable network. */
    down: false,
    /** The expiry header to send, or null. */
    expiry: '2030-02-20 12:00:00 UTC' as string | null,
    /** Requests seen, as URLs. */
    calls: [] as string[],
  };
  const fetchImpl = vi.fn(async (url: string) => {
    state.calls.push(url);
    if (state.down) throw new TypeError('fetch failed');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (state.expiry) headers['github-authentication-token-expiration'] = state.expiry;
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (state.status) return answer({ message: 'nope' }, state.status);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/commits')) {
      return answer(
        state.commits.map((c, i) => ({
          sha: c.sha,
          html_url: `https://github.com/acme/plans/commit/${c.sha}`,
          parents: [{ sha: state.commits[i + 1]?.sha ?? 'f'.repeat(40) }],
          author: null,
          commit: {
            message: c.message ?? '',
            author: { name: c.author ?? 'chef', date: c.date ?? '2030-01-10T09:00:00Z' },
          },
        }))
      );
    }
    const ref = parsed.searchParams.get('ref');
    const commit = ref ? state.commits.find((c) => c.sha === ref) : state.commits[0];
    if (!commit) return answer({ message: 'Not Found' }, 404);
    return answer({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(commit.text, 'utf8').toString('base64'),
      sha: 'b'.repeat(40),
      html_url: 'https://github.com/acme/plans/blob/main/roadmap/roadmap.json',
    });
  });
  return { state, fetch: fetchImpl as unknown as typeof fetch, spy: fetchImpl };
}

/** A 40-character sha made from one character. */
export function sha(char: string): string {
  return char.repeat(40);
}
