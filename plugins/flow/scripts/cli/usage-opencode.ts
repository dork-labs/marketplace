/**
 * `flow usage scan --runtime opencode` and `flow usage record --runtime
 * opencode` (spec `flow-usage` Amendment 1, A3 and A4): OpenCode's spend this
 * month and its per-provider credit and rate-limit errors, saved to the
 * OpenCode account's usage ledger.
 *
 * - **Spend** is the sum of `cost` over the assistant messages created this UTC
 *   month, recorded as the account total through the ledger's `spend` fact
 *   (`source: "transcript"`). The per-provider split is shown only in `scan`'s
 *   output. `limitUsd` is never inferred.
 * - **Errors**, per provider: the provider's newest assistant message decides.
 *   An `APIError` with status 402 marks `credits:<provider>` rejected, 429 marks
 *   `rate_limit:<provider>` rejected, and no error marks both allowed. Other
 *   errors record nothing, and one provider never clears another's error.
 *
 * The store is read only through `../fleet/opencode-store.ts`.
 *
 * @module @dorkos/flow/cli/usage-opencode
 */

import { PreconditionError, UsageError } from '../errors.ts';
import { loadAccounts, resolveDorkHome, type RuntimeAccount } from '../fleet/accounts.ts';
import {
  pickMessageFields,
  readOpenCodeStore,
  resolveOpenCodeStorePath,
  type OpenCodeMessage,
  type SqliteLoader,
  loadNodeSqlite,
} from '../fleet/opencode-store.ts';
import {
  bucketSlug,
  mergeLedger,
  readLedger,
  recordUsage,
  type FactObservation,
  type FleetWarning,
  type UsageLedger,
  type UsageObservation,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { journalUsage } from './usage-journal.ts';

/** The runtime this module records for. */
const RUNTIME = 'opencode';

/** The HTTP status that means a provider is out of credits. */
const PAYMENT_REQUIRED = 402;

/** The HTTP status that means a provider is rate limiting. */
const TOO_MANY_REQUESTS = 429;

/** Injected parts of the machine, for tests. */
export interface OpenCodeDeps {
  /** Loads `node:sqlite`. Default: the real dynamic import. */
  loadSqlite?: SqliteLoader;
}

/** One provider's share of this month's spend (scan output only). */
export interface ProviderSpend {
  /** The `providerID` as OpenCode stores it (`unknown` when missing). */
  provider: string;
  /** Dollars this month. */
  costUsd: number;
  /** Assistant messages this month. */
  messages: number;
}

/** This month's spend, as {@link openCodeSpend} works it out. */
export interface OpenCodeSpend {
  /** The `spend` fact to record. */
  fact: Extract<FactObservation, { kind: 'spend' }>;
  /** The per-provider split, largest first. */
  providers: ProviderSpend[];
}

/** Round to a millionth of a dollar, so float sums print and compare cleanly. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Epoch milliseconds to UTC ISO. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The first instant of `now`'s UTC month.
 *
 * @param now - The current time.
 * @returns Epoch milliseconds.
 */
export function utcMonthStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * This month's spend (spec A3 "Spend"). Pure. `costUsd` is the sum of `cost`
 * over the assistant messages created from the first instant of the current UTC
 * month up to the next month, and `observedAt` is the newest such message's time.
 * A month with no message yet costs 0 and is observed at `periodStart`, so a
 * rerun in that month changes nothing. `limitUsd` is never set.
 *
 * @param messages - The store's messages.
 * @param now - The current time.
 * @returns The `spend` fact and the per-provider split.
 */
export function openCodeSpend(messages: readonly OpenCodeMessage[], now: Date): OpenCodeSpend {
  const start = utcMonthStart(now);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const counted = messages
    .filter(
      (m) =>
        m.role === 'assistant' && m.createdMs !== null && m.createdMs >= start && m.createdMs < next
    )
    .sort((a, b) => (a.createdMs as number) - (b.createdMs as number));
  let total = 0;
  let newest = start;
  const byProvider = new Map<string, ProviderSpend>();
  for (const message of counted) {
    const cost = message.cost ?? 0;
    total += cost;
    // A row's cost can still grow until the turn completes: date it by its
    // completion, so a later scan's larger total counts as newer.
    newest = Math.max(newest, message.completedMs ?? (message.createdMs as number));
    const provider = message.providerID ?? 'unknown';
    const row = byProvider.get(provider) ?? { provider, costUsd: 0, messages: 0 };
    row.costUsd += cost;
    row.messages += 1;
    byProvider.set(provider, row);
  }
  const providers = [...byProvider.values()]
    .map((row) => ({ ...row, costUsd: roundUsd(row.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider));
  return {
    fact: {
      kind: 'spend',
      periodStart: iso(start),
      costUsd: roundUsd(total),
      observedAt: iso(newest),
      source: 'transcript',
    },
    providers,
  };
}

/**
 * The error signal of each provider (spec A3 "Errors"). Pure. Per provider, the
 * newest assistant message that has a creation time decides:
 *
 * - `APIError` 402: `credits:<provider>` rejected;
 * - `APIError` 429: `rate_limit:<provider>` rejected;
 * - no error: both keys allowed;
 * - anything else: nothing for that provider.
 *
 * Entries are the ledger's window-less error entries (`source: "error"`,
 * `usedPct: null`, `resetsAt: null`). The provider slug follows the model-slug
 * rule ({@link bucketSlug}).
 *
 * @param messages - The store's messages (or one message, for `record`).
 * @param fallbackMs - The time to use for a message with no `time.created`
 *   (only `record` passes one; `scan` skips such messages).
 * @returns The observations, sorted by key.
 */
export function openCodeErrorObservations(
  messages: readonly OpenCodeMessage[],
  fallbackMs: number | null = null
): UsageObservation[] {
  const newest = new Map<string, { message: OpenCodeMessage; at: number }>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.providerID === null) continue;
    // OpenCode writes the error (for example a 429 while it retries) onto the
    // row it created first, so date the row by its completion when it has one:
    // otherwise a later scan's error would tie with an earlier "allowed" and be dropped.
    const at = message.completedMs ?? message.createdMs ?? fallbackMs;
    if (at === null) continue;
    const slug = bucketSlug(message.providerID);
    if (slug === null) continue;
    const kept = newest.get(slug);
    if (kept === undefined || at >= kept.at) newest.set(slug, { message, at });
  }
  const out: UsageObservation[] = [];
  for (const [slug, { message, at }] of newest) {
    const base = { usedPct: null, resetsAt: null, observedAt: iso(at), source: 'error' as const };
    if (message.errorName === null) {
      out.push({ key: `credits:${slug}`, status: 'allowed', ...base });
      out.push({ key: `rate_limit:${slug}`, status: 'allowed', ...base });
    } else if (message.errorName === 'APIError' && message.errorStatus === PAYMENT_REQUIRED) {
      out.push({ key: `credits:${slug}`, status: 'rejected', ...base });
    } else if (message.errorName === 'APIError' && message.errorStatus === TOO_MANY_REQUESTS) {
      out.push({ key: `rate_limit:${slug}`, status: 'rejected', ...base });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** What `scan --runtime opencode` did for one account. */
export interface OpenCodeAccountScan {
  /** The account id. */
  id: string;
  /** The store file read, or `null` when there is none. */
  store: string | null;
  /** `read`, or why nothing was read. */
  status: 'read' | 'missing' | 'sqlite-unavailable' | 'unreadable' | 'store-unknown';
  /** Messages read from the store. */
  messages: number;
  /** This month's spend: the total and the per-provider split. */
  spend: { periodStart: string; costUsd: number; providers: ProviderSpend[] } | null;
  /** The error entries found, one or two per provider. */
  errors: UsageObservation[];
  /** The ledger keys this scan replaced (or would, with `--dry-run`); `spend` for the spend. */
  changed: string[];
  /** True when the write was given up because the usage file stayed locked. */
  dropped: boolean;
}

/** The OpenCode accounts in the registry (the implicit `default` when there is none). */
function openCodeAccounts(dorkHome: string): {
  accounts: RuntimeAccount[];
  warnings: FleetWarning[];
} {
  const loaded = loadAccounts(dorkHome);
  return {
    accounts: loaded.accounts.filter((a) => a.runtime === RUNTIME && a.routable),
    warnings: loaded.warnings,
  };
}

/** The ledger keys a merge of `observations` into `before` would replace, checked one by one. */
function predictChanged(
  before: UsageLedger | null,
  observations: readonly (UsageObservation | FactObservation)[],
  now: Date,
  accountId: string
): string[] {
  const keys: string[] = [];
  for (const observation of observations) {
    const merged = mergeLedger(before, [observation], now, { runtime: RUNTIME, accountId });
    if (!merged.changed) continue;
    const after = merged.ledger as UsageLedger;
    if ('kind' in observation) {
      if (after[observation.kind] !== before?.[observation.kind]) keys.push(observation.kind);
    } else if (after.windows[observation.key] !== before?.windows[observation.key]) {
      keys.push(observation.key);
    }
  }
  return keys;
}

/** Dollars for people: cents, or four places below one cent. */
function money(value: number): string {
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** The human text for one account. */
function renderAccount(scan: OpenCodeAccountScan, dryRun: boolean): string {
  const state = (key: string) =>
    scan.dropped
      ? 'not saved (the usage file stayed locked; run scan again)'
      : scan.changed.includes(key)
        ? dryRun
          ? 'would record'
          : 'recorded'
        : 'unchanged (as new or newer is stored)';
  if (scan.status !== 'read') {
    const why = {
      missing:
        scan.store === null
          ? 'OpenCode keeps no store file (OPENCODE_DB is :memory:)'
          : `no OpenCode store at ${scan.store}`,
      'sqlite-unavailable': 'not read (this Node has no node:sqlite)',
      unreadable: `could not read ${scan.store ?? 'the store'}`,
      'store-unknown': 'not read (flow does not know where a registered account keeps its store)',
    }[scan.status];
    return `${scan.id}: ${why}`;
  }
  const noun = scan.messages === 1 ? 'message' : 'messages';
  const lines = [`${scan.id}: ${scan.messages} ${noun} read from ${scan.store ?? ''}`];
  if (scan.spend !== null) {
    lines.push(
      `  spend since ${scan.spend.periodStart.slice(0, 10)}: ${money(scan.spend.costUsd)}  ${state('spend')}`
    );
    for (const row of scan.spend.providers) {
      lines.push(
        `    ${row.provider}  ${money(row.costUsd)} (${row.messages} ${row.messages === 1 ? 'message' : 'messages'})`
      );
    }
  }
  for (const error of scan.errors) {
    lines.push(`  ${error.key}  ${error.status ?? ''}, ${state(error.key)}`);
  }
  return lines.join('\n');
}

/**
 * Run `flow usage scan --runtime opencode`: read the OpenCode store from a copy
 * and save this month's spend and each provider's error signal.
 *
 * @param ctx - The verb context.
 * @param deps - Injected parts, for tests.
 * @returns Per account: the store, messages read, the spend with its
 *   per-provider split, the error entries and which keys changed; plus warnings.
 * @throws {UsageError} For `--days` or `--all` (the store is read whole).
 * @throws {PreconditionError} When `--account` names no OpenCode account.
 */
export async function scanOpenCode(ctx: VerbContext, deps: OpenCodeDeps = {}): Promise<VerbResult> {
  if (ctx.args.flags.days !== undefined || ctx.args.flags.all !== undefined) {
    throw new UsageError('--days and --all read transcripts; the OpenCode store is read whole');
  }
  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const warnings: FleetWarning[] = [];
  const warn = (warning: FleetWarning) => {
    warnings.push(warning);
    ctx.warn(warning.message);
  };
  const registry = openCodeAccounts(dorkHome);
  for (const warning of registry.warnings) warn(warning);
  const flag = ctx.args.flags.account;
  const accounts =
    typeof flag === 'string' ? registry.accounts.filter((a) => a.id === flag) : registry.accounts;
  if (typeof flag === 'string' && accounts.length === 0) {
    throw new PreconditionError(`no OpenCode account "${flag}"; "flow fleet" lists the accounts`);
  }

  // Load node:sqlite once, so a Node without it warns once, not once per account.
  let loaded: Promise<Awaited<ReturnType<SqliteLoader>>> | undefined;
  const loadSqlite: SqliteLoader = () => (loaded ??= (deps.loadSqlite ?? loadNodeSqlite)());
  let warnedSqlite = false;

  const now = ctx.now();
  const scans: OpenCodeAccountScan[] = [];
  for (const account of accounts) {
    const scan: OpenCodeAccountScan = {
      id: account.id,
      store: null,
      status: 'read',
      messages: 0,
      spend: null,
      errors: [],
      changed: [],
      dropped: false,
    };
    scans.push(scan);
    if (!account.implicit) {
      scan.status = 'store-unknown';
      continue;
    }
    scan.store = resolveOpenCodeStorePath(ctx.env, ctx.io.osHome);
    const read = await readOpenCodeStore(scan.store, { loadSqlite });
    if (read.status === 'sqlite-unavailable') {
      scan.status = read.status;
      if (!warnedSqlite) {
        warnedSqlite = true;
        warn({
          code: 'sqlite-unavailable',
          message:
            'this Node has no node:sqlite (it needs Node 22.13 or later), so OpenCode usage was not read.',
        });
      }
      continue;
    }
    if (read.status === 'missing') {
      scan.status = 'missing';
      continue;
    }
    if (read.status === 'unreadable') {
      scan.status = 'unreadable';
      warn({
        code: 'store-unreadable',
        message: `could not read a copy of ${scan.store} (${read.reason}); nothing recorded.`,
      });
      continue;
    }

    scan.messages = read.messages.length;
    const spend = openCodeSpend(read.messages, now);
    scan.spend = {
      periodStart: spend.fact.periodStart,
      costUsd: spend.fact.costUsd,
      providers: spend.providers,
    };
    scan.errors = openCodeErrorObservations(read.messages);
    const observations = [spend.fact, ...scan.errors];
    const before = readLedger(dorkHome, RUNTIME, account.id).ledger;
    scan.changed = predictChanged(before, observations, now, account.id);
    if (!ctx.dryRun) {
      const result = await recordUsage(dorkHome, RUNTIME, account.id, observations, now);
      for (const warning of result.warnings) warn(warning);
      scan.dropped = result.status === 'dropped';
      if (result.status !== 'written') scan.changed = [];
    }
  }

  const text =
    scans.length === 0
      ? 'No OpenCode accounts to scan.'
      : [
          ...(ctx.dryRun ? ['Dry run: nothing was saved.'] : []),
          ...scans.map((scan) => renderAccount(scan, ctx.dryRun)),
        ].join('\n');
  if (!ctx.dryRun) {
    journalUsage(
      ctx,
      dorkHome,
      scans.map((scan) => ({ runtime: RUNTIME, id: scan.id }))
    );
  }
  return { json: { runtime: RUNTIME, accounts: scans, warnings }, text };
}

/**
 * Run `flow usage record --runtime opencode` on stdin already read: one OpenCode
 * assistant message JSON updates only its own provider's error keys (spec A4).
 * It adds nothing to spend (that comes from `scan`). Like every `record`, it
 * prints nothing and never fails: problems are said on stderr only with
 * `--verbose`.
 *
 * @param ctx - The verb context (the caller has armed the watchdog and refused a TTY).
 * @param stdinText - stdin, or `null` when it was over the size limit.
 * @returns An empty text result, and the outcome for `--json`.
 */
export async function recordOpenCode(
  ctx: VerbContext,
  stdinText: string | null
): Promise<VerbResult> {
  const say = (message: string) => {
    if (ctx.args.flags.verbose === true) ctx.warn(message);
  };
  const outcome = {
    account: null as string | null,
    recorded: [] as string[],
    changed: false,
    dropped: false,
  };
  const done = (): VerbResult => ({ json: { ok: true, runtime: RUNTIME, ...outcome }, text: '' });
  try {
    if (stdinText === null) {
      say('the input was over 1 MiB; nothing recorded');
      return done();
    }
    const message = pickMessageFields(stdinText);
    if (message === null) {
      say('the input is not one JSON message; nothing recorded');
      return done();
    }
    const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
    const { accounts } = openCodeAccounts(dorkHome);
    const flag = ctx.args.flags.account;
    const account =
      typeof flag === 'string'
        ? accounts.find((a) => a.id === flag)
        : accounts.find((a) => a.implicit);
    if (account === undefined) {
      say('no OpenCode account to record for');
      return done();
    }
    const now = ctx.now();
    const observations = openCodeErrorObservations([message], now.getTime());
    if (observations.length === 0) {
      say('no credit or rate-limit signal in the message');
      return done();
    }
    outcome.account = account.id;
    const result = await recordUsage(dorkHome, RUNTIME, account.id, observations, now);
    for (const warning of result.warnings) say(warning.message);
    if (result.status === 'dropped') {
      outcome.dropped = true;
      return done();
    }
    outcome.recorded = observations.map((o) => o.key);
    outcome.changed = result.status === 'written';
  } catch (error) {
    // Anything unexpected is swallowed: a hook must never see an error.
    outcome.dropped = true;
    say(`usage not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return done();
}
