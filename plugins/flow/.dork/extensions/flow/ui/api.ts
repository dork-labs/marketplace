/**
 * The Flow screens' calls to the extension's own routes (`server.ts`), mounted
 * by DorkOS at `/api/ext/flow/`. Every call goes through the frame's
 * `api.request` (DorkOS client API version 2): a screen runs in a frame of its
 * own, with no network, and can reach only flow's routes. `activate` hands
 * the API in with {@link setFlowRequester}.
 *
 * @module @dorkos/flow/extension/ui/api
 */

import type { AccountEligibility, CoreProject } from '../lib/account-rules.ts';
import type { CapacityView } from '../lib/capacity.ts';
import type { FleetAccount, FleetView } from '../lib/fleet.ts';
import type { DecisionAnswer, FlowRequester } from '../lib/host-types.ts';
import type { FlowModel } from '../lib/model.ts';
import type { RepoMigration } from '../lib/repo-migration.ts';
import type {
  LocalSettings,
  PauseDefault,
  ProjectSettingsView,
  SharedSettings,
} from '../lib/settings-shape.ts';

export type {
  AccountEligibility,
  AccountEligibilityRow,
  CoreProject,
} from '../lib/account-rules.ts';

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

/** Shown when DorkOS refused a change because it could not tell a person made it. */
export const PERSON_ONLY_MESSAGE = 'Only a person can change this.';

/** Shown when a request fails without a message from flow. */
export const UNREACHABLE_MESSAGE = "Flow didn't respond, so nothing was changed. Try again.";

/** Said when a name holds a character no route path can carry. */
export const UNSENDABLE_NAME_MESSAGE =
  "Flow can't send a name with /, \\, %, ? or # in it, so nothing was changed.";

/** The frame's API, once `activate` has handed it in. */
let requester: FlowRequester | null = null;

/**
 * Hand the calls the frame's API. `activate` calls it first, in every frame.
 *
 * @param api - The frame's `api`, or `null` to forget it (tests).
 */
export function setFlowRequester(api: FlowRequester | null): void {
  requester = api;
}

/** What DorkOS refuses in a path segment: separators, `%`, a query or hash, control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const UNSENDABLE = /[/\\%?#\u0000-\u001f\u007f]/;

/**
 * One path segment as written. DorkOS encodes each segment itself and refuses
 * a raw `%`, so a value is never encoded here; one that a path cannot carry
 * is refused before anything is sent.
 *
 * @param value - A project name, account key or decision key.
 * @returns The value.
 * @throws {FleetRequestError} When the value can't be a segment.
 */
export function segment(value: string): string {
  if (value === '' || value === '.' || value === '..' || UNSENDABLE.test(value)) {
    throw new FleetRequestError(0, UNSENDABLE_NAME_MESSAGE, true);
  }
  return value;
}

