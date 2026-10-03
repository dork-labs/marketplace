/**
 * The GitHub {@link Forge} (spec `flow-handoff-dispatch` §4.6): every call is
 * the `gh` CLI run through the injected process runner with an argv array, so
 * no argument can reach a shell and tests replay recorded `gh` output.
 *
 * The failing-check rule is the one the retired `watch.sh` used: a check run
 * whose conclusion is `FAILURE`, `CANCELLED`, `TIMED_OUT` or `ACTION_REQUIRED`,
 * or a commit status whose state is `FAILURE` or `ERROR`.
 *
 * Merge groups: GitHub names each merge-group branch
 * `gh-readonly-queue/<base>/pr-<n>-<base sha>`, which names the PR the attempt
 * was created for but not the PRs queued ahead of it. So a group may hold any
 * PR whose attempt started from the same base commit, and
 * {@link GroupFailure.prs} lists all of them: a PR's innocence is never proven
 * by a group that might have contained it.
 *
 * Dependency-free: node builtins only.
 *
 * @module @dorkos/flow/forge/github
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import {
  ForgeError,
  type FailingCheck,
  type Forge,
  type ForgePr,
  type ForgeTarget,
  type GroupFailure,
  type PrStatus,
} from './types.ts';

/** A check run conclusion that counts as failing (`watch.sh`'s rule). */
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);
/** A commit status state that counts as failing. */
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
/** How many merge-group runs one {@link Forge.recentGroupFailures} call reads. */
const RUN_LIST_LIMIT = 100;
/** How long one `gh` call may take. */
const GH_TIMEOUT_MS = 60_000;

