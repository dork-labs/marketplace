/**
 * The forge: where a drain run's branch and pull request live (spec
 * `flow-handoff-dispatch` §4.6). GitHub is the only implementation today
 * (`github.ts`); the drain, `flow report`, `flow pr` and `flow watch` see only
 * this interface, so a test hands them a fake.
 *
 * A forge is bound to one repository. The forge is not a tracker: it never
 * reads or writes work items.
 *
 * Dependency-free: types, one error class and one URL parser.
 *
 * @module @dorkos/flow/forge/types
 */

import { ConfigError, EXIT, FlowError } from '../errors.ts';

/** An open pull request found or created on a branch. */
export interface ForgePr {
  /** The PR number. */
  number: number;
  /** The PR's web address. */
  url: string;
  /** The head commit, when the forge reported it. */
  headSha: string | null;
}

/** One failing check on a pull request. */
export interface FailingCheck {
  /** The check run's name, or a commit status's context. */
  name: string;
  /** Where to read it, when the forge gave a link. */
  url: string | null;
}

/** A pull request as the forge sees it now. */
export interface PrStatus {
  /** Open, merged, or closed without merging. */
  state: 'open' | 'merged' | 'closed';
  /** Every failing check on the head commit (empty when none fails). */
  failing: FailingCheck[];
  /** Whether auto-merge is armed. */
  armed: boolean;
  /** Whether the PR sits in the merge queue. */
  queued: boolean;
  /** The head commit. */
  headSha: string;
  /** The branch it merges into. */
  base: string;
}

/**
 * One merge-group attempt on a base branch that had failing checks. `prs` is
 * every PR the group may contain; a group this forge cannot rule out as
 * containing a PR lists it, so it never counts as "someone else's" failure.
 */
export interface GroupFailure {
  /** The PR the attempt was created for (its own queue entry). */
  pr: number;
  /** The PRs the group may contain, {@link pr} included. */
  prs: number[];
  /** The names of its failing checks. */
  failing: string[];
}

/** What {@link Forge.createPr} opens. */
export interface CreatePrInput {
  /** The branch with the work. */
  head: string;
  /** The branch it merges into. */
  base: string;
  /** The PR title. */
  title: string;
  /** The PR body, already carrying its provenance line. */
  body: string;
}

/** One repository on a forge. Every method throws {@link ForgeError} when the forge cannot answer. */
export interface Forge {
  /** `owner/name`. */
  readonly repo: string;
  /** The branch's head commit on the forge, or `null` when the branch does not exist. */
  branchHead(branch: string): Promise<string | null>;
  /** The open PR whose head is `branch`, or `null`. */
  prForBranch(branch: string): Promise<ForgePr | null>;
  /** Open a PR. */
  createPr(input: CreatePrInput): Promise<ForgePr>;
  /** Read a PR's state, failing checks, auto-merge and queue position. */
  prStatus(pr: number): Promise<PrStatus>;
  /** Arm auto-merge. */
  arm(pr: number): Promise<void>;
  /** Disarm auto-merge. */
  disarm(pr: number): Promise<void>;
  /**
   * Merge-group attempts on `base` in the last `sinceMinutes` minutes that had
   * failing checks. `checkNames` narrows `failing` to those names; empty keeps
   * every failing check.
   */
  recentGroupFailures(
    base: string,
    checkNames: readonly string[],
    sinceMinutes: number
  ): Promise<GroupFailure[]>;
}

/** Which forge and repository a remote points at. */
export interface ForgeTarget {
  /** `github.com`, or the `GH_HOST` it matched. */
  host: string;
  /** `owner/name`. */
  repo: string;
}

/** Builds a {@link Forge} for one repository. The CLI wires the GitHub one; tests pass a fake. */
export type ForgeFactory = (target: ForgeTarget) => Forge;

/**
 * The forge could not be read or refused a write (exit 4, the code for an
 * unreachable remote service, shared with the tracker).
 */
export class ForgeError extends FlowError {
  /** @param message - What failed, naming the repository or PR. */
  constructor(message: string) {
    super(message, EXIT.tracker);
  }
}

/** The owner/name part of a remote path: `owner/name` with an optional `.git`. */
const REPO_PATH = /^\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/**
 * Where a git remote points: its host and `owner/name`. Accepts
 * `https://host/owner/name(.git)`, `ssh://git@host/owner/name(.git)` and
 * `git@host:owner/name(.git)`.
 *
 * @param originUrl - The remote URL (`git remote get-url origin`).
 * @param env - Environment variables; `GH_HOST` names a GitHub Enterprise host.
 * @returns The target.
 * @throws {ConfigError} When the remote is not on github.com or `GH_HOST` (exit 3).
 */
export function forgeTargetFor(
  originUrl: string,
  env: Readonly<Record<string, string | undefined>>
): ForgeTarget {
  const url = originUrl.trim();
  let host: string | undefined;
  let repoPath: string | undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      host = undefined;
    }
  }
  const allowed = new Set(['github.com', env.GH_HOST].filter((h): h is string => !!h));
  const match = repoPath === undefined ? null : REPO_PATH.exec(repoPath);
  if (host === undefined || !allowed.has(host.toLowerCase()) || match === null) {
    throw new ConfigError(`flow drain supports GitHub only today; origin is ${url || 'not set'}`);
  }
  return { host: host.toLowerCase(), repo: `${match[1]}/${match[2]}` };
}
