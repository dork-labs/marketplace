/**
 * `flow accounts`: list the accounts flow may spend, register one, and set how
 * flow routes work to them (spec `flow-cli-core` §6, §1.1).
 *
 * - `list` (the default) joins the identities in `<dorkHome>/config.json`, the
 *   policy in `<dorkHome>/flow/fleet.json` and each account's usage ledger.
 * - `add` appends one identity to `config.json` and writes no policy, so a new
 *   account starts kept out.
 * - `set <id>` edits that account's policy in `fleet.json`; `set` with no id
 *   takes only `--handoff`.
 *
 * It needs no tracker and no flow project config, and it reads `<dorkHome>` from
 * `DORK_HOME` like every fleet file. Dependency-free: node builtins and local
 * zero-dependency modules only, so it runs before `npm install`.
 *
 * @module @dorkos/flow/cli/accounts
 */

import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJsonFile } from '../atomic-json.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import {
  addIdentity,
  effectiveReservePct,
  fiveHourRoom,
  fleetPolicyPath,
  loadFleetPolicy,
  loadIdentities,
  resolveDorkHome,
  resolveFleetPolicy,
  setAccountPolicy,
  setHandoff,
  updateFleetPolicy,
  weeklyRoom,
  type AccountPolicyPatch,
  type AccountRole,
  type HandoffMode,
} from '../fleet/accounts.ts';
import { readLedger, readWindow, type FleetWarning } from '../fleet/usage-ledger.ts';
import { formatColumns } from './output.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** The flags `set` takes with an account id. */
const POLICY_FLAGS = ['role', 'reserve', 'spend-down-hours', 'repos'] as const;

/** The flags `add` takes. */
const ADD_FLAGS = ['path', 'label', 'color'] as const;

/** A string flag's value, when given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Refuse any of `names` that was given, naming the subcommand that does not take it. */
function refuseFlags(ctx: VerbContext, names: readonly string[], where: string): void {
  const given = names.find((name) => ctx.args.flags[name] !== undefined);
  if (given !== undefined)
    throw new UsageError(`"flow accounts ${where}" does not take --${given}`);
}

/**
 * Run `flow accounts`.
 *
 * @param ctx - The invocation and the injected world.
 * @returns The listing, or what `add` or `set` changed.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [action = 'list', id] = ctx.args.positionals;
  const dorkHome = resolveDorkHome(ctx.env, ctx.env.HOME || os.homedir());
  switch (action) {
    case 'list':
      if (id !== undefined)
        throw new UsageError(`unexpected argument "${id}" for "flow accounts list"`);
      refuseFlags(ctx, [...ADD_FLAGS, ...POLICY_FLAGS, 'handoff', 'dry-run'], 'list');
      return list(ctx, dorkHome);
    case 'add':
      if (id !== undefined)
        throw new UsageError(`unexpected argument "${id}" for "flow accounts add"`);
      refuseFlags(ctx, [...POLICY_FLAGS, 'handoff'], 'add');
      return add(ctx, dorkHome);
    case 'set':
      refuseFlags(ctx, ADD_FLAGS, 'set');
      return id === undefined ? setFleet(ctx, dorkHome) : setAccount(ctx, dorkHome, id);
    default:
      throw new UsageError(`unknown action "${action}" for "flow accounts"; use list, add or set`);
  }
}

/** One account as `list` reports it. */
interface ListedAccount {
  id: string;
  label: string | null;
  path: string;
  color: string | null;
  routable: boolean;
  role: AccountRole;
  reservePct: number;
  effectiveReservePct: number;
  spendDownWindowHours: number;
  scope: { repos: string[] };
  fiveHourRoom: boolean | null;
  weeklyRoom: boolean | null;
  windows: Record<string, unknown>;
}

/** Every identity with its resolved policy, ledger readings and room. */
function list(ctx: VerbContext, dorkHome: string): VerbResult {
  const now = ctx.now();
  const identities = loadIdentities(dorkHome);
  const policy = loadFleetPolicy(dorkHome, identities.accounts);
  const warnings: FleetWarning[] = [...identities.warnings, ...policy.warnings];

  const accounts: ListedAccount[] = identities.accounts.map((identity, index) => {
    const resolved = policy.accounts[index];
    let windows: Record<string, unknown> | null = null;
    const readings: Record<string, unknown> = {};
    if (identity.routable) {
      const ledger = readLedger(dorkHome, identity.id);
      warnings.push(...ledger.warnings);
      windows = ledger.ledger?.windows ?? null;
      for (const key of Object.keys(windows ?? {})) {
        const reading = readWindow(windows?.[key], now, key);
        if (reading !== null) readings[key] = reading;
      }
    }
    return {
      id: identity.id,
      label: identity.label,
      path: identity.path,
      color: identity.color,
      routable: identity.routable,
      role: resolved.role,
      reservePct: resolved.reservePct,
      effectiveReservePct: effectiveReservePct(resolved, windows, now),
      spendDownWindowHours: resolved.spendDownWindowHours,
      scope: resolved.scope,
      fiveHourRoom: fiveHourRoom(windows, now),
      weeklyRoom: weeklyRoom(resolved, windows, now),
      windows: readings,
    };
  });
  if (accounts.length > 0 && policy.mainId === null) {
    warnings.push({
      code: 'no-main',
      message:
        'No account is main, so none keeps a default reserve for your own use. Pick one with "flow accounts set <id> --role main".',
    });
  }
  for (const warning of warnings) ctx.warn(warning.message);

  return {
    json: {
      ok: true,
      dorkHome,
      handoff: policy.handoff,
      mainId: policy.mainId,
      accounts,
      warnings,
    },
    text: renderList(accounts, policy.handoff),
  };
}

