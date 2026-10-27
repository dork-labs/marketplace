/**
 * Open pull requests (DOR-3341, the Flow half): the one read that counts them,
 * how a PR is tied to a work item, the open-PR cap, and when an open PR is
 * stuck.
 *
 * **Where a PR's item comes from.** The tracker snapshot carries no PR links
 * (`WorkItem` has no attachments, by the adapter contract), and `drain.pr` on a
 * run knows only the PRs the drain opened. So the source is the forge's own
 * list of open PRs, read with one fixed call ({@link openPrListArgs}), and a PR
 * belongs to an item when the item's identifier appears in its branch name or
 * its title as a whole token (`dor-12-fix` and `Fix it (DOR-12)` are DOR-12's;
 * `dor-123` is not). Flow names every branch it makes after the identifier, so
 * its own PRs always match.
 *
 * **Unreadable fails closed.** A list `gh` could not give, or gave in a shape
 * this file does not know, is never read as "no open PRs": the cap reports
 * itself unreadable, and everything that would open a PR refuses.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/forge/open-prs
 */

import { ForgeError } from './types.ts';

/** How many open PRs one read lists. A repo at the limit is far past any cap. */
export const OPEN_PR_LIST_LIMIT = 200;

/** The fields the read asks for: fixed, so the command is always the same. */
export const OPEN_PR_FIELDS =
  'number,title,url,createdAt,author,headRefName,headRefOid,baseRefName,isDraft,labels,autoMergeRequest';

/**
 * The one read-only `gh` call that lists a repository's open PRs.
 *
 * @param repoArg - `owner/name`, or `host/owner/name` on GitHub Enterprise.
 * @returns The argv after `gh`.
 */
export function openPrListArgs(repoArg: string): string[] {
  return [
    'pr',
    'list',
    '-R',
    repoArg,
    '--state',
    'open',
    '--limit',
    String(OPEN_PR_LIST_LIMIT),
    '--json',
    OPEN_PR_FIELDS,
  ];
}

/** One open pull request. */
export interface OpenPr {
  /** Its number. */
  number: number;
  /** Its title. */
  title: string;
  /** Its web address. */
  url: string;
  /** When it was opened, ISO-8601. */
  createdAt: string;
  /** Its author's login, or `null` when the forge gave none. */
  author: string | null;
  /** The branch with the work. */
  headRefName: string;
  /** The head commit. */
  headSha: string;
  /** The branch it merges into. */
  baseRefName: string;
  /** Whether it is a draft. */
  isDraft: boolean;
  /** Its label names. */
  labels: string[];
  /** Whether auto-merge is armed. */
  armed: boolean;
}

/** A plain object, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse the answer to {@link openPrListArgs}.
 *
 * @param raw - The parsed JSON.
 * @returns Every open PR, oldest first.
 * @throws {ForgeError} When the answer is not a list, or any entry lacks a
 *   number, a head or an opening date: one entry that cannot be read makes the
 *   count unreadable, never one smaller.
 */
export function parseOpenPrs(raw: unknown): OpenPr[] {
  if (!Array.isArray(raw)) throw new ForgeError('gh pr list returned something other than a list');
  const prs = raw.map((entry): OpenPr => {
    const pr = record(entry);
    const createdAt = str(pr?.createdAt);
    const headSha = str(pr?.headRefOid);
    if (
      pr === undefined ||
      typeof pr.number !== 'number' ||
      headSha === undefined ||
      createdAt === undefined ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      throw new ForgeError('gh pr list returned an open pull request flow cannot read');
    }
    return {
      number: pr.number,
      title: str(pr.title) ?? '',
      url: str(pr.url) ?? '',
      createdAt,
      author: str(record(pr.author)?.login) ?? null,
      headRefName: str(pr.headRefName) ?? '',
      headSha,
      baseRefName: str(pr.baseRefName) ?? '',
      isDraft: pr.isDraft === true,
      labels: (Array.isArray(pr.labels) ? pr.labels : []).flatMap((label) => {
        const name = str(record(label)?.name);
        return name === undefined ? [] : [name];
      }),
      armed: record(pr.autoMergeRequest) !== undefined,
    };
  });
  return prs.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
  );
}

/** Escape a string for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `pr` is the PR of the item `identifier` names: the identifier is a
 * whole token of its branch name or title, in any case.
 *
 * @param pr - The PR.
 * @param identifier - The item's human key, for example `DOR-12`.
 * @returns `true` when it is.
 */
export function prMatchesItem(
  pr: Pick<OpenPr, 'headRefName' | 'title'>,
  identifier: string
): boolean {
  if (identifier === '') return false;
  const token = new RegExp(`(?:^|[^A-Za-z0-9])${escape(identifier)}(?![0-9A-Za-z])`, 'i');
  return token.test(pr.headRefName) || token.test(pr.title);
}

