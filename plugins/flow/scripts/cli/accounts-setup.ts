/**
 * `flow accounts setup` (spec `flow-cli-core` Amendment "account setup", S1):
 * find the account folders on this machine, propose a role for each, and, once
 * confirmed, make the changes through the writers the other verbs use.
 *
 * - In a terminal it asks: which folders are work, organization or client
 *   accounts (kept out), whether the machine default stays main, and whether
 *   each spent account gets the usage recorder in its status line. Then it
 *   prints every change and asks once before making any.
 * - With `--yes` it asks nothing and the flags decide (`--rotation`,
 *   `--keep-out`, `--main`, `--statusline`); the changes are still printed.
 * - With neither, it prints what it proposes and changes nothing.
 * - `--dry-run` never writes.
 *
 * Writes go through `addIdentity` (the `accounts add` writer), `updateFleetPolicy`
 * with `setAccountPolicy` (the `accounts set` writer) and `planScript` (the
 * `usage install-statusline` writer). Nothing else is written.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/cli/accounts-setup
 */

import path from 'node:path';

import { readJsonFile } from '../atomic-json.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import {
  accountKey,
  addIdentity,
  canonicalAccountPath,
  fleetPolicyPath,
  identityConfigPath,
  loadAccounts,
  mintAccountId,
  resolveAccountRef,
  resolveDorkHome,
  resolveFleetPolicy,
  setAccountPolicy,
  updateFleetPolicy,
  type AccountRole,
} from '../fleet/accounts.ts';
import {
  blockedReason,
  detectAccountFolders,
  storedPolicyOf,
  type AccountCandidate,
} from '../fleet/detect-accounts.ts';
import {
  IMPLICIT_ACCOUNT_ID,
  readLedger,
  readWindow,
  type RuntimeSlug,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';
import { planScript, recorderFor, type InstallPlan } from './usage-install.ts';

/** Each runtime's name for people. */
const RUNTIME_NAMES: Readonly<Record<RuntimeSlug, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** How setup runs: asking a person, applying flags, or only proposing. */
type Mode = 'ask' | 'yes' | 'propose';

/** One folder with what setup knows and decides about it. */
interface Row {
  candidate: AccountCandidate;
  /** The account id it runs as (`default` for a standalone default), or `null` when unregistered. */
  id: string | null;
  /** The role stored in `fleet.json`, or `null`. */
  storedRole: AccountRole | null;
  /** The reserve stored in `fleet.json`, or `null`. */
  storedReserve: number | null;
  /** The reserve it has now, resolved. */
  reservePct: number;
  /** The role it has now, resolved, or `null` when it has no account. */
  currentRole: AccountRole | null;
  /** Latest 5-hour and 7-day used share from its ledger, when known. */
  usage: { fiveHour: number | null; sevenDay: number | null };
  /** The role chosen, or `null` to leave it as it is. */
  choice: AccountRole | null;
  /** Whether to add the usage recorder to its status line. */
  statusline: boolean;
  /** Why it cannot be changed, when it cannot. */
  blocked: string | null;
  /** Why the plan changes its role, when that needs saying. */
  why: string | null;
}

/** One planned write. */
export interface PlannedWrite {
  /** `add` registers a folder, `set` stores a role, `statusline` edits a script. */
  kind: 'add' | 'set' | 'statusline';
  /** The runtime of the account. */
  runtime: RuntimeSlug;
  /** The account id (planned, for an add). */
  id: string;
  /** The account folder. */
  path: string;
  /** For `set`: the role. */
  role?: AccountRole;
  /** For `set` to main: the reserve it will keep. */
  reservePct?: number;
  /** For `set`: why, when the role overrides something (a kept-out account named in --rotation). */
  why?: string;
  /** The file it changes. */
  file: string;
  /** The `flow` command that makes the same change. */
  command: string;
  /** For `statusline`: the planned edit. */
  install?: InstallPlan;
}

/** A string flag's value, when given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** A folder for people: `~/…` under the home folder. */
function shown(dir: string, home: string): string {
  const rel = path.relative(home, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : dir;
}

/** A role for people, with a main account's reserve. */
function roleText(role: AccountRole | null, reservePct: number): string {
  if (role === 'main') return `main (keeps ${reservePct}% for you)`;
  if (role === 'kept-out') return 'kept out';
  return role ?? '-';
}

/** The reserve a main account keeps: what is stored, else the default for main (50). */
function mainReserve(row: Row): number {
  return row.storedReserve ?? 50;
}

/** A count and a noun: "1 change", "3 changes". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The rows a comma list of refs names. `all` names nothing here; callers handle it. */
function matchRefs(value: string | undefined, rows: readonly Row[], home: string): Set<Row> {
  const out = new Set<Row>();
  if (value === undefined) return out;
  for (const ref of value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== 'all')) {
    const colon = ref.indexOf(':');
    const runtime = colon > 0 ? ref.slice(0, colon) : null;
    const id = colon > 0 ? ref.slice(colon + 1) : ref;
    const canonical =
      ref.startsWith('/') || ref.startsWith('~') ? canonicalAccountPath(ref, home) : null;
    const hits = rows.filter(
      (row) =>
        (runtime === null || row.candidate.runtime === runtime) &&
        ((row.id !== null && row.id === id) ||
          (id === IMPLICIT_ACCOUNT_ID && row.candidate.isDefault) ||
          (canonical !== null && row.candidate.canonicalPath === canonical) ||
          path.basename(row.candidate.path) === id)
    );
    if (hits.length === 0) {
      throw new UsageError(
        `"${ref}" is not one of the account folders found. Run "flow accounts setup" to list them.`
      );
    }
    for (const hit of hits) out.add(hit);
  }
  return out;
}

/**
 * Ask a yes-or-no question on stderr and read the answer. An empty answer, or
 * the end of input, takes the default.
 */
async function ask(ctx: VerbContext, question: string, fallback: boolean): Promise<boolean> {
  const readLine = ctx.io.stdin.readLine;
  if (readLine === undefined) return fallback;
  for (let tries = 0; tries < 3; tries += 1) {
    ctx.stderr.write(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `);
    const line = await readLine.call(ctx.io.stdin);
    if (line === null) {
      ctx.stderr.write('\n');
      return fallback;
    }
    const answer = line.trim().toLowerCase();
    if (answer === '') return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    ctx.stderr.write('Please answer y or n.\n');
  }
  return fallback;
}

/** The detection table. */
function renderFound(rows: readonly Row[], home: string): string {
  if (rows.length === 0) return 'No account folders found on this computer.';
  const pct = (value: number | null) => (value === null ? 'unknown' : `${Math.round(value)}%`);
  const table = [['RUNTIME', 'FOLDER', 'ACCOUNT', 'ROLE NOW', '5-HOUR', '7-DAY', 'NOTE']];
  for (const row of rows) {
    const notes: string[] = [];
    if (row.candidate.isDefault) notes.push("this computer's default");
    if (row.candidate.orgMarker !== null)
      notes.push(`looks org-managed: ${row.candidate.orgMarker.reason}`);
    table.push([
      RUNTIME_NAMES[row.candidate.runtime],
      shown(row.candidate.path, home),
      row.id ?? 'not registered',
      row.currentRole === null ? '-' : roleText(row.currentRole, row.reservePct),
      pct(row.usage.fiveHour),
      pct(row.usage.sevenDay),
      notes.join('; '),
    ]);
  }
  return `Account folders found:\n${formatColumns(table)}`;
}

/** The planned changes, one per line, with folders shown under `~`. */
function renderPlan(plan: readonly PlannedWrite[], home: string): string {
  if (plan.length === 0) return 'Nothing to change.';
  return [
    `Changes (${plan.length}):`,
    ...plan.map((write, i) => {
      const what =
        write.kind === 'add'
          ? `register ${shown(write.path, home)} as "${write.id}" in ${shown(write.file, home)}`
          : write.kind === 'set'
            ? `make ${accountKey(write.runtime, write.id)} ${roleText(write.role ?? null, write.reservePct ?? 50)} in ${shown(write.file, home)}${write.why === undefined ? '' : ` (${write.why})`}`
            : `add the usage recorder to ${shown(write.file, home)} after line ${write.install?.line ?? '?'}`;
      return `  ${i + 1}. ${what}\n     (${write.command})`;
    }),
  ].join('\n');
}

/** The usage share of one window from a ledger, or `null`. */
function usedPct(windows: Record<string, unknown> | undefined, key: string, now: Date) {
  const reading = readWindow(windows?.[key], now, key);
  return typeof reading?.usedPct === 'number' ? reading.usedPct : null;
}

/**
 * Run `flow accounts setup`.
 *
 * @param ctx - The invocation and the injected world.
 * @returns What was found, proposed and (when confirmed) changed.
 * @throws {UsageError} On a `--rotation`, `--keep-out` or `--main` ref that
 *   names no folder found (exit 2).
 * @throws {PreconditionError} When `fleet.json` stayed locked, or is a newer version.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const home = ctx.io.osHome;
  const now = ctx.now();
  const dorkHome = resolveDorkHome({ ...ctx.env }, home);
  const configFile = identityConfigPath(dorkHome);
  const fleetFile = fleetPolicyPath(dorkHome);
  const config = readJsonFile(configFile).value;
  const registry = loadAccounts(dorkHome, { home });
  const fleetRaw = readJsonFile(fleetFile).value;
  const policy = resolveFleetPolicy(registry.accounts, fleetRaw);
  const candidates = detectAccountFolders({
    home,
    env: ctx.env,
    config,
    accounts: registry.accounts,
  });

  const yes = ctx.args.flags.yes === true;
  const mode: Mode = yes
    ? 'yes'
    : ctx.io.stdin.isTTY && ctx.io.stdin.readLine !== undefined
      ? 'ask'
      : 'propose';
  const notes: string[] = [];

  const rows: Row[] = candidates.map((candidate) => {
    const account = candidate.account;
    const index = account === null ? -1 : registry.accounts.indexOf(account);
    let usage: Row['usage'] = { fiveHour: null, sevenDay: null };
    if (account !== null && account.ledgerId !== null) {
      const windows = readLedger(dorkHome, account.runtime, account.ledgerId).ledger?.windows as
        Record<string, unknown> | undefined;
      usage = {
        fiveHour: usedPct(windows, 'five_hour', now),
        sevenDay: usedPct(windows, 'seven_day', now),
      };
    }
    const stored =
      account === null
        ? { role: null, reservePct: null }
        : storedPolicyOf(fleetRaw, account.runtime, account.id, account.isDefault);
    return {
      candidate,
      id: account?.id ?? null,
      storedRole: stored.role,
      storedReserve: stored.reservePct,
      reservePct: index === -1 ? 0 : (policy.accounts[index]?.reservePct ?? 0),
      currentRole: index === -1 ? null : (policy.accounts[index]?.role ?? null),
      usage,
      choice: null,
      statusline: false,
      blocked: blockedReason(candidate, configFile),
      why: null,
    };
  });

  const rotationFlag = flag(ctx, 'rotation');
  const rotationAll = (rotationFlag ?? '').split(',').some((ref) => ref.trim() === 'all');
  const rotationRefs = matchRefs(rotationFlag, rows, home);
  const keepOutRefs = matchRefs(flag(ctx, 'keep-out'), rows, home);
  const mainRefs = matchRefs(flag(ctx, 'main'), rows, home);
  if (mode === 'ask' && (rotationFlag !== undefined || flag(ctx, 'keep-out') !== undefined)) {
    notes.push(
      'The --rotation and --keep-out flags only apply with --yes; answer the questions instead.'
    );
  }

  if (mode === 'ask') ctx.stderr.write(`${renderFound(rows, home)}\n\n`);

  for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
    const own = rows.filter((row) => row.candidate.runtime === runtime);
    // One folder is already rotation by default (rev 6d): nothing to set up.
    if (!own.some((row) => !row.candidate.isDefault)) continue;
    let main =
      own.find((row) => mainRefs.has(row)) ??
      own.find((row) => row.storedRole === 'main') ??
      own.find((row) => row.candidate.isDefault) ??
      null;
    if (main !== null && main.blocked !== null) main = null;
    const namedMain = main !== null && mainRefs.has(main);

    for (const row of own) {
      if (row === main || row.blocked !== null) continue;
      const where = shown(row.candidate.path, home);
      const keptOutWhy =
        row.storedRole === 'kept-out'
          ? 'you set it kept out'
          : row.candidate.orgMarker !== null
            ? row.candidate.orgMarker.reason
            : null;
      if (mode === 'ask') {
        if (row.candidate.orgMarker !== null) {
          ctx.stderr.write(`${where} looks org-managed: ${row.candidate.orgMarker.reason}.\n`);
        }
        const work = await ask(
          ctx,
          `Is ${where} a work, organization or client account? Yes keeps it out; no lets flow spend it in rotation.`,
          keptOutWhy !== null
        );
        row.choice = work ? 'kept-out' : 'rotation';
      } else if (mode === 'propose' && rotationFlag === undefined && keepOutRefs.size === 0) {
        row.choice = keptOutWhy !== null ? 'kept-out' : 'rotation';
      } else if (keepOutRefs.has(row)) {
        row.choice = 'kept-out';
      } else if (rotationRefs.has(row)) {
        row.choice = 'rotation';
        if (keptOutWhy !== null) row.why = `was kept out: ${keptOutWhy}; named in --rotation`;
      } else if (rotationAll && !row.candidate.isDefault && keptOutWhy === null) {
        row.choice = 'rotation';
      } else if (rotationAll && !row.candidate.isDefault) {
        notes.push(`${where} stays kept out: ${keptOutWhy}. Name it in --rotation to spend it.`);
      } else if (row.storedRole === 'main' && main !== null) {
        row.choice = 'rotation';
        row.why = `${shown(main.candidate.path, home)} becomes main`;
      }
    }

    // A main keeps a reserve back from the others; with no other account in
    // the rotation it would only hold back the one account flow can use.
    const othersRotate = own.some(
      (row) =>
        row !== main &&
        (row.choice === 'rotation' ||
          (row.choice === null &&
            row.candidate.account !== null &&
            !row.candidate.account.implicit &&
            row.currentRole === 'rotation'))
    );
    if (main === null || !(othersRotate || namedMain)) continue;
    if (mode === 'ask') {
      const keep = await ask(
        ctx,
        `Keep ${shown(main.candidate.path, home)} as your main ${RUNTIME_NAMES[runtime]} account, with ${mainReserve(main)}% of its weekly limit held back for you?`,
        true
      );
      if (!keep) continue;
    }
    main.choice = 'main';
    // A standalone default with no stored role reads as rotation once another
    // account is main (rev 6d): nothing is written for it, so say so.
    const standalone = own.find(
      (row) => row.candidate.isDefault && row.candidate.account?.implicit === true
    );
    if (standalone !== undefined && standalone !== main && standalone.storedRole === null) {
      notes.push(
        `${shown(standalone.candidate.path, home)} (this computer's default) will read as rotation once ${shown(main.candidate.path, home)} is main.`
      );
    }
  }

  // The status line: Claude Code accounts that will be spent.
  for (const row of rows) {
    const role = row.choice ?? row.currentRole;
    if (row.candidate.runtime !== 'claude-code' || row.blocked !== null) continue;
    if (role !== 'main' && role !== 'rotation') continue;
    row.statusline =
      mode === 'ask'
        ? await ask(
            ctx,
            `Add the usage recorder to ${shown(row.candidate.path, home)}'s status line, so flow sees its limits?`,
            false
          )
        : ctx.args.flags.statusline === true;
  }

  // The plan: registrations, then roles, then status lines.
  const plan: PlannedWrite[] = [];
  const taken = new Set(
    registry.accounts.filter((a) => a.runtime === 'claude-code' && !a.implicit).map((a) => a.id)
  );
  const ids = new Map<Row, string>();
  for (const row of rows) {
    if (row.id !== null) {
      ids.set(row, row.id);
      continue;
    }
    const needsId = row.choice === 'rotation' || row.choice === 'main' || row.statusline;
    if (!needsId || row.blocked !== null) continue;
    const id = mintAccountId({ label: null, path: row.candidate.path, taken });
    taken.add(id);
    ids.set(row, id);
    plan.push({
      kind: 'add',
      runtime: row.candidate.runtime,
      id,
      path: row.candidate.path,
      file: configFile,
      command: `flow accounts add --path ${shown(row.candidate.path, home)}`,
    });
  }
  const roleWrites: PlannedWrite[] = [];
  for (const row of rows) {
    const id = ids.get(row);
    if (row.choice === null || id === undefined) continue;
    const registered = row.candidate.account !== null && !row.candidate.account.implicit;
    const before = row.storedRole ?? (registered || row.id === null ? 'kept-out' : null);
    if (row.choice === before) continue;
    const key = accountKey(row.candidate.runtime, id);
    roleWrites.push({
      kind: 'set',
      runtime: row.candidate.runtime,
      id,
      path: row.candidate.path,
      role: row.choice,
      ...(row.choice === 'main' ? { reservePct: mainReserve(row) } : {}),
      ...(row.why === null ? {} : { why: row.why }),
      file: fleetFile,
      command: `flow accounts set ${key} --role ${row.choice}`,
    });
  }
  // A main is stored after every other role, so the old main has given way first.
  plan.push(
    ...roleWrites.filter((w) => w.role !== 'main'),
    ...roleWrites.filter((w) => w.role === 'main')
  );

  let block: ((variable: string) => [string, string]) | null = null;
  if (rows.some((row) => row.statusline)) {
    try {
      block = recorderFor(ctx.flowRoot);
    } catch (error) {
      notes.push(`Skipped the status lines: ${(error as Error).message}`);
    }
  }
  for (const row of rows) {
    const id = ids.get(row);
    if (!row.statusline || block === null || id === undefined) continue;
    const install = planScript({ id, path: row.candidate.path }, home, block, {
      remove: false,
      apply: false,
      stamp: now.getTime(),
    });
    if (install.action === 'insert' || install.action === 'update') {
      plan.push({
        kind: 'statusline',
        runtime: row.candidate.runtime,
        id,
        path: row.candidate.path,
        file: install.script ?? row.candidate.path,
        command: `flow usage install-statusline --account ${id} --yes`,
        install,
      });
    } else if (install.action === 'none') {
      notes.push(`${shown(row.candidate.path, home)} already records its usage.`);
    } else {
      notes.push(
        `${shown(row.candidate.path, home)}: add the usage recorder by hand (${install.reason}). See "flow usage install-statusline --account ${id}".`
      );
    }
  }
  for (const row of rows) {
    if (row.blocked === null) continue;
    notes.push(
      row.candidate.account === null
        ? `${shown(row.candidate.path, home)}: ${row.blocked}.`
        : `${shown(row.candidate.path, home)}: left as it is, ${row.blocked}.`
    );
  }

  // Confirm, then write.
  let apply = false;
  if (plan.length > 0 && !ctx.dryRun) {
    if (mode === 'yes') apply = true;
    else if (mode === 'ask') {
      ctx.stderr.write(`${renderPlan(plan, home)}\n\n`);
      apply = await ask(
        ctx,
        plan.length === 1 ? 'Make this change?' : `Make these ${plan.length} changes?`,
        false
      );
    }
  }
  if (apply) await applyPlan(ctx, dorkHome, home, plan, now);

  const proposal = rows
    .filter((row) => row.choice !== null)
    .map(
      (row) =>
        `  ${shown(row.candidate.path, home)}: ${roleText(row.choice, row.choice === 'main' ? mainReserve(row) : 0)}`
    );
  const text: string[] = [];
  if (mode !== 'ask') text.push(renderFound(rows, home));
  if (proposal.length > 0) text.push(['Roles:', ...proposal].join('\n'));
  if (mode !== 'ask' || !apply) text.push(renderPlan(plan, home));
  if (plan.length > 0) {
    if (apply) text.push(`Made ${plural(plan.length, 'change')}. See them with "flow accounts".`);
    else if (ctx.dryRun) text.push('Dry run: nothing changed.');
    else if (mode === 'ask') text.push('Nothing changed.');
    else text.push(`Nothing changed. To make these changes, run: ${suggestion(rows, home)}`);
  }
  if (notes.length > 0) text.push(notes.join('\n'));

  return {
    json: {
      ok: true,
      mode,
      dryRun: ctx.dryRun,
      applied: apply,
      candidates: rows.map((row) => ({
        runtime: row.candidate.runtime,
        path: row.candidate.path,
        sources: row.candidate.sources,
        isDefault: row.candidate.isDefault,
        id: row.id,
        registered: row.candidate.account !== null && !row.candidate.account.implicit,
        role: row.currentRole,
        storedRole: row.storedRole,
        proposedRole: row.choice,
        usage: row.usage,
        orgManaged: row.candidate.orgMarker,
        statusline: row.statusline,
        ...(row.blocked === null ? {} : { blocked: row.blocked }),
      })),
      plan: plan.map(({ install, ...write }) => ({
        ...write,
        ...(install === undefined ? {} : { line: install.line ?? null }),
      })),
      notes,
    },
    text: text.join('\n\n'),
  };
}

/** The `--yes` command that makes the proposed changes. */
function suggestion(rows: readonly Row[], home: string): string {
  const refs = (role: AccountRole) =>
    rows
      .filter((row) => row.choice === role && !row.candidate.isDefault)
      .map((row) => shown(row.candidate.path, home));
  const parts = ['flow accounts setup --yes'];
  const rotation = refs('rotation');
  const keptOut = refs('kept-out');
  if (rotation.length > 0) parts.push(`--rotation ${rotation.join(',')}`);
  if (keptOut.length > 0) parts.push(`--keep-out ${keptOut.join(',')}`);
  const main = rows.find((row) => row.choice === 'main' && !row.candidate.isDefault);
  if (main !== undefined) parts.push(`--main ${shown(main.candidate.path, home)}`);
  if (rows.some((row) => row.statusline)) parts.push('--statusline');
  return parts.join(' ');
}

/** Make the planned writes, in order, through the existing writers. */
async function applyPlan(
  ctx: VerbContext,
  dorkHome: string,
  home: string,
  plan: PlannedWrite[],
  now: Date
): Promise<void> {
  // Registrations first: the policy of a new folder needs its id.
  for (const write of plan) {
    if (write.kind !== 'add') continue;
    const result = addIdentity(dorkHome, { path: write.path, label: null, color: null });
    if (result.row.id !== write.id) {
      for (const later of plan) if (later.path === write.path) later.id = result.row.id;
    }
  }
  const sets = plan.filter((write) => write.kind === 'set');
  if (sets.length > 0) {
    const { accounts } = loadAccounts(dorkHome, { home });
    const result = await updateFleetPolicy(dorkHome, (raw) => {
      let next: unknown = raw;
      for (const write of sets) {
        const account = resolveAccountRef(accounts, write.runtime, write.id);
        next = setAccountPolicy(
          next,
          accountKey(write.runtime, account?.id ?? write.id),
          { role: write.role ?? null },
          { aliased: account !== null && account.isDefault && !account.implicit }
        );
      }
      return next;
    });
    if (result.status === 'dropped') {
      throw new PreconditionError(
        `${fleetPolicyPath(dorkHome)} stayed locked by another writer; the roles did not change. Run "flow accounts setup" again.`
      );
    }
  }
  const statuslines = plan.filter((write) => write.kind === 'statusline');
  if (statuslines.length > 0) {
    const block = recorderFor(ctx.flowRoot);
    for (const write of statuslines) {
      write.install = planScript({ id: write.id, path: write.path }, home, block, {
        remove: false,
        apply: true,
        stamp: now.getTime(),
      });
    }
  }
}
