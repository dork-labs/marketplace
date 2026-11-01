/**
 * Flow's person bar (`lib/person.ts`) against DorkOS's own, copied verbatim
 * into `lib/__contract__/person-check.contract.ts`: both are fed the same
 * verdicts and must admit the same callers and refuse the rest with the same
 * status and words. The one planned difference is the message for a caller
 * DorkOS said nothing about, where flow says Flow changed nothing.
 *
 * @module @dorkos/flow/extension/__tests__/person-parity
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  checkPerson,
  requirePerson as coreRequirePerson,
} from '../lib/__contract__/person-check.contract.ts';
import { UNKNOWN_CALLER, requirePerson, type FlowEnv } from '../lib/person.ts';
import { AGENT_REFUSAL } from './fixtures.ts';

/** The words core refuses a caller it said nothing about with. */
const CORE_UNKNOWN_BODY = {
  error: 'Only a person can do this.',
  code: 'extension_person_required',
  message: 'DorkOS changed nothing. Only a person can do this. Ask them to do it in DorkOS.',
};

const refusal = (status: unknown, body: unknown) => ({ person: { ok: false, status, body } });

/** Every shape of caller worth asking both bars about. */
const CALLERS: [string, unknown][] = [
  ['a person', { person: { ok: true } }],
  ['a person, with extra fields', { person: { ok: true, status: 200, body: null } }],
  ['an agent', { person: AGENT_REFUSAL }],
  ['a refusal at 401', refusal(401, AGENT_REFUSAL.body)],
  ['a refusal at 599', refusal(599, AGENT_REFUSAL.body)],
  ['a refusal at 399', refusal(399, AGENT_REFUSAL.body)],
  ['a refusal at 600', refusal(600, AGENT_REFUSAL.body)],
  ['a refusal at 403.5', refusal(403.5, AGENT_REFUSAL.body)],
  ['a refusal with a string status', refusal('403', AGENT_REFUSAL.body)],
  ['a refusal with no body', refusal(403, undefined)],
  ['a refusal with a null body', refusal(403, null)],
  ['a refusal missing its message', refusal(403, { error: 'x', code: 'y' })],
  ['a refusal with a number code', refusal(403, { error: 'x', code: 1, message: 'z' })],
  ['ok as a string', { person: { ok: 'true' } }],
  ['ok as 1', { person: { ok: 1 } }],
  ['a bare ok: false', { person: { ok: false } }],
  ['a null person', { person: null }],
  ['a person as a string', { person: 'yes' }],
  ['an empty caller', {}],
  ['a null caller', null],
  ['no caller at all', undefined],
  ['a caller that is an array', [{ ok: true }]],
];

/** What flow's bar answers, as status and body (`null` when it let the route run). */
async function flowAnswer(caller: unknown) {
  const app = new Hono<FlowEnv>();
  app.post('/x', requirePerson(), (c) => c.body(null, 204));
  const res = await app.request('/x', { method: 'POST' }, caller as never);
  return res.status === 204 ? null : { status: res.status, body: await res.json() };
}

/** What core's Hono middleware answers, the same way. */
async function coreAnswer(caller: unknown) {
  const app = new Hono();
  app.post('/x', coreRequirePerson() as never, (c) => c.body(null, 204));
  const res = await app.request('/x', { method: 'POST' }, caller as never);
  return res.status === 204 ? null : { status: res.status, body: await res.json() };
}

describe("flow's person bar against core's", () => {
  it.each(CALLERS)('answers %s as core does', async (_name, caller) => {
    const core = await coreAnswer(caller);
    // core's checkPerson and its middleware agree with each other.
    const checked = checkPerson(caller);
    expect(checked === null ? null : checked.status).toBe(core === null ? null : core.status);
    const flow = await flowAnswer(caller);
    if (core !== null && JSON.stringify(core.body) === JSON.stringify(CORE_UNKNOWN_BODY)) {
      expect(flow).toEqual({ status: 403, body: UNKNOWN_CALLER.body });
      expect(UNKNOWN_CALLER.body.error).toBe(CORE_UNKNOWN_BODY.error);
      expect(UNKNOWN_CALLER.body.code).toBe(CORE_UNKNOWN_BODY.code);
    } else {
      expect(flow).toEqual(core);
    }
  });

  it('admits exactly the callers core admits', async () => {
    const admitted = [];
    for (const [name, caller] of CALLERS)
      if ((await coreAnswer(caller)) === null) admitted.push(name);
    expect(admitted).toEqual(['a person', 'a person, with extra fields']);
  });
});
