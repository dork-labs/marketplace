/**
 * DorkOS's own person check, copied verbatim from dork-labs/dorkos
 * `packages/extension-api/src/server-entry.ts` as released in DorkOS 0.116.0
 * (unchanged on main since). `__tests__/person-parity.contract.test.ts` feeds
 * it and flow's `lib/person.ts` the same verdicts and expects the same
 * answers, so flow's copy cannot quietly drift from core's rule. Refresh by
 * copying core's code over everything below the imports; never edit it by hand.
 *
 * @module @dorkos/flow/extension/contract/person-check
 */
import type { PersonCheck, PersonRefusal } from './fetch-handler.contract.ts';

/** What a caller DorkOS said nothing about is refused with: fail closed. */
const UNKNOWN_CALLER: PersonRefusal = {
  ok: false,
  status: 403,
  body: {
    error: 'Only a person can do this.',
    code: 'extension_person_required',
    message: 'DorkOS changed nothing. Only a person can do this. Ask them to do it in DorkOS.',
  },
};

/**
 * The answer to send a caller who is not a person, or `null` when the caller
 * is one. For a fetch handler written without Hono:
 *
 * ```ts
 * fetch(request, caller) {
 *   const refused = checkPerson(caller);
 *   if (refused) return refused;
 *   // ...
 * }
 * ```
 *
 * Anything that is not a caller DorkOS handed over is refused.
 *
 * @param caller - The second argument the fetch handler was called with.
 */
export function checkPerson(caller: unknown): Response | null {
  const person = (caller as { person?: unknown } | null | undefined)?.person;
  const check: PersonCheck = isPersonCheck(person) ? person : UNKNOWN_CALLER;
  if (check.ok) return null;
  return Response.json(check.body, { status: check.status });
}

/**
 * Hono middleware that admits only a person; anyone else is answered as
 * {@link checkPerson} answers them. Put it in front of every route that
 * changes something on a person's behalf:
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { requirePerson } from '@dorkos/extension-api/server';
 *
 * const app = new Hono();
 * app.put('/settings', requirePerson(), async (c) => c.json(await save(await c.req.json())));
 * ```
 *
 * Typed without Hono's own types, so this package does not depend on it.
 */
export function requirePerson(): (
  c: { readonly env: unknown },
  next: () => Promise<void>
) => Promise<Response | void> {
  return async (c, next) => {
    const refused = checkPerson(c.env);
    if (refused) return refused;
    await next();
  };
}

/** Whether a value is a well-formed {@link PersonCheck}. */
function isPersonCheck(value: unknown): value is PersonCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as { ok?: unknown; status?: unknown; body?: unknown };
  if (check.ok === true) return true;
  if (check.ok !== false) return false;
  const body = check.body as { error?: unknown; code?: unknown; message?: unknown } | null;
  return (
    typeof check.status === 'number' &&
    Number.isInteger(check.status) &&
    check.status >= 400 &&
    check.status <= 599 &&
    !!body &&
    typeof body === 'object' &&
    typeof body.error === 'string' &&
    typeof body.code === 'string' &&
    typeof body.message === 'string'
  );
}