/** A window's used share and room, for one cell: `41%`, `100% (no room)` or `unknown`. */
function roomCell(reading: unknown, room: boolean | null): string {
  if (room === null) return 'unknown';
  const used = (reading as { usedPct?: number | null } | undefined)?.usedPct;
  const shown = typeof used === 'number' ? `${Math.round(used)}%` : 'no share';
  return room ? shown : `${shown} (no room)`;
}

/** The human listing: one row per account, then the handoff. */
function renderList(accounts: readonly ListedAccount[], handoff: HandoffMode): string {
  if (accounts.length === 0) {
    return 'No accounts registered. Add one with "flow accounts add --path <dir>".';
  }
  const rows = [['ID', 'ROLE', 'RESERVE', '5-HOUR', '7-DAY', 'LABEL', 'PATH']];
  for (const account of accounts) {
    const role =
      account.role === 'kept-out' && account.scope.repos.length > 0
        ? `kept-out (${account.scope.repos.join(', ')})`
        : account.role;
    const reserve =
      account.effectiveReservePct < account.reservePct
        ? `${account.effectiveReservePct}% (spending down)`
        : `${account.reservePct}%`;
    rows.push([
      account.id,
      role,
      reserve,
      roomCell(account.windows.five_hour, account.fiveHourRoom),
      roomCell(account.windows.seven_day, account.weeklyRoom),
      account.label ?? '-',
      account.path,
    ]);
  }
  const handoffLine =
    handoff === 'auto'
      ? 'Handoff: auto (work moves off a spent account on its own)'
      : 'Handoff: ask (flow asks before moving work off a spent account)';
  return `${formatColumns(rows)}\n\n${handoffLine}`;
}

/** Expand a leading `~` to the home folder. */
function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/** `flow accounts add`: register one identity in `config.json`. */
function add(ctx: VerbContext, dorkHome: string): VerbResult {
  const given = flag(ctx, 'path');
  if (given === undefined || given === '') {
    throw new UsageError('"flow accounts add" needs --path <dir>');
  }
  const accountPath = expandHome(given, ctx.env.HOME || os.homedir());
  if (!path.isAbsolute(accountPath)) {
    throw new UsageError(`--path must be absolute (or start with ~); got "${given}"`);
  }
  let isDir = false;
  try {
    isDir = statSync(accountPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new PreconditionError(`${accountPath} is not an existing folder.`);

  const label = flag(ctx, 'label');
  const rawColor = flag(ctx, 'color');
  const color = rawColor === undefined ? null : rawColor.toLowerCase();
  if (color !== null && !/^#[0-9a-f]{6}$/.test(color)) {
    throw new UsageError(`--color must be #rrggbb; got "${rawColor}"`);
  }

  const result = addIdentity(
    dorkHome,
    { path: accountPath, label: label === undefined || label === '' ? null : label, color },
    { dryRun: ctx.dryRun }
  );
  const note = result.dorkosManaged
    ? 'DorkOS manages this file; you can also add accounts in its settings.'
    : null;
  const lines = [
    `${result.written ? 'Added' : 'Would add'} "${result.row.id}" (${result.row.path}) to ${result.file}.`,
    'It starts kept out: flow spends it only after "flow accounts set" gives it a role.',
  ];
  if (note !== null) lines.unshift(note);
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      file: result.file,
      account: result.row,
      ...(note === null ? {} : { note }),
    },
    text: lines.join('\n'),
  };
}

