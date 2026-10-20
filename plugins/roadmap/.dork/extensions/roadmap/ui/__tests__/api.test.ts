import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBoard, getConfig, RoadmapRequestError } from '../api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the panel’s calls', () => {
  it('reach only this extension’s own routes', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await getBoard();
    await getBoard(true);
    await getConfig();
    expect(fetchSpy.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      '/api/ext/roadmap/board',
      '/api/ext/roadmap/board?refresh=1',
      '/api/ext/roadmap/config',
    ]);
  });

  it('throws one plain error when the server fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    await expect(getBoard()).rejects.toBeInstanceOf(RoadmapRequestError);
  });
});
