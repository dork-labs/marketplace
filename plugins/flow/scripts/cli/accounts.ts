/**
 * `flow accounts`: list the accounts flow may spend, register one, and set how
 * flow routes work to them (spec `flow-cli-core` §6, §1.1).
 *
 * - `list` (the default) joins every runtime's accounts in
 *   `<dorkHome>/config.json` (a runtime with none has its implicit `default`),
 *   the policy in `<dorkHome>/flow/fleet.json` and each account's usage ledger,
 *   grouped by runtime. It drops the stored policy of an account that is no
 *   longer registered, and says so.
 * - `add` appends one Claude Code identity to `config.json` and writes no
 *   policy, so a new account starts kept out.
 * - `set <id>` edits that account's policy in `fleet.json` (`<runtime>:<id>`, or
 *   a bare id for Claude Code); `set` with no id takes the fleet-wide
 *   `--handoff`, `--runtimes` and `--cross-runtime-fallback`.
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
  accountKey,
  accountRoom,
  addIdentity,
  dropAccountPolicies,
  effectiveReservePct,
  fiveHourRoom,
  fleetPolicyPath,
  loadAccounts,
  loadFleetPolicy,
  parseAccountKey,
  resolveDorkHome,
  resolveFleetPolicy,
  setAccountPolicy,
  setFleetSetting,
  unknownPolicyKeys,
  updateFleetPolicy,
  weeklyRoom,
  type AccountPolicyPatch,
  type AccountRole,
  type CrossRuntimeFallback,
  type FleetSettings,
  type HandoffMode,
  type ResolvedFleetPolicy,
} from '../fleet/accounts.ts';
import {
  RUNTIMES,
  isRuntimeSlug,
  readLedger,
  readSpend,
  readWindow,
  type FleetWarning,
  type RuntimeSlug,
  type SpendEntry,
} from '../fleet/usage-ledger.ts';
import { formatColumns } from './output.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** The flags `set` takes with an account id. */
const POLICY_FLAGS = ['role', 'reserve', 'spend-down-hours', 'repos'] as const;

/** The flags `add` takes. */
const ADD_FLAGS = ['path', 'label', 'color'] as const;

/** The flags `set` takes with no account id. */
const FLEET_FLAGS = ['handoff', 'runtimes', 'cross-runtime-fallback'] as const;

/** Each runtime's name for people. */
const RUNTIME_NAMES: Readonly<Record<RuntimeSlug, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

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
      refuseFlags(ctx, [...ADD_FLAGS, ...POLICY_FLAGS, ...FLEET_FLAGS], 'list');
      return list(ctx, dorkHome);
    case 'add':
      if (id !== undefined)
        throw new UsageError(`unexpected argument "${id}" for "flow accounts add"`);
      refuseFlags(ctx, [...POLICY_FLAGS, ...FLEET_FLAGS], 'add');
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
  runtime: RuntimeSlug;
  key: string;
  id: string;
  implicit: boolean;
  label: string | null;
  path: string | null;
  color: string | null;
  routable: boolean;
  role: AccountRole;
  reservePct: number;
  effectiveReservePct: number;
  spendDownWindowHours: number;
  scope: { repos: string[] };
  fiveHourRoom: boolean | null;
  weeklyRoom: boolean | null;
  room: boolean | null;
  windows: Record<string, unknown>;
  spend: SpendEntry | null;
}

/**
 * Drop the stored policy of every account that is no longer registered (spec
 * §1.1b), unless the registry could not be read in full or this is a dry run.
 *
 * @returns The keys dropped (or, on a dry run, that would be).
 */
async function dropUnknown(
  ctx: VerbContext,
  dorkHome: string,
  accounts: Parameters<typeof unknownPolicyKeys>[0],
  registryReadable: boolean
): Promise<string[]> {
  if (!registryReadable) return [];
  const file = fleetPolicyPath(dorkHome);
  const raw = readJsonFile(file).value;
  const keys = unknownPolicyKeys(accounts, raw);
  if (keys.length === 0 || ctx.dryRun) return keys;
  let dropped: string[] = [];
  const result = await updateFleetPolicy(dorkHome, (current) => {
    dropped = unknownPolicyKeys(accounts, current);
    return dropped.length === 0 ? current : dropAccountPolicies(current, dropped);
  });
  return result.status === 'dropped' ? [] : dropped;
}