/** What {@link createGithubForge} needs. */
export interface GithubForgeOptions {
  /** The repository. */
  target: ForgeTarget;
  /** Runs `gh` with no shell. */
  runProcess: ProcessRunner;
  /** The clock (for the merge-group window). */
  now(): Date;
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
 * The failing checks in a `statusCheckRollup`: check runs by conclusion,
 * commit statuses by state.
 *
 * @param rollup - The `statusCheckRollup` array from `gh pr view --json`.
 * @returns Every failing check, in rollup order.
 */
export function failingChecks(rollup: unknown): FailingCheck[] {
  if (!Array.isArray(rollup)) return [];
  const failing: FailingCheck[] = [];
  for (const entry of rollup) {
    const check = record(entry);
    if (check === undefined) continue;
    const conclusion = (str(check.conclusion) ?? '').toUpperCase();
    const state = (str(check.state) ?? '').toUpperCase();
    if (!FAILING_CONCLUSIONS.has(conclusion) && !FAILING_STATES.has(state)) continue;
    failing.push({
      name: str(check.name) ?? str(check.context) ?? '(unnamed check)',
      url: str(check.detailsUrl) ?? str(check.targetUrl) ?? null,
    });
  }
  return failing;
}

/**
 * How many checks in `statusCheckRollup` have not finished: a check run whose
 * `status` is not `COMPLETED`, or a commit status still `PENDING` or `EXPECTED`.
 *
 * A PR with no checks at all, or a rollup that cannot be read, counts as one
 * pending check: nothing has passed yet (checks may not have registered), so
 * nothing may treat it as passed.
 *
 * @param rollup - The `statusCheckRollup` array from `gh pr view --json`.
 * @returns The count; at least 1 when there are no checks.
 */
export function pendingChecks(rollup: unknown): number {
  if (!Array.isArray(rollup) || rollup.length === 0) return 1;
  let pending = 0;
  for (const entry of rollup) {
    const check = record(entry);
    if (check === undefined) continue;
    const status = str(check.status)?.toUpperCase();
    const state = str(check.state)?.toUpperCase();
    if (
      status !== undefined ? status !== 'COMPLETED' : state === 'PENDING' || state === 'EXPECTED'
    ) {
      pending += 1;
    }
  }
  return pending;
}

/**
 * Parse `gh pr view --json state,autoMergeRequest,statusCheckRollup,headRefOid,baseRefName,mergeable,mergeStateStatus`.
 *
 * @param raw - The parsed JSON.
 * @param queued - Whether the PR is in the merge queue (a separate GraphQL read).
 * @param where - `owner/name#n`, for the error.
 * @returns The status.
 * @throws {ForgeError} When the answer has no recognizable state or head: a
 *   read that cannot be understood is an error, never "merged".
 */
export function parsePrView(raw: unknown, queued: boolean, where: string): PrStatus {
  const view = record(raw);
  const state = str(view?.state)?.toUpperCase();
  const headSha = str(view?.headRefOid);
  if (
    view === undefined ||
    headSha === undefined ||
    !['OPEN', 'MERGED', 'CLOSED'].includes(state ?? '')
  ) {
    throw new ForgeError(`gh returned an unreadable pull request for ${where}`);
  }
  return {
    state: (state as string).toLowerCase() as PrStatus['state'],
    failing: failingChecks(view.statusCheckRollup),
    pendingChecks: pendingChecks(view.statusCheckRollup),
    armed: view.autoMergeRequest !== null && view.autoMergeRequest !== undefined,
    queued,
    headSha,
    base: str(view.baseRefName) ?? '',
    conflicting:
      str(view.mergeable)?.toUpperCase() === 'CONFLICTING' ||
      str(view.mergeStateStatus)?.toUpperCase() === 'DIRTY',
  };
}

/** One merge-group workflow run from `gh run list --json`. */
export interface GroupRun {
  /** The run id. */
  id: number;
  /** The PR the group was created for. */
  pr: number;
  /** The base commit the group started from. */
  baseSha: string;
  /** The group branch. */
  branch: string;
  /** Whether the run concluded as failing. */
  failed: boolean;
}

/** `gh-readonly-queue/<base>/pr-<n>-<base sha>`. */
const GROUP_BRANCH = /^gh-readonly-queue\/(.+)\/pr-(\d+)-([0-9a-f]+)$/;

/**
 * The merge-group runs on `base` created at or after `since`, from
 * `gh run list --event merge_group --json databaseId,headBranch,conclusion,createdAt`.
 * Runs on other bases, older runs and branches that do not parse are dropped.
 *
 * @param raw - The parsed JSON array.
 * @param base - The base branch.
 * @param since - The window's start.
 * @returns The runs.
 */
export function parseGroupRuns(raw: unknown, base: string, since: Date): GroupRun[] {
  if (!Array.isArray(raw)) throw new ForgeError('gh run list returned something other than a list');
  const runs: GroupRun[] = [];
  for (const entry of raw) {
    const run = record(entry);
    const match = GROUP_BRANCH.exec(str(run?.headBranch) ?? '');
    const created = Date.parse(str(run?.createdAt) ?? '');
    if (run === undefined || match === null || match[1] !== base) continue;
    if (!Number.isFinite(created) || created < since.getTime()) continue;
    if (typeof run.databaseId !== 'number') continue;
    runs.push({
      id: run.databaseId,
      pr: Number(match[2]),
      baseSha: match[3],
      branch: match[0],
      failed: FAILING_CONCLUSIONS.has((str(run.conclusion) ?? '').toUpperCase()),
    });
  }
  return runs;
}

/**
 * The failing job names from `gh run view <id> --json jobs`.
 *
 * @param raw - The parsed JSON.
 * @returns The names of jobs whose conclusion counts as failing.
 */
export function failingJobs(raw: unknown): string[] {
  const jobs = record(raw)?.jobs;
  if (!Array.isArray(jobs)) throw new ForgeError('gh run view returned no jobs');
  return jobs
    .map(record)
    .filter((job) => FAILING_CONCLUSIONS.has((str(job?.conclusion) ?? '').toUpperCase()))
    .map((job) => str(job?.name) ?? '(unnamed job)');
}

/**
 * Fold failed runs into groups: one per group branch, its failing jobs merged,
 * and `prs` every PR whose group started from the same base commit.
 *
 * @param runs - Every merge-group run in the window (failed or not).
 * @param failingByRun - The failing job names of each failed run, by run id.
 * @param checkNames - Keep only these names; empty keeps all.
 * @returns One entry per group with at least one failing check.
 */
export function foldGroups(
  runs: readonly GroupRun[],
  failingByRun: ReadonlyMap<number, readonly string[]>,
  checkNames: readonly string[]
): GroupFailure[] {
  const prsByBase = new Map<string, Set<number>>();
  for (const run of runs) {
    const set = prsByBase.get(run.baseSha) ?? new Set<number>();
    set.add(run.pr);
    prsByBase.set(run.baseSha, set);
  }
  const keep = checkNames.length === 0 ? undefined : new Set(checkNames);
  const groups = new Map<string, GroupFailure>();
  for (const run of runs) {
    const failing = (failingByRun.get(run.id) ?? []).filter((name) => keep?.has(name) ?? true);
    if (failing.length === 0) continue;
    const group = groups.get(run.branch) ?? {
      pr: run.pr,
      prs: [...(prsByBase.get(run.baseSha) ?? [run.pr])].sort((a, b) => a - b),
      failing: [],
    };
    for (const name of failing) if (!group.failing.includes(name)) group.failing.push(name);
    groups.set(run.branch, group);
  }
  return [...groups.values()];
}

/**
 * Run gh with no shell; a failure to start or a non-zero exit is a
 * {@link ForgeError} naming `what` and saying what gh said.
 *
 * @param runProcess - The process runner.
 * @param args - gh's arguments.
 * @param what - What the call was for, for the error.
 * @param timeoutMs - How long it may take.
 * @returns What gh printed.
 */
async function runGh(
  runProcess: ProcessRunner,
  args: readonly string[],
  what: string,
  timeoutMs: number
): Promise<string> {
  let result;
  try {
    result = await runProcess('gh', args, { timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ForgeError(
      `${what}: could not run gh (${message}); install the GitHub CLI and sign in with "gh auth login"`
    );
  }
  if (result.code !== 0) {
    throw new ForgeError(`${what}: ${result.stderr.trim() || `gh exited ${result.code}`}`);
  }
  return result.stdout;
}

/** {@link runGh}, with stdout parsed as JSON. */
async function runGhJson(
  runProcess: ProcessRunner,
  args: readonly string[],
  what: string,
  timeoutMs: number
): Promise<unknown> {
  const text = await runGh(runProcess, args, what, timeoutMs);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ForgeError(`${what}: gh printed something other than JSON`);
  }
}

/**
 * Build the GitHub forge for one repository.
 *
 * @param options - The repository, the process runner and the clock.
 * @returns The forge.
 */
export function createGithubForge(options: GithubForgeOptions): Forge {
  const { target, runProcess } = options;
  const [owner, name] = target.repo.split('/');
  const repoArg = target.host === 'github.com' ? target.repo : `${target.host}/${target.repo}`;
  const hostArgs = target.host === 'github.com' ? [] : ['--hostname', target.host];

  const gh = (args: readonly string[], what: string) =>
    runGh(runProcess, args, what, GH_TIMEOUT_MS);
  const ghJson = (args: readonly string[], what: string) =>
    runGhJson(runProcess, args, what, GH_TIMEOUT_MS);

  async function inMergeQueue(pr: number): Promise<boolean> {
    const query =
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}';
    const raw = await ghJson(
      [
        'api',
        'graphql',
        ...hostArgs,
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${pr}`,
      ],
      `reading whether ${target.repo}#${pr} is queued`
    );
    const pull = record(record(record(record(raw)?.data)?.repository)?.pullRequest);
    return pull?.isInMergeQueue === true;
  }

  return {
    repo: target.repo,

    async branchHead(branch) {
      const ref = branch.split('/').map(encodeURIComponent).join('/');
      let result;
      try {
        result = await runProcess(
          'gh',
          ['api', ...hostArgs, `repos/${target.repo}/git/ref/heads/${ref}`],
          { timeoutMs: GH_TIMEOUT_MS }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ForgeError(`reading ${target.repo} ${branch}: could not run gh (${message})`);
      }
      if (result.code !== 0) {
        if (/HTTP 404/.test(result.stderr)) return null;
        throw new ForgeError(`reading ${target.repo} ${branch}: ${result.stderr.trim()}`);
      }
      const sha = str(record(record(safeJson(result.stdout))?.object)?.sha);
      if (sha === undefined)
        throw new ForgeError(`reading ${target.repo} ${branch}: no commit in the answer`);
      return sha;
    },

    async prForBranch(branch) {
      const raw = await ghJson(
        [
          'pr',
          'list',
          '-R',
          repoArg,
          '--head',
          branch,
          '--state',
          'open',
          '--json',
          'number,url,headRefOid',
        ],
        `listing open PRs for ${target.repo} ${branch}`
      );
      if (!Array.isArray(raw))
        throw new ForgeError(`gh pr list returned something other than a list`);
      const first = record(raw[0]);
      if (first === undefined || typeof first.number !== 'number') return null;
      return {
        number: first.number,
        url: str(first.url) ?? '',
        headSha: str(first.headRefOid) ?? null,
      };
    },

    async createPr(input) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'flow-pr-'));
      const bodyFile = path.join(dir, 'body.md');
      try {
        writeFileSync(bodyFile, input.body);
        const out = await gh(
          [
            'pr',
            'create',
            '-R',
            repoArg,
            '--head',
            input.head,
            '--base',
            input.base,
            '--title',
            input.title,
            '--body-file',
            bodyFile,
          ],
          `opening a PR on ${target.repo} from ${input.head}`
        );
        const url = out.trim().split('\n').pop() ?? '';
        const number = /\/pull\/(\d+)/.exec(url);
        if (number === null)
          throw new ForgeError(`gh pr create printed no PR address: ${out.trim()}`);
        return { number: Number(number[1]), url, headSha: null } satisfies ForgePr;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async prStatus(pr) {
      const where = `${target.repo}#${pr}`;
      const raw = await ghJson(
        [
          'pr',
          'view',
          String(pr),
          '-R',
          repoArg,
          '--json',
          'state,autoMergeRequest,statusCheckRollup,headRefOid,baseRefName,mergeable,mergeStateStatus',
        ],
        `reading ${where}`
      );
      const status = parsePrView(raw, false, where);
      return status.state === 'open' ? { ...status, queued: await inMergeQueue(pr) } : status;
    },

    async arm(pr, headSha) {
      await gh(
        ['pr', 'merge', String(pr), '-R', repoArg, '--auto', '--match-head-commit', headSha],
        `arming ${target.repo}#${pr} at ${headSha.slice(0, 7)}`
      );
    },

    async disarm(pr) {
      await gh(
        ['pr', 'merge', String(pr), '-R', repoArg, '--disable-auto'],
        `disarming ${target.repo}#${pr}`
      );
    },

    async review(pr, input) {
      const where = `${target.repo}#${pr}`;
      const view = record(
        await ghJson(
          ['pr', 'view', String(pr), '-R', repoArg, '--json', 'author'],
          `reading who wrote ${where}`
        )
      );
      const author = str(record(view?.author)?.login);
      const viewer = (
        await gh(['api', ...hostArgs, 'user', '--jq', '.login'], 'reading the signed-in account')
      ).trim();
      const own = author !== undefined && viewer !== '' && author === viewer;
      if (own && input.event === 'approve') return 'skipped';
      const dir = mkdtempSync(path.join(os.tmpdir(), 'flow-review-'));
      const bodyFile = path.join(dir, 'body.md');
      try {
        writeFileSync(bodyFile, input.body);
        if (own) {
          await gh(
            ['pr', 'comment', String(pr), '-R', repoArg, '--body-file', bodyFile],
            `commenting on ${where}`
          );
          return 'commented';
        }
        const flag = input.event === 'approve' ? '--approve' : '--request-changes';
        await gh(
          ['pr', 'review', String(pr), '-R', repoArg, flag, '--body-file', bodyFile],
          `reviewing ${where}`
        );
        return 'reviewed';
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async recentGroupFailures(base, checkNames, sinceMinutes) {
      const since = new Date(options.now().getTime() - sinceMinutes * 60_000);
      const raw = await ghJson(
        [
          'run',
          'list',
          '-R',
          repoArg,
          '--event',
          'merge_group',
          '--limit',
          String(RUN_LIST_LIMIT),
          '--json',
          'databaseId,headBranch,conclusion,createdAt',
        ],
        `listing merge-group runs on ${target.repo}`
      );
      const runs = parseGroupRuns(raw, base, since);
      const failingByRun = new Map<number, string[]>();
      for (const run of runs.filter((r) => r.failed)) {
        const jobs = await ghJson(
          ['run', 'view', String(run.id), '-R', repoArg, '--json', 'jobs'],
          `reading merge-group run ${run.id} on ${target.repo}`
        );
        failingByRun.set(run.id, failingJobs(jobs));
      }
      return foldGroups(runs, failingByRun, checkNames);
    },
  };
}

/** JSON.parse that returns `undefined` instead of throwing. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reads for Flow's dashboard (spec "Flow Dashboard", M1). Each is one gh call
// per repository, through the same runner, never a shell string.
// ---------------------------------------------------------------------------

/** How long one dashboard read may take: a page waits on it. */
const READ_TIMEOUT_MS = 30_000;

/** The most open PRs or issues one read lists per repository. */
export const DASHBOARD_LIST_LIMIT = 50;

/** One open pull request as the dashboard reads it. */
export interface OpenPr {
  /** The PR number. */
  number: number;
  /** Its title, as written. */
  title: string;
  /** Its web address. */
  url: string;
  /** Who opened it, or `null` for a deleted account. */
  author: string | null;
  /** Whether it is a draft. */
  draft: boolean;
  /** When it was opened. */
  createdAt: string | null;
  /** Its branch. */
  headRefName: string;
  /** Its description, as written (read for tracker ids, never shown). */
  body: string;
  /** GitHub's review decision, or `null` when no review is required. */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** Who a review is asked of: a login, or `team:<slug>`. */
  reviewRequests: string[];
  /** Whether it sits in the merge queue. */
  queued: boolean;
  /** Its place in the merge queue, or `null`. */
  queuePosition: number | null;
  /** Whether auto-merge is armed. */
  armed: boolean;
  /** Whether it conflicts with its base. */
  conflicting: boolean;
  /** Its failing checks (the forge rule). */
  failing: FailingCheck[];
  /** How many of its checks have not finished; 0 with no checks. */
  pendingChecks: number;
  /** How many checks it has. */
  checkCount: number;
}

/** One open issue as the dashboard reads it. */
export interface OpenIssue {
  /** The issue number. */
  number: number;
  /** Its title, as written. */
  title: string;
  /** Its web address. */
  url: string;
  /** Who opened it, or `null` for a deleted account. */
  author: string | null;
  /** The logins it is assigned to. */
  assignees: string[];
  /** Its labels. */
  labels: string[];
  /** When it was opened. */
  createdAt: string | null;
  /** When it last changed. */
  updatedAt: string | null;
}

/** A repository's release state. */
export interface ReleaseState {
  /** The default branch, or `null` for an empty repository. */
  defaultBranch: string | null;
  /** The combined checks on the default branch's head (`SUCCESS`, `FAILURE`, `PENDING`…), or `null`. */
  branchChecks: string | null;
  /** The latest published release, or `null`. */
  latestRelease: { tagName: string; name: string | null; publishedAt: string | null; url: string } | null;
  /** The newest tag by commit date, or `null`. */
  latestTag: string | null;
}

/** The latest run of one workflow. */
export interface WorkflowRun {
  /** The run id. */
  id: number;
  /** The workflow's name. */
  workflow: string;
  /** `QUEUED`, `IN_PROGRESS`, `COMPLETED`… */
  status: string;
  /** `SUCCESS`, `FAILURE`… once completed, else `null`. */
  conclusion: string | null;
  /** When it started. */
  createdAt: string | null;
  /** Its web address. */
  url: string | null;
  /** The branch or tag it ran on. */
  branch: string | null;
  /** What started it (`push`, `release`, `workflow_dispatch`…). */
  event: string | null;
}

/** The open-PR read: every field the PRs page shows, the merge queue included. */
export const OPEN_PRS_QUERY =
  'query($owner:String!,$name:String!,$first:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:$first,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{number title url isDraft createdAt headRefName body author{login} reviewDecision reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login}}}} isInMergeQueue mergeQueueEntry{position} autoMergeRequest{enabledAt} mergeable commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}}}}';

/** The open-issue read. */
export const OPEN_ISSUES_QUERY =
  'query($owner:String!,$name:String!,$first:Int!){viewer{login} repository(owner:$owner,name:$name){issues(states:OPEN,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{number title url createdAt updatedAt author{login} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}}}}}';

/** The release-state read: the default branch's checks, the latest release and the newest tag. */
export const RELEASE_STATE_QUERY =
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{... on Commit{oid statusCheckRollup{state}}}} latestRelease{tagName name publishedAt url} refs(refPrefix:"refs/tags/",first:1,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name}}}}';

