/**
 * What the dashboard makes of what it reads (spec "Flow Dashboard", M1). Pure
 * functions over the forge's reads, flow's tracker snapshot and a local
 * checkout's files, so each rule is tested on its own:
 *
 * - **Linked items:** a PR names a tracker item when its title, description or
 *   branch holds `<KEY>-<number>` for a key from config (`linkKeysOf`). There
 *   is no built-in prefix: a key nobody configured never matches.
 * - **Waiting on you:** a review asked of your `gh` login by name (a team ask
 *   does not count: flow cannot see who is in a team), or your own PR with
 *   changes asked for, a failing check or a conflict; a tracker item an agent
 *   asked a person about (`agent/needs-input`); a GitHub issue assigned to you.
 * - **Addresses:** only an `http:` or `https:` address is ever passed on.
 *
 * @module @dorkos/flow/extension/dashboard/parse
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { DashboardProduct } from '../../../../../scripts/dashboard-config.ts';
import type {
  OpenIssue,
  OpenPr,
  ReleaseState,
  WorkflowRun,
} from '../../../../../scripts/forge/github.ts';
import type {
  DashboardIssue,
  DashboardPr,
  DashboardRelease,
  IssueState,
  WatchedWorkflow,
} from './types.ts';

/** The most of a version file read: a version is near the top. */
const VERSION_READ_BYTES = 256 * 1024;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An address that is safe to open: `http:` or `https:`, else `null`.
 *
 * @param url - The address, as read.
 * @returns The address, or `null`.
 */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The tracker ids the texts name, for the configured keys, once each, in the
 * order they first appear, with the key in capitals (`acme-12-x` names `ACME-12`).
 *
 * @param texts - A title, a description, a branch.
 * @param keys - The configured keys, longest first (`linkKeysOf`).
 * @returns The ids.
 */
export function linkedKeys(texts: readonly string[], keys: readonly string[]): string[] {
  if (keys.length === 0) return [];
  // Keys are capitals, digits and `_` (TEAM_KEY_PATTERN), so they need no escaping.
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${keys.join('|')})-(\\d+)(?![A-Za-z0-9_])`, 'gi');
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const id = `${match[1].toUpperCase()}-${match[2]}`;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

/**
 * Whether a review is asked of `viewer` by name.
 *
 * @param pr - The PR.
 * @param viewer - The `gh` login, or `null` when unknown.
 * @returns True when one of its review requests is that login.
 */
export function reviewAskedOf(pr: Pick<OpenPr, 'reviewRequests'>, viewer: string | null): boolean {
  if (viewer === null) return false;
  const me = viewer.toLowerCase();
  return pr.reviewRequests.some((login) => login.toLowerCase() === me);
}

/**
 * A PR as the dashboard shows it. Its description is read for links and then
 * left behind.
 *
 * @param pr - The PR as the forge read it.
 * @param repo - Its repository.
 * @param viewer - The `gh` login, or `null`.
 * @param keys - The tracker keys to link.
 * @returns The PR.
 */
export function toDashboardPr(
  pr: OpenPr,
  repo: string,
  viewer: string | null,
  keys: readonly string[]
): DashboardPr {
  const state: DashboardPr['checks']['state'] =
    pr.checkCount === 0
      ? 'none'
      : pr.failing.length > 0
        ? 'failing'
        : pr.pendingChecks > 0
          ? 'pending'
          : 'passing';
  const review: DashboardPr['review'] =
    pr.reviewDecision === 'APPROVED'
      ? 'approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes-requested'
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review-required'
          : 'none';
  const asked = reviewAskedOf(pr, viewer);
  const mine = viewer !== null && pr.author?.toLowerCase() === viewer.toLowerCase();
  const stuck =
    !pr.draft && (review === 'changes-requested' || state === 'failing' || pr.conflicting);
  return {
    id: `${repo}#${pr.number}`,
    source: `github:${repo}`,
    repo,
    number: pr.number,
    title: pr.title,
    url: safeUrl(pr.url),
    author: pr.author,
    draft: pr.draft,
    checks: {
      state,
      failing: pr.failing.map((check) => ({ name: check.name, url: safeUrl(check.url) })),
      pending: pr.pendingChecks,
      total: pr.checkCount,
    },
    review,
    reviewRequestedFromYou: asked,
    queue: { queued: pr.queued, position: pr.queuePosition, armed: pr.armed },
    conflicting: pr.conflicting,
    linked: linkedKeys([pr.title, pr.body, pr.headRefName], keys),
    createdAt: pr.createdAt,
    waitingOnYou: asked || (mine && stuck),
  };
}

/** A tracker state category in the dashboard's words. */
const TRACKER_STATES: Readonly<Record<string, IssueState>> = {
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in-progress',
};

/**
 * A team's open items from flow's tracker snapshot (`flow snapshot --json`),
 * read leniently: an item without an id, closed, or of another team is left out.
 *
 * @param snapshot - The snapshot file's JSON.
 * @param team - The team it must be of.
 * @returns When the tracker answered, and the items.
 * @throws {Error} When the snapshot is of another team or cannot be read.
 */
