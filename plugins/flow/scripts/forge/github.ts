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
 * Parse `gh pr view --json state,autoMergeRequest,statusCheckRollup,headRefOid,baseRefName`.
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
    armed: view.autoMergeRequest !== null && view.autoMergeRequest !== undefined,
    queued,
    headSha,
    base: str(view.baseRefName) ?? '',
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

  /** Run gh; a failure to start or a non-zero exit is a ForgeError naming `what`. */
  async function gh(args: readonly string[], what: string): Promise<string> {
    let result;
    try {
      result = await runProcess('gh', args, { timeoutMs: GH_TIMEOUT_MS });
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

  /** Run gh and parse its stdout as JSON. */
  async function ghJson(args: readonly string[], what: string): Promise<unknown> {
    const text = await gh(args, what);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ForgeError(`${what}: gh printed something other than JSON`);
    }
  }

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
          'state,autoMergeRequest,statusCheckRollup,headRefOid,baseRefName',
        ],
        `reading ${where}`
      );
      const status = parsePrView(raw, false, where);
      return status.state === 'open' ? { ...status, queued: await inMergeQueue(pr) } : status;
    },

    async arm(pr) {
      await gh(['pr', 'merge', String(pr), '-R', repoArg, '--auto'], `arming ${target.repo}#${pr}`);
    },

    async disarm(pr) {
      await gh(
        ['pr', 'merge', String(pr), '-R', repoArg, '--disable-auto'],
        `disarming ${target.repo}#${pr}`
      );
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