/** `data.repository` of a GraphQL answer, or a ForgeError naming the repository. */
function repositoryOf(raw: unknown, repo: string): Record<string, unknown> {
  const root = record(raw);
  const repository = record(record(root?.data)?.repository);
  if (repository === undefined) {
    const errors = Array.isArray(root?.errors)
      ? root.errors.map((e) => str(record(e)?.message)).filter(Boolean)
      : [];
    throw new ForgeError(
      `GitHub returned no repository ${repo}${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`
    );
  }
  return repository;
}

/** The nodes of a GraphQL connection, as records. */
function nodesOf(connection: unknown): Record<string, unknown>[] {
  const nodes = record(connection)?.nodes;
  return Array.isArray(nodes)
    ? nodes.map(record).filter((n): n is Record<string, unknown> => n !== undefined)
    : [];
}

/** The signed-in login of a GraphQL answer, or `null`. */
function viewerOf(raw: unknown): string | null {
  return str(record(record(record(raw)?.data)?.viewer)?.login) ?? null;
}

/**
 * Parse {@link OPEN_PRS_QUERY}'s answer.
 *
 * @param raw - The parsed JSON.
 * @param repo - `owner/name`, for the error.
 * @returns Who is signed in, how many PRs are open, and the PRs read.
 * @throws {ForgeError} When the answer has no repository.
 */
