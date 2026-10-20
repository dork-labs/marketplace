import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import register, { createHandler, type RoadmapContext } from '../server.ts';
import { fakeGitHub, sha } from './fake-github.ts';
import { sampleText } from './fixtures/roadmap.ts';

const TOKEN = 'github_pat_SECRET_do_not_leak_0123456789';
const EXT_DIR = path.resolve(import.meta.dirname, '..');

function ctx(settings: Record<string, string> = { repo: 'acme/plans' }): RoadmapContext {
  let data: unknown = null;
  return {
    secrets: { get: async (key) => (key === 'github_token' ? TOKEN : null) },
    settings: { get: async (key) => settings[key] ?? null },
    storage: {
      loadData: async <T>() => data as T | null,
      saveData: async (value) => {
        data = value;
      },
    },
  };
}

const get = (p: string, method = 'GET') => new Request(`http://ext${p}`, { method });

describe('the server half', () => {
  it('answers the board with no caching by the browser', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: sampleText() }]);
    const handler = createHandler(ctx(), { fetch: gh.fetch, log: vi.fn() });
    const response = await handler(get('/board'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('takes no path, repo or ref from the request', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: sampleText() }]);
    const handler = createHandler(ctx(), { fetch: gh.fetch, log: vi.fn() });
    await handler(get('/board?repo=evil/repo&path=../../secrets&ref=main'));
    for (const url of gh.state.calls) {
      expect(url.startsWith('https://api.github.com/repos/acme/plans/')).toBe(true);
      expect(url).not.toContain('evil');
      expect(url).not.toContain('secrets');
    }
  });

  it('refuses anything but GET on its two routes', async () => {
    const handler = createHandler(ctx(), { fetch: fakeGitHub([]).fetch });
    expect((await handler(get('/board', 'POST'))).status).toBe(405);
    expect((await handler(get('/seen', 'POST'))).status).toBe(405);
    expect((await handler(get('/elsewhere'))).status).toBe(404);
  });

  it('answers the names the panel uses, cleaned', async () => {
    const handler = createHandler(
      ctx({ repo: 'acme/plans', decider_name: '  Sam\u202e ', keeper_handle: '@plan-keeper' })
    );
    expect(await (await handler(get('/config'))).json()).toEqual({
      deciderName: 'Sam',
      keeperHandle: 'plan-keeper',
      prRepo: null,
    });
    const bad = createHandler(ctx({ keeper_handle: 'Not A Handle' }));
    expect(await (await bad(get('/config'))).json()).toEqual({
      deciderName: null,
      keeperHandle: null,
      prRepo: null,
    });
  });

  it('answers a failure in its own words, never the error’s', async () => {
    const context = ctx();
    context.settings.get = async () => {
      throw new Error(`boom ${TOKEN}`);
    };
    const response = await createHandler(context)(get('/board'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(TOKEN);
  });

  it('lets only a person mark the board seen, and keeps the last good board when they do', async () => {
    const gh = fakeGitHub([{ sha: sha('1'), text: sampleText() }]);
    const context = ctx();
    const handler = createHandler(context, { fetch: gh.fetch, log: vi.fn() });
    await handler(get('/board'));
    const put = (caller: unknown, seen: unknown = sha('1')) =>
      handler(
        new Request('http://ext/seen', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seen }),
        }),
        caller
      );
    const agent = {
      person: { ok: false, status: 403, body: { error: 'x', code: 'y', message: 'z' } },
    };
    expect((await put(agent)).status).toBe(403);
    expect((await put(undefined)).status).toBe(403);
    expect((await put({ person: { ok: true } }, 'main')).status).toBe(400);
    expect((await put({ person: { ok: true } })).status).toBe(200);
    expect(await (await handler(get('/seen'))).json()).toEqual({ seen: sha('1') });
    const stored = (await context.storage.loadData()) as Record<string, unknown>;
    expect(stored.seen).toBe(sha('1'));
    expect(stored.lastGood).toBeDefined();
    expect(stored.tokenExpiresAt).toBeDefined();
  });

  it('registers as a fetch handler', () => {
    expect(typeof register(null, ctx()).fetch).toBe('function');
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'extension.json'), 'utf8'));

  it('runs separately, reaching api.github.com only', () => {
    expect(manifest.serverCapabilities.runtime).toBe('subprocess');
    expect(manifest.serverCapabilities.allow).toEqual({
      net: ['api.github.com:443'],
      run: [],
      agents: false,
    });
  });

  it('keeps the token a secret and names no repo by default', () => {
    const secrets = manifest.serverCapabilities.secrets;
    expect(secrets.map((s: { key: string }) => s.key)).toEqual(['github_token']);
    const repo = manifest.serverCapabilities.settings.find(
      (s: { key: string }) => s.key === 'repo'
    );
    expect(repo.required).toBe(true);
    expect(repo.default).toBeUndefined();
  });
});
