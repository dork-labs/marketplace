/**
 * The `dashboard` block of a project's flow config, read without zod (spec
 * "Flow Dashboard", M1).
 *
 * The block names what Flow's Issues, Pull requests and Releases pages show:
 * tracker teams, GitHub repositories and the products a repository releases.
 * `config-schema.ts` builds the authoritative Zod schema from the patterns and
 * defaults here, so the two cannot drift; the Flow extension's bundled server
 * half and the self-test read the block through {@link parseDashboardBlock},
 * which applies the same rules leniently: a bad entry is dropped and named in
 * `problems`, so one typo never blanks the whole dashboard.
 *
 * Dependency-free: node builtins and flow's own zod-free modules only.
 *
 * @module @dorkos/flow/dashboard-config
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile } from './atomic-json.ts';
import { CONFIG_FILE, LOCAL_CONFIG_FILE, PROJECT_CONFIG_DIR } from './config-names.ts';

/** The dashboard's pages, in the order they are offered. */
export const DASHBOARD_VIEWS = ['next', 'roadmap', 'issues', 'prs', 'releases'] as const;

/** One dashboard page. `next` and `roadmap` are reserved for later versions. */
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** A tracker team key: capitals, digits and `_`, starting with a capital (`ACME`). */
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A GitHub repository as `owner/name`. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A product id: lowercase letters, digits and dashes (`app`, `desktop-app`). */
export const PRODUCT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A path inside a repository, relative to its root: not absolute, no drive
 * letter, and no `..` segment, so it can never point outside the checkout.
 */
