/**
 * How flow's Hono routes read a request, pinned to what the old Express
 * router handed them: the body as `req.body` held it, a query value as
 * `req.query` held it, and a trailing slash still meeting the person bar.
 *
 * @module @dorkos/flow/extension/__tests__/request-parity
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requirePerson, type FlowEnv } from '../lib/person.ts';
import { jsonBody, queryValue } from '../server.ts';
import { AGENT, PERSON, REFUSED_AGENT } from './fixtures.ts';

/** An app that echoes what flow's helpers read. */
function echo() {
  const app = new Hono<FlowEnv>({ strict: false });
  app.post('/body', async (c) => c.json({ body: (await jsonBody(c)) ?? null }));
  app.get('/query', (c) => c.json({ value: queryValue(c, 'since') ?? null }));
  app.post('/write', requirePerson(), (c) => c.json({ ran: true }));
  return app;
}

async function body(contentType: string | undefined, text: string | undefined) {
  const res = await echo().request(
    '/body',
    {
      method: 'POST',
      headers: contentType === undefined ? undefined : { 'content-type': contentType },
      body: text,
    },
    PERSON
  );
  return ((await res.json()) as { body: unknown }).body;
}

describe('the body, as the old req.body held it', () => {
  it('reads a JSON body, with or without a charset', async () => {
    expect(await body('application/json', '{"a":1}')).toEqual({ a: 1 });
    expect(await body('application/json; charset=utf-8', '{"a":1}')).toEqual({ a: 1 });
    expect(await body('Application/JSON', '{"a":1}')).toEqual({ a: 1 });
  });

  it('reads any other body, and no body at all, as nothing', async () => {
    expect(await body('text/plain', '{"a":1}')).toBeNull();
    expect(await body(undefined, '{"a":1}')).toBeNull();
    expect(await body('application/json', '')).toBeNull();
    expect(await body('application/json', undefined)).toBeNull();
  });
});

describe('a query value, as the old req.query held it', () => {
  async function value(query: string) {
    const res = await echo().request(`/query${query}`, {}, PERSON);
    return ((await res.json()) as { value: unknown }).value;
  }

  it('is missing, one string, or every value when repeated', async () => {
    expect(await value('')).toBeNull();
    expect(await value('?since=1h')).toBe('1h');
    expect(await value('?since=a&since=b')).toEqual(['a', 'b']);
  });
});

describe('the person bar on path variants', () => {
  it('refuses an agent on a trailing slash or an encoded path, and lets a person through', async () => {
    for (const route of ['/write', '/write/', '/%77rite']) {
      const res = await echo().request(route, { method: 'POST' }, AGENT);
      expect({ status: res.status, body: await res.json() }, route).toEqual(REFUSED_AGENT);
    }
    const ok = await echo().request('/write/', { method: 'POST' }, PERSON);
    expect(await ok.json()).toEqual({ ran: true });
  });
});