/** Every account of every runtime with its resolved policy, ledger readings and room. */
async function list(ctx: VerbContext, dorkHome: string): Promise<VerbResult> {
  const now = ctx.now();
  const registry = loadAccounts(dorkHome);
  const dropped = await dropUnknown(ctx, dorkHome, registry.accounts, registry.registryReadable);
  const policy = loadFleetPolicy(dorkHome, registry.accounts);
  const warnings: FleetWarning[] = [
    ...registry.warnings,
    ...policy.warnings.filter((w) => !(w.code === 'entry-unknown-id' && dropped.length > 0)),
  ];

  const accounts: ListedAccount[] = registry.accounts.map((account, index) => {
    const resolved = policy.accounts[index];
    let windows: Record<string, unknown> | null = null;
    let ledger: { windows?: unknown; spend?: unknown } | null = null;
    const readings: Record<string, unknown> = {};
    if (account.routable) {
      const read = readLedger(dorkHome, account.runtime, account.id);
      warnings.push(...read.warnings);
      ledger = read.ledger;
      windows = read.ledger?.windows ?? null;
      for (const key of Object.keys(windows ?? {})) {
        const reading = readWindow(windows?.[key], now, key);
        if (reading !== null) readings[key] = reading;
      }
    }
    return {
      runtime: account.runtime,
      key: account.key,
      id: account.id,
      implicit: account.implicit,
      label: account.label,
      path: account.path,
      color: account.color,
      routable: account.routable,
      role: resolved.role,
      reservePct: resolved.reservePct,
      effectiveReservePct: effectiveReservePct(resolved, windows, now),
      spendDownWindowHours: resolved.spendDownWindowHours,
      scope: resolved.scope,
      fiveHourRoom: fiveHourRoom(windows, now),
      weeklyRoom: weeklyRoom(resolved, windows, now),
      room: account.routable ? accountRoom(account.runtime, resolved, ledger, now) : false,
      windows: readings,
      spend: readSpend(ledger?.spend),
    };
  });
  for (const runtime of RUNTIMES) {
    const registered = accounts.filter((a) => a.runtime === runtime && !a.implicit);
    if (registered.length > 0 && policy.mains[runtime] === undefined) {
      warnings.push({
        code: 'no-main',
        message: `No ${RUNTIME_NAMES[runtime]} account is main, so none keeps a default reserve for your own use. Pick one with "flow accounts set <id> --role main".`,
      });
    }
  }
  const notes = dropped.map(
    (key) =>
      `${ctx.dryRun ? 'Would drop' : 'Dropped'} the policy for "${key}": it is no longer a registered account.`
  );
  for (const note of notes) ctx.warn(note);
  for (const warning of warnings) ctx.warn(warning.message);

  return {
    json: {
      ok: true,
      dorkHome,
      handoff: policy.handoff,
      runtimes: policy.runtimes,
      crossRuntimeFallback: policy.crossRuntimeFallback,
      mains: policy.mains,
      accounts,
      dropped,
      warnings,
    },
    text: renderList(accounts, policy),
  };
}

/** A window's used share and room, for one cell: `41%`, `100% (no room)` or `unknown`. */
function roomCell(reading: unknown, room: boolean | null): string {
  if (room === null) return 'unknown';
  const used = (reading as { usedPct?: number | null } | undefined)?.usedPct;
  const shown = typeof used === 'number' ? `${Math.round(used)}%` : 'no share';
  return room ? shown : `${shown} (no room)`;
}

/** The overall room, for one cell. */
function overallCell(account: ListedAccount): string {
  const spend =
    account.spend === null
      ? ''
      : ` ($${account.spend.costUsd.toFixed(2)}${account.spend.limitUsd === null ? '' : ` of $${account.spend.limitUsd.toFixed(2)}`})`;
  if (account.room === null) return `unknown${spend}`;
  return `${account.room ? 'yes' : 'no'}${spend}`;
}

