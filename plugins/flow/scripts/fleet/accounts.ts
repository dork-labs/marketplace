/**
 * The account registry flow and DorkOS share (spec `flow-cli-core` §1.1).
 *
 * An account is a billing identity of ONE runtime (`claude-code`, `codex` or
 * `opencode`). The registry is split by owner:
 *
 * - **Identity** (who the accounts are, how they look) lives in DorkOS config:
 *   `<dorkHome>/config.json` at `runtimes.<claudeCode|codex|opencode>.accounts[]`.
 *   DorkOS core owns it; flow reads it ({@link readAccounts}) and, through
 *   `flow accounts add`, may append a Claude Code row. Every runtime has a
 *   `default` account (rev 6d, {@link resolveAccounts}): an account is its
 *   folder, and `default` names the runtime's default folder, as an alias of
 *   the registered row in that folder or as its own account.
 * - **Routing policy** (which accounts flow may spend, and how much to keep
 *   back) lives in flow's own file, `<dorkHome>/flow/fleet.json`, keyed
 *   `<runtime>:<account-id>`. DorkOS core never touches it. A registered account
 *   with no entry is kept out; a standalone `default` is main beside registered
 *   accounts, else rotation.
 *
 * Defaults are resolved at read time ({@link resolveFleetPolicy}) and never
 * written. The room and reserve rules ({@link effectiveReservePct},
 * {@link fiveHourRoom}, {@link weeklyRoom}, {@link modelRoom}, {@link spendRoom},
 * {@link accountRoom}) read the usage ledger through `usage-ledger.ts`.
 *
 * This is a shared contract, pinned by the case files in
 * `plugins/flow/conformance/fleet/` (`account-id`, `identity`, `accounts`,
 * `fleet-policy`, `room`, `eligibility`). Change a rule only together with that
 * folder's `CONTRACT_VERSION`.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/fleet/accounts
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, updateJsonFile, type AtomicUpdateResult } from '../atomic-json.ts';
import { ConfigError, PreconditionError, UsageError } from '../errors.ts';
import {
  IMPLICIT_ACCOUNT_ID,
  RUNTIMES,
  isRuntimeSlug,
  isValidAccountId,
  readSpend,
  readWindow,
  type FleetWarning,
  type Instant,
  type RuntimeSlug,
  type SpendEntry,
} from './usage-ledger.ts';

export { IMPLICIT_ACCOUNT_ID };

/** A display color: `#rrggbb`, lowercase. */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** A repo in `scope.repos`: `owner/name`. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The fleet policy format version this module reads and writes. */
export const FLEET_POLICY_VERSION = 1;

/** Each runtime's key under `runtimes` in DorkOS config. */
export const RUNTIME_CONFIG_KEYS: Readonly<Record<RuntimeSlug, string>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * One registered row of one runtime's registry, read from DorkOS config.
 */
export interface AccountIdentity {
  /** The registry id. May fail the id pattern on a hand-edited row (then `routable` is false). */
  id: string;
  /**
   * The absolute folder this account runs in: a `CLAUDE_CONFIG_DIR` for Claude
   * Code, a `CODEX_HOME` for Codex, the provider profile's folder for OpenCode.
   */
  path: string;
  /** The operator's name for it, or `null`. */
  label: string | null;
  /** `#rrggbb`, or `null` for the stable default by position. */
  color: string | null;
  /** False when the id fails the id pattern: no usage file, and it reads as kept-out. */
  routable: boolean;
}

/** A registered account of one runtime. */
export interface RegisteredAccount extends AccountIdentity {
  /** The runtime it belongs to. */
  runtime: RuntimeSlug;
  /** `<runtime>:<id>`, its key in `fleet.json`. */
  key: string;
  /** Always false: it has a row in the registry. */
  implicit: false;
  /**
   * Its folder for comparison ({@link canonicalAccountPath}): the identity of the
   * real account, since two rows or a row and the default can name one folder.
   */
  canonicalPath: string;
  /**
   * True when `<runtime>:default` names this row: the runtime's default folder
   * (spec §1.1a rev 6d) is this row's folder. Then `default` is an alias of its
   * id, and there is no separate `default` account.
   */
  isDefault: boolean;
  /** The ledger file's id (`<ledgerId>.json`): the id, or `null` when it is not routable. */
  ledgerId: string | null;
}

/**
 * A runtime's own `default` account (spec §1.1a rev 6d): the runtime's default
 * folder when no registered row names it. For Claude Code and Codex it always
 * has a folder; OpenCode keeps its ambient default (no folder), and only while
 * it has no registered account.
 */
export interface ImplicitAccount {
  /** The runtime it belongs to. */
  runtime: RuntimeSlug;
  /** Always `default`. */
  id: typeof IMPLICIT_ACCOUNT_ID;
  /** `<runtime>:default`. */
  key: string;
  /** The default folder, `~` expanded (`null` for OpenCode: the session's own environment). */
  path: string | null;
  /** The folder for comparison, or `null` with no folder. */
  canonicalPath: string | null;
  /** {@link DEFAULT_ACCOUNT_LABEL} with a folder; `null` for OpenCode. */
  label: string | null;
  /** Never set. */
  color: null;
  /** Always true. */
  routable: true;
  /** Always true. */
  implicit: true;
  /** Always true: `<runtime>:default` names it. */
  isDefault: true;
  /** Always `default`: its ledger is `default.json`. */
  ledgerId: typeof IMPLICIT_ACCOUNT_ID;
}

/** Any account of any runtime. */
export type RuntimeAccount = RegisteredAccount | ImplicitAccount;

/** What {@link resolveFleetPolicy} needs to know about an account. */
export type PolicySubject = Pick<RuntimeAccount, 'runtime' | 'id' | 'routable' | 'implicit'> &
  Partial<Pick<RuntimeAccount, 'isDefault'>>;

/** How flow may spend an account. */
export type AccountRole = 'main' | 'rotation' | 'kept-out';

/** Whether a task whose runtime is out may continue on another runtime. */
export type CrossRuntimeFallback = 'off' | 'on';

/** Whether work moves off a spent account automatically or after asking. */
export type HandoffMode = 'auto' | 'ask';

/** One account's policy with every default filled in. */
export interface ResolvedAccountPolicy {
  /** The runtime the account belongs to. */
  runtime: RuntimeSlug;
  /** The registry id (`default` for an implicit account). */
  id: string;
  /** `<runtime>:<id>`. */
  key: string;
  /** `main`: the operator's own, drained last. `rotation`: spent freely. `kept-out`: only on its scoped repos. */
  role: AccountRole;
  /** Share of the 7-day window kept back for the operator (0-100). */
  reservePct: number;
  /** Hours before the 7-day reset in which the reserve drops to 0. */
  spendDownWindowHours: number;
  /** For kept-out only: the `owner/name` repos it may serve. */
  scope: { repos: string[] };
}

