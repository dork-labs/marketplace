import { describe, expect, it, vi } from 'vitest';
import { BoardService, type BoardServiceOptions } from '../lib/board-service.ts';
import { fakeGitHub, sha } from './fake-github.ts';
import { itemsOf, sampleText } from './fixtures/roadmap.ts';

const TOKEN = 'github_pat_SECRET_do_not_leak_0123456789';

const V1 = sampleText();
const V2 = sampleText((doc) => {
  itemsOf(doc)[2]!.horizon = 'now';
});

function host(overrides: { token?: string | null; repo?: string | null } = {}) {
  const store: { data: unknown } = { data: null };
  const settings: Record<string, string | null> = {
    repo: overrides.repo === undefined ? 'acme/plans' : overrides.repo,
  };
  let now = new Date('2030-01-15T10:00:00Z');
  const log = vi.fn();
  return {
    store,
    settings,
    log,
    clock: {
      set(iso: string) {
        now = new Date(iso);
      },
      advance(ms: number) {
        now = new Date(now.getTime() + ms);
      },
    },
    options(fetchImpl: typeof fetch): BoardServiceOptions {
      return {
        fetch: fetchImpl,
        secrets: {
          get: async (key: string) =>
            key === 'github_token'
              ? overrides.token === undefined
                ? TOKEN
                : overrides.token
              : null,
        },
        settings: { get: async (key: string) => settings[key] ?? null },
        storage: {
          loadData: async <T>() => store.data as T | null,
          saveData: async <T>(data: T) => {
            store.data = structuredClone(data);
          },
        },
        now: () => now,
        log,
      };
    },
  };
}

