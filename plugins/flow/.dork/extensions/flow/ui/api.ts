/**
 * The Flow tab's calls to the extension's own routes (`server.ts`), mounted by
 * DorkOS at `/api/ext/flow/`.
 *
 * @module @dorkos/flow/extension/ui/api
 */

import type { FleetAccount, FleetView } from '../lib/fleet.ts';

/** The desktop shell's bridge, when the tab runs inside the DorkOS app. */
interface ElectronBridge {
  getServerPort?: () => number | null | undefined;
}

/** What a write to one account may change (`null` resets a field to flow's default). */
export interface AccountPatch {
  /** The account's role. */
  role?: FleetAccount['role'] | null;
  /** The share of the weekly limit kept back, 0-100. */
  reservePct?: number | null;
  /** Hours before the weekly reset in which the reserve drops to 0. */
  spendDownWindowHours?: number | null;
  /** For a kept-out account: the repos it may serve. */
  repos?: string[] | null;
}

/** A request the server refused or could not answer, with the words to show. */
export class FleetRequestError extends Error {
  /** The HTTP status, or 0 when the server could not be reached. */
  readonly status: number;

  /**
   * @param status - The HTTP status, or 0.
   * @param message - The message to show.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FleetRequestError';
    this.status = status;
  }
}

/** Thrown by {@link getFleet} when DorkOS is too old for the Flow tab. */
export class HostTooOldError extends Error {
  constructor() {
    super('host-too-old');
    this.name = 'HostTooOldError';
  }
}

/** Shown when a request fails without a message from flow. */
export const UNREACHABLE_MESSAGE = 'Flow could not be reached, so this was not changed.';

/**
 * The DorkOS API base URL. In the desktop app the page is not served by the
 * DorkOS server, so a relative `/api` would miss it; the shell reports the port.
 * Mirrors DorkOS's `linear-issues` extension, which cannot share the client's
 * helper either.
 *
 * @returns `http://localhost:<port>/api` in the desktop app, else `/api`.
 */
export function resolveApiBaseUrl(): string {
  const bridge = (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
  const port = bridge?.getServerPort?.();
  return port ? `http://localhost:${port}/api` : '/api';
}

/** Call one of flow's routes and return its body, or throw with the words to show. */
async function call(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<FleetView> {
  let response: Response;
  try {
    response = await fetch(`${resolveApiBaseUrl()}/ext/flow${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new FleetRequestError(0, UNREACHABLE_MESSAGE);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return json as FleetView;
  const answer = (json ?? {}) as { error?: unknown; reason?: unknown };
  if (response.status === 501 && answer.reason === 'host-too-old') throw new HostTooOldError();
  const message =
    typeof answer.error === 'string' && answer.error !== '' ? answer.error : UNREACHABLE_MESSAGE;
  throw new FleetRequestError(response.status, message);
}

/**
 * Read every account with flow's policy for it.
 *
 * @returns The `GET /fleet` body.
 */
export function getFleet(): Promise<FleetView> {
  return call('GET', '/fleet');
}

/**
 * Change one account's policy.
 *
 * @param key - The account's policy key, `<runtime>:<id>`.
 * @param patch - The fields to change.
 * @returns The new `GET /fleet` body.
 */
export function putAccount(key: string, patch: AccountPatch): Promise<FleetView> {
  return call('PUT', `/fleet/accounts/${encodeURIComponent(key)}`, patch);
}

/**
 * Change what happens when an account runs out.
 *
 * @param handoff - `auto` or `ask`.
 * @returns The new `GET /fleet` body.
 */
export function putHandoff(handoff: FleetView['handoff']): Promise<FleetView> {
  return call('PUT', '/fleet/handoff', { handoff });
}

/**
 * Turn continuing on another runtime on or off.
 *
 * @param crossRuntimeFallback - `off` or `on`.
 * @returns The new `GET /fleet` body.
 */
export function putCrossRuntime(
  crossRuntimeFallback: FleetView['crossRuntimeFallback']
): Promise<FleetView> {
  return call('PUT', '/fleet/cross-runtime', { crossRuntimeFallback });
}