export function parseOpenPrs(
  raw: unknown,
  repo: string
): { viewer: string | null; total: number; prs: OpenPr[] } {
  const connection = record(repositoryOf(raw, repo).pullRequests);
  const prs: OpenPr[] = [];
  for (const node of nodesOf(connection)) {
    if (typeof node.number !== 'number') continue;
    const commit = record(nodesOf(node.commits)[0]?.commit);
    const contexts = nodesOf(record(commit?.statusCheckRollup)?.contexts);
    const decision = str(node.reviewDecision)?.toUpperCase();
    prs.push({
      number: node.number,
      title: str(node.title) ?? '',
      url: str(node.url) ?? '',
      author: str(record(node.author)?.login) ?? null,
      draft: node.isDraft === true,
      createdAt: str(node.createdAt) ?? null,
      headRefName: str(node.headRefName) ?? '',
      body: str(node.body) ?? '',
      reviewDecision:
        decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED'
          ? decision
          : null,
      reviewRequests: nodesOf(node.reviewRequests).flatMap((request) => {
        const reviewer = record(request.requestedReviewer);
        const login = str(reviewer?.login);
        const slug = str(reviewer?.slug);
        return login !== undefined ? [login] : slug !== undefined ? [`team:${slug}`] : [];
      }),
      queued: node.isInMergeQueue === true,
      queuePosition:
        typeof record(node.mergeQueueEntry)?.position === 'number'
          ? (record(node.mergeQueueEntry)?.position as number)
          : null,
      armed: record(node.autoMergeRequest) !== undefined,
      conflicting: str(node.mergeable)?.toUpperCase() === 'CONFLICTING',
      failing: failingChecks(contexts),
      pendingChecks: contexts.length === 0 ? 0 : pendingChecks(contexts),
      checkCount: contexts.length,
    });
  }
  const total = connection?.totalCount;
  return { viewer: viewerOf(raw), total: typeof total === 'number' ? total : prs.length, prs };
}

