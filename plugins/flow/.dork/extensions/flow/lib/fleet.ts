/**
 * The Flow tab's data (spec `claude-account-ui` §8.2): every account DorkOS
 * knows, with flow's routing policy for it, and the writes that change that
 * policy in `<dorkHome>/flow/fleet.json`.
 *
 * Every rule comes from flow's own fleet contract (`scripts/fleet/accounts.ts`,
 * `scripts/fleet/usage-ledger.ts`); this module maps DorkOS's account list onto
 * it and shapes the answer. Writes go through `updateFleetPolicy`, the
 * contract's lock-and-merge writer, so an edit the flow CLI makes between two
 * requests is never lost.
 *
 * @module @dorkos/flow/extension/fleet
 */

import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import { PreconditionError, UsageError } from '../../../../scripts/errors.ts';
import {
  DEFAULT_ACCOUNT_LABEL,
  accountKey,
  effectiveReservePct,
  fleetPolicyPath,
  loadFleetPolicy,
  resolveFleetPolicy,
  setAccountPolicy,
  setFleetSetting,
  updateFleetPolicy,
  type AccountPolicyPatch,
  type AccountRole,
  type CrossRuntimeFallback,
  type HandoffMode,
  type PolicySubject,
  type ResolvedFleetPolicy,
} from '../../../../scripts/fleet/accounts.ts';
import {
  ACCOUNT_ID_PATTERN,
  isRuntimeSlug,
  readLedger,
  type RuntimeSlug,
  type UsageLedger,
} from '../../../../scripts/fleet/usage-ledger.ts';
import type { AccountSummary } from './host-types.ts';

/** The color of a runtime's implicit account: the stone palette value (decided, Q21). */
export const IMPLICIT_ACCOUNT_COLOR = '#78716c';

/** A repo a kept-out account may serve: `owner/name`. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Each runtime's name as a person reads it. */
export const RUNTIME_LABELS: Readonly<Record<RuntimeSlug, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** One account row of `GET /fleet`. */
export interface FleetAccount {
  /** The contract's policy key, `<runtime>:<id>`. */
  key: string;
  /** The registry id, or `default`. */
  id: string;
  /** What to call it. */
  label: string;
  /** Its display color. */
  color: string;
  /** True for a runtime's implicit `default`. */
  implicit: boolean;
  /** The resolved role. */
  role: AccountRole;
  /** The stored or default reserve. */
  reservePct: number;
  /** Hours before the weekly reset in which the reserve drops to 0. */
  spendDownWindowHours: number;
  /** For kept-out: the repos it may serve. */
  repos: string[];
  /** The reserve in force now. */
  effectiveReservePct: number;
}

/** One runtime's group in `GET /fleet`. */
export interface FleetGroup {
  /** The runtime slug. */
  runtime: string;
  /** Its name. */
  label: string;
  /** Whether the runtime can run on more than its own sign-in (spec §8.2). */
  supportsAccounts: boolean;
  /** Its accounts. */
  accounts: FleetAccount[];
}

/** The `GET /fleet` body. */
export interface FleetView {
  /** Fleet-wide handoff mode. */
  handoff: HandoffMode;
  /** Whether work may continue on another runtime. */
  crossRuntimeFallback: CrossRuntimeFallback;
  /** Accounts by runtime. */
  groups: FleetGroup[];
  /** True when at least one account has a role stored in `fleet.json`. */
  anyRoleStored: boolean;
  /** Everything flow read as absent or ignored, in plain words. */
  warnings: string[];
}

/** One DorkOS account as flow's contract sees it. */
export interface FleetSubject extends PolicySubject {
  /** The runtime. */
  runtime: RuntimeSlug;
  /** DorkOS's summary of it. */
  summary: AccountSummary;
}

/** An error a route turns into a status code. */
export class RouteError extends Error {
  /** The HTTP status. */
  readonly status: number;