export const RELATIVE_PATH_PATTERN = /^(?![/\\])(?![A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/;

/** The most items the reserved `next` view may ask for. */
export const NEXT_LIMIT_MAX = 50;

/** How a product is released. Only an agent command exists; flow does not run it yet. */
export interface DashboardRelease {
  /** The only kind: an agent runs a command. */
  kind: 'agent-command';
  /** The command, such as `/system:release`. */
  command: string;
  /** The flag that makes it a dry run, such as `--dry-run`. */
  dryRunFlag: string;
}

/** One product a repository releases. */
export interface DashboardProduct {
  /** Its id, unique in the block. */
  id: string;
  /** The repository it is released from, `owner/name`. */
  repo: string;
  /** The file that holds its version, relative to the repository root. */
  versionFile: string;
  /** The folder of changes not yet released, relative to the repository root. */
  unreleased: string;
  /** How it is released (reserved: read and checked, not run, in this version). */
  release?: DashboardRelease;
  /** Workflows whose latest run the Releases page shows, by file or name. */
  watchWorkflows: string[];
}

/** The resolved `dashboard` block. */
export interface DashboardSettings {
  /** Tracker team keys whose issues the Issues page lists. Empty: the project's own team. */
  teams: string[];
  /** GitHub repositories whose issues and pull requests the pages list. */
  repos: string[];
  /** Products the Releases page shows. */
  products: DashboardProduct[];
  /** Which pages are on. */
  views: DashboardView[];
  /** Reserved for the "Next" page. */
  next?: { limit: number };
  /** Reserved for the "Roadmap" page. */
  roadmap?: { lanes: string[] };
}

/** The block's defaults: nothing listed, every page on. `config-schema.ts` must resolve to this. */
export const DASHBOARD_DEFAULTS: Readonly<DashboardSettings> = Object.freeze({
  teams: [],
  repos: [],
  products: [],
  views: [...DASHBOARD_VIEWS],
});

/** What reading the block found. */
export interface DashboardRead {
  /** Whether either config file has a `dashboard` block at all. */
  configured: boolean;
  /** The block, with every bad entry dropped. */
  settings: DashboardSettings;
  /** One line per dropped or wrong entry, naming its path. */
  problems: string[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a list of strings that each pass `accepts`, naming every entry that does not. */
function stringList(
  value: unknown,
  at: string,
  accepts: (entry: string) => boolean,
  rule: string,
  problems: string[]
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${at} must be a list`);
    return [];
  }
  const kept: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry === 'string' && accepts(entry)) {
      if (!kept.includes(entry)) kept.push(entry);
    } else {
      problems.push(`${at}[${i}] ${rule}`);
    }
  });
  return kept;
}

/** Read one product, or `null` with the reasons in `problems`. */
function product(value: unknown, at: string, problems: string[]): DashboardProduct | null {
  if (!isObject(value)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const before = problems.length;
  const need = (key: string, pattern: RegExp, rule: string): string => {
    const field = value[key];
    if (field === undefined) problems.push(`${at}.${key} is missing`);
    else if (typeof field !== 'string' || !pattern.test(field)) {
      problems.push(`${at}.${key} ${rule}`);
    }
    return typeof field === 'string' ? field : '';
  };
  const id = need('id', PRODUCT_ID_PATTERN, 'must be lowercase letters, digits and dashes');
  const repo = need('repo', REPO_PATTERN, 'must be a GitHub repository as owner/name');
  const insideRule = 'must be a path inside the repository, relative to its root, with no ..';
  const versionFile = need('versionFile', RELATIVE_PATH_PATTERN, insideRule);
  const unreleased = need('unreleased', RELATIVE_PATH_PATTERN, insideRule);
  let release: DashboardRelease | undefined;
  if (value.release !== undefined) {
    const raw = value.release;
    if (
      isObject(raw) &&
      raw.kind === 'agent-command' &&
      typeof raw.command === 'string' &&
      raw.command !== '' &&
      typeof raw.dryRunFlag === 'string' &&
      raw.dryRunFlag !== ''
    ) {
      release = { kind: 'agent-command', command: raw.command, dryRunFlag: raw.dryRunFlag };
    } else {
      problems.push(
        `${at}.release must be { "kind": "agent-command", "command": "…", "dryRunFlag": "…" }`
      );
    }
  }
  const watchWorkflows = stringList(
    value.watchWorkflows,
    `${at}.watchWorkflows`,
    (entry) => entry.trim() !== '',
    'must be a workflow file or name',
    problems
  );
  if (problems.length > before) return null;
  return {
    id,
    repo,
    versionFile,
    unreleased,
    ...(release === undefined ? {} : { release }),
    watchWorkflows,
  };
}

/**
 * Read a `dashboard` block leniently, by the same rules as the Zod schema.
 *
 * @param value - The block as written (`undefined` when absent).
 * @param at - The block's path, for the problems (default `dashboard`).
 * @returns The settings and every problem found.
 */
export function parseDashboardBlock(
  value: unknown,
  at = 'dashboard'
): { settings: DashboardSettings; problems: string[] } {
  const problems: string[] = [];
  if (value === undefined) return { settings: copyDefaults(), problems };
  if (!isObject(value)) {
    return { settings: copyDefaults(), problems: [`${at} must be an object`] };
  }
  const teams = stringList(
    value.teams,
    `${at}.teams`,
    (entry) => TEAM_KEY_PATTERN.test(entry),
    'must be a team key such as ACME',
    problems
  );
  const repos = stringList(
    value.repos,
    `${at}.repos`,
    (entry) => REPO_PATTERN.test(entry),
    'must be a GitHub repository as owner/name',
    problems
  );
  const products: DashboardProduct[] = [];
  if (value.products !== undefined) {
    if (!Array.isArray(value.products)) problems.push(`${at}.products must be a list`);
    else {
      value.products.forEach((entry, i) => {
        const read = product(entry, `${at}.products[${i}]`, problems);
        if (read === null) return;
        if (products.some((other) => other.id === read.id)) {
          problems.push(`${at}.products[${i}].id ${read.id} is used twice`);
          return;
        }
        products.push(read);
      });
    }
  }
  let views: DashboardView[] = [...DASHBOARD_VIEWS];
  if (value.views !== undefined) {
    const names = new Set<string>(DASHBOARD_VIEWS);
    views = stringList(
      value.views,
      `${at}.views`,
      (entry) => names.has(entry),
      `must be one of ${DASHBOARD_VIEWS.join(', ')}`,
      problems
    ) as DashboardView[];
  }
  const settings: DashboardSettings = { teams, repos, products, views };
  if (value.next !== undefined) {
    const limit = isObject(value.next) ? value.next.limit : undefined;
    if (
      typeof limit === 'number' &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= NEXT_LIMIT_MAX
    ) {
      settings.next = { limit };
    } else {
      problems.push(`${at}.next.limit must be a whole number from 1 to ${NEXT_LIMIT_MAX}`);
    }
  }
  if (value.roadmap !== undefined) {
    const lanes = isObject(value.roadmap) ? value.roadmap.lanes : undefined;
    if (Array.isArray(lanes) && lanes.every((lane) => typeof lane === 'string' && lane !== '')) {
      settings.roadmap = { lanes: [...(lanes as string[])] };
    } else {
      problems.push(`${at}.roadmap.lanes must be a list of names`);
    }
  }
  return { settings, problems };
}

/** A fresh copy of {@link DASHBOARD_DEFAULTS}. */
function copyDefaults(): DashboardSettings {
  return { teams: [], repos: [], products: [], views: [...DASHBOARD_VIEWS] };
}

/** One config file's `dashboard` value, or `undefined` (no file, or no block). */
function blockIn(file: string | null): unknown {
  if (file === null || !existsSync(file)) return undefined;
  const { value } = readJsonFile(file);
  return isObject(value) ? value.dashboard : undefined;
}

/**
 * Read the `dashboard` block from a project's two config files the way flow's
 * loader merges them: each key of `config.local.json`'s block replaces the
 * same key of `config.json`'s (lists replace, as everywhere in flow's config).
 *
 * @param files - The committed and local config files, `null` when absent.
 * @returns What the block holds, and whether there is one.
 */
export function readDashboardSettings(files: {
  committed: string | null;
  local: string | null;
}): DashboardRead {
  const shared = blockIn(files.committed);
  const local = blockIn(files.local);
  if (shared === undefined && local === undefined) {
    return { configured: false, settings: copyDefaults(), problems: [] };
  }
  const merged =
    isObject(shared) && isObject(local)
      ? { ...shared, ...local }
      : local !== undefined
        ? local
        : shared;
  const { settings, problems } = parseDashboardBlock(merged);
  return { configured: true, settings, problems };
}

/**
 * The `dashboard` block of the project whose main checkout is `root`, from
 * `<root>/.agents/flow/`.
 *
 * @param root - The project's main checkout.
 * @returns What the block holds, and whether there is one.
 */
export function readProjectDashboard(root: string): DashboardRead {
  const dir = path.join(root, PROJECT_CONFIG_DIR);
  return readDashboardSettings({
    committed: path.join(dir, CONFIG_FILE),
    local: path.join(dir, LOCAL_CONFIG_FILE),
  });
}

/**
 * The tracker keys an id such as `ACME-12` may start with, longest first, so a
 * key that is a prefix of another (`AC`, `ACME`) never steals its match.
 *
 * @param settings - The block.
 * @param ownTeam - The project's own team key, when it has one.
 * @returns The keys.
 */
export function linkKeysOf(settings: DashboardSettings, ownTeam: string | null): string[] {
  const keys = new Set(settings.teams);
  if (ownTeam !== null && TEAM_KEY_PATTERN.test(ownTeam)) keys.add(ownTeam);
  return [...keys].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