/**
 * Parse {@link OPEN_ISSUES_QUERY}'s answer.
 *
 * @param raw - The parsed JSON.
 * @param repo - `owner/name`, for the error.
 * @returns Who is signed in, how many issues are open, and the issues read.
 * @throws {ForgeError} When the answer has no repository.
 */
export function parseOpenIssues(
  raw: unknown,
  repo: string
): { viewer: string | null; total: number; issues: OpenIssue[] } {
  const connection = record(repositoryOf(raw, repo).issues);
  const issues: OpenIssue[] = [];
  for (const node of nodesOf(connection)) {
    if (typeof node.number !== 'number') continue;
    issues.push({
      number: node.number,
      title: str(node.title) ?? '',
      url: str(node.url) ?? '',
      author: str(record(node.author)?.login) ?? null,
      assignees: nodesOf(node.assignees).flatMap((a) => str(a.login) ?? []),
      labels: nodesOf(node.labels).flatMap((l) => str(l.name) ?? []),
      createdAt: str(node.createdAt) ?? null,
      updatedAt: str(node.updatedAt) ?? null,
    });
  }
  const total = connection?.totalCount;
  return { viewer: viewerOf(raw), total: typeof total === 'number' ? total : issues.length, issues };
}

/**
 * Parse {@link RELEASE_STATE_QUERY}'s answer.
 *
 * @param raw - The parsed JSON.
 * @param repo - `owner/name`, for the error.
 * @returns The release state.
 * @throws {ForgeError} When the answer has no repository.
 */