describe('BoardService', () => {
  it('asks for setup when no repo is set, and reads nothing', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host({ repo: null });
    const view = await new BoardService(h.options(gh.fetch)).view();
    expect(view.status).toBe('setup');
    expect(gh.spy).not.toHaveBeenCalled();
  });

  it('asks for setup when the repo is not owner/name', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const view = await new BoardService(host({ repo: 'a/b/c' }).options(gh.fetch)).view();
    expect(view.status).toBe('setup');
    expect(gh.spy).not.toHaveBeenCalled();
  });

  it('says to connect GitHub when there is no token', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const view = await new BoardService(host({ token: null }).options(gh.fetch)).view();
    expect(view.status).toBe('no-token');
    expect(gh.spy).not.toHaveBeenCalled();
  });

  it('draws the board with its history, newest first, each change with its reason', async () => {
    const gh = fakeGitHub([
      {
        sha: sha('2'),
        text: V2,
        author: 'kettle-bot',
        message: 'Fridge first: the cheese is urgent',
      },
      { sha: sha('1'), text: V1, author: 'chef', message: '' },
    ]);
    const view = await new BoardService(host().options(gh.fetch)).view();
    expect(view.status).toBe('ok');
    expect(view.stale).toBe(false);
    expect(view.board?.items).toHaveLength(5);
    expect(view.revision).toBe(sha('2'));
    expect(view.fileUrl).toBe('https://github.com/acme/plans/blob/main/roadmap/roadmap.json');
    expect(view.history.map((e) => [e.author, e.reason, e.changes.map((c) => c.kind)])).toEqual([
      ['kettle-bot', 'Fridge first: the cheese is urgent', ['moved']],
      ['chef', null, ['created']],
    ]);
    expect(view.tokenExpiresAt).toBe('2030-02-20T12:00:00.000Z');
  });

  it('reads GitHub at most once a minute, and a refresh at most every ten seconds', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    await service.view();
    const after = gh.state.calls.length;
    await service.view();
    expect(gh.state.calls.length).toBe(after);
    h.clock.advance(5_000);
    await service.view({ refresh: true });
    expect(gh.state.calls.length).toBe(after);
    h.clock.advance(6_000);
    await service.view({ refresh: true });
    expect(gh.state.calls.length).toBeGreaterThan(after);
    const second = gh.state.calls.length;
    h.clock.advance(61_000);
    await service.view();
    expect(gh.state.calls.length).toBeGreaterThan(second);
  });

  it('reads each old version once, however often the history is drawn', async () => {
    const gh = fakeGitHub([
      { sha: sha('2'), text: V2 },
      { sha: sha('1'), text: V1 },
    ]);
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    await service.view();
    h.clock.advance(61_000);
    await service.view();
    const refs = gh.state.calls.filter((u) => u.includes('?ref='));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('shares one read between callers that ask at the same time', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const service = new BoardService(host().options(gh.fetch));
    await Promise.all([service.view(), service.view(), service.view()]);
    const heads = gh.state.calls.filter((u) => u.endsWith('/contents/roadmap/roadmap.json'));
    expect(heads).toHaveLength(1);
  });

  it('keeps the last good board, dimmed, when the file stops parsing', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    await service.view();
    gh.state.commits = [
      { sha: sha('3'), text: '{ "version": 1, "items": [ } ', author: 'nose', message: 'oops' },
      ...gh.state.commits,
    ];
    h.clock.advance(61_000);
    const view = await service.view();
    expect(view.status).toBe('invalid');
    expect(view.stale).toBe(true);
    expect(view.board?.items).toHaveLength(5);
    expect(view.parseError?.message).toMatch(/^line 1: unexpected '}'/);
    expect(view.history[0]).toMatchObject({ author: 'nose', changes: [{ kind: 'unreadable' }] });
    expect(view.asOf).toBe('2030-01-15T10:00:00.000Z');
  });

  it('keeps the last good board across a restart', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host();
    await new BoardService(h.options(gh.fetch)).view();
    gh.state.down = true;
    const view = await new BoardService(h.options(gh.fetch)).view();
    expect(view.status).toBe('unreachable');
    expect(view.stale).toBe(true);
    expect(view.board?.items).toHaveLength(5);
    expect(view.problem).toBe("GitHub didn't answer");
  });

  it('never shows one repo’s last good board for another', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host();
    await new BoardService(h.options(gh.fetch)).view();
    gh.state.down = true;
    h.settings.repo = 'acme/other';
    const view = await new BoardService(h.options(gh.fetch)).view();
    expect(view.board).toBeNull();
  });

  it('says GitHub refused, by status only', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    gh.state.status = 403;
    const view = await new BoardService(host().options(gh.fetch)).view();
    expect(view.status).toBe('unreachable');
    expect(view.problem).toBe('GitHub refused (403)');
  });

  it('says there is no roadmap yet when the file is not there', async () => {
    const gh = fakeGitHub([]);
    const view = await new BoardService(host().options(gh.fetch)).view();
    expect(view.status).toBe('no-file');
    expect(view.board).toBeNull();
  });

  it('tells an expired token from one that stopped working', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    gh.state.expiry = '2030-01-20 12:00:00 UTC';
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    await service.view();
    gh.state.status = 401;
    gh.state.expiry = null;

    h.clock.advance(61_000);
    let view = await service.view();
    expect(view.status).toBe('auth-failed');
    expect(view.stale).toBe(true);
    expect(view.board?.items).toHaveLength(5);

    h.clock.set('2030-01-21T00:00:00Z');
    view = await service.view();
    expect(view.status).toBe('auth-expired');
    expect(view.tokenExpiresAt).toBe('2030-01-20T12:00:00.000Z');
    expect(view.problem).toBe('GitHub refused (401)');
  });

  it('forgets an old token’s expiry once GitHub answers without one', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    gh.state.expiry = '2030-01-18 12:00:00 UTC';
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    expect((await service.view()).tokenExpiresAt).toBe('2030-01-18T12:00:00.000Z');
    gh.state.expiry = null;
    h.clock.advance(61_000);
    expect((await service.view()).tokenExpiresAt).toBeNull();
  });

  it('says a commit fixed the file, and what it changed since the last good version', async () => {
    const V3 = sampleText((doc) => {
      itemsOf(doc)[2]!.horizon = 'later';
    });
    const gh = fakeGitHub([
      { sha: sha('3'), text: V3, message: 'Fix the file' },
      { sha: sha('2'), text: '{ broken', message: 'oops' },
      { sha: sha('1'), text: V1 },
    ]);
    const view = await new BoardService(host().options(gh.fetch)).view();
    expect(view.history.map((e) => e.changes.map((c) => c.kind))).toEqual([
      ['fixed', 'moved'],
      ['unreadable'],
      ['created'],
    ]);
  });

  it('says the repo moved when GitHub redirects', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    gh.state.status = 301;
    const view = await new BoardService(host().options(gh.fetch)).view();
    expect(view.problem).toBe('The repo has moved. Update the Repo setting');
  });

  it('starts again when the token or the repo changes', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
    const h = host();
    const service = new BoardService(h.options(gh.fetch));
    await service.view();
    const before = gh.state.calls.length;
    h.settings.repo = 'acme/other';
    await service.view();
    expect(gh.state.calls.length).toBeGreaterThan(before);
    expect(gh.state.calls.at(-1)).toContain('/repos/acme/other/');
  });

  it('never puts the token in a view or a log line, whatever happens', async () => {
    const scenarios: ((gh: ReturnType<typeof fakeGitHub>) => void)[] = [
      () => {},
      (gh) => (gh.state.status = 401),
      (gh) => (gh.state.status = 500),
      (gh) => (gh.state.down = true),
      (gh) => (gh.state.commits = [{ sha: sha('9'), text: 'not json' }]),
    ];
    for (const scenario of scenarios) {
      const gh = fakeGitHub([{ sha: sha('1'), text: V1 }]);
      scenario(gh);
      const h = host();
      const view = await new BoardService(h.options(gh.fetch)).view();
      expect(JSON.stringify(view)).not.toContain(TOKEN);
      expect(JSON.stringify(h.log.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(h.store.data)).not.toContain(TOKEN);
    }
  });
});