/** The whole fleet policy, resolved. */
export interface ResolvedFleetPolicy {
  /** Fleet-wide handoff mode. */
  handoff: HandoffMode;
  /**
   * Runtimes in order of preference. Empty (the default) means "the runtime the
   * item started on first".
   */
  runtimes: RuntimeSlug[];
  /** Whether a task may continue on another runtime once its own is out. Default `off`. */
  crossRuntimeFallback: CrossRuntimeFallback;
  /** Each runtime's one main account id, when it has one. */
  mains: Partial<Record<RuntimeSlug, string>>;
  /** One resolved policy per account, in the order given. */
  accounts: ResolvedAccountPolicy[];
  /** Everything read as absent or ignored, and why. */
  warnings: FleetWarning[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve `<dorkHome>`: the `DORK_HOME` environment variable when set and
 * non-empty, else `<os home>/.dork`. flow never uses DorkOS's dev-mode default; a
 * DorkOS dev server that wants flow to see its accounts sets `DORK_HOME`.
 *
 * @param env - The environment. Default `process.env`.
 * @param homedir - The OS home folder. Default `os.homedir()`.
 * @returns The absolute DorkOS home.
 */
export function resolveDorkHome(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir()
): string {
  const fromEnv = env.DORK_HOME;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(homedir, '.dork');
}

/**
 * Reduce text to the account id alphabet: lowercase, every run of characters
 * outside `[a-z0-9]` becomes one `-`, and `-` is trimmed from both ends. May
 * return `''`. Identical to DorkOS `slugifyAccountId`.
 *
 * @param value - Free text (a label, a path segment).
 * @returns The slug, possibly empty.
 */
export function slugifyAccountId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Mint an id for an account (spec §1.1a): the label slugified, else the path's
 * last segment slugified, else `account`; `-2`, `-3`, ... appended until it is not
 * in `taken`. `default` is always taken: it is reserved for a runtime's implicit
 * account, so a label "Default" mints `default-2`. DorkOS `claudeAccountId` must
 * reserve it the same way (spec §1.1a).
 *
 * @param opts - The row's label and path, and the ids already taken.
 * @returns A free id matching the id pattern.
 */
export function mintAccountId(opts: {
  label?: string | null;
  path: string;
  taken: Iterable<string>;
}): string {
  const basename =
    opts.path
      .replace(/(?<![/\\])[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  const base = slugifyAccountId(opts.label ?? '') || slugifyAccountId(basename) || 'account';
  const taken = new Set(opts.taken);
  taken.add(IMPLICIT_ACCOUNT_ID);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Whether `value` is an absolute path on any platform: `/…`, a drive letter and
 * a separator (`C:\…`, `C:/…`), or a UNC path (`\\…`).
 */
function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
  );
}

/**
 * Read one runtime's registered rows out of a parsed `config.json` (spec
 * §1.1a), at `runtimes.<claudeCode|codex|opencode>.accounts`. Every runtime's
 * rows follow the same rules.
 *
 * - A missing file (`null`/`undefined`) or a missing key means no accounts.
 * - A row with no id gets one by {@link mintAccountId} (`id-minted`), exactly as
 *   DorkOS backfills it: over every object row in array order, BEFORE any row
 *   is skipped, with every id already present reserved first (including ids on
 *   later rows).
 * - Rows without an absolute `path` are then skipped (`path-invalid`).
 * - A duplicate id keeps the first row (`id-duplicate`).
 * - An id failing the pattern is listed with `routable: false` (`id-invalid`).
 * - A bad `color` or `label` reads as `null` (`color-invalid`, `label-invalid`).
 * - Unknown fields are ignored.
 *
 * @param config - The parsed `config.json`, or `null`/`undefined` when missing.
 * @param runtime - Whose registry to read.
 * @returns The identities in file order, and warnings.
 */
export function readIdentities(
  config: unknown,
  runtime: RuntimeSlug
): {
  accounts: AccountIdentity[];
  warnings: FleetWarning[];
} {
  const warnings: FleetWarning[] = [];
  const accounts: AccountIdentity[] = [];
  const configKey = RUNTIME_CONFIG_KEYS[runtime];
  const runtimes = isObject(config) ? config.runtimes : undefined;
  const section = isObject(runtimes) ? runtimes[configKey] : undefined;
  const rows = isObject(section) ? section.accounts : undefined;
  if (rows === undefined || rows === null) return { accounts, warnings };
  if (!Array.isArray(rows)) {
    warnings.push({
      code: 'accounts-invalid',
      message: `runtimes.${configKey}.accounts in config.json is not a list; read it as no accounts.`,
    });
    return { accounts, warnings };
  }

  // Ids are minted over EVERY object row, in array order, before any row is
  // skipped: the same row selection, order and taken-set as DorkOS's
  // backfillMissingAccountIds. Skipping a bad-path row first would shift the
  // ids of later rows, and the two sides would write different ledger files.
  const taken = new Set<string>();
  for (const row of rows) {
    if (isObject(row) && typeof row.id === 'string' && row.id.length > 0) taken.add(row.id);
  }
  const ids = rows.map((row): { id: string; minted: boolean } | null => {
    if (!isObject(row)) return null;
    if (typeof row.id === 'string' && row.id.length > 0) return { id: row.id, minted: false };
    const id = mintAccountId({
      label: typeof row.label === 'string' ? row.label : null,
      path: typeof row.path === 'string' ? row.path : '',
      taken,
    });
    taken.add(id);
    return { id, minted: true };
  });
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const resolved = ids[index];
    if (!isObject(row) || resolved === null) {
      warnings.push({
        code: 'row-invalid',
        message: `Account row ${index} is not an object; skipped it.`,
      });
      return;
    }
    if (!isAbsolutePath(row.path)) {
      warnings.push({
        code: 'path-invalid',
        message: `Account row ${index} has no absolute path; skipped it.`,
      });
      return;
    }
    let label: string | null = null;
    if (typeof row.label === 'string') {
      label = row.label;
    } else if (row.label !== undefined && row.label !== null) {
      warnings.push({
        code: 'label-invalid',
        message: `Account row ${index} has a label that is not text; read it as none.`,
      });
    }
    const id = resolved.id;
    if (resolved.minted) {
      warnings.push({
        code: 'id-minted',
        message: `Account row ${index} had no id; read it as "${id}".`,
      });
    }
    if (seen.has(id)) {
      warnings.push({
        code: 'id-duplicate',
        message: `Account id "${id}" appears more than once; kept the first row.`,
      });
      return;
    }
    seen.add(id);
    const reserved = id === IMPLICIT_ACCOUNT_ID;
    const routable = isValidAccountId(id) && !reserved;
    if (reserved) {
      // `default` names the runtime's default account and its usage file; a
      // registered row with that id would read another folder's readings as
      // its own, and could be spent as if it were the default account.
      warnings.push({
        code: 'id-reserved',
        message: `Account id "default" is reserved for the account a runtime uses when none is registered; this row is listed but kept out, with no usage file. Give it another id.`,
      });
    } else if (!routable) {
      warnings.push({
        code: 'id-invalid',
        message: `Account id "${id}" is not lowercase letters, digits and single hyphens; it is listed but kept out, with no usage file.`,
      });
    }
    let color: string | null = null;
    if (typeof row.color === 'string' && COLOR_PATTERN.test(row.color)) {
      color = row.color;
    } else if (row.color !== undefined && row.color !== null) {
      warnings.push({
        code: 'color-invalid',
        message: `Account "${id}" has a color that is not #rrggbb (lowercase); read it as none.`,
      });
    }
    accounts.push({ id, path: row.path, label, color, routable });
  });
  return { accounts, warnings };
}

/**
 * An account's key in `fleet.json`: `<runtime>:<id>`.
 *
 * @param runtime - The runtime slug.
 * @param id - The account id.
 * @returns The key.
 */
export function accountKey(runtime: RuntimeSlug, id: string): string {
  return `${runtime}:${id}`;
}

/**
 * Split a `fleet.json` key into its runtime and id. A bare key with no `:` is a
 * key written before contract 2.0.0 and means a Claude Code account.
 *
 * @param key - A key from `fleet.json`, or an id the operator typed.
 * @returns The runtime, the id and whether the key was bare; `null` when the part
 *   before the `:` is not a runtime slug or the id is empty.
 */
export function parseAccountKey(
  key: string
): { runtime: RuntimeSlug; id: string; bare: boolean } | null {
  const colon = key.indexOf(':');
  if (colon === -1) return key === '' ? null : { runtime: 'claude-code', id: key, bare: true };
  const runtime = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (!isRuntimeSlug(runtime) || id === '') return null;
  return { runtime, id, bare: false };
}

/** The label of a runtime's own `default` account when no registered row names its folder. */
export const DEFAULT_ACCOUNT_LABEL = "Main (this computer's sign-in)";

/**
 * What the default account is resolved from besides `config.json` (spec §1.1a
 * rev 6d). Pure inputs, so a conformance runner resolves it without the
 * filesystem. There is deliberately no environment here: which account
 * `default` names is machine-wide, and a session's own `CLAUDE_CONFIG_DIR` or
 * `CODEX_HOME` must never change it (use {@link ambientAccountPath} for "which
 * folder is this process running in").
 */
export interface AccountEnvironment {
  /** The OS home folder, for `~` and the built-in default folders. */
  home: string;
  /**
   * A folder's real path, or `null` when it does not exist (then the path is
   * compared as written, normalized). Default: the filesystem's real path.
   */
  realpath?: (dir: string) => string | null;
}

/** The filesystem's real path of `dir`, or `null` when it cannot be resolved. */
function systemRealpath(dir: string): string | null {
  try {
    return realpathSync.native(dir);
  } catch {
    return null;
  }
}

/**
 * A folder in the form two folders are compared in (spec §1.1a rev 6d): a
 * leading `~` expanded, resolved, trailing separators dropped, then its real
 * path when it exists (so a symlink finds its target), else as normalized.
 *
 * @param dir - A folder as written in config or the environment.
 * @param home - The OS home folder, for `~`.
 * @param realpath - The real-path lookup. Default: the filesystem.
 * @returns The comparable path.
 */
export function canonicalAccountPath(
  dir: string,
  home: string,
  realpath: (dir: string) => string | null = systemRealpath
): string {
  return realpath(expandedPath(dir, home)) ?? expandedPath(dir, home);
}

/** `dir` with `~` expanded, resolved and trailing separators dropped (no real path). */
function expandedPath(dir: string, home: string): string {
  let expanded = dir;
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/')) expanded = path.join(home, expanded.slice(2));
  // `path.resolve` also normalizes `..` and drops trailing separators.
  return path.resolve(expanded);
}

/**
 * The folder THIS process runs in: `CLAUDE_CONFIG_DIR`, else `<home>/.claude`
 * for Claude Code; `CODEX_HOME`, else `<home>/.codex` for Codex (an empty
 * variable counts as unset). OpenCode has none (`null`).
 *
 * This is session attribution (which account a status line or a launcher
 * runs as), never identity: {@link defaultAccountPath} decides what `default`
 * names, machine-wide.
 *
 * @param runtime - The runtime.
 * @param env - The environment.
 * @param home - The OS home folder.
 * @returns The folder, not yet resolved, or `null`.
 */
export function ambientAccountPath(
  runtime: RuntimeSlug,
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string | null {
  const variable =
    runtime === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : runtime === 'codex' ? 'CODEX_HOME' : null;
  if (variable === null) return null;
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(home, runtime === 'claude-code' ? '.claude' : '.codex');
}

/**
 * The folder `<runtime>:default` names, machine-wide (spec §1.1a rev 6d):
 *
 * - Claude Code: DorkOS `runtimes.claudeCode.defaultAccount` when it is a path
 *   (`activeAccount`, its name before DorkOS 0.65.0, when `defaultAccount` is
 *   null or absent), else `<home>/.claude`.
 * - Codex: `<home>/.codex`.
 * - OpenCode: `null` (its ambient default has no folder).
 *
 * The process environment is never read: a session running with
 * `CLAUDE_CONFIG_DIR=~/.claude3` must not make `default` mean claude3, or it
 * would read, write and prune another account's ledger and policy.
 *
 * A `defaultAccount` that is not an absolute or `~` path is ignored
 * (`default-account-invalid`).
 *
 * @param config - The parsed `config.json`, or `null`/`undefined`.
 * @param runtime - The runtime.
 * @param environment - The OS home folder.
 * @returns The folder (not yet resolved) or `null`, and warnings.
 */
export function defaultAccountPath(
  config: unknown,
  runtime: RuntimeSlug,
  environment: Pick<AccountEnvironment, 'home'>
): { path: string | null; warnings: FleetWarning[] } {
  const warnings: FleetWarning[] = [];
  if (runtime === 'claude-code') {
    const runtimes = isObject(config) ? config.runtimes : undefined;
    const section = isObject(runtimes) ? runtimes.claudeCode : undefined;
    const chosen = isObject(section)
      ? typeof section.defaultAccount === 'string' && section.defaultAccount !== ''
        ? section.defaultAccount
        : section.defaultAccount == null &&
            typeof section.activeAccount === 'string' &&
            section.activeAccount !== ''
          ? section.activeAccount
          : undefined
      : undefined;
    if (chosen !== undefined) {
      if (chosen === '~' || chosen.startsWith('~/') || isAbsolutePath(chosen)) {
        return { path: chosen, warnings };
      }
      warnings.push({
        code: 'default-account-invalid',
        message: `runtimes.claudeCode.defaultAccount in config.json is not an absolute path; used the built-in default folder instead.`,
      });
    }
  }
  if (runtime === 'opencode') return { path: null, warnings };
  return {
    path: path.join(environment.home, runtime === 'claude-code' ? '.claude' : '.codex'),
    warnings,
  };
}

/**
 * Every account of every runtime (spec §1.1a rev 6d), in runtime order
 * (`claude-code`, `codex`, `opencode`), registered rows in registry order, then
 * the runtime's own `default` when it stands alone.
 *
 * - Identity is the folder, not the id. For Claude Code and Codex,
 *   `<runtime>:default` always exists and names {@link defaultAccountPath}.
 * - When a routable registered row's folder is that folder (compared by
 *   {@link canonicalAccountPath}), `default` is an ALIAS of that row: the row
 *   gets `isDefault: true` and no separate account is listed.
 * - Otherwise `default` is its own account, labelled
 *   {@link DEFAULT_ACCOUNT_LABEL}, with the ledger `default.json`.
 * - OpenCode keeps its ambient default: a `default` with no folder, only while
 *   it has no registered row left.
 *
 * @param config - The parsed `config.json`, or `null`/`undefined` when missing.
 * @param environment - The home and real-path lookup the default resolves from.
 * @returns The accounts and every runtime's warnings.
 */
export function readAccounts(
  config: unknown,
  environment: AccountEnvironment
): {
  accounts: RuntimeAccount[];
  warnings: FleetWarning[];
} {
  const accounts: RuntimeAccount[] = [];
  const warnings: FleetWarning[] = [];
  for (const runtime of RUNTIMES) {
    const read = resolveAccounts(runtime, { config, ...environment });
    warnings.push(...read.warnings);
    accounts.push(...read.accounts);
  }
  return { accounts, warnings };
}

/**
 * One runtime's accounts (spec §1.1a rev 6d; {@link readAccounts} for all of
 * them): the one resolver every reader and writer uses, so no path can give one
 * real account two readings. Each account carries its canonical folder, whether
 * `default` names it (`isDefault`), its ledger id and its label.
 *
 * @param runtime - The runtime.
 * @param inputs - The parsed `config.json` (`null`/`undefined` when missing), the
 *   OS home folder, and the real-path lookup (default: the filesystem). No
 *   environment: `default` is machine-wide.
 * @returns The accounts in registry order (a standalone `default` last), and warnings.
 */
export function resolveAccounts(
  runtime: RuntimeSlug,
  inputs: AccountEnvironment & { config: unknown }
): { accounts: RuntimeAccount[]; warnings: FleetWarning[] } {
  const realpath = inputs.realpath ?? systemRealpath;
  const read = readIdentities(inputs.config, runtime);
  const warnings = [...read.warnings];
  const registered = asRegistered(runtime, read.accounts, inputs.home, realpath);
  if (runtime === 'opencode') {
    return {
      accounts: registered.length > 0 ? registered : [implicitAccount(runtime, null, null)],
      warnings,
    };
  }
  const chosen = defaultAccountPath(inputs.config, runtime, inputs);
  warnings.push(...chosen.warnings);
  const folder = expandedPath(chosen.path ?? '', inputs.home);
  const canonical = canonicalAccountPath(folder, inputs.home, realpath);
  const alias = registered.find(
    (account) => account.routable && account.canonicalPath === canonical
  );
  if (alias !== undefined) {
    alias.isDefault = true;
    return { accounts: registered, warnings };
  }
  return { accounts: [...registered, implicitAccount(runtime, folder, canonical)], warnings };
}

/**
 * The account an id names in one runtime: `default` resolves to whichever
 * account `isDefault` marks (a registered row when it is an alias), any other id
 * to the registered row with that id. Every verb that takes an id resolves it
 * here before it names a ledger file or a `fleet.json` key.
 *
 * @param accounts - Accounts from {@link resolveAccounts} or {@link readAccounts}.
 * @param runtime - The runtime.
 * @param id - The id given (`default` or a registry id).
 * @returns The account, or `null`.
 */
export function resolveAccountRef<A extends RuntimeAccount>(
  accounts: readonly A[],
  runtime: RuntimeSlug,
  id: string
): A | null {
  if (id === IMPLICIT_ACCOUNT_ID) {
    return accounts.find((account) => account.runtime === runtime && account.isDefault) ?? null;
  }
  return (
    accounts.find(
      (account) => account.runtime === runtime && !account.implicit && account.id === id
    ) ?? null
  );
}

/**
 * The routable account whose folder is `dir` (compared by
 * {@link canonicalAccountPath}): the account a session running in that folder
 * bills. The first match in list order wins.
 *
 * @param accounts - Accounts from {@link resolveAccounts} or {@link readAccounts}.
 * @param runtime - The runtime.
 * @param dir - The folder the session runs in.
 * @param environment - The home and real-path lookup.
 * @returns The account, or `null`.
 */
export function accountForPath<A extends RuntimeAccount>(
  accounts: readonly A[],
  runtime: RuntimeSlug,
  dir: string,
  environment: Pick<AccountEnvironment, 'home' | 'realpath'>
): A | null {
  const target = canonicalAccountPath(dir, environment.home, environment.realpath);
  return (
    accounts.find(
      (account) =>
        account.runtime === runtime && account.routable && account.canonicalPath === target
    ) ?? null
  );
}

/**
 * Tag one runtime's registered rows with their runtime, key, canonical folder
 * and ledger id.
 *
 * @param runtime - The runtime the rows belong to.
 * @param identities - Rows from {@link readIdentities} or {@link loadIdentities}.
 * @param home - The OS home folder, for `~`.
 * @param realpath - The real-path lookup. Default: the filesystem.
 * @returns The rows as registered accounts, in the same order, none marked default.
 */
export function asRegistered(
  runtime: RuntimeSlug,
  identities: readonly AccountIdentity[],
  home: string,
  realpath: (dir: string) => string | null = systemRealpath
): RegisteredAccount[] {
  return identities.map((identity) => ({
    ...identity,
    runtime,
    key: accountKey(runtime, identity.id),
    implicit: false,
    canonicalPath: canonicalAccountPath(identity.path, home, realpath),
    isDefault: false,
    ledgerId: identity.routable ? identity.id : null,
  }));
}

/** A runtime's own `default` account, with its folder (or none). */
function implicitAccount(
  runtime: RuntimeSlug,
  folder: string | null,
  canonical: string | null
): ImplicitAccount {
  return {
    runtime,
    id: IMPLICIT_ACCOUNT_ID,
    key: accountKey(runtime, IMPLICIT_ACCOUNT_ID),
    path: folder,
    canonicalPath: canonical,
    label: folder === null ? null : DEFAULT_ACCOUNT_LABEL,
    color: null,
    routable: true,
    implicit: true,
    isDefault: true,
    ledgerId: IMPLICIT_ACCOUNT_ID,
  };
}

/** `<dorkHome>/config.json`. */
export function identityConfigPath(dorkHome: string): string {
  return path.join(dorkHome, 'config.json');
}

/**
 * Read one runtime's registered rows from `<dorkHome>/config.json`. A missing
 * file means no accounts; an unparsable one means no accounts with a
 * `file-corrupt` warning.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - Whose registry to read.
 * @returns The identities and warnings.
 */
export function loadIdentities(
  dorkHome: string,
  runtime: RuntimeSlug
): {
  accounts: AccountIdentity[];
  warnings: FleetWarning[];
} {
  const read = readJsonFile(identityConfigPath(dorkHome));
  const result = readIdentities(read.value, runtime);
  return { accounts: result.accounts, warnings: [...read.warnings, ...result.warnings] };
}

/**
 * Read every account of every runtime from `<dorkHome>/config.json`
 * ({@link readAccounts}).
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param environment - The home (and real-path lookup) the default account resolves from.
 * @returns The accounts, the warnings, and whether the file itself read cleanly
 *   (false when it exists but is not JSON: then no registry can be trusted to be
 *   complete, and nothing may be deleted because of it).
 */
export function loadAccounts(
  dorkHome: string,
  environment: AccountEnvironment
): {
  accounts: RuntimeAccount[];
  warnings: FleetWarning[];
  registryReadable: boolean;
} {
  const read = readJsonFile(identityConfigPath(dorkHome));
  const result = readAccounts(read.value, environment);
  const registryReadable =
    read.warnings.length === 0 && !result.warnings.some((w) => w.code === 'accounts-invalid');
  return {
    accounts: result.accounts,
    warnings: [...read.warnings, ...result.warnings],
    registryReadable,
  };
}

/**
 * The role an account has with no stored role (spec §1.1b rev 6d):
 *
 * - A registered account: `kept-out`.
 * - A runtime's own `default` beside at least one routable registered account
 *   of its runtime: `main` (it is the operator's own sign-in), unless another
 *   account of that runtime is explicitly `main` in `fleet.json`, which wins;
 *   then `rotation`.
 * - A `default` that is its runtime's only routable account: `rotation`.
 */
function defaultRole(
  account: PolicySubject,
  accounts: readonly PolicySubject[],
  explicitMains: ReadonlySet<RuntimeSlug>
): AccountRole {
  if (!account.implicit) return 'kept-out';
  const besideRegistered = accounts.some(
    (other) => other.runtime === account.runtime && !other.implicit && other.routable
  );
  if (!besideRegistered || explicitMains.has(account.runtime)) return 'rotation';
  return 'main';
}

/** The defaults for an account with no stored entry. */
function unlisted(account: PolicySubject, role: AccountRole): ResolvedAccountPolicy {
  return {
    runtime: account.runtime,
    id: account.id,
    key: accountKey(account.runtime, account.id),
    role,
    reservePct: role === 'main' ? 50 : 0,
    spendDownWindowHours: 24,
    scope: { repos: [] },
  };
}

/** The kept-out defaults for an account. */
function keptOut(account: PolicySubject): ResolvedAccountPolicy {
  return unlisted(account, 'kept-out');
}

/** Parse one policy entry's fields, dropping invalid values with a warning. */
function readEntry(
  id: string,
  entry: Record<string, unknown>,
  warnings: FleetWarning[]
): { role?: AccountRole; reservePct?: number; spendDownWindowHours?: number; repos?: string[] } {
  const out: {
    role?: AccountRole;
    reservePct?: number;
    spendDownWindowHours?: number;
    repos?: string[];
  } = {};
  if (entry.role !== undefined) {
    if (entry.role === 'main' || entry.role === 'rotation' || entry.role === 'kept-out') {
      out.role = entry.role;
    } else {
      warnings.push({
        code: 'role-invalid',
        message: `"${id}" has an unknown role; read it as the default.`,
      });
    }
  }
  if (entry.reservePct !== undefined) {
    const v = entry.reservePct;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) {
      out.reservePct = v;
    } else {
      warnings.push({
        code: 'reserve-invalid',
        message: `"${id}" has a reservePct outside 0-100; read it as the default.`,
      });
    }
  }
  if (entry.spendDownWindowHours !== undefined) {
    const v = entry.spendDownWindowHours;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out.spendDownWindowHours = v;
    } else {
      warnings.push({
        code: 'spend-down-invalid',
        message: `"${id}" has a spendDownWindowHours below 0 or not a number; read it as 24.`,
      });
    }
  }
  if (entry.scope !== undefined) {
    if (!isObject(entry.scope)) {
      warnings.push({
        code: 'scope-invalid',
        message: `"${id}" has a scope that is not an object; read it as no repos.`,
      });
    } else if (entry.scope.repos !== undefined) {
      if (!Array.isArray(entry.scope.repos)) {
        warnings.push({
          code: 'scope-invalid',
          message: `"${id}" has scope.repos that is not a list; read it as no repos.`,
        });
      } else {
        out.repos = [];
        for (const repo of entry.scope.repos) {
          if (typeof repo === 'string' && REPO_PATTERN.test(repo)) {
            out.repos.push(repo);
          } else {
            warnings.push({
              code: 'repo-invalid',
              message: `"${id}" lists a repo that is not owner/name (${JSON.stringify(repo)}); ignored it.`,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Resolve the routing policy for every account (spec §1.1b), filling in the
 * defaults: role `kept-out` for a registered account; for a runtime's own
 * `default`, `main` beside a routable registered account of its runtime (unless
 * another account there is explicitly main) and `rotation` when it is the only
 * one (rev 6d); `reservePct` 50 for main else 0, `spendDownWindowHours` 24,
 * `scope.repos` [], handoff `auto`, `runtimes` [], `crossRuntimeFallback` `off`.
 *
 * - When `default` is an alias (a subject with `isDefault` that is not
 *   implicit), an entry under `<runtime>:default` is that row's entry; the row's
 *   own key wins when both are stored (`entry-duplicate`).
 * - Entries are keyed `<runtime>:<id>`. A bare key (written before contract
 *   2.0.0) reads as `claude-code:<key>`; when both forms are present the
 *   prefixed one wins (`entry-duplicate`).
 * - No `fleet.json`, or no entry for an account: the defaults above.
 * - Invalid values read as absent, with a warning.
 * - At most one main per runtime: later mains of that runtime, in the order
 *   given, read as rotation (`main-duplicate`).
 * - Entries whose key names no account are ignored (`entry-unknown-id`); a
 *   non-routable account stays kept out whatever its entry says
 *   (`entry-unroutable`).
 * - A file of another version is not read (`fleet-version-unknown`).
 *
 * @param accounts - The accounts, in runtime then registry order.
 * @param fleet - The parsed `fleet.json`, or `null`/`undefined` when missing.
 * @returns The resolved policy.
 */
export function resolveFleetPolicy(
  accounts: readonly PolicySubject[],
  fleet: unknown
): ResolvedFleetPolicy {
  const warnings: FleetWarning[] = [];
  const defaults = (): ResolvedFleetPolicy => {
    const mains: Partial<Record<RuntimeSlug, string>> = {};
    const resolved = accounts.map((account) => {
      if (!account.routable) return keptOut(account);
      const policy = unlisted(account, defaultRole(account, accounts, new Set()));
      if (policy.role === 'main') mains[account.runtime] = account.id;
      return policy;
    });
    return {
      handoff: 'auto',
      runtimes: [],
      crossRuntimeFallback: 'off',
      mains,
      accounts: resolved,
      warnings,
    };
  };
  if (fleet === undefined || fleet === null) return defaults();
  if (!isObject(fleet)) {
    warnings.push({
      code: 'fleet-invalid',
      message: 'fleet.json is not an object; every account reads as its default.',
    });
    return defaults();
  }
  if (fleet.v !== undefined && fleet.v !== FLEET_POLICY_VERSION) {
    warnings.push({
      code: 'fleet-version-unknown',
      message: `fleet.json is version ${JSON.stringify(fleet.v)}; this reader knows ${FLEET_POLICY_VERSION}, so every account reads as its default.`,
    });
    return defaults();
  }

  let handoff: HandoffMode = 'auto';
  if (fleet.handoff !== undefined) {
    if (fleet.handoff === 'auto' || fleet.handoff === 'ask') {
      handoff = fleet.handoff;
    } else {
      warnings.push({
        code: 'handoff-invalid',
        message: 'fleet.json has an unknown handoff; read it as auto.',
      });
    }
  }

  const runtimes: RuntimeSlug[] = [];
  if (fleet.runtimes !== undefined) {
    const listed = Array.isArray(fleet.runtimes) ? fleet.runtimes : [fleet.runtimes];
    for (const runtime of listed) {
      if (isRuntimeSlug(runtime) && !runtimes.includes(runtime)) {
        runtimes.push(runtime);
      } else {
        warnings.push({
          code: 'runtimes-invalid',
          message: `fleet.json runtimes lists ${JSON.stringify(runtime)}, which is not a runtime or is listed twice; ignored it.`,
        });
      }
    }
  }

  let crossRuntimeFallback: CrossRuntimeFallback = 'off';
  if (fleet.crossRuntimeFallback !== undefined) {
    if (fleet.crossRuntimeFallback === 'off' || fleet.crossRuntimeFallback === 'on') {
      crossRuntimeFallback = fleet.crossRuntimeFallback;
    } else {
      warnings.push({
        code: 'cross-runtime-fallback-invalid',
        message: 'fleet.json has an unknown crossRuntimeFallback; read it as off.',
      });
    }
  }

  let raw: Record<string, unknown> = {};
  if (fleet.accounts !== undefined) {
    if (isObject(fleet.accounts)) {
      raw = fleet.accounts;
    } else {
      warnings.push({
        code: 'accounts-invalid',
        message: 'fleet.json accounts is not an object; read it as empty.',
      });
    }
  }
  const migrated = migrateEntries(raw);
  for (const key of migrated.shadowed) {
    warnings.push({
      code: 'entry-duplicate',
      message: `fleet.json has a policy under both "${key}" and "claude-code:${key}"; used the second.`,
    });
  }
  const entries = migrated.entries;

  // rev 6d: when `default` is an alias, `<runtime>:default` is the aliased row's
  // entry. The row's own key wins when both are stored.
  for (const account of accounts) {
    if (!account.isDefault || account.implicit) continue;
    const alias = accountKey(account.runtime, IMPLICIT_ACCOUNT_ID);
    const own = accountKey(account.runtime, account.id);
    if (!Object.hasOwn(entries, alias)) continue;
    if (Object.hasOwn(entries, own)) {
      warnings.push({
        code: 'entry-duplicate',
        message: `fleet.json has a policy under both "${alias}" and "${own}", which are one account; used the second.`,
      });
    } else {
      entries[own] = entries[alias];
    }
    delete entries[alias];
  }

  const explicitMains = new Set<RuntimeSlug>();
  for (const account of accounts) {
    const entry = entries[accountKey(account.runtime, account.id)];
    if (account.routable && isObject(entry) && entry.role === 'main') {
      explicitMains.add(account.runtime);
    }
  }

  const known = new Set(accounts.map((account) => accountKey(account.runtime, account.id)));
  for (const key of Object.keys(entries)) {
    if (!known.has(key)) {
      warnings.push({
        code: 'entry-unknown-id',
        message: `fleet.json has a policy for "${key}", which is not an account; ignored it.`,
      });
    }
  }

  const mains: Partial<Record<RuntimeSlug, string>> = {};
  const resolved = accounts.map((account): ResolvedAccountPolicy => {
    const key = accountKey(account.runtime, account.id);
    const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
    if (!account.routable) {
      // A hand-edited row with the reserved id shares its key with the real
      // `default`; that entry is the real one's, not this row's.
      const sharedKey = accounts.some(
        (other) =>
          other !== account && other.routable && accountKey(other.runtime, other.id) === key
      );
      if (entry !== undefined && !sharedKey) {
        warnings.push({
          code: 'entry-unroutable',
          message: `"${key}" is not a valid account id, so its policy is ignored and it stays kept out.`,
        });
      }
      return keptOut(account);
    }
    const base = unlisted(account, defaultRole(account, accounts, explicitMains));
    let read: ReturnType<typeof readEntry> = {};
    if (entry !== undefined && !isObject(entry)) {
      warnings.push({
        code: 'entry-invalid',
        message: `fleet.json's policy for "${key}" is not an object; read it as the default.`,
      });
    } else if (entry !== undefined) {
      read = readEntry(key, entry, warnings);
    }
    let role: AccountRole = read.role ?? base.role;
    if (role === 'main') {
      const current = mains[account.runtime];
      if (current === undefined) {
        mains[account.runtime] = account.id;
      } else {
        warnings.push({
          code: 'main-duplicate',
          message: `"${key}" is also marked main; "${accountKey(account.runtime, current)}" came first, so "${key}" reads as rotation.`,
        });
        role = 'rotation';
      }
    }
    return {
      ...base,
      role,
      reservePct: read.reservePct ?? (role === 'main' ? 50 : 0),
      spendDownWindowHours: read.spendDownWindowHours ?? 24,
      scope: { repos: read.repos ?? [] },
    };
  });

  return { handoff, runtimes, crossRuntimeFallback, mains, accounts: resolved, warnings };
}

/**
 * `fleet.json` accounts with every bare key renamed to `claude-code:<key>`. A
 * bare key whose prefixed form is also present is dropped (the prefixed one
 * wins) and reported in `shadowed`.
 */
function migrateEntries(raw: Record<string, unknown>): {
  entries: Record<string, unknown>;
  shadowed: string[];
} {
  const entries: Record<string, unknown> = {};
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key.includes(':')) entries[key] = value;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.includes(':')) continue;
    const prefixed = accountKey('claude-code', key);
    if (Object.hasOwn(entries, prefixed)) shadowed.push(key);
    else entries[prefixed] = value;
  }
  return { entries, shadowed };
}

/** `<dorkHome>/flow/fleet.json`. */
export function fleetPolicyPath(dorkHome: string): string {
  return path.join(dorkHome, 'flow', 'fleet.json');
}

/**
 * Read `<dorkHome>/flow/fleet.json` (no lock) and resolve it for `accounts`.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param accounts - The accounts, in runtime then registry order.
 * @returns The resolved policy; file problems are in its warnings.
 */
export function loadFleetPolicy(
  dorkHome: string,
  accounts: readonly PolicySubject[]
): ResolvedFleetPolicy {
  const read = readJsonFile(fleetPolicyPath(dorkHome));
  const resolved = resolveFleetPolicy(accounts, read.value);
  return { ...resolved, warnings: [...read.warnings, ...resolved.warnings] };
}

/**
 * Edit `fleet.json` under its lock (§1.2 steps, lock at `fleet.json.lock`). The
 * mutation receives the raw file (`undefined` when missing) and returns the new
 * raw file; build it with {@link setAccountPolicy}, {@link setFleetSetting} and
 * {@link dropAccountPolicies} so only what the operator set is stored, bare keys
 * are migrated, and unknown fields survive.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param mutate - Raw file in, raw file out.
 * @returns What happened to the file.
 * @throws {PreconditionError} When the file is another version; it is left as it is.
 */
export function updateFleetPolicy(
  dorkHome: string,
  mutate: (raw: unknown) => unknown
): Promise<AtomicUpdateResult> {
  const file = fleetPolicyPath(dorkHome);
  return updateJsonFile(file, (raw) => {
    if (isObject(raw) && raw.v !== undefined && raw.v !== FLEET_POLICY_VERSION) {
      throw new PreconditionError(
        `${file} is version ${JSON.stringify(raw.v)}; this flow writes version ${FLEET_POLICY_VERSION} and will not downgrade it. Update flow, then retry.`
      );
    }
    return mutate(raw);
  });
}

/**
 * The raw file as a v1 object to edit (a copy), creating one when missing or
 * unusable. Bare account keys are renamed to `claude-code:<key>` here, so every
 * write stores the 2.0.0 form.
 */
function editable(raw: unknown): Record<string, unknown> {
  if (isObject(raw) && raw.v !== undefined && raw.v !== FLEET_POLICY_VERSION) {
    throw new PreconditionError(
      `fleet.json is version ${JSON.stringify(raw.v)}; this flow writes version ${FLEET_POLICY_VERSION} and will not downgrade it. Update flow, then retry.`
    );
  }
  const next: Record<string, unknown> = isObject(raw)
    ? { ...raw, v: FLEET_POLICY_VERSION }
    : { v: FLEET_POLICY_VERSION };
  if (isObject(next.accounts)) next.accounts = migrateEntries(next.accounts).entries;
  return next;
}

/**
 * A change to one account's stored policy. For each field: omitted (`undefined`)
 * leaves it, `null` deletes it (back to the default), a value sets it.
 */
export interface AccountPolicyPatch {
  /** The role, or `null` for the default ({@link resolveFleetPolicy}). */
  role?: AccountRole | null;
  /** 0-100, or `null` for the default. */
  reservePct?: number | null;
  /** 0 or more, or `null` for the default (24). */
  spendDownWindowHours?: number | null;
  /** `owner/name` list (`[]` = never), or `null` to delete the field. */
  repos?: string[] | null;
}

/**
 * Apply a patch to one account's entry in a raw `fleet.json` value. Pure:
 * returns a new value, stores only fields that were set, keeps unknown fields,
 * migrates bare keys, and drops an entry (or `scope`) left empty.
 *
 * When `default` is an alias of this account (rev 6d), pass `aliased: true`: an
 * entry stored under `<runtime>:default` is folded into this key (this key's own
 * entry wins) and removed, so one account keeps one entry.
 *
 * @param raw - The raw file (`undefined` when missing).
 * @param key - `<runtime>:<id>`, already resolved ({@link resolveAccountRef}).
 * @param patch - The fields to set or delete.
 * @param opts - `aliased`: `<runtime>:default` names this account.
 * @returns The new raw file.
 * @throws {UsageError} On a key or value the contract does not allow.
 * @throws {PreconditionError} When the file is another version (never downgraded).
 */
export function setAccountPolicy(
  raw: unknown,
  key: string,
  patch: AccountPolicyPatch,
  opts: { aliased?: boolean } = {}
): Record<string, unknown> {
  const parsed = parseAccountKey(key);
  if (parsed === null || parsed.bare || !isValidAccountId(parsed.id)) {
    throw new UsageError(`"${key}" is not a valid account key (<runtime>:<id>).`);
  }
  if (patch.role != null && !['main', 'rotation', 'kept-out'].includes(patch.role)) {
    throw new UsageError(
      `role must be main, rotation or kept-out (got ${JSON.stringify(patch.role)}).`
    );
  }
  if (
    patch.reservePct != null &&
    !(Number.isFinite(patch.reservePct) && patch.reservePct >= 0 && patch.reservePct <= 100)
  ) {
    throw new UsageError(`reserve must be a number from 0 to 100 (got ${patch.reservePct}).`);
  }
  if (
    patch.spendDownWindowHours != null &&
    !(Number.isFinite(patch.spendDownWindowHours) && patch.spendDownWindowHours >= 0)
  ) {
    throw new UsageError(`spend-down hours must be 0 or more (got ${patch.spendDownWindowHours}).`);
  }
  for (const repo of patch.repos ?? []) {
    if (!REPO_PATTERN.test(repo)) throw new UsageError(`"${repo}" is not an owner/name repo.`);
  }

  const next = editable(raw);
  const accounts = isObject(next.accounts) ? { ...next.accounts } : {};
  if (opts.aliased === true && parsed.id !== IMPLICIT_ACCOUNT_ID) {
    const alias = accountKey(parsed.runtime, IMPLICIT_ACCOUNT_ID);
    if (Object.hasOwn(accounts, alias)) {
      if (!Object.hasOwn(accounts, key)) accounts[key] = accounts[alias];
      delete accounts[alias];
    }
  }
  const entry: Record<string, unknown> = isObject(accounts[key])
    ? { ...(accounts[key] as object) }
    : {};
  const apply = (field: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) delete entry[field];
    else entry[field] = value;
  };
  apply('role', patch.role);
  apply('reservePct', patch.reservePct);
  apply('spendDownWindowHours', patch.spendDownWindowHours);
  if (patch.repos !== undefined) {
    const scope: Record<string, unknown> = isObject(entry.scope) ? { ...entry.scope } : {};
    if (patch.repos === null) delete scope.repos;
    else scope.repos = [...patch.repos];
    if (Object.keys(scope).length === 0) delete entry.scope;
    else entry.scope = scope;
  }
  if (Object.keys(entry).length === 0) delete accounts[key];
  else accounts[key] = entry;
  next.accounts = accounts;
  return next;
}

/**
 * Remove stored policies from a raw `fleet.json` value (spec §1.1b, "An entry
 * whose key names no account"). Pure; migrates bare keys first, so a bare key is
 * named by its `claude-code:` form.
 *
 * @param raw - The raw file (`undefined` when missing).
 * @param keys - The `<runtime>:<id>` keys to remove.
 * @returns The new raw file.
 * @throws {PreconditionError} When the file is another version (never downgraded).
 */
export function dropAccountPolicies(
  raw: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const next = editable(raw);
  if (!isObject(next.accounts)) return next;
  const accounts = { ...next.accounts };
  for (const key of keys) delete accounts[key];
  next.accounts = accounts;
  return next;
}

/**
 * The stored policies whose key names no account (after migrating bare keys):
 * what `flow accounts` drops. Pure.
 *
 * @param accounts - Every account of every runtime ({@link readAccounts}).
 * @param raw - The raw `fleet.json` (`undefined` when missing).
 * @returns The `<runtime>:<id>` keys, sorted.
 */
export function unknownPolicyKeys(
  accounts: readonly (Pick<RuntimeAccount, 'runtime' | 'id'> &
    Partial<Pick<RuntimeAccount, 'isDefault'>>)[],
  raw: unknown
): string[] {
  if (!isObject(raw) || !isObject(raw.accounts)) return [];
  const known = new Set(accounts.map((account) => accountKey(account.runtime, account.id)));
  // `<runtime>:default` always names an account in Claude Code and Codex (rev
  // 6d): an alias keeps its entry until a write moves it under the row's id.
  for (const account of accounts) {
    if (account.isDefault) known.add(accountKey(account.runtime, IMPLICIT_ACCOUNT_ID));
  }
  return Object.keys(migrateEntries(raw.accounts).entries)
    .filter((key) => !known.has(key))
    .sort();
}

/** A fleet-wide setting and the value type `fleet.json` stores for it. */
export interface FleetSettings {
  /** Move work off a spent account on its own, or ask first. */
  handoff: HandoffMode;
  /** Runtimes in order of preference. */
  runtimes: RuntimeSlug[];
  /** Whether a task may continue on another runtime once its own is out. */
  crossRuntimeFallback: CrossRuntimeFallback;
}

/**
 * Set or clear one fleet-wide setting in a raw `fleet.json` value. Pure.
 *
 * @param raw - The raw file (`undefined` when missing).
 * @param name - `handoff`, `runtimes` or `crossRuntimeFallback`.
 * @param value - The value, or `null` to delete it (back to the default).
 * @returns The new raw file.
 * @throws {UsageError} On a value the contract does not allow.
 * @throws {PreconditionError} When the file is another version (never downgraded).
 */
export function setFleetSetting<K extends keyof FleetSettings>(
  raw: unknown,
  name: K,
  value: FleetSettings[K] | null
): Record<string, unknown> {
  if (value !== null) {
    const ok =
      name === 'handoff'
        ? value === 'auto' || value === 'ask'
        : name === 'crossRuntimeFallback'
          ? value === 'off' || value === 'on'
          : Array.isArray(value) &&
            value.every(isRuntimeSlug) &&
            new Set(value).size === value.length;
    if (!ok) throw new UsageError(`${name} cannot be ${JSON.stringify(value)}.`);
  }
  const next = editable(raw);
  if (value === null) delete next[name];
  else next[name] = Array.isArray(value) ? [...value] : value;
  return next;
}

/**
 * The `owner/name` of a checkout's `origin` URL: https (`https://host/owner/name`),
 * scp-style ssh (`git@host:owner/name.git`) or `ssh://` form, with `.git` and
 * trailing slashes stripped. The last two path segments are the owner and name.
 *
 * @param origin - The origin URL, or `null` when the checkout has none.
 * @returns `owner/name` as written (case kept), or `null` when it cannot be parsed.
 */
export function parseOriginRepo(origin: string | null | undefined): string | null {
  if (typeof origin !== 'string') return null;
  const value = origin.trim();
  let repoPath: string | null = null;
  const scp = /^[A-Za-z0-9._-]+@[^:/\s]+:(.+)$/.exec(value);
  if (scp !== null) {
    repoPath = scp[1];
  } else {
    try {
      const url = new URL(value);
      if (['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) repoPath = url.pathname;
    } catch {
      repoPath = null;
    }
  }
  if (repoPath === null) return null;
  const segments = repoPath
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const repo = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return REPO_PATTERN.test(repo) ? repo : null;
}

/**
 * Whether an account may serve a repo (spec §1.1b): main and rotation serve any
 * repo; kept-out serves only a repo in `scope.repos`, compared
 * case-insensitively. A checkout with no parsable origin (`null`) matches no
 * scope.
 *
 * @param policy - The account's resolved policy.
 * @param repo - `owner/name` from {@link parseOriginRepo}, or `null`.
 * @returns True when flow may spend this account on the repo.
 */
export function mayServe(policy: ResolvedAccountPolicy, repo: string | null): boolean {
  if (policy.role === 'main' || policy.role === 'rotation') return true;
  if (repo === null) return false;
  const wanted = repo.toLowerCase();
  return policy.scope.repos.some((entry) => entry.toLowerCase() === wanted);
}

/** A ledger's `windows`, or nothing. */
type Windows = Record<string, unknown> | null | undefined;

/** One window's stored entry, when `windows` is an object. */
function entryOf(windows: Windows, key: string): unknown {
  return isObject(windows) && Object.hasOwn(windows, key) ? windows[key] : undefined;
}

/**
 * The reserve in force now (spec §1.1b): 0 when the `seven_day` reading has a
 * `resetsAt` and `resetsAt - spendDownWindowHours <= now < resetsAt`, else
 * `reservePct`. At or after `resetsAt` the reading has expired (the window
 * reset), so the reserve applies again.
 *
 * @param policy - The account's resolved policy.
 * @param windows - The account's ledger windows, or `null` with no ledger.
 * @param now - The moment to judge at.
 * @returns The effective reserve, 0-100.
 */
export function effectiveReservePct(
  policy: ResolvedAccountPolicy,
  windows: Windows,
  now: Instant
): number {
  const reading = readWindow(entryOf(windows, 'seven_day'), now, 'seven_day');
  if (reading === null || reading.resetsAt === null) return policy.reservePct;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const resetsAtMs = Date.parse(reading.resetsAt);
  const spendDownStarts = resetsAtMs - policy.spendDownWindowHours * 60 * 60 * 1000;
  return nowMs >= spendDownStarts && nowMs < resetsAtMs ? 0 : policy.reservePct;
}

/** Room in one window against a ceiling: false when rejected or at/over it, null with no reading. */
function roomIn(windows: Windows, key: string, now: Instant, ceiling: number): boolean | null {
  const reading = readWindow(entryOf(windows, key), now, key);
  if (reading === null) return null;
  if (reading.status === 'rejected') return false;
  if (reading.usedPct !== null && reading.usedPct >= ceiling) return false;
  return true;
}

/**
 * Room in the 5-hour window: false when rejected or `usedPct >= 100`, `null` with
 * no reading, else true.
 *
 * @param windows - The account's ledger windows, or `null` with no ledger.
 * @param now - The moment to judge at.
 * @returns True, false, or `null` for unknown.
 */
export function fiveHourRoom(windows: Windows, now: Instant): boolean | null {
  return roomIn(windows, 'five_hour', now, 100);
}

/**
 * Room in the 7-day window: false when rejected or
 * `usedPct >= 100 - effectiveReservePct`, `null` with no reading, else true.
 *
 * @param policy - The account's resolved policy.
 * @param windows - The account's ledger windows, or `null` with no ledger.
 * @param now - The moment to judge at.
 * @returns True, false, or `null` for unknown.
 */
export function weeklyRoom(
  policy: ResolvedAccountPolicy,
  windows: Windows,
  now: Instant
): boolean | null {
  return roomIn(windows, 'seven_day', now, 100 - effectiveReservePct(policy, windows, now));
}

/**
 * Room in a model's bucket (`model:<model>`), checked against 100 with no reserve.
 *
 * @param windows - The account's ledger windows, or `null` with no ledger.
 * @param model - The model slug (the part after `model:`).
 * @param now - The moment to judge at.
 * @returns True, false, or `null` for unknown.
 */
export function modelRoom(windows: Windows, model: string, now: Instant): boolean | null {
  return roomIn(windows, `model:${model}`, now, 100);
}

/**
 * Room within a spend cap (spec §1.1b, metered accounts): false when the spend
 * reading has a `limitUsd` and `costUsd >= limitUsd`, true for any other valid
 * reading, `null` with none.
 *
 * @param spend - The ledger's `spend`, or anything.
 * @returns True, false, or `null` for unknown.
 */
export function spendRoom(spend: unknown): boolean | null {
  const read: SpendEntry | null = readSpend(spend);
  if (read === null) return null;
  return read.limitUsd === null || read.costUsd < read.limitUsd;
}

/** The runtimes whose accounts always have rate-limit windows (subscription plans). */
const WINDOWED_RUNTIMES: ReadonlySet<RuntimeSlug> = new Set(['claude-code', 'codex']);

/** Whether a window key is one model's bucket, which bounds only sessions on that model. */
function isModelBucket(key: string): boolean {
  return key.startsWith('model:') || key.startsWith('seven_day_');
}

/**
 * Whether an account has room for work, whatever kind of account it is (spec
 * §1.1b "Room on an account"):
 *
 * - `false` when any current window that is not a model bucket is `rejected` or
 *   at its ceiling (`seven_day` against `100 - effectiveReservePct`, every other
 *   window against 100), or when the spend reading is at its `limitUsd`.
 * - Else `true` when the account has a current window reading (not a model
 *   bucket) or a spend reading: a metered account is eligible unless its spend
 *   cap is reached.
 * - Else, with nothing to go on: `true` for a runtime without subscription
 *   windows (OpenCode; a local-model account, no windows and no cap, is always
 *   eligible), and `null` (unknown) for Claude Code and Codex.
 *
 * Model buckets are checked separately with {@link modelRoom}, when the model is
 * known.
 *
 * @param runtime - The account's runtime.
 * @param policy - The account's resolved policy (for the weekly reserve).
 * @param ledger - The account's parsed ledger, or `null` with none.
 * @param now - The moment to judge at.
 * @returns True, false, or `null` for unknown.
 */
export function accountRoom(
  runtime: RuntimeSlug,
  policy: ResolvedAccountPolicy,
  ledger: { windows?: unknown; spend?: unknown } | null,
  now: Instant
): boolean | null {
  const windows = isObject(ledger?.windows) ? ledger.windows : null;
  let seen = false;
  for (const key of Object.keys(windows ?? {})) {
    if (isModelBucket(key)) continue;
    const reading = readWindow(entryOf(windows, key), now, key);
    if (reading === null) continue;
    seen = true;
    const ceiling = key === 'seven_day' ? 100 - effectiveReservePct(policy, windows, now) : 100;
    if (reading.status === 'rejected') return false;
    if (reading.usedPct !== null && reading.usedPct >= ceiling) return false;
  }
  const spend = spendRoom(ledger?.spend);
  if (spend === false) return false;
  if (seen || spend === true) return true;
  return WINDOWED_RUNTIMES.has(runtime) ? null : true;
}

/** What `flow accounts add` registers. */
export interface NewIdentity {
  /** The absolute `CLAUDE_CONFIG_DIR` (already `~`-expanded and checked by the caller). */
  path: string;
  /** The operator's name for it, or `null`. */
  label: string | null;
  /** `#rrggbb` (lowercase), or `null`. */
  color: string | null;
}

/** What {@link addIdentity} did or, on a dry run, would do. */
export interface AddIdentityResult {
  /** The row written (all four keys). */
  row: { id: string; path: string; label: string | null; color: string | null };
  /** The file written. */
  file: string;
  /** Whether the file carries DorkOS's `__internal__` key (DorkOS manages it). */
  dorkosManaged: boolean;
  /** Whether the file was written (false on a dry run). */
  written: boolean;
}

/** A path with its trailing separators removed, for comparing registered paths. */
function normalizedPath(value: string): string {
  const trimmed = value.replace(/(?<=.)[/\\]+$/, '');
  return path.resolve(trimmed);
}

/**
 * The indent a JSON file was written with, so a rewrite leaves every key it did
 * not change byte-for-byte as it was: a tab (the `conf` default DorkOS uses),
 * the first indented line's spaces, or two spaces for a new or one-line file.
 */
function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  return match === null ? '  ' : match[1];
}

/**
 * Register an identity in `<dorkHome>/config.json` (spec §1.1a, `flow accounts
 * add`). Reads the file fresh, appends one row with all four keys to
 * `runtimes.claudeCode.accounts`, and changes nothing else: every other key keeps
 * its value and, when the file was written with one indent style, its bytes.
 * Writes a temp file and renames it over, keeping the file's mode (a new file is
 * `0600`). Never writes any routing policy, so the new account starts kept out.
 *
 * DorkOS writes this file with `conf`, not the §1.2 lock, and re-reads it before
 * each write of `runtimes.claudeCode` (spec §1.1a), so no lock is taken here.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param identity - The account to add.
 * @param opts - `dryRun` computes the row and writes nothing.
 * @returns The row, the file and whether DorkOS manages it.
 * @throws {PreconditionError} When the path is already registered.
 * @throws {ConfigError} When the file exists but cannot be read as a JSON object.
 */
export function addIdentity(
  dorkHome: string,
  identity: NewIdentity,
  opts: { dryRun?: boolean } = {}
): AddIdentityResult {
  const file = identityConfigPath(dorkHome);
  let text: string | null = null;
  let mode = 0o600;
  try {
    text = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let config: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      throw new ConfigError(
        `${file} is not a JSON object, so flow did not change it. Fix or move it, then retry.`
      );
    }
    config = parsed;
  }

  const runtimes = isObject(config.runtimes) ? config.runtimes : undefined;
  const claudeCode =
    runtimes !== undefined && isObject(runtimes.claudeCode) ? runtimes.claudeCode : undefined;
  const rows =
    claudeCode !== undefined && Array.isArray(claudeCode.accounts) ? claudeCode.accounts : [];
  if (
    claudeCode !== undefined &&
    claudeCode.accounts !== undefined &&
    !Array.isArray(claudeCode.accounts)
  ) {
    throw new ConfigError(
      `runtimes.claudeCode.accounts in ${file} is not a list, so flow did not change it. Fix it, then retry.`
    );
  }

  const { accounts } = readIdentities(config, 'claude-code');
  const wanted = normalizedPath(identity.path);
  const existing = accounts.find((account) => normalizedPath(account.path) === wanted);
  if (existing !== undefined) {
    throw new PreconditionError(`${identity.path} is already registered as "${existing.id}".`);
  }

  // Reserve every id the file already holds, minted ones included, exactly as
  // readIdentities (and DorkOS) would read them.
  const taken = new Set(accounts.map((account) => account.id));
  for (const row of rows) {
    if (isObject(row) && typeof row.id === 'string' && row.id.length > 0) taken.add(row.id);
  }
  const id = mintAccountId({ label: identity.label, path: identity.path, taken });
  const row = { id, path: identity.path, label: identity.label, color: identity.color };
  const dorkosManaged = Object.hasOwn(config, '__internal__');
  if (opts.dryRun) return { row, file, dorkosManaged, written: false };

  const next: Record<string, unknown> = {
    ...config,
    runtimes: {
      ...(runtimes ?? {}),
      claudeCode: { ...(claudeCode ?? {}), accounts: [...rows, row] },
    },
  };
  const indent = text === null ? '  ' : detectIndent(text);
  const trailing = text === null || text.endsWith('\n') ? '\n' : '';
  mkdirSync(dorkHome, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, indent)}${trailing}`, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { row, file, dorkosManaged, written: true };
}
