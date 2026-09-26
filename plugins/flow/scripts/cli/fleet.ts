/**
 * The `flow fleet` verb (spec `flow-usage` §2.6 and Amendment 1 A5): every
 * account of every runtime with its usage, and every live session with its
 * account, item, state and host, on one screen, grouped by runtime.
 *
 * Reads only. No file, lock, stamp or tracker is written; the only network call
 * is one `GET` to a DorkOS on this machine. Needs no flow project config and no
 * tracker.
 *
 * Imports no npm package, so it runs before `npm install`. Run records are read
 * leniently through `fleet/sessions.ts` (`readRunStore`), not the zod-validated
 * store reader: one odd record must not hide the others, and a corrupt file must
 * say so rather than read as empty.
 *
 * @module @dorkos/flow/cli/fleet
 */

import { existsSync } from 'node:fs';
import { UsageError } from '../errors.ts';
import { resolveOpenCodeDataDir } from '../fleet/opencode-store.ts';
import {
  accountRoom,
  effectiveReservePct,
  fiveHourRoom,
  loadAccounts,
  loadFleetPolicy,
  resolveAccountRef,
  resolveDorkHome,
  weeklyRoom,
  type AccountIdentity,
  type ResolvedFleetPolicy,
  type RuntimeAccount,
} from '../fleet/accounts.ts';
import { renderFleet, type FleetAccount, type FleetModel } from '../fleet/render.ts';
import {
  assertLoopback,
  collectRuns,
  fetchDorkosSessions,
  fleetAccountKey,
  joinSessions,
  readCliSessions,
  readRunStore,
  resolveDorkosUrl,
  type DorkosResult,
} from '../fleet/sessions.ts';
import {
  IMPLICIT_ACCOUNT_ID,
  isErrorWindowKey,
  listLedgerIds,
  readCredits,
  readLedger,
  readPlan,
  readSpend,
  readWindow,
  type RuntimeSlug,
  type WindowReading,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** One account's report plus the raw ledger windows the session join needs. */
interface AccountRead {
  account: FleetAccount;
  rawWindows: Record<string, unknown> | null;
}

/**
 * Where a runtime's own `default` account lives on this machine, for deciding
 * whether to show it before it has a reading: its folder (rev 6d), or OpenCode's
 * data folder for OpenCode's ambient default.
 */
function implicitHome(
  account: RuntimeAccount,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string | null {
  if (account.path !== null) return account.path;
  if (account.runtime === 'opencode') return resolveOpenCodeDataDir(env, osHome);
  return null;
}

/** Read one account's ledger and policy into its report row. */
function readAccount(
  account: RuntimeAccount,
  resolved: ResolvedFleetPolicy['accounts'][number] | undefined,
  dorkHome: string,
  now: Date,
  warn: (message: string) => void
): AccountRead {
  const tracked = account.ledgerId !== null && resolved !== undefined;
  let ledger: ReturnType<typeof readLedger>['ledger'] = null;
  if (tracked && account.ledgerId !== null) {
    const read = readLedger(dorkHome, account.runtime, account.ledgerId);
    for (const warning of read.warnings) warn(warning.message);
    ledger = read.ledger;
  }
  const rawWindows = ledger?.windows ?? null;
  const windows: Record<string, WindowReading> = {};
  let lastSeen: string | null = null;
  for (const [key, entry] of Object.entries(rawWindows ?? {})) {
    const reading = readWindow(entry, now, key);
    if (reading === null) continue;
    windows[key] = reading;
    if (lastSeen === null || reading.observedAt > lastSeen) lastSeen = reading.observedAt;
  }
  const spend = readSpend(ledger?.spend);
  if (spend !== null && (lastSeen === null || spend.observedAt > lastSeen))
    lastSeen = spend.observedAt;
  const reservePct = resolved?.reservePct ?? 0;
  // Key order is the --json order in spec §2.6 and Amendment 1 A5.
  const row: FleetAccount = {
    runtime: account.runtime,
    id: account.id,
    implicit: account.implicit,
    label: account.label,
    color: account.color,
    path: account.path,
    validId: account.routable,
    role: resolved?.role ?? 'kept-out',
    reservePct,
    effectiveReservePct:
      tracked && resolved ? effectiveReservePct(resolved, rawWindows, now) : reservePct,
    scopeRepos: [...(resolved?.scope.repos ?? [])],
    fiveHourRoom: tracked ? fiveHourRoom(rawWindows, now) : null,
    weeklyRoom: tracked && resolved ? weeklyRoom(resolved, rawWindows, now) : null,
    room: tracked && resolved ? accountRoom(account.runtime, resolved, ledger, now) : null,
    lastSeen,
    windows,
    plan: readPlan(ledger?.plan)?.name ?? null,
    credits: readCredits(ledger?.credits),
    spend,
    errors: Object.keys(windows)
      .filter((key) => isErrorWindowKey(key) && windows[key].status === 'rejected')
      .sort(),
  };
  return { account: row, rawWindows };
}

/**
 * The accounts `flow fleet` shows: every registered account (an aliased
 * `default` is its row), and a runtime's standalone `default` when it has a
 * ledger file or its folder (OpenCode: its data folder) exists on this machine.
 */
function shownAccounts(
  accounts: readonly RuntimeAccount[],
  dorkHome: string,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): RuntimeAccount[] {
  return accounts.filter((account) => {
    if (!account.implicit) return true;
    if (listLedgerIds(dorkHome, account.runtime).includes(account.id)) return true;
    const home = implicitHome(account, env, osHome);
    return home !== null && existsSync(home);
  });
}

/**
 * Run `flow fleet`.
 *
 * @param ctx - The verb context.
 * @returns The screen and its `--json` payload.
 * @throws {UsageError} When `--dorkos-url` and `--no-dorkos` are both given, or
 *   the DorkOS URL is not on this machine (exit 2, before anything is read).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const flag = ctx.args.flags['dorkos-url'];
  const skipDorkos = ctx.args.flags['no-dorkos'] === true;
  if (skipDorkos && flag !== undefined) {
    throw new UsageError('pass --dorkos-url or --no-dorkos, not both');
  }
  const dorkosUrl = skipDorkos
    ? null
    : resolveDorkosUrl(typeof flag === 'string' ? flag : undefined, ctx.env);
  if (dorkosUrl !== null) assertLoopback(dorkosUrl);

  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    ctx.warn(message);
  };
  const now = ctx.now();
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);

  const loaded = loadAccounts(dorkHome, { home: ctx.io.osHome });
  for (const warning of loaded.warnings) warn(warning.message);
  const accounts = shownAccounts(loaded.accounts, dorkHome, ctx.env, ctx.io.osHome);
  const policy = loadFleetPolicy(dorkHome, accounts);
  for (const warning of policy.warnings) warn(warning.message);
  const reads = accounts.map((account, index) =>
    readAccount(account, policy.accounts[index], dorkHome, now, warn)
  );
  // Claude Code session files and DorkOS's account paths are Claude Code config
  // dirs: every Claude Code account with a folder, the standalone default too.
  const claudeIdentities: AccountIdentity[] = accounts.flatMap((account) =>
    account.runtime === 'claude-code' && account.path !== null
      ? [{ ...account, path: account.path }]
      : []
  );
  // A run or DorkOS session that names `default` means the account `default` names (rev 6d).
  const canonicalId = (runtime: string, id: string | null): string | null => {
    if (id !== IMPLICIT_ACCOUNT_ID) return id;
    const runtimeSlug = runtime as RuntimeSlug;
    return resolveAccountRef(loaded.accounts, runtimeSlug, id)?.id ?? id;
  };

  const [cli, dorkos] = await Promise.all([
    readCliSessions(claudeIdentities, {
      pidAlive: ctx.io.pidAlive,
      runProcess: ctx.runProcess,
    }),
    dorkosUrl === null
      ? Promise.resolve<DorkosResult | null>(null)
      : fetchDorkosSessions(dorkosUrl, claudeIdentities, { fetchImpl: ctx.io.fetch }),
  ]);
  for (const warning of cli.warnings) warn(warning.message);
  if (dorkos?.warning !== undefined) warn(dorkos.warning);
  const dorkosSessions = (dorkos?.sessions ?? []).map((session) => ({
    ...session,
    account: canonicalId(session.runtime ?? 'claude-code', session.account),
  }));

  const cwds = [ctx.projectDir];
  for (const session of [...cli.sessions, ...dorkosSessions]) {
    if (session.cwd !== null) cwds.push(session.cwd);
  }
  const collected = await collectRuns(cwds, {
    runProcess: ctx.runProcess,
    readRuns: readRunStore,
  });
  const runWarnings = collected.warnings;
  const runs = collected.runs.map((run) => ({
    ...run,
    account: canonicalId(run.runtime ?? 'claude-code', run.account),
  }));
  for (const warning of runWarnings) warn(warning.message);

  const sessions = joinSessions({
    identities: accounts.map((account) => ({ runtime: account.runtime, id: account.id })),
    cli: cli.sessions,
    dorkos: dorkosSessions,
    runs,
    windowsByAccount: Object.fromEntries(
      reads.map((r) => [fleetAccountKey(r.account.runtime, r.account.id), r.rawWindows])
    ),
    now,
    pidAlive: ctx.io.pidAlive,
  });

  const model: FleetModel = {
    home: ctx.io.osHome,
    handoff: policy.handoff,
    accounts: reads.map((r) => r.account),
    sessions,
    dorkos:
      dorkos === null
        ? null
        : {
            url: dorkos.url,
            reachable: dorkos.reachable,
            sessionsShown: sessions.filter((s) => s.sources.includes('dorkos')).length,
          },
    dorkosListed: dorkos !== null && dorkos.reachable && dorkos.warning === undefined,
  };

  return {
    json: {
      now: now.toISOString(),
      handoff: model.handoff,
      accounts: model.accounts,
      sessions: model.sessions,
      dorkos: model.dorkos,
      warnings,
    },
    text: renderFleet(model, now),
  };
}
