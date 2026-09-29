/**
 * The Flow tab's calls to the extension's own routes (`server.ts`), mounted by
 * DorkOS at `/api/ext/flow/`.
 *
 * @module @dorkos/flow/extension/ui/api
 */

import type { CapacityView } from '../lib/capacity.ts';
import type { FleetAccount, FleetView } from '../lib/fleet.ts';
import type { DecisionAnswer } from '../lib/host-types.ts';
import type { FlowModel } from '../lib/model.ts';

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
  /** True when flow itself refused, in words meant for the person. */
  readonly refusedByFlow: boolean;

  /**
   * @param status - The HTTP status, or 0.
   * @param message - The message to show.
   * @param refusedByFlow - Whether flow itself refused.
   */
  constructor(status: number, message: string, refusedByFlow = false) {
    super(message);
    this.name = 'FleetRequestError';
    this.status = status;
    this.refusedByFlow = refusedByFlow;
  }
}

/** Thrown by {@link getFleet} when DorkOS is too old for the Flow tab. */
export class HostTooOldError extends Error {
  constructor() {
    super('host-too-old');
    this.name = 'HostTooOldError';
  }
}

/** Shown when DorkOS refused a change because it could not tell a person made it. */
export const PERSON_ONLY_MESSAGE = 'Only a person can change this.';

/** Shown when a request fails without a message from flow. */
export const UNREACHABLE_MESSAGE = "Flow didn't respond, so nothing was changed. Try again.";

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
async function call<T = FleetView>(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
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
  if (response.ok) return json as T;
  const answer = (json ?? {}) as { error?: unknown; reason?: unknown; refusedBy?: unknown };
  if (response.status === 501 && answer.reason === 'host-too-old') throw new HostTooOldError();
  // Only flow's own refusal (a 4xx its routes send on purpose, in plain words)
  // is shown; the host's errors and any 5xx read as "could not be reached".
  const refusal =
    response.status >= 400 &&
    response.status < 500 &&
    answer.refusedBy === 'flow' &&
    typeof answer.error === 'string' &&
    answer.error !== '';
  if (!refusal && response.status === 403) {
    // DorkOS's person guard: the change came from something it could not tell was you.
    throw new FleetRequestError(403, PERSON_ONLY_MESSAGE);
  }
  throw new FleetRequestError(
    response.status,
    refusal ? (answer.error as string) : UNREACHABLE_MESSAGE,
    refusal
  );
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

/**
 * Read the Flow tab's model. The folder of the chat the tab sits beside is
 * passed along, so flow looks for a project there too and says which project
 * it is (for a DorkOS that does not say so itself).
 *
 * @param cwd - The chat's folder, or `null`.
 * @returns The `GET /model` body.
 */
export function getModel(cwd: string | null): Promise<FlowModel> {
  return call<FlowModel>('GET', cwd ? `/model?cwd=${encodeURIComponent(cwd)}` : '/model');
}

/** Which projects a pause or resume acts on: one, by name, or every set-up one. */
export type PauseTarget = { project: string } | { all: true };

/**
 * Pause flow in one project or all of them.
 *
 * @param target - Which.
 * @param until - When it ends by itself (ISO with its offset), or `null` for "until I resume".
 * @returns The new model.
 */
export function pauseFlow(target: PauseTarget, until: string | null): Promise<FlowModel> {
  return call<FlowModel>('POST', '/pause', { ...target, until });
}

/**
 * Resume flow in one project or all of them.
 *
 * @param target - Which.
 * @returns The new model.
 */
export function resumeFlow(target: PauseTarget): Promise<FlowModel> {
  return call<FlowModel>('POST', '/resume', target);
}

/**
 * Tell flow which DorkOS schedules the Flow tab switched back on (or found
 * gone), so it stops asking.
 *
 * @param project - The project's name.
 * @param ids - The schedule ids.
 * @returns The new model.
 */
export function schedulesRestored(project: string, ids: readonly string[]): Promise<FlowModel> {
  return call<FlowModel>('POST', '/schedules/restored', { project, ids });
}

/**
 * Read "Capacity this week".
 *
 * @param since - The start of the person's week (their Monday 00:00), ISO.
 * @returns The `GET /capacity` body.
 */
export function getCapacity(since: string): Promise<CapacityView> {
  return call<CapacityView>('GET', `/capacity?since=${encodeURIComponent(since)}`);
}

/** What flow's own answer route says (a DorkOS without the inbox, §7.6). */
export interface LocalAnswerReply {
  /** Whether the answer settled the ask. */
  resolved: boolean;
  /** Something to tell the person, or `null`. */
  message: string | null;
  /** A chat flow started for it, or `null`. */
  watch: { sessionId: string; label: string } | null;
  /** The new model. */
  model: FlowModel;
}

/**
 * Answer an ask through flow's own route, on a DorkOS without the inbox.
 *
 * @param key - The ask's key.
 * @param body - The answer, as DorkOS's `DecisionAnswer` shapes it.
 * @param shown - The ask's words as the page showed them; flow refuses the
 *   answer when the ask changed since.
 * @returns What happened, and the new model.
 */
export function answerHere(
  key: string,
  body: DecisionAnswer,
  shown: string
): Promise<LocalAnswerReply> {
  return call<LocalAnswerReply>('POST', `/decisions/${encodeURIComponent(key)}`, {
    ...body,
    shown,
  });
}

/**
 * Let flow run a project's own tracker adapter, as it is now.
 *
 * @param project - The project's name.
 * @returns The new model.
 */
export function allowAdapter(project: string): Promise<FlowModel> {
  return call<FlowModel>('POST', `/projects/${encodeURIComponent(project)}/allow-adapter`);
}
