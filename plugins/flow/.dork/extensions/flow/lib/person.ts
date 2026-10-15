/**
 * The person bar in front of every Flow route that changes something.
 *
 * DorkOS decides, for each request, whether a person sent it, and hands its
 * verdict to the fetch handler as the second argument: Hono's `c.env`
 * (`ExtensionCaller.person`). It is the same bar `ctx.requirePerson` applied
 * to the old router, so an agent calling flow's routes still cannot pause a
 * project or change an account's policy.
 *
 * DorkOS has its own `requirePerson()` in `@dorkos/extension-api/server`, but
 * that package is not published, so flow keeps this small copy of it. Like
 * core's, it fails closed: a request that arrives with no verdict, or one it
 * cannot read, is refused, never let through.
 *
 * @module @dorkos/flow/extension/person
 */

import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ExtensionCaller, PersonCheck, PersonRefusal } from './host-types.ts';

/** The Hono environment of flow's app: DorkOS's caller is `c.env`. */
export interface FlowEnv {
  /** Who sent the request, as DorkOS passes it to the fetch handler. */
  Bindings: ExtensionCaller;
}

/** What a request with no verdict DorkOS gave, or one flow cannot read, is refused with. */
export const UNKNOWN_CALLER: PersonRefusal = {
  ok: false,
  status: 403,
  body: {
    error: 'Only a person can do this.',
    code: 'extension_person_required',
    message: 'Flow changed nothing, because it could not tell who sent this.',
  },
};

/**
 * Whether a value is a well-formed verdict: `{ ok: true }`, or a refusal with
 * an error status and the three words DorkOS always sends.
 *
 * @param value - What arrived as `c.env.person`.
 * @returns True when it can be trusted as a verdict.
 */
function isPersonCheck(value: unknown): value is PersonCheck {
  if (typeof value !== 'object' || value === null) return false;
  const check = value as { ok?: unknown; status?: unknown; body?: unknown };
  if (check.ok === true) return true;
  if (check.ok !== false) return false;
  const body = check.body as { error?: unknown; code?: unknown; message?: unknown } | null;
  return (
    typeof check.status === 'number' &&
    Number.isInteger(check.status) &&
    check.status >= 400 &&
    check.status <= 599 &&
    typeof body === 'object' &&
    body !== null &&
    typeof body.error === 'string' &&
    typeof body.code === 'string' &&
    typeof body.message === 'string'
  );
}

/**
 * Hono middleware that admits only a person. Anyone else is answered with
 * DorkOS's own refusal (its status and words), and the route never runs.
 *
 * @returns The middleware.
 */
export function requirePerson(): MiddlewareHandler<FlowEnv> {
  return async (c, next) => {
    const person: unknown = (c.env as Partial<ExtensionCaller> | undefined)?.person;
    const check = isPersonCheck(person) ? person : UNKNOWN_CALLER;
    if (!check.ok) return c.json(check.body, check.status as ContentfulStatusCode);
    await next();
  };
}