export function parseReleaseState(raw: unknown, repo: string): ReleaseState {
  const repository = repositoryOf(raw, repo);
  const branch = record(repository.defaultBranchRef);
  const rollup = record(record(branch?.target)?.statusCheckRollup);
  const release = record(repository.latestRelease);
  const tagName = str(release?.tagName);
  return {
    defaultBranch: str(branch?.name) ?? null,
    branchChecks: str(rollup?.state)?.toUpperCase() ?? null,
    latestRelease:
      release === undefined || tagName === undefined
        ? null
        : {
            tagName,
            name: str(release.name) ?? null,
            publishedAt: str(release.publishedAt) ?? null,
            url: str(release.url) ?? '',
          },
    latestTag: str(nodesOf(repository.refs)[0]?.name) ?? null,
  };
}

/**
 * Parse `gh run list --json databaseId,workflowName,status,conclusion,createdAt,url,headBranch,event`
 * for its newest run. gh prints states in lowercase; they are read in capitals,
 * as the rest of the forge has them.
 *
 * @param raw - The parsed JSON array.
 * @returns The newest run, or `null` when the workflow never ran.
 * @throws {ForgeError} When the answer is not a list.
 */
export function parseLatestRun(raw: unknown): WorkflowRun | null {
  if (!Array.isArray(raw)) throw new ForgeError('gh run list returned something other than a list');
  const run = record(raw[0]);
  if (run === undefined || typeof run.databaseId !== 'number') return null;
  return {
    id: run.databaseId,
    workflow: str(run.workflowName) ?? '',
    status: (str(run.status) ?? '').toUpperCase(),
    conclusion: str(run.conclusion)?.toUpperCase() || null,
    createdAt: str(run.createdAt) ?? null,
    url: str(run.url) ?? null,
    branch: str(run.headBranch) ?? null,
    event: str(run.event) ?? null,
  };
}

