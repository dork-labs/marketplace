/**
 * The fetch-handler types flow builds against, copied from dork-labs/dorkos
 * `packages/extension-api/src/server-entry.ts` as first released in DorkOS
 * 0.116.0 (DOR-2857), types only. They are not in core's seam contract, so
 * this file stands beside it: `__tests__/host-types.contract.test.ts` checks
 * flow's mirror against both. Refresh by copying the types over these; never
 * reshape them by hand.
 *
 * @module @dorkos/flow/extension/contract/fetch-handler
 */
/** What DorkOS answers a caller who is not a person with. */
export interface PersonRefusal {
  /** Not a person. */
  readonly ok: false;
  /** The HTTP status to answer with. */
  readonly status: number;
  /** The JSON body to answer with. */
  readonly body: { readonly error: string; readonly code: string; readonly message: string };
}

/**
 * Whether the caller passed the person bar, the same bar as approving an
 * extension, including its login-off residual: with Require login off, a
 * local caller that does not name itself an agent passes, and in any posture
 * this extension's own page code passes.
 */
export type PersonCheck = { readonly ok: true } | PersonRefusal;

/**
 * Who sent a request, as DorkOS decided before handing it over. The request
 * itself carries no cookie a handler could use to decide this, in an
 * extension that runs in its own process.
 */
export interface ExtensionCaller {
  /** Whether the caller is a person. */
  readonly person: PersonCheck;
}

/**
 * A web-standard request handler. It gets the request with the path below
 * the extension's mount: a request to `/api/ext/my-ext/items?page=2` arrives
 * with the URL `http://<host>/items?page=2`. The second argument says who
 * sent it, which a Hono app reads as `c.env`.
 */
export type ExtensionFetchHandler = (
  request: Request,
  caller: ExtensionCaller
) => Response | Promise<Response>;

/** What `register()` returns to serve its API with a fetch handler. */
export interface ServerExtensionHandlers {
  /** Answers every request under `/api/ext/<id>/` the router does not. */
  fetch?: ExtensionFetchHandler;
  /** Called when the extension stops, like the function `register()` may return. */
  cleanup?: () => void | Promise<void>;
}
