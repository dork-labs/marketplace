/**
 * The account registry flow and DorkOS share (spec `flow-cli-core` §1.1).
 *
 * The registry is split by owner:
 *
 * - **Identity** (who the accounts are, how they look) lives in DorkOS config:
 *   `<dorkHome>/config.json` at `runtimes.claudeCode.accounts[]`. DorkOS core owns
 *   it; flow reads it ({@link readIdentities}) and, through `flow accounts add`,
 *   may append a row.
 * - **Routing policy** (which accounts flow may spend, and how much to keep
 *   back) lives in flow's own file, `<dorkHome>/flow/fleet.json`. DorkOS core
 *   never touches it. It is opt-in: an account with no entry is kept out.
 *
 * Defaults are resolved at read time ({@link resolveFleetPolicy}) and never
 * written. The room and reserve rules ({@link effectiveReservePct},
 * {@link fiveHourRoom}, {@link weeklyRoom}, {@link modelRoom}) read the usage
 * ledger through `usage-ledger.ts`.
 *
 * This is a shared contract, pinned by the case files in
 * `plugins/flow/conformance/fleet/` (`account-id`, `identity`, `fleet-policy`,
 * `room`). Change a rule only together with that folder's `CONTRACT_VERSION`.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/fleet/accounts
 */

import os from 'node:os';
import path from 'node:path';
import { readJsonFile, updateJsonFile, type AtomicUpdateResult } from '../atomic-json.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import { isValidAccountId, readWindow, type FleetWarning, type Instant } from './usage-ledger.ts';

/** A display color: `#rrggbb`, lowercase. */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** A repo in `scope.repos`: `owner/name`. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The fleet policy format version this module reads and writes. */
export const FLEET_POLICY_VERSION = 1;

/** One account identity, read from DorkOS config. */
export interface AccountIdentity {
  /** The registry id. May fail the id pattern on a hand-edited row (then `routable` is false). */
  id: string;
  /** The absolute `CLAUDE_CONFIG_DIR` this account runs in. */
  path: string;
  /** The operator's name for it, or `null`. */
  label: string | null;
  /** `#rrggbb`, or `null` for the stable default by position. */
  color: string | null;
  /** False when the id fails the id pattern: no usage file, and it reads as kept-out. */
  routable: boolean;
}

/** How flow may spend an account. */
export type AccountRole = 'main' | 'rotation' | 'kept-out';

/** Whether work moves off a spent account automatically or after asking. */
export type HandoffMode = 'auto' | 'ask';