/** The dashboard's GitHub reads. */
export interface GithubReads {
  /** The open PRs of a repository, newest first, at most {@link DASHBOARD_LIST_LIMIT}. */
  openPrs(repo: string): Promise<ReturnType<typeof parseOpenPrs>>;
  /** The open issues of a repository, most recently changed first. */
  openIssues(repo: string): Promise<ReturnType<typeof parseOpenIssues>>;
  /** A repository's default branch checks, latest release and newest tag. */
  releaseState(repo: string): Promise<ReleaseState>;
  /** The latest run of one workflow, by its file or name, or `null`. */
  latestRun(repo: string, workflow: string): Promise<WorkflowRun | null>;
  /** True when the repository exists for the signed-in account; else throws with gh's words. */
  repoExists(repo: string): Promise<true>;
}

/**
 * Build the dashboard's GitHub reads over `gh`, on github.com.
 *
 * @param options - The process runner.
 * @returns The reads.
 */
export function createGithubReads(options: { runProcess: ProcessRunner }): GithubReads {
  const { runProcess } = options;
  const graphql = (query: string, repo: string, what: string, extra: string[] = []) => {
    const [owner, name] = repo.split('/');
    return runGhJson(
      runProcess,
      ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...extra],
      what,
      READ_TIMEOUT_MS
    );
  };
  const first = ['-F', `first=${DASHBOARD_LIST_LIMIT}`];
  return {
    async openPrs(repo) {
      return parseOpenPrs(
        await graphql(OPEN_PRS_QUERY, repo, `reading the open PRs of ${repo}`, first),
        repo
      );
    },
    async openIssues(repo) {
      return parseOpenIssues(
        await graphql(OPEN_ISSUES_QUERY, repo, `reading the open issues of ${repo}`, first),
        repo
      );
    },
    async releaseState(repo) {
      return parseReleaseState(
        await graphql(RELEASE_STATE_QUERY, repo, `reading the releases of ${repo}`),
        repo
      );
    },
    async latestRun(repo, workflow) {
      return parseLatestRun(
        await runGhJson(
          runProcess,
          [
            'run',
            'list',
            '-R',
            repo,
            '--workflow',
            workflow,
            '--limit',
            '1',
            '--json',
            'databaseId,workflowName,status,conclusion,createdAt,url,headBranch,event',
          ],
          `reading the latest ${workflow} run of ${repo}`,
          READ_TIMEOUT_MS
        )
      );
    },
    async repoExists(repo) {
      await runGh(
        runProcess,
        ['repo', 'view', repo, '--json', 'nameWithOwner'],
        `looking up ${repo}`,
        READ_TIMEOUT_MS
      );
      return true;
    },
  };
}