/** The human listing: one table per runtime, then the fleet-wide settings. */
function renderList(accounts: readonly ListedAccount[], policy: ResolvedFleetPolicy): string {
  const blocks: string[] = [];
  for (const runtime of RUNTIMES) {
    const rows = [['ID', 'ROLE', 'RESERVE', '5-HOUR', '7-DAY', 'ROOM', 'LABEL', 'PATH']];
    for (const account of accounts.filter((a) => a.runtime === runtime)) {
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
        overallCell(account),
        account.label ?? '-',
        account.path ?? '(this environment)',
      ]);
    }
    blocks.push(`${RUNTIME_NAMES[runtime]}\n${formatColumns(rows)}`);
  }
  if (!accounts.some((a) => a.runtime === 'claude-code' && !a.implicit)) {
    blocks.push(
      'No Claude Code account is registered, so flow uses the one this environment signs in with. Add one with "flow accounts add --path <dir>".'
    );
  }
  const settings = [
    policy.handoff === 'auto'
      ? 'Handoff: auto (work moves off a spent account on its own)'
      : 'Handoff: ask (flow asks before moving work off a spent account)',
    policy.runtimes.length === 0
      ? 'Runtimes: the one each item started on'
      : `Runtimes: ${policy.runtimes.join(', ')}`,
    policy.crossRuntimeFallback === 'on'
      ? 'Cross-runtime fallback: on (work may move to another runtime when its own is out)'
      : 'Cross-runtime fallback: off',
  ];
  blocks.push(settings.join('\n'));
  return blocks.join('\n\n');
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

/** An account's stored entry in a raw `fleet.json` (bare keys read as Claude Code), or `null`. */
function storedEntry(raw: unknown, key: string): unknown {
  const accounts = (raw as { accounts?: unknown } | undefined)?.accounts;
  if (typeof accounts !== 'object' || accounts === null) return null;
  const record = accounts as Record<string, unknown>;
  if (Object.hasOwn(record, key)) return record[key];
  const parsed = parseAccountKey(key);
  if (parsed?.runtime === 'claude-code' && Object.hasOwn(record, parsed.id))
    return record[parsed.id];
  return null;
}

/** `flow accounts set <id>`: edit one account's policy in `fleet.json`. */
async function setAccount(ctx: VerbContext, dorkHome: string, given: string): Promise<VerbResult> {
  refuseFlags(ctx, FLEET_FLAGS, 'set <id>');
  const patch = policyPatch(ctx);
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      '"flow accounts set <id>" needs at least one of --role, --reserve, --spend-down-hours, --repos'
    );
  }
  const parsed = parseAccountKey(given);
  if (parsed === null) {
    throw new UsageError(
      `"${given}" is not an account: use <id> for Claude Code, or <runtime>:<id> with a runtime of ${RUNTIMES.join(', ')}`
    );
  }
  const { accounts } = loadAccounts(dorkHome);
  const account = accounts.find((a) => a.runtime === parsed.runtime && a.id === parsed.id);
  const key = accountKey(parsed.runtime, parsed.id);
  if (account === undefined) {
    throw new PreconditionError(
      `"${key}" is not a registered account. Run "flow accounts" to see them, or add one with "flow accounts add --path <dir>".`
    );
  }
  if (!account.routable) {
    throw new PreconditionError(
      `"${key}" is not a valid account id, so flow cannot route work to it. Fix its id in ${path.join(dorkHome, 'config.json')}.`
    );
  }

  const mutate = (raw: unknown): Record<string, unknown> => {
    if (patch.role === 'main') {
      const current = resolveFleetPolicy(accounts, raw).mains[account.runtime];
      if (current !== undefined && current !== account.id) {
        const currentKey = accountKey(account.runtime, current);
        throw new PreconditionError(
          `"${currentKey}" is already the main ${RUNTIME_NAMES[account.runtime]} account. Give it another role first ("flow accounts set ${currentKey} --role rotation").`
        );
      }
    }
    return setAccountPolicy(raw, key, patch);
  };

  const file = fleetPolicyPath(dorkHome);
  if (ctx.dryRun) {
    const raw = readJsonFile(file).value;
    const next = mutate(raw);
    return changeResult(file, key, storedEntry(raw, key), storedEntry(next, key), true);
  }
  let before: unknown = null;
  const result = await updateFleetPolicy(dorkHome, (raw) => {
    before = storedEntry(raw, key);
    return mutate(raw);
  });
  droppedCheck(result.status, file);
  return changeResult(file, key, before, storedEntry(result.value, key), false);
}

