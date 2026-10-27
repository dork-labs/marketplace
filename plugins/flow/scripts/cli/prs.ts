/**
 * `flow prs [--for <identifier>] [--no-behind]` (DOR-3341): the repository's
 * open pull requests, read-only. The report `/flow:groom` and triage call for
 * stuck PRs, and the check `/flow:verify` runs before it opens one.
 *
 * - The open-PR cap (`pr.maxOpen`): how many are open, and which hold the slots.
 * - Every open PR, oldest first: its age, its author, and how many commits it
 *   is behind its base (one read each; `--no-behind` skips them).
 * - Stuck PRs: older than `pr.staleDays`, or more than `pr.maxBehind` commits
 *   behind (or behind by a count that could not be read), each with a ship /
 *   split / close prompt that names its owner.
 * - `--for <identifier>`: whether a new PR may open for that item. At the cap,
 *   only an urgent (P0) item may; a count that cannot be read refuses. A
 *   refusal exits 5 naming the PRs that hold the slots.
 *
 * Exits 4 when the open PRs cannot be read (with no `--for`: the report has
 * nothing to show).
 *
 * @module @dorkos/flow/cli/prs
 */

import { PreconditionError, UsageError } from '../errors.ts';
import { prCap, stuckPrs, type OpenPr, type StuckPr } from '../forge/open-prs.ts';
import { ForgeError } from '../forge/types.ts';
import { loadProjectConfig } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { prCapGate, readOpenPrs } from './open-prs-read.ts';
import { formatColumns } from './output.ts';

/**
 * The prompt for one stuck PR: ship it, split it or close it, asking its owner.
 *
 * @param stuck - The stuck PR.
 * @param limits - `pr.staleDays` and `pr.maxBehind`.
 * @returns One sentence.
 */
export function stuckPrompt(
  stuck: StuckPr,
  limits: { staleDays: number; maxBehind: number }
): string {
  const why = [
    ...(stuck.stale ? [`open ${stuck.ageDays} days (over ${limits.staleDays})`] : []),
    ...(stuck.farBehind
      ? [
          stuck.behind === null
            ? 'behind its base by a count flow could not read'
            : `${stuck.behind} commits behind (over ${limits.maxBehind})`,
        ]
      : []),
  ].join(' and ');
  const owner = stuck.owner === null ? 'its author' : `@${stuck.owner}`;
  return `#${stuck.pr.number} is ${why}: ${owner}, ship it, split it or close it?`;
}

/**
 * Run `flow prs`.
 *
 * @param ctx - The verb's context.
 * @returns The cap, the open PRs and the stuck ones.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const project = loadProjectConfig(ctx);
  const { config } = project.loaded;
  project.flushWarnings();
  const forItem = ctx.args.flags.for;
  if (forItem === true) throw new UsageError('--for needs an item identifier');

  if (typeof forItem === 'string') {
    const gate = await prCapGate(ctx, { dir: ctx.projectDir, identifier: forItem });
    if (!gate.ok) throw new PreconditionError(`no new pull request for ${forItem}: ${gate.detail}`);
    const cap = gate.cap;
    return {
      json: { identifier: forItem, mayOpen: true, prCap: cap },
      text:
        cap === null
          ? `${forItem} may open a pull request (this checkout has no forge to count).`
          : cap.readable
            ? `${forItem} may open a pull request (${cap.open} of ${cap.max} open${cap.atCap ? '; urgent items are exempt' : ''}).`
            : `${forItem} may open a pull request: it is urgent (P0), which the cap exempts.`,
    };
  }

  const open = await readOpenPrs(ctx, ctx.projectDir);
  if (open.kind === 'none') {
    return {
      json: { repo: null, prCap: null, prs: [], stuck: [], why: open.why },
      text: `No open pull requests to show: ${open.why}.`,
    };
  }
  if (open.kind === 'unreadable') {
    throw new ForgeError(`flow could not list the open pull requests: ${open.error}`);
  }
  const { forge, prs } = open;
  const behind = new Map<number, number | null>();
  if (ctx.args.flags['no-behind'] !== true) {
    for (const pr of prs) behind.set(pr.number, await behindOf(forge, pr));
  }
  const limits = { staleDays: config.pr.staleDays, maxBehind: config.pr.maxBehind };
  const now = ctx.now();
  const cap = prCap(prs, config.pr.maxOpen);
  // With --no-behind there is no count to judge, so only age flags a PR.
  const stuck = stuckPrs(
    prs,
    ctx.args.flags['no-behind'] === true ? new Map(prs.map((pr) => [pr.number, 0])) : behind,
    limits,
    now
  );
  const day = 86_400_000;
  const rows = prs.map((pr) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: pr.author,
    createdAt: pr.createdAt,
    ageDays: Math.floor((now.getTime() - Date.parse(pr.createdAt)) / day),
    behind: behind.has(pr.number) ? behind.get(pr.number) : undefined,
    isDraft: pr.isDraft,
    armed: pr.armed,
    labels: pr.labels,
  }));
  const text = [
    `Open pull requests on ${forge.repo}: ${prs.length} (cap ${cap.max}${cap.atCap ? ', reached' : ''}).`,
    ...(rows.length === 0
      ? []
      : [
          formatColumns(
            rows.map((r) => [
              `  #${r.number}`,
              `${r.ageDays}d`,
              r.behind === undefined ? '' : r.behind === null ? 'behind ?' : `${r.behind} behind`,
              r.author === null ? '' : `@${r.author}`,
              r.armed ? 'armed' : r.isDraft ? 'draft' : '',
              r.title,
            ])
          ),
        ]),
    ...(stuck.length === 0
      ? ['Nothing is stuck.']
      : ['Stuck:', ...stuck.map((s) => `  ${stuckPrompt(s, limits)}`)]),
  ].join('\n');
  return {
    json: {
      repo: forge.repo,
      prCap: cap,
      prs: rows,
      stuck: stuck.map((s) => ({
        number: s.pr.number,
        url: s.pr.url,
        owner: s.owner,
        ageDays: s.ageDays,
        behind: s.behind,
        stale: s.stale,
        farBehind: s.farBehind,
        prompt: stuckPrompt(s, limits),
      })),
    },
    text,
  };
}

/** Commits `pr` is behind its base, or `null` when that cannot be read. */
async function behindOf(
  forge: { behindBy?(base: string, sha: string): Promise<number> },
  pr: OpenPr
) {
  if (forge.behindBy === undefined) return null;
  try {
    return await forge.behindBy(pr.baseRefName, pr.headSha);
  } catch {
    return null;
  }
}