  /**
   * @param status - The HTTP status.
   * @param message - The message the body carries.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
  }
}

/** The fleet writer, injectable so tests can count its calls. */
export type FleetWriter = typeof updateFleetPolicy;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * DorkOS's accounts as the contract's policy subjects, in DorkOS's order.
 * An account of a runtime flow does not know is left out.
 *
 * @param summaries - `ctx.accounts.list()`.
 * @returns One subject per account.
 */
export function fleetSubjects(summaries: readonly AccountSummary[]): FleetSubject[] {
  const subjects: FleetSubject[] = [];
  for (const summary of summaries) {
    if (!isRuntimeSlug(summary.runtime)) continue;
    subjects.push({
      runtime: summary.runtime,
      id: summary.id,
      implicit: summary.implicit,
      routable: ACCOUNT_ID_PATTERN.test(summary.id),
      summary,
    });
  }
  return subjects;
}

/**
 * An account's raw ledger, read with flow's own reader. A missing or unreadable
 * ledger, or an id with no ledger file, reads as `null`.
 *
 * @param dorkHome - The DorkOS home.
 * @param runtime - The account's runtime.
 * @param accountId - Its id.
 * @returns The ledger, or `null`.
 */
export function ledgerFor(
  dorkHome: string,
  runtime: RuntimeSlug,
  accountId: string
): UsageLedger | null {
  return readLedger(dorkHome, runtime, accountId).ledger;
}

/**
 * An account's raw ledger windows (the record flow's room and reserve rules
 * take, not DorkOS's `AccountUsage`). A missing ledger reads as `null`.
 *
 * @param dorkHome - The DorkOS home.
 * @param runtime - The account's runtime.
 * @param accountId - Its id.
 * @returns The windows, or `null`.
 */
export function ledgerWindowsFor(
  dorkHome: string,
  runtime: RuntimeSlug,
  accountId: string
): Record<string, unknown> | null {
  const ledger = ledgerFor(dorkHome, runtime, accountId);
  return ledger === null ? null : (ledger.windows as Record<string, unknown>);
}

/**
 * The raw `fleet.json` value, or `undefined` when there is none.
 *
 * @param dorkHome - The DorkOS home.
 * @returns The parsed file.
 */
export function readRawFleet(dorkHome: string): unknown {
  return readJsonFile(fleetPolicyPath(dorkHome)).value;
}

/**
 * The entry `fleet.json` stores for an account, before defaults: its
 * `<runtime>:<id>` key, or a bare pre-2.0.0 key for a Claude Code account.
 *
 * @param raw - The raw file.
 * @param runtime - The account's runtime.
 * @param id - Its id.
 * @returns The stored entry, or `undefined`.
 */
export function storedEntry(
  raw: unknown,
  runtime: RuntimeSlug,
  id: string
): Record<string, unknown> | undefined {
  if (!isObject(raw) || !isObject(raw.accounts)) return undefined;
  const accounts = raw.accounts;
  const key = accountKey(runtime, id);
  const entry = Object.hasOwn(accounts, key)
    ? accounts[key]
    : runtime === 'claude-code' && Object.hasOwn(accounts, id)
      ? accounts[id]
      : undefined;
  return isObject(entry) ? entry : undefined;
}

/**
 * The label of an account as the Flow tab and the Flow panel show it.
 *
 * - Claude Code's standalone `default` (its own sign-in folder, when no
 *   registered row names that folder) takes DorkOS's label, "Main (this
 *   computer's sign-in)", or flow's same {@link DEFAULT_ACCOUNT_LABEL} when
 *   DorkOS gave none. A `default` that aliases a registered row is not listed
 *   on its own: DorkOS lists that row once, under its own label.
 * - Codex's and OpenCode's implicit accounts read "<Runtime> (this computer's
 *   sign-in)": the panel has no runtime captions, so two rows called "Main"
 *   would not say which is which.
 */
function accountLabel(subject: FleetSubject): string {
  if (subject.implicit) {
    if (subject.runtime === 'claude-code') return subject.summary.label ?? DEFAULT_ACCOUNT_LABEL;
    return `${RUNTIME_LABELS[subject.runtime]} (this computer's sign-in)`;
  }
  return subject.summary.label ?? subject.id;
}

/**
 * Build the `GET /fleet` body.
 *
 * @param dorkHome - The DorkOS home.
 * @param summaries - `ctx.accounts.list()`.
 * @param now - The clock.
 * @returns The view.
 */
export function buildFleetView(
  dorkHome: string,
  summaries: readonly AccountSummary[],
  now: Date
): FleetView {
  const subjects = fleetSubjects(summaries);
  const policy: ResolvedFleetPolicy = loadFleetPolicy(dorkHome, subjects);
  const raw = readRawFleet(dorkHome);
  const groups: FleetGroup[] = [];
  let anyRoleStored = false;
  subjects.forEach((subject, index) => {
    const resolved = policy.accounts[index];
    let group = groups.find((g) => g.runtime === subject.runtime);
    if (group === undefined) {
      group = {
        runtime: subject.runtime,
        label: RUNTIME_LABELS[subject.runtime],
        supportsAccounts: false,
        accounts: [],
      };
      groups.push(group);
    }
    if (!subject.implicit) group.supportsAccounts = true;
    if (typeof storedEntry(raw, subject.runtime, subject.id)?.role === 'string') {
      anyRoleStored = true;
    }
    const windows = subject.routable
      ? ledgerWindowsFor(dorkHome, subject.runtime, subject.id)
      : null;
    group.accounts.push({
      key: resolved.key,
      id: subject.id,
      label: accountLabel(subject),
      color: subject.implicit ? IMPLICIT_ACCOUNT_COLOR : subject.summary.color,
      implicit: subject.implicit,
      role: resolved.role,
      reservePct: resolved.reservePct,
      spendDownWindowHours: resolved.spendDownWindowHours,
      repos: [...resolved.scope.repos],
      effectiveReservePct: effectiveReservePct(resolved, windows, now),
    });
  });
  return {
    handoff: policy.handoff,
    crossRuntimeFallback: policy.crossRuntimeFallback,
    groups,
    anyRoleStored,
    warnings: policy.warnings.map((warning) => warning.message),
  };
}

/**
 * Check a `PUT /fleet/accounts/:key` body and turn it into flow's patch.
 *
 * @param body - The request body.
 * @returns The patch.
 * @throws {RouteError} 400 naming the first field or repo that is wrong.
 */
export function parsePolicyPatch(body: unknown): AccountPolicyPatch {
  if (!isObject(body)) throw new RouteError(400, 'The body must be a JSON object.');
  const patch: AccountPolicyPatch = {};
  if (body.role !== undefined) {
    if (body.role !== null && !['main', 'rotation', 'kept-out'].includes(body.role as string)) {
      throw new RouteError(400, `role must be main, rotation, kept-out or null.`);
    }
    patch.role = body.role as AccountRole | null;
  }
  for (const field of ['reservePct', 'spendDownWindowHours'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'number') {
      throw new RouteError(400, `${field} must be a number or null.`);
    }
    patch[field] = value;
  }
  if (body.repos !== undefined) {
    if (body.repos !== null && !Array.isArray(body.repos)) {
      throw new RouteError(400, 'repos must be a list of owner/name repos, or null.');
    }
    for (const repo of body.repos ?? []) {
      if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
        throw new RouteError(400, `${JSON.stringify(repo)} is not an owner/name repo.`);
      }
    }
    patch.repos = body.repos as string[] | null;
  }
  return patch;
}