/** Call one of flow's routes and return its body, or throw with the words to show. */
async function call<T = FleetView>(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  if (requester === null) throw new FleetRequestError(0, UNREACHABLE_MESSAGE);
  try {
    return await requester.request<T>(path, body === undefined ? { method } : { method, body });
  } catch (failure) {
    // A route that answered with an error rejects with its status and body;
    // anything else (DorkOS refused the call, or nothing answered) has no status.
    const { status, body: said } = (failure ?? {}) as { status?: unknown; body?: unknown };
    if (typeof status !== 'number') throw new FleetRequestError(0, UNREACHABLE_MESSAGE);
    const answer = (said !== null && typeof said === 'object' ? said : {}) as {
      error?: unknown;
      refusedBy?: unknown;
    };
    // Only flow's own refusal (a 4xx its routes send on purpose, in plain words)
    // is shown; the host's errors and any 5xx read as "could not be reached".
    const refusal =
      status >= 400 &&
      status < 500 &&
      answer.refusedBy === 'flow' &&
      typeof answer.error === 'string' &&
      answer.error !== '';
    if (!refusal && status === 403) {
      // DorkOS's person guard: the change came from something it could not tell was you.
      throw new FleetRequestError(403, PERSON_ONLY_MESSAGE);
    }
    throw new FleetRequestError(
      status,
      refusal ? (answer.error as string) : UNREACHABLE_MESSAGE,
      refusal
    );
  }
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
export async function putAccount(key: string, patch: AccountPatch): Promise<FleetView> {
  return call('PUT', `/fleet/accounts/${segment(key)}`, patch);
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
 * passed along, so flow says which project it is (for a DorkOS that does not
 * say so itself). Reading never makes flow look in a new folder; `addFolder`
 * does.
 *
 * @param cwd - The chat's folder, or `null`.
 * @returns The `GET /model` body.
 */
export function getModel(cwd: string | null): Promise<FlowModel> {
  return call<FlowModel>('GET', cwd ? `/model?cwd=${encodeURIComponent(cwd)}` : '/model');
}

/**
 * Tell flow, as the person, to look for a project in the chat's folder from
 * now on, and report it to DorkOS so "Set up flow here" can start work there.
 * Only a person can (DOR-3581).
 *
 * @param cwd - The chat's folder.
 * @returns The `GET /model?cwd=` body for that folder.
 */
export function addFolder(cwd: string): Promise<FlowModel> {
  return call<FlowModel>('POST', '/folders', { cwd });
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
 * Tell flow which DorkOS schedules the person switched back on in Tasks (or
 * found gone), so it stops asking.
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
export async function answerHere(
  key: string,
  body: DecisionAnswer,
  shown: string
): Promise<LocalAnswerReply> {
  return call<LocalAnswerReply>('POST', `/decisions/${segment(key)}`, {
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
export async function allowAdapter(project: string): Promise<FlowModel> {
  return call<FlowModel>('POST', `/projects/${segment(project)}/allow-adapter`);
}

/**
 * Read a project's settings, by who a change reaches.
 *
 * @param project - The project's name.
 * @returns The `GET /settings/:name` body.
 */
export async function getSettings(project: string): Promise<ProjectSettingsView> {
  return call<ProjectSettingsView>('GET', `/settings/${segment(project)}`);
}

/** What a settings write may change. */
export interface SettingsWrite {
  /** Keys for the shared file. */
  shared?: Partial<{ [K in keyof SharedSettings]: SharedSettings[K]['value'] }>;
  /** Keys for the local file. */
  local?: Partial<{ [K in keyof LocalSettings]: LocalSettings[K]['value'] }>;
  /** The pause menu's highlighted choice. */
  pauseDefault?: PauseDefault;
}

/**
 * Change a project's settings.
 *
 * @param project - The project's name.
 * @param body - What to change.
 * @returns The new `GET /settings/:name` body.
 */
export async function putSettings(
  project: string,
  body: SettingsWrite
): Promise<ProjectSettingsView> {
  return call<ProjectSettingsView>('PUT', `/settings/${segment(project)}`, body);
}

/**
 * Read the record of moving "Only for these repos" into DorkOS.
 *
 * @returns The record.
 */
export function getRepoMigration(): Promise<RepoMigration> {
  return call<RepoMigration>('GET', '/fleet/migration');
}

/**
 * Replace the record of moving "Only for these repos" into DorkOS.
 *
 * @param record - The new record.
 * @returns The record as stored.
 */
export function putRepoMigration(record: RepoMigration): Promise<RepoMigration> {
  return call<RepoMigration>('PUT', '/fleet/migration', record);
}

/**
 * Every Claude account as a project's rules see it, as DorkOS keeps them.
 * Read through flow's route; only a person changes the rules, in Settings →
 * Runtimes.
 *
 * @param project - One of flow's projects, by its main checkout, or none for
 *   each account's own rule alone.
 * @returns The rules.
 */
export function getEligibility(project?: string): Promise<AccountEligibility> {
  const query = project === undefined ? '' : `?project=${encodeURIComponent(project)}`;
  return call<AccountEligibility>('GET', `/accounts/eligibility${query}`);
}

/**
 * Every project DorkOS lists for flow, with the repo it comes from.
 *
 * @returns The projects.
 */
export async function listCoreProjects(): Promise<CoreProject[]> {
  const body = await call<{ projects?: unknown }>('GET', '/known-projects');
  return Array.isArray(body?.projects) ? (body.projects as CoreProject[]) : [];
}