/**
 * The identifiers, among `identifiers`, that have an open PR.
 *
 * @param prs - The open PRs.
 * @param identifiers - Item keys to look for.
 * @returns Each identifier with an open PR, mapped to its PRs' numbers.
 */
export function itemsWithOpenPrs(
  prs: readonly OpenPr[],
  identifiers: readonly string[]
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const identifier of identifiers) {
    const numbers = prs.filter((pr) => prMatchesItem(pr, identifier)).map((pr) => pr.number);
    if (numbers.length > 0) found.set(identifier, numbers);
  }
  return found;
}

/** The open-PR cap, as `flow next`, `flow prs` and the drain report it. */
export type PrCap =
  | {
      /** The count was read. */
      readable: true;
      /** How many PRs are open. */
      open: number;
      /** `pr.maxOpen`. */
      max: number;
      /** Whether the repository is at or past the cap. */
      atCap: boolean;
      /** Every open PR's number, oldest first: the PRs holding the slots. */
      holding: number[];
    }
  | {
      /** The count could not be read: everything that would open a PR refuses. */
      readable: false;
      /** `pr.maxOpen`. */
      max: number;
      /** At the cap, as far as anything is concerned (fails closed). */
      atCap: true;
      /** Why it could not be read. */
      error: string;
    };

/**
 * The cap, from the open PRs.
 *
 * @param prs - The open PRs, or an error message when they could not be read.
 * @param max - `pr.maxOpen`.
 * @returns The cap state.
 */
export function prCap(prs: readonly OpenPr[] | string, max: number): PrCap {
  if (typeof prs === 'string') return { readable: false, max, atCap: true, error: prs };
  return {
    readable: true,
    open: prs.length,
    max,
    atCap: prs.length >= max,
    holding: prs.map((pr) => pr.number),
  };
}

/** The priority that is P0: urgent, by the work-item model (`1` urgent … `4` low). */
export const URGENT_PRIORITY = 1;

/**
 * Why a new PR may not open, or `null` when it may: the repository is at the
 * cap (or the count could not be read) and the item is not urgent (P0).
 *
 * @param cap - The cap state.
 * @param priority - The item's priority, or `undefined` when unknown (not urgent).
 * @returns A sentence naming the PRs that hold the slots, or `null`.
 */
export function capRefusal(cap: PrCap, priority: number | undefined): string | null {
  if (priority === URGENT_PRIORITY) return null;
  if (!cap.readable) {
    return `flow could not count the open pull requests (${cap.error}), so it opens no new one; an urgent (P0) item is exempt`;
  }
  if (!cap.atCap) return null;
  return `${cap.open} pull requests are open, at the cap of ${cap.max} (pr.maxOpen): ${cap.holding.map((n) => `#${n}`).join(', ')}. Land one of them first; an urgent (P0) item is exempt`;
}

/** Why an open PR is stuck. */
export interface StuckPr {
  /** The PR. */
  pr: OpenPr;
  /** Whole days since it opened. */
  ageDays: number;
  /** Commits behind its base, or `null` when that could not be read. */
  behind: number | null;
  /** Older than `pr.staleDays`. */
  stale: boolean;
  /** More than `pr.maxBehind` commits behind, or behind by an unknown count. */
  farBehind: boolean;
  /** Who to ask: the PR's author. */
  owner: string | null;
}

/**
 * The stuck PRs: older than `staleDays`, or more than `maxBehind` commits
 * behind their base. A behind count that could not be read flags the PR too,
 * so nothing stuck hides behind a failed read.
 *
 * @param prs - The open PRs.
 * @param behind - Commits behind per PR number; a missing or `null` entry is unknown.
 * @param limits - `pr.staleDays` and `pr.maxBehind`.
 * @param now - The moment to judge at.
 * @returns The stuck PRs, oldest first.
 */
export function stuckPrs(
  prs: readonly OpenPr[],
  behind: ReadonlyMap<number, number | null>,
  limits: { staleDays: number; maxBehind: number },
  now: Date
): StuckPr[] {
  const day = 86_400_000;
  return prs.flatMap((pr) => {
    const ageMs = now.getTime() - Date.parse(pr.createdAt);
    const ageDays = Math.floor(ageMs / day);
    const count = behind.get(pr.number) ?? null;
    const stale = ageMs > limits.staleDays * day;
    const farBehind = count === null || count > limits.maxBehind;
    if (!stale && !farBehind) return [];
    return [{ pr, ageDays, behind: count, stale, farBehind, owner: pr.author }];
  });
}