/** Parse a numeric flag, `default`, or leave it. */
function numberPatch(ctx: VerbContext, name: string): number | null | undefined {
  const value = flag(ctx, name);
  if (value === undefined) return undefined;
  if (value === 'default') return null;
  const parsed = value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number or "default"`);
  return parsed;
}

/** The patch the `set <id>` flags describe. */
function policyPatch(ctx: VerbContext): AccountPolicyPatch {
  const patch: AccountPolicyPatch = {};
  const role = flag(ctx, 'role');
  if (role !== undefined) {
    if (role === 'default') patch.role = null;
    else if (role === 'main' || role === 'rotation' || role === 'kept-out') patch.role = role;
    else throw new UsageError(`--role must be main, rotation, kept-out or default; got "${role}"`);
  }
  const reserve = numberPatch(ctx, 'reserve');
  if (reserve !== undefined) patch.reservePct = reserve;
  const hours = numberPatch(ctx, 'spend-down-hours');
  if (hours !== undefined) patch.spendDownWindowHours = hours;
  const repos = flag(ctx, 'repos');
  if (repos !== undefined) {
    if (repos === 'default') patch.repos = null;
    else if (repos === 'none') patch.repos = [];
    else
      patch.repos = repos
        .split(',')
        .map((repo) => repo.trim())
        .filter((repo) => repo !== '');
  }
  return patch;
}

/** An account's stored entry in a raw `fleet.json`, or `null`. */
function storedEntry(raw: unknown, id: string): unknown {
  const accounts = (raw as { accounts?: unknown } | undefined)?.accounts;
  if (typeof accounts !== 'object' || accounts === null) return null;
  return Object.hasOwn(accounts, id) ? (accounts as Record<string, unknown>)[id] : null;
}

/** `flow accounts set <id>`: edit one account's policy in `fleet.json`. */
async function setAccount(ctx: VerbContext, dorkHome: string, id: string): Promise<VerbResult> {
  refuseFlags(ctx, ['handoff'], 'set <id>');
  const patch = policyPatch(ctx);
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      '"flow accounts set <id>" needs at least one of --role, --reserve, --spend-down-hours, --repos'
    );
  }
  const { accounts: identities } = loadIdentities(dorkHome);
  const identity = identities.find((candidate) => candidate.id === id);
  if (identity === undefined) {
    throw new PreconditionError(
      `"${id}" is not a registered account. Run "flow accounts" to see them, or add it with "flow accounts add --path <dir>".`
    );
  }
  if (!identity.routable) {
    throw new PreconditionError(
      `"${id}" is not a valid account id, so flow cannot route work to it. Fix its id in ${path.join(dorkHome, 'config.json')}.`
    );
  }

  const mutate = (raw: unknown): Record<string, unknown> => {
    if (patch.role === 'main') {
      const { mainId } = resolveFleetPolicy(identities, raw);
      if (mainId !== null && mainId !== id) {
        throw new PreconditionError(
          `"${mainId}" is already the main account. Give it another role first ("flow accounts set ${mainId} --role rotation").`
        );
      }
    }
    return setAccountPolicy(raw, id, patch);
  };

  const file = fleetPolicyPath(dorkHome);
  if (ctx.dryRun) {
    const raw = readJsonFile(file).value;
    const next = mutate(raw);
    return changeResult(file, id, storedEntry(raw, id), storedEntry(next, id), true);
  }
  let before: unknown = null;
  const result = await updateFleetPolicy(dorkHome, (raw) => {
    before = storedEntry(raw, id);
    return mutate(raw);
  });
  droppedCheck(result.status, file);
  return changeResult(file, id, before, storedEntry(result.value, id), false);
}

/** `flow accounts set` with no id: the fleet-wide handoff. */
async function setFleet(ctx: VerbContext, dorkHome: string): Promise<VerbResult> {
  refuseFlags(ctx, POLICY_FLAGS, 'set');
  const value = flag(ctx, 'handoff');
  if (value === undefined) {
    throw new UsageError('"flow accounts set" needs an account id, or --handoff auto|ask|default');
  }
  let handoff: HandoffMode | null;
  if (value === 'default') handoff = null;
  else if (value === 'auto' || value === 'ask') handoff = value;
  else throw new UsageError(`--handoff must be auto, ask or default; got "${value}"`);

  const file = fleetPolicyPath(dorkHome);
  const handoffOf = (raw: unknown): unknown =>
    (raw as { handoff?: unknown } | undefined)?.handoff ?? null;
  if (ctx.dryRun) {
    const raw = readJsonFile(file).value;
    return changeResult(file, null, handoffOf(raw), handoffOf(setHandoff(raw, handoff)), true);
  }
  let before: unknown = null;
  const result = await updateFleetPolicy(dorkHome, (raw) => {
    before = handoffOf(raw);
    return setHandoff(raw, handoff);
  });
  droppedCheck(result.status, file);
  return changeResult(file, null, before, handoffOf(result.value), false);
}

/** A write the lock never let through is a failure the operator should retry. */
function droppedCheck(status: string, file: string): void {
  if (status === 'dropped') {
    throw new PreconditionError(`${file} stayed locked by another writer; nothing changed. Retry.`);
  }
}

/** The result of a `set`: what was stored before and after, as JSON and text. */
function changeResult(
  file: string,
  id: string | null,
  before: unknown,
  after: unknown,
  dryRun: boolean
): VerbResult {
  const subject = id === null ? 'handoff' : `"${id}"`;
  const show = (value: unknown) =>
    value === null || value === undefined ? '(defaults)' : JSON.stringify(value);
  const unchanged = JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
  const verb = unchanged ? 'unchanged' : dryRun ? 'would change' : 'set';
  return {
    json: {
      ok: true,
      file,
      ...(id === null ? {} : { id }),
      dryRun,
      changed: !unchanged,
      before: before ?? null,
      after: after ?? null,
    },
    text: unchanged
      ? `${subject} ${verb}: ${show(after)}`
      : `${subject} ${verb}: ${show(before)} -> ${show(after)} in ${file}`,
  };
}
