/**
 * flow's person bar (`lib/person.ts`): a person passes; anyone DorkOS refused
 * is answered with DorkOS's own status and words, and the route never runs;
 * and a request with no verdict, or one flow cannot read, is refused (it
 * fails closed).
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_CALLER, requirePerson, type FlowEnv } from '../lib/person.ts';
import { AGENT, AGENT_REFUSAL, PERSON } from './fixtures.ts';

/** An app with one guarded route, and a spy on whether the route ran. */
function guarded() {
  const ran = vi.fn();
  const app = new Hono<FlowEnv>();
  app.post('/change', requirePerson(), (c) => {
    ran();
    return c.json({ changed: true });
  });
  return { app, ran };
}

/** POST /change with `env` as the caller; the status and body. */
async function post(app: Hono<FlowEnv>, env?: unknown) {
  const res = await app.request('/change', { method: 'POST' }, env as FlowEnv['Bindings']);
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('requirePerson', () => {
  it('lets a person through', async () => {
    const { app, ran } = guarded();
    expect(await post(app, PERSON)).toEqual({ status: 200, body: { changed: true } });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('answers an agent with the verdict’s status and body, and the route never runs', async () => {
    const { app, ran } = guarded();
    expect(await post(app, AGENT)).toEqual({ status: 403, body: AGENT_REFUSAL.body });
    const signedOut = {
      person: { ...AGENT_REFUSAL, status: 401, body: { ...AGENT_REFUSAL.body, code: 'login' } },
    };
    expect(await post(app, signedOut)).toEqual({ status: 401, body: signedOut.person.body });
    expect(ran).not.toHaveBeenCalled();
  });

  it.each([
    ['no caller', undefined],
    ['a caller with no verdict', {}],
    ['a verdict that is not an object', { person: 'yes' }],
    ['ok that is not exactly true', { person: { ok: 'true' } }],
    ['a refusal with no body', { person: { ok: false, status: 403 } }],
    ['a refusal with a status that is not an error', { person: { ...AGENT_REFUSAL, status: 200 } }],
    ['a refusal with a body missing its words', { person: { ...AGENT_REFUSAL, body: {} } }],
  ])('fails closed on %s: 403, and the route never runs', async (_name, env) => {
    const { app, ran } = guarded();
    expect(await post(app, env)).toEqual({ status: 403, body: UNKNOWN_CALLER.body });
    expect(ran).not.toHaveBeenCalled();
  });
});
