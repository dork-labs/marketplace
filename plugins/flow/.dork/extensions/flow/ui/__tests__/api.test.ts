/**
 * `ui/api.ts` on client API v2: every call goes through the frame's
 * `api.request`, path segments are sent as written (DorkOS encodes each one
 * and refuses a raw `%`), and a failure reads the way the fetch version read
 * it: flow's own 4xx refusal in its words, any other 403 as person-only, and
 * everything else, a call that never got an answer included, as unreachable.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FleetRequestError,
  PERSON_ONLY_MESSAGE,
  UNREACHABLE_MESSAGE,
  UNSENDABLE_NAME_MESSAGE,
  getSettings,
  putAccount,
  segment,
  setFlowRequester,
} from '../api.ts';
import { NO_JSON, routeRequests } from './helpers.ts';

/** What a call rejected with. */
async function failure(call: Promise<unknown>): Promise<FleetRequestError> {
  const error = await call.then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(FleetRequestError);
  return error as FleetRequestError;
}

describe('segment', () => {
  it('sends a name as written, `.` and `:` included', () => {
    expect(segment('claude-code:Acct 2')).toBe('claude-code:Acct 2');
    expect(segment('q3.v2')).toBe('q3.v2');
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', '50%', 'a?b', 'a#b', 'a\u0000b'])(
    'refuses %j before anything is sent',
    async (name) => {
      const { calls } = routeRequests(() => ({ status: 200, body: {} }));
      expect(() => segment(name)).toThrow(UNSENDABLE_NAME_MESSAGE);
      const error = await failure(getSettings(name));
      expect(error).toMatchObject({ status: 0, refusedByFlow: true });
      expect(calls).toEqual([]);
    }
  );
});

describe('call', () => {
  it('sends the method and body through api.request, and answers its body', async () => {
    const { calls } = routeRequests(() => ({ status: 200, body: { groups: [] } }));
    expect(await putAccount('claude-code:work', { role: 'main' })).toEqual({ groups: [] });
    expect(calls).toEqual([
      { method: 'PUT', url: '/fleet/accounts/claude-code:work', body: { role: 'main' } },
    ]);
  });

  it('shows flow’s own 4xx refusal in its words', async () => {
    routeRequests(() => ({ status: 409, body: { error: 'Pick a role.', refusedBy: 'flow' } }));
    expect(await failure(getSettings('dorkos'))).toMatchObject({
      status: 409,
      message: 'Pick a role.',
      refusedByFlow: true,
    });
  });

  it('reads any other 403 as person-only', async () => {
    routeRequests(() => ({ status: 403, body: { error: 'Agents may not.' } }));
    expect(await failure(getSettings('dorkos'))).toMatchObject({
      status: 403,
      message: PERSON_ONLY_MESSAGE,
      refusedByFlow: false,
    });
  });

  it.each([
    ['a 5xx with flow’s mark', { status: 500, body: { error: 'boom', refusedBy: 'flow' } }],
    ['a host 404', { status: 404, body: { error: 'No such app route' } }],
    ['a body that is not JSON', { status: 502, body: NO_JSON }],
    ['a body that is null', { status: 400, body: null }],
  ])('reads %s as unreachable', async (_name, answer) => {
    routeRequests(() => answer);
    expect(await failure(getSettings('dorkos'))).toMatchObject({
      status: answer.status,
      message: UNREACHABLE_MESSAGE,
      refusedByFlow: false,
    });
  });

  it('reads a call DorkOS refused, or that got no answer, as unreachable with status 0', async () => {
    setFlowRequester({
      request: vi.fn(async () => {
        throw new Error('Use a path inside this app.');
      }),
    });
    expect(await failure(getSettings('dorkos'))).toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
    setFlowRequester(null);
    expect(await failure(getSettings('dorkos'))).toMatchObject({ status: 0 });
  });
});