/** The one fleet-wide setting the `set` flags name, and its new value (`null` = default). */
function fleetChange(ctx: VerbContext): {
  name: keyof FleetSettings;
  value: FleetSettings[keyof FleetSettings] | null;
} {
  const given = FLEET_FLAGS.filter((name) => ctx.args.flags[name] !== undefined);
  if (given.length !== 1) {
    throw new UsageError(
      '"flow accounts set" needs an account id, or exactly one of --handoff auto|ask|default, --runtimes <runtime,...>|default, --cross-runtime-fallback off|on|default'
    );
  }
  const value = flag(ctx, given[0]) ?? '';
  if (given[0] === 'handoff') {
    if (value === 'default') return { name: 'handoff', value: null };
    if (value === 'auto' || value === 'ask') return { name: 'handoff', value };
    throw new UsageError(`--handoff must be auto, ask or default; got "${value}"`);
  }
  if (given[0] === 'cross-runtime-fallback') {
    if (value === 'default') return { name: 'crossRuntimeFallback', value: null };
    if (value === 'off' || value === 'on')
      return { name: 'crossRuntimeFallback', value: value as CrossRuntimeFallback };
    throw new UsageError(`--cross-runtime-fallback must be off, on or default; got "${value}"`);
  }
  if (value === 'default') return { name: 'runtimes', value: null };
  const listed = value
    .split(',')
    .map((runtime) => runtime.trim())
    .filter((runtime) => runtime !== '');
  const bad = listed.find((runtime) => !isRuntimeSlug(runtime));
  if (listed.length === 0 || bad !== undefined || new Set(listed).size !== listed.length) {
    throw new UsageError(
      `--runtimes must list runtimes once each, in order (${RUNTIMES.join(', ')}), or be "default"; got "${value}"`
    );
  }
  return { name: 'runtimes', value: listed as RuntimeSlug[] };
}

/** `flow accounts set` with no id: one fleet-wide setting. */
async function setFleet(ctx: VerbContext, dorkHome: string): Promise<VerbResult> {
  refuseFlags(ctx, POLICY_FLAGS, 'set');
  const { name, value } = fleetChange(ctx);
  const file = fleetPolicyPath(dorkHome);
  const valueOf = (raw: unknown): unknown =>
    (raw as Record<string, unknown> | undefined)?.[name] ?? null;
  const apply = (raw: unknown) => setFleetSetting(raw, name, value);
  if (ctx.dryRun) {
    const raw = readJsonFile(file).value;
    return changeResult(file, name, valueOf(raw), valueOf(apply(raw)), true, true);
  }
  let before: unknown = null;
  const result = await updateFleetPolicy(dorkHome, (raw) => {
    before = valueOf(raw);
    return apply(raw);
  });
  droppedCheck(result.status, file);
  return changeResult(file, name, before, valueOf(result.value), false, true);
}

/** A write the lock never let through is a failure the operator should retry. */
function droppedCheck(status: string, file: string): void {
  if (status === 'dropped') {
    throw new PreconditionError(`${file} stayed locked by another writer; nothing changed. Retry.`);
  }
}

/**
 * The result of a `set`: what was stored before and after, as JSON and text.
 * `subject` is the account key, or the fleet-wide setting's name when `fleet`.
 */
function changeResult(
  file: string,
  subject: string,
  before: unknown,
  after: unknown,
  dryRun: boolean,
  fleet = false
): VerbResult {
  const id = fleet ? null : subject;
  const shown = fleet ? subject : `"${subject}"`;
  const show = (value: unknown) =>
    value === null || value === undefined ? '(defaults)' : JSON.stringify(value);
  const unchanged = JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
  const verb = unchanged ? 'unchanged' : dryRun ? 'would change' : 'set';
  return {
    json: {
      ok: true,
      file,
      ...(id === null ? { setting: subject } : { id }),
      dryRun,
      changed: !unchanged,
      before: before ?? null,
      after: after ?? null,
    },
    text: unchanged
      ? `${shown} ${verb}: ${show(after)}`
      : `${shown} ${verb}: ${show(before)} -> ${show(after)} in ${file}`,
  };
}