/** One account's policy with every default filled in. */
export interface ResolvedAccountPolicy {
  /** The registry id. */
  id: string;
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
  /** The one main account, or `null` when there is none. */
  mainId: string | null;
  /** One resolved policy per identity, in registry order. */
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
 * in `taken`. Identical to DorkOS `claudeAccountId`.
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
 * Read the account identities out of a parsed `config.json` (spec §1.1a).
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
 * @returns The identities in file order, and warnings.
 */
export function readIdentities(config: unknown): {
  accounts: AccountIdentity[];
  warnings: FleetWarning[];
} {
  const warnings: FleetWarning[] = [];
  const accounts: AccountIdentity[] = [];
  const runtimes = isObject(config) ? config.runtimes : undefined;
  const claudeCode = isObject(runtimes) ? runtimes.claudeCode : undefined;
  const rows = isObject(claudeCode) ? claudeCode.accounts : undefined;
  if (rows === undefined || rows === null) return { accounts, warnings };
  if (!Array.isArray(rows)) {
    warnings.push({
      code: 'accounts-invalid',
      message: 'runtimes.claudeCode.accounts in config.json is not a list; read it as no accounts.',
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
    const routable = isValidAccountId(id);
    if (!routable) {
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

/** `<dorkHome>/config.json`. */
export function identityConfigPath(dorkHome: string): string {
  return path.join(dorkHome, 'config.json');
}

/**
 * Read the identities from `<dorkHome>/config.json`. A missing file means no
 * accounts; an unparsable one means no accounts with a `file-corrupt` warning.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @returns The identities and warnings.
 */
export function loadIdentities(dorkHome: string): {
  accounts: AccountIdentity[];
  warnings: FleetWarning[];
} {
  const read = readJsonFile(identityConfigPath(dorkHome));
  const result = readIdentities(read.value);
  return { accounts: result.accounts, warnings: [...read.warnings, ...result.warnings] };
}

/** The kept-out defaults for an account. */
function keptOut(id: string): ResolvedAccountPolicy {
  return { id, role: 'kept-out', reservePct: 0, spendDownWindowHours: 24, scope: { repos: [] } };
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
        message: `"${id}" has an unknown role; read it as kept-out.`,
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
 * Resolve the routing policy for every identity (spec §1.1b), filling in the
 * defaults: role `kept-out`, `reservePct` 50 for main else 0,
 * `spendDownWindowHours` 24, `scope.repos` [], handoff `auto`.
 *
 * - No `fleet.json`, or no entry for an identity: kept out (opt-in by default).
 * - Invalid values read as absent, with a warning.
 * - At most one main: later mains in registry order read as rotation
 *   (`main-duplicate`).
 * - Entries whose key is not an identity id are ignored (`entry-unknown-id`);
 *   a non-routable identity stays kept out whatever its entry says
 *   (`entry-unroutable`).
 * - A file of another version is not read (`fleet-version-unknown`).
 *
 * @param identities - The identities in registry order.
 * @param fleet - The parsed `fleet.json`, or `null`/`undefined` when missing.
 * @returns The resolved policy.
 */
export function resolveFleetPolicy(
  identities: readonly Pick<AccountIdentity, 'id' | 'routable'>[],
  fleet: unknown
): ResolvedFleetPolicy {
  const warnings: FleetWarning[] = [];
  const defaults = (): ResolvedFleetPolicy => ({
    handoff: 'auto',
    mainId: null,
    accounts: identities.map((identity) => keptOut(identity.id)),
    warnings,
  });
  if (fleet === undefined || fleet === null) return defaults();
  if (!isObject(fleet)) {
    warnings.push({
      code: 'fleet-invalid',
      message: 'fleet.json is not an object; every account is kept out.',
    });
    return defaults();
  }
  if (fleet.v !== undefined && fleet.v !== FLEET_POLICY_VERSION) {
    warnings.push({
      code: 'fleet-version-unknown',
      message: `fleet.json is version ${JSON.stringify(fleet.v)}; this reader knows ${FLEET_POLICY_VERSION}, so every account is kept out.`,
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

  let entries: Record<string, unknown> = {};
  if (fleet.accounts !== undefined) {
    if (isObject(fleet.accounts)) {
      entries = fleet.accounts;
    } else {
      warnings.push({
        code: 'accounts-invalid',
        message: 'fleet.json accounts is not an object; read it as empty.',
      });
    }
  }

  const known = new Set(identities.map((identity) => identity.id));
  for (const key of Object.keys(entries)) {
    if (!known.has(key)) {
      warnings.push({
        code: 'entry-unknown-id',
        message: `fleet.json has a policy for "${key}", which is not a registered account; ignored it.`,
      });
    }
  }

  let mainId: string | null = null;
  const accounts = identities.map((identity): ResolvedAccountPolicy => {
    const entry = Object.hasOwn(entries, identity.id) ? entries[identity.id] : undefined;
    if (!identity.routable) {
      if (entry !== undefined) {
        warnings.push({
          code: 'entry-unroutable',
          message: `"${identity.id}" is not a valid account id, so its policy is ignored and it stays kept out.`,
        });
      }
      return keptOut(identity.id);
    }
    if (entry === undefined) return keptOut(identity.id);
    if (!isObject(entry)) {
      warnings.push({
        code: 'entry-invalid',
        message: `fleet.json's policy for "${identity.id}" is not an object; read it as kept-out.`,
      });
      return keptOut(identity.id);
    }
    const read = readEntry(identity.id, entry, warnings);
    let role: AccountRole = read.role ?? 'kept-out';
    if (role === 'main') {
      if (mainId === null) {
        mainId = identity.id;
      } else {
        warnings.push({
          code: 'main-duplicate',
          message: `"${identity.id}" is also marked main; "${mainId}" came first, so "${identity.id}" reads as rotation.`,
        });
        role = 'rotation';
      }
    }
    return {
      id: identity.id,
      role,
      reservePct: read.reservePct ?? (role === 'main' ? 50 : 0),
      spendDownWindowHours: read.spendDownWindowHours ?? 24,
      scope: { repos: read.repos ?? [] },
    };
  });

  return { handoff, mainId, accounts, warnings };
}

/** `<dorkHome>/flow/fleet.json`. */
export function fleetPolicyPath(dorkHome: string): string {
  return path.join(dorkHome, 'flow', 'fleet.json');
}

/**
 * Read `<dorkHome>/flow/fleet.json` (no lock) and resolve it for `identities`.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param identities - The identities in registry order.
 * @returns The resolved policy; file problems are in its warnings.
 */
export function loadFleetPolicy(
  dorkHome: string,
  identities: readonly Pick<AccountIdentity, 'id' | 'routable'>[]
): ResolvedFleetPolicy {
  const read = readJsonFile(fleetPolicyPath(dorkHome));
  const resolved = resolveFleetPolicy(identities, read.value);
  return { ...resolved, warnings: [...read.warnings, ...resolved.warnings] };
}

/**
 * Edit `fleet.json` under its lock (§1.2 steps, lock at `fleet.json.lock`). The
 * mutation receives the raw file (`undefined` when missing) and returns the new
 * raw file; build it with {@link setAccountPolicy} and {@link setHandoff} so
 * only what the operator set is stored and unknown fields survive.
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

/** The raw file as a v1 object to edit (a copy), creating one when missing or unusable. */
function editable(raw: unknown): Record<string, unknown> {
  if (isObject(raw) && raw.v !== undefined && raw.v !== FLEET_POLICY_VERSION) {
    throw new PreconditionError(
      `fleet.json is version ${JSON.stringify(raw.v)}; this flow writes version ${FLEET_POLICY_VERSION} and will not downgrade it. Update flow, then retry.`
    );
  }
  return isObject(raw) ? { ...raw, v: FLEET_POLICY_VERSION } : { v: FLEET_POLICY_VERSION };
}

/**
 * A change to one account's stored policy. For each field: omitted (`undefined`)
 * leaves it, `null` deletes it (back to the default), a value sets it.
 */
export interface AccountPolicyPatch {
  /** The role, or `null` for the default (kept-out). */
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
 * and drops an entry (or `scope`) left empty.
 *
 * @param raw - The raw file (`undefined` when missing).
 * @param id - A registry id.
 * @param patch - The fields to set or delete.
 * @returns The new raw file.
 * @throws {UsageError} On an id or value the contract does not allow.
 * @throws {PreconditionError} When the file is another version (never downgraded).
 */
export function setAccountPolicy(
  raw: unknown,
  id: string,
  patch: AccountPolicyPatch
): Record<string, unknown> {
  if (!isValidAccountId(id)) throw new UsageError(`"${id}" is not a valid account id.`);
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
  const entry: Record<string, unknown> = isObject(accounts[id])
    ? { ...(accounts[id] as object) }
    : {};
  const apply = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) delete entry[key];
    else entry[key] = value;
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
  if (Object.keys(entry).length === 0) delete accounts[id];
  else accounts[id] = entry;
  next.accounts = accounts;
  return next;
}

/**
 * Set or clear the fleet-wide handoff in a raw `fleet.json` value. Pure.
 *
 * @param raw - The raw file (`undefined` when missing).
 * @param handoff - `auto`, `ask`, or `null` to delete it (back to the default, auto).
 * @returns The new raw file.
 * @throws {UsageError} On a value other than auto, ask or null.
 * @throws {PreconditionError} When the file is another version (never downgraded).
 */
export function setHandoff(raw: unknown, handoff: HandoffMode | null): Record<string, unknown> {
  if (handoff !== null && handoff !== 'auto' && handoff !== 'ask') {
    throw new UsageError(`handoff must be auto or ask (got ${JSON.stringify(handoff)}).`);
  }
  const next = editable(raw);
  if (handoff === null) delete next.handoff;
  else next.handoff = handoff;
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
 * `resetsAt` and `now >= resetsAt - spendDownWindowHours`, else `reservePct`.
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
  const spendDownStarts =
    Date.parse(reading.resetsAt) - policy.spendDownWindowHours * 60 * 60 * 1000;
  return nowMs >= spendDownStarts ? 0 : policy.reservePct;
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