/**
 * Run one `fleet.json` write and turn flow's failures into route errors: a
 * lock that never freed or a newer file version is 409 with flow's message, a
 * value the contract refuses is 400.
 */
async function write(
  writer: FleetWriter,
  dorkHome: string,
  mutate: (raw: unknown) => unknown
): Promise<void> {
  let result: Awaited<ReturnType<FleetWriter>>;
  try {
    result = await writer(dorkHome, mutate);
  } catch (error) {
    if (error instanceof UsageError) throw new RouteError(400, error.message);
    if (error instanceof PreconditionError) throw new RouteError(409, error.message);
    throw error;
  }
  if (result.status === 'dropped') {
    throw new RouteError(
      409,
      result.warnings[0]?.message ?? 'fleet.json is locked; nothing was changed.'
    );
  }
}

/**
 * `PUT /fleet/accounts/:key`: change one account's policy in ONE locked
 * write. Choosing `main` while another account of the same runtime is stored as
 * `main` stores that one as `rotation` in the same write (one main per runtime).
 *
 * @param opts - The DorkOS home, the accounts, the key, the body and the writer.
 * @throws {RouteError} 404 for an unknown key, 400 for a bad body, 409 for a lock failure.
 */
export async function putAccountPolicy(opts: {
  dorkHome: string;
  summaries: readonly AccountSummary[];
  key: string;
  body: unknown;
  writer: FleetWriter;
}): Promise<void> {
  const subjects = fleetSubjects(opts.summaries);
  const target = subjects.find((s) => accountKey(s.runtime, s.id) === opts.key);
  if (target === undefined) throw new RouteError(404, `No account has the key "${opts.key}".`);
  const patch = parsePolicyPatch(opts.body);
  await write(opts.writer, opts.dorkHome, (raw) => {
    let next: unknown = setAccountPolicy(raw, opts.key, patch);
    if (patch.role === 'main') {
      for (const other of subjects) {
        if (other === target || other.runtime !== target.runtime) continue;
        if (storedEntry(raw, other.runtime, other.id)?.role !== 'main') continue;
        next = setAccountPolicy(next, accountKey(other.runtime, other.id), { role: 'rotation' });
      }
    }
    return next;
  });
}