export function trackerIssues(
  snapshot: unknown,
  team: string
): { fetchedAt: string | null; items: DashboardIssue[] } {
  if (!isObject(snapshot) || !Array.isArray(snapshot.items)) {
    throw new Error("flow's copy of the tracker could not be read");
  }
  const key = isObject(snapshot.team) ? snapshot.team.key : null;
  if (key !== team) throw new Error(`flow's copy of the tracker is of ${String(key)}, not ${team}`);
  const teamPage = isObject(snapshot.team) ? safeUrl(snapshot.team.url) : null;
  const base = teamPage === null ? null : /^(https:\/\/linear\.app\/[^/]+)\/team\//.exec(teamPage);
  const items: DashboardIssue[] = [];
  for (const raw of snapshot.items) {
    // The adapter scopes a snapshot to its team; an item of another team is never shown as this one's.
    if (!isObject(raw) || typeof raw.identifier !== 'string') continue;
    if (!raw.identifier.startsWith(`${team}-`)) continue;
    const state = TRACKER_STATES[String(raw.stateCategory)];
    if (state === undefined) continue;
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((label): label is string => typeof label === 'string')
      : [];
    items.push({
      id: raw.identifier,
      source: `tracker:${team}`,
      key: raw.identifier,
      title: typeof raw.title === 'string' ? raw.title : '',
      state,
      stateName: typeof raw.stateName === 'string' ? raw.stateName : '',
      team,
      repo: null,
      url: base === null ? null : `${base[1]}/issue/${encodeURIComponent(raw.identifier)}`,
      assignee: null,
      labels,
      waitingOnYou: raw.agentDisposition === 'needs-input' || labels.includes('agent/needs-input'),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    });
  }
  return {
    fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : null,
    items,
  };
}

/**
 * A repository's open GitHub issues.
 *
 * @param list - The forge's read.
 * @param repo - The repository.
 * @returns The issues.
 */
export function githubIssues(
  list: { viewer: string | null; total: number; issues: OpenIssue[] },
  repo: string
): DashboardIssue[] {
  const me = list.viewer?.toLowerCase() ?? null;
  return list.issues.map((issue) => ({
    id: `${repo}#${issue.number}`,
    source: `github:${repo}`,
    key: `${repo}#${issue.number}`,
    title: issue.title,
    state: 'todo',
    stateName: 'Open',
    team: null,
    repo,
    url: safeUrl(issue.url),
    assignee: issue.assignees.length > 0 ? issue.assignees.join(', ') : null,
    labels: issue.labels,
    waitingOnYou: me !== null && issue.assignees.some((login) => login.toLowerCase() === me),
    createdAt: issue.createdAt,
  }));
}

/**
 * The version a file holds: `version` of a JSON file, else the first
 * `x.y.z` in it.
 *
 * @param file - The file.
 * @returns The version, or `null` when there is none or no file.
 */
export function readVersion(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').slice(0, VERSION_READ_BYTES);
  } catch {
    return null;
  }
  if (file.endsWith('.json')) {
    try {
      const value: unknown = JSON.parse(text);
      return isObject(value) && typeof value.version === 'string' ? value.version : null;
    } catch {
      return null;
    }
  }
  return /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? null;
}

/**
 * How many changes wait in an unreleased folder: its files, leaving out
 * hidden files, a README and folders.
 *
 * @param dir - The folder.
 * @returns The count, or `null` when there is no such folder.
 */
export function countUnreleased(dir: string): number | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
    return readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && !entry.name.startsWith('.') && !/^readme(\.|$)/i.test(entry.name)
    ).length;
  } catch {
    return null;
  }
}

/** A combined checks state in the dashboard's words. */
function checksWord(state: string | null): DashboardRelease['ci']['state'] {
  if (state === 'SUCCESS') return 'passing';
  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'none';
}

/** One watched workflow's latest run in the dashboard's words. */
function workflowOf(entry: {
  name: string;
  run: WorkflowRun | null;
  error: string | null;
}): WatchedWorkflow {
  if (entry.error !== null) {
    return { name: entry.name, state: 'error', url: null, at: null, error: entry.error };
  }
  const { run } = entry;
  if (run === null) return { name: entry.name, state: 'never', url: null, at: null, error: null };
  const state: WatchedWorkflow['state'] =
    run.status !== 'COMPLETED'
      ? 'running'
      : run.conclusion === 'SUCCESS' || run.conclusion === 'SKIPPED' || run.conclusion === 'NEUTRAL'
        ? 'passing'
        : 'failing';
  return {
    name: run.workflow || entry.name,
    state,
    url: safeUrl(run.url),
    at: run.createdAt,
    error: null,
  };
}

/** What the local checkout says about a product. */
export interface LocalRelease {
  /** Whether the repository has a local checkout here. */
  checkout: boolean;
  /** The version in its version file. */
  fileVersion: string | null;
  /** How many changes wait, or `null`. */
  unreleased: number | null;
  /** Why they cannot be counted, or `null`. */
  unreleasedNote: string | null;
}

/**
 * One product's release state.
 *
 * @param input - The product, its repository's release state, what the local
 *   checkout says, and each watched workflow's latest run or why it could not be read.
 * @returns The release state.
 */
export function releaseOf(input: {
  product: DashboardProduct;
  state: ReleaseState;
  local: LocalRelease;
  workflows: { name: string; run: WorkflowRun | null; error: string | null }[];
}): DashboardRelease {
  const { product, state, local } = input;
  const release = state.latestRelease;
  return {
    id: product.id,
    source: `product:${product.id}`,
    repo: product.repo,
    lastRelease:
      release === null
        ? null
        : { tag: release.tagName, publishedAt: release.publishedAt, url: safeUrl(release.url) },
    lastTag: state.latestTag,
    version: release === null ? null : release.tagName.replace(/^v(?=\d)/, ''),
    fileVersion: local.fileVersion,
    checkout: local.checkout,
    unreleased: local.unreleased,
    unreleasedNote: local.unreleasedNote,
    ci: { branch: state.defaultBranch, state: checksWord(state.branchChecks) },
    workflows: input.workflows.map(workflowOf),
  };
}
