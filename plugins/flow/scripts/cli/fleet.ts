/**
 * The `flow fleet` verb (spec `flow-usage` §2.6): every registered account with
 * its usage bars, and every live session with its account, item, state and host,
 * on one screen.
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

import { UsageError } from '../errors.ts';
import {
  effectiveReservePct,
  fiveHourRoom,
  loadFleetPolicy,
  loadIdentities,
  resolveDorkHome,
  weeklyRoom,
  type AccountIdentity,
  type ResolvedFleetPolicy,
} from '../fleet/accounts.ts';
import { renderFleet, type FleetAccount, type FleetModel } from '../fleet/render.ts';
import {
  assertLoopback,
  collectRuns,
  fetchDorkosSessions,
  joinSessions,
  readCliSessions,
  readRunStore,
  resolveDorkosUrl,
  type DorkosResult,
} from '../fleet/sessions.ts';
import { readLedger, readWindow, type WindowReading } from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** One account's report plus the raw ledger windows the session join needs. */
interface AccountRead {
  account: FleetAccount;
  rawWindows: Record<string, unknown> | null;
}

/** Read one account's ledger and policy into its report row. */
function readAccount(
  identity: AccountIdentity,
  policy: ResolvedFleetPolicy,
  dorkHome: string,
  now: Date,
  warn: (message: string) => void
): AccountRead {
  const resolved = policy.accounts.find((entry) => entry.id === identity.id);
  const tracked = identity.routable && resolved !== undefined;
  let rawWindows: Record<string, unknown> | null = null;
  if (tracked) {
    const { ledger, warnings } = readLedger(dorkHome, identity.id);
    for (const warning of warnings) warn(warning.message);
    rawWindows = ledger?.windows ?? null;
  }
  const windows: Record<string, WindowReading> = {};
  let lastSeen: string | null = null;
  for (const [key, entry] of Object.entries(rawWindows ?? {})) {
    const reading = readWindow(entry, now, key);
    if (reading === null) continue;
    windows[key] = reading;
    if (lastSeen === null || reading.observedAt > lastSeen) lastSeen = reading.observedAt;
  }
  const reservePct = resolved?.reservePct ?? 0;
  // Key order is the --json order in spec §2.6.
  const account: FleetAccount = {
    id: identity.id,
    label: identity.label,
    color: identity.color,
    path: identity.path,
    validId: identity.routable,
    role: resolved?.role ?? 'kept-out',
    reservePct,
    effectiveReservePct: tracked ? effectiveReservePct(resolved, rawWindows, now) : reservePct,
    scopeRepos: [...(resolved?.scope.repos ?? [])],
    fiveHourRoom: tracked ? fiveHourRoom(rawWindows, now) : null,
    weeklyRoom: tracked ? weeklyRoom(resolved, rawWindows, now) : null,
    lastSeen,
    windows,
  };
  return { account, rawWindows };
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

  const identities = loadIdentities(dorkHome);
  for (const warning of identities.warnings) warn(warning.message);
  const policy = loadFleetPolicy(dorkHome, identities.accounts);
  for (const warning of policy.warnings) warn(warning.message);
  const reads = identities.accounts.map((identity) =>
    readAccount(identity, policy, dorkHome, now, warn)
  );

  const [cli, dorkos] = await Promise.all([
    readCliSessions(identities.accounts, {
      pidAlive: ctx.io.pidAlive,
      runProcess: ctx.runProcess,
    }),
    dorkosUrl === null
      ? Promise.resolve<DorkosResult | null>(null)
      : fetchDorkosSessions(dorkosUrl, identities.accounts, { fetchImpl: ctx.io.fetch }),
  ]);
  for (const warning of cli.warnings) warn(warning.message);
  if (dorkos?.warning !== undefined) warn(dorkos.warning);
  const dorkosSessions = dorkos?.sessions ?? [];

  const cwds = [ctx.projectDir];
  for (const session of [...cli.sessions, ...dorkosSessions]) {
    if (session.cwd !== null) cwds.push(session.cwd);
  }
  const { runs, warnings: runWarnings } = await collectRuns(cwds, {
    runProcess: ctx.runProcess,
    readRuns: readRunStore,
  });
  for (const warning of runWarnings) warn(warning.message);

  const sessions = joinSessions({
    identities: identities.accounts,
    cli: cli.sessions,
    dorkos: dorkosSessions,
    runs,
    windowsByAccount: Object.fromEntries(reads.map((r) => [r.account.id, r.rawWindows])),
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