/**
 * `PUT /fleet/handoff`.
 *
 * @param opts - The DorkOS home, the body and the writer.
 * @throws {RouteError} 400 for a bad body, 409 for a lock failure.
 */
export async function putHandoff(opts: {
  dorkHome: string;
  body: unknown;
  writer: FleetWriter;
}): Promise<void> {
  const value = isObject(opts.body) ? opts.body.handoff : undefined;
  if (value !== 'auto' && value !== 'ask') {
    throw new RouteError(400, 'handoff must be auto or ask.');
  }
  await write(opts.writer, opts.dorkHome, (raw) => setFleetSetting(raw, 'handoff', value));
}

/**
 * `PUT /fleet/cross-runtime`.
 *
 * @param opts - The DorkOS home, the body and the writer.
 * @throws {RouteError} 400 for a bad body, 409 for a lock failure.
 */
export async function putCrossRuntime(opts: {
  dorkHome: string;
  body: unknown;
  writer: FleetWriter;
}): Promise<void> {
  const value = isObject(opts.body) ? opts.body.crossRuntimeFallback : undefined;
  if (value !== 'off' && value !== 'on') {
    throw new RouteError(400, 'crossRuntimeFallback must be off or on.');
  }
  await write(opts.writer, opts.dorkHome, (raw) =>
    setFleetSetting(raw, 'crossRuntimeFallback', value)
  );
}

/**
 * The resolved policy for DorkOS's accounts, and the raw file it came from.
 *
 * @param dorkHome - The DorkOS home.
 * @param subjects - The accounts.
 * @returns The policy and the raw file.
 */
export function readPolicy(
  dorkHome: string,
  subjects: readonly FleetSubject[]
): { policy: ResolvedFleetPolicy; raw: unknown } {
  const raw = readRawFleet(dorkHome);
  return { policy: resolveFleetPolicy(subjects, raw), raw };
}
