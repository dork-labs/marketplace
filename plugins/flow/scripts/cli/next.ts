/**
 * `flow next [-n N] [--for-project <name|id>]` (spec `flow-cli-core` §6): what
 * to work on next, from the same dispatch oracle `dispatch.ts` runs, with every
 * input built here instead of by hand.
 *
 * - Config, snapshot (tracker or `--snapshot`), and identity: `identity.agent`,
 *   or the tracker's current user when it is `auto`; `identity.reviewer` as set.
 * - Ownership: `classifyOwnership` per item. With `issues` in `ownership.scope`
 *   an item is classified by its assignee (the claim is per item); with only
 *   `projects`, by its project's lead.
 * - WIP load: open items that are `started` and carry `agent/claimed`, counted
 *   by project id and in total, over the whole snapshot.
 * - `--for-project` narrows the candidates (project id, else case-insensitive
 *   name) before dispatch; the WIP load still counts every project.
 * - `-n` (default 1) keeps the first N picks, already capped by WIP.
 * - Paused: exit 7 unless `--manual`. Nothing eligible is still exit 0, with
 *   `atWipCap` saying the WIP cap is what blocks, else `starved` saying whether
 *   a triage pass would help.
 * - The account (spec `flow-handoff-dispatch` §3.5): each pick gains
 *   `account`, the (runtime, account) pair its session should bill, from
 *   `rankAccounts` over every account of every runtime (from the shared
 *   resolver: each runtime's `default` in its machine-wide folder, an alias as
 *   its registered row), their policy and ledgers, the checkout's origin repo, the
 *   implementation model, and the live runs in `flow-state.json`. Picks are
 *   assigned in order and each adds one to its account's live count, so `-n`
 *   spreads work. `--no-account` skips this. No tracker call is added.
 *
 * @module @dorkos/flow/cli/next
 */

import { classifyDispatchOutcome } from '../dispatch-policy.ts';
import {
  chooseAccount,
  itemRuntime,
  rankAccounts,
  type AccountRef,
  type IneligibleAccount,
  type RankableAccount,
  type RankedAccount,
} from '../drain/account-rank.ts';
import { ConfigError, PausedError, PreconditionError, UsageError } from '../errors.ts';
import {
  accountKey,
  loadAccounts,
  loadFleetPolicy,
  parseOriginRepo,
  resolveDorkHome,
  type RuntimeAccount,
} from '../fleet/accounts.ts';
import { readLedger, type RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { handleRuntime } from '../launchers/types.ts';
import { classifyOwnership, type Identity, type OwnershipScope } from '../identity.ts';
import type { BacklogSnapshot, WorkItem, WorkItemProject } from '../tracker/types.ts';
import { AGENT_CLAIMED } from '../work-state.ts';
import { loadProjectConfig, readBacklog, resolveAgentId } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** The live in-progress load the WIP cap measures. */
export interface WipLoad {
  /** Claimed, started items across every project. */
  total: number;
  /** Claimed, started items per project id. */
  byProject: Record<string, number>;
}

/**
 * Count the WIP load: open items that are `started` and carry `agent/claimed`.
 *
 * @param items - Every open item of the snapshot.
 * @returns The total and the per-project counts.
 */
export function wipLoad(items: readonly WorkItem[]): WipLoad {
  const load: WipLoad = { total: 0, byProject: {} };
  for (const item of items) {
    if (item.stateCategory !== 'started' || !item.labels.includes(AGENT_CLAIMED)) continue;
    load.total += 1;
    if (item.project) load.byProject[item.project.id] = (load.byProject[item.project.id] ?? 0) + 1;
  }
  return load;
}

/**
 * Find the project `--for-project` names: by id first, else by name ignoring case.
 *
 * @param snapshot - The pulled snapshot.
 * @param wanted - The flag's value.
 * @returns The project id to keep.
 * @throws {PreconditionError} When no open item's project matches, or the name
 *   matches more than one project.
 */
export function resolveProjectFilter(snapshot: BacklogSnapshot, wanted: string): string {
  const known = new Map<string, WorkItemProject>();
  for (const project of snapshot.projects) known.set(project.id, project);
  for (const item of snapshot.items) if (item.project) known.set(item.project.id, item.project);

  if (known.has(wanted)) return wanted;
  const byName = [...known.values()].filter(
    (project) => project.name.toLowerCase() === wanted.toLowerCase()
  );
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new PreconditionError(
      `more than one project is named "${wanted}"; pass one id: ${byName.map((p) => p.id).join(', ')}`
    );
  }
  throw new PreconditionError(`no open item belongs to a project with the id or name "${wanted}"`);
}

/**
 * Parse `-n`: a whole number of at least 1.
 *
 * @param value - The flag's value, if given.
 * @returns The count, 1 by default.
 * @throws {UsageError} On anything but a positive whole number.
 */
function parseCount(value: string | true | undefined): number {
  if (value === undefined) return 1;
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError('-n (--count) needs a whole number of at least 1');
  }
  return count;
}

/** Why a pick got the account it did. */
export type AccountReason = 'ranked' | 'ambient' | 'cross-runtime' | 'none';

/** The account a pick's session should bill (§3.5), as `flow next --json` shows it. */
export interface ItemAccount {
  /** The item's runtime: its run's, else the first of `fleet.runtimes`, else `claude-code`. */
  runtime: RuntimeSlug;
  /** The (runtime, account) pair, or `null` when no account may take it. */
  pick: AccountRef | null;
  /** Eligible accounts, best first. */
  ranked: RankedAccount[];
  /** Accounts left out, with every reason. */
  ineligible: IneligibleAccount[];
  /**
   * `ranked`: an account of the item's runtime, a standalone `default` in its
   * machine-wide folder included (spec `flow-cli-core` §1.1a rev 6d).
   * `ambient`: OpenCode's ambient `default`, which has no folder and runs in
   * the session's own environment. `cross-runtime`: an account of another runtime
   * (`crossRuntimeFallback: on`). `none`: nothing may take it.
   */
  reason: AccountReason;
  /** The picked account's label, or `null` (for the human text). */
  label: string | null;
}

/** Everything account assignment reads, gathered once per run. */
export interface AssignmentInput {
  /** The moment to judge at. */
  now: Date;
  /** The checkout's `owner/name`, or `null`. */
  repo: string | null;
  /** The implementation model, or `null`. */
  model: string | null;
  /**
   * Every account of every runtime, with policy, windows and spend. `isDefault`
   * marks the account `<runtime>:default` names (rev 6d): an aliased row, or the
   * standalone `default`.
   */
  accounts: readonly (RankableAccount & { label: string | null; isDefault?: boolean })[];
  /** `fleet.runtimes`. */
  runtimes: readonly RuntimeSlug[];
  /** `fleet.crossRuntimeFallback`. */
  crossRuntimeFallback: 'off' | 'on';
  /** Every run in `flow-state.json`, keyed by issue id. */
  runs: Readonly<Record<string, FlowRun>>;
  /** `drain.warnMarginPct` and `drain.maxLivePerAccount`. */
  opts: { warnMarginPct: number; maxLivePerAccount: number };
}

/** `<runtime>:<id>` for a stored account, where no account means the runtime's `default`. */
function liveKey(runtime: string | undefined, account: string | null | undefined): string {
  return `${runtime ?? 'claude-code'}:${account ?? 'default'}`;
}

/**
 * Live sessions per `<runtime>:<id>`: every `running` or `queued` run by its
 * account, plus its drain reviewer's handle by the reviewer's account. A parked
 * drain run counts for nothing. A run or
 * handle with no account bills its runtime's `default` ({@link assignAccounts}
 * folds `<runtime>:default` into the row it aliases).
 *
 * @param runs - Every run, keyed by issue id.
 * @returns The counts.
 */
export function liveByAccount(runs: Readonly<Record<string, FlowRun>>): Record<string, number> {
  const live: Record<string, number> = {};
  const add = (key: string): void => {
    live[key] = (live[key] ?? 0) + 1;
  };
  for (const run of Object.values(runs)) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    // A parked drain run holds no live session (parking stops them).
    if (run.drain?.phase === 'parked') continue;
    add(liveKey(run.runtime, run.account));
    const reviewer = run.drain?.reviewer;
    if (reviewer) add(liveKey(handleRuntime(reviewer), reviewer.account));
  }
  return live;
}

/**
 * Assign each pick its account, in pick order (§3.5). Each assignment adds one
 * to its account's live count, so later picks see it and `-n` spreads work.
 * Pure.
 *
 * @param picked - The picks, in order.
 * @param input - The accounts, runs, repo, model, policy and settings.
 * @returns One assignment per pick.
 */
export function assignAccounts(picked: readonly WorkItem[], input: AssignmentInput): ItemAccount[] {
  // A run or handle with no account (or `default`) bills `default`; when that is
  // an alias, it is its registered row's session (rev 6d), counted under the row.
  const aliasOf = new Map(
    input.accounts
      .filter((a) => a.isDefault === true && !a.implicit)
      .map((a) => [accountKey(a.runtime, 'default'), accountKey(a.runtime, a.id)])
  );
  const canonical = (key: string): string => aliasOf.get(key) ?? key;
  const live: Record<string, number> = {};
  for (const [key, count] of Object.entries(liveByAccount(input.runs))) {
    live[canonical(key)] = (live[canonical(key)] ?? 0) + count;
  }
  const runByItem = new Map(Object.values(input.runs).map((run) => [run.issueId, run]));
  return picked.map((item): ItemAccount => {
    const run = runByItem.get(item.id);
    const runtime = itemRuntime(run?.runtime, input.runtimes);
    const rank = rankAccounts({
      now: input.now,
      repo: input.repo,
      accounts: input.accounts,
      runtime,
      runtimes: input.runtimes,
      crossRuntimeFallback: input.crossRuntimeFallback,
      model: input.model,
      affinity: run?.account ? canonical(liveKey(run.runtime, run.account)) : null,
      exclude: [],
      liveByAccount: live,
      opts: input.opts,
    });
    const choice = chooseAccount({ accounts: input.accounts, rank });
    const base = { runtime, ranked: rank.ranked, ineligible: rank.ineligible };
    if (choice.account === 'none') return { ...base, pick: null, reason: 'none', label: null };
    const chosen = choice.account;
    const key = accountKey(chosen.runtime, chosen.id);
    live[key] = (live[key] ?? 0) + 1;
    const label =
      input.accounts.find((a) => a.runtime === chosen.runtime && a.id === chosen.id)?.label ?? null;
    const reason: AccountReason =
      chosen.runtime !== runtime ? 'cross-runtime' : chosen.path === null ? 'ambient' : 'ranked';
    return { ...base, pick: { runtime: chosen.runtime, id: chosen.id }, reason, label };
  });
}

/**
 * The human suffix for one assignment: ` -> <label or id>`, ` -> ambient
 * account`, or ` -> no account`; another runtime's account is named with its
 * runtime.
 *
 * @param account - The assignment.
 * @returns The suffix, starting with a space.
 */
export function accountSuffix(account: ItemAccount): string {
  if (account.pick === null) return ' -> no account';
  const name =
    account.reason === 'ambient' ? 'ambient account' : (account.label ?? account.pick.id);
  if (account.reason !== 'cross-runtime') return ` -> ${name}`;
  return account.pick.id === 'default' && account.label === null
    ? ` -> ${account.pick.runtime} ambient account`
    : ` -> ${account.pick.runtime}:${name}`;
}

/**
 * The stderr block when a pick has no account: every account's reasons, and
 * the command that allows one.
 *
 * @param repo - The checkout's `owner/name`, or `null`.
 * @param account - The first assignment with no account.
 * @returns The message.
 */
export function noAccountMessage(repo: string | null, account: ItemAccount): string {
  const reasons = account.ineligible
    .map((entry) => `${accountKey(entry.runtime, entry.id)}: ${entry.reasons.join(', ')}`)
    .join('; ');
  return `No account may take work for ${repo ?? 'this checkout (no origin repo)'}: ${reasons || 'no account of this runtime'}. Run \`flow accounts set <id> --role rotation\` to allow one.`;
}

/** The fields of an outcome the human text needs. */
interface NextSummary {
  picked: WorkItem[];
  /** Each pick's account, in pick order; absent with `--no-account`. */
  accounts?: ItemAccount[];
  eligibleCount: number;
  starved: boolean;
  shapeableCount: number;
  /** Nothing is eligible only because work in progress fills the WIP cap. */
  atWipCap: boolean;
  wip: WipLoad;
  wipCap: { global: number; perProject: number };
}

/**
 * Render the human text: the picks as `KEY - Title` with priority and size, or
 * why nothing is eligible.
 *
 * @param summary - The outcome, the WIP load and the cap.
 * @returns The text.
 */
export function renderNext(summary: NextSummary): string {
  const wipLine = `In progress: ${summary.wip.total} (cap ${summary.wipCap.global} in total, ${summary.wipCap.perProject} per project).`;
  if (summary.picked.length === 0) {
    const why = summary.atWipCap
      ? 'Nothing is eligible now: ready work waits because work in progress is at its cap. Finish or release an item first.'
      : summary.starved
        ? `Nothing is eligible, but ${summary.shapeableCount} item(s) wait behind the agent/ready gate: a triage pass would ready them.`
        : 'Nothing is eligible, and nothing waits behind the agent/ready gate: the queue is drained.';
    return [why, wipLine].join('\n');
  }
  const rows = summary.picked.map((item, i) => {
    const account = summary.accounts?.[i];
    const size = item.size === undefined ? 'no size' : `size ${item.size}`;
    return [
      `  ${item.identifier} - ${item.title}`,
      item.priority === undefined || item.priority === 0
        ? 'no priority'
        : `priority ${item.priority}`,
      account === undefined ? size : `${size}${accountSuffix(account)}`,
    ];
  });
  return [
    `Next (${summary.picked.length} of ${summary.eligibleCount} eligible):`,
    formatColumns(rows),
    wipLine,
  ].join('\n');
}

/** What {@link planNext} is asked for. */
export interface PlanRequest {
  /** How many picks to keep. */
  count: number;
  /** `--for-project`: only items of this project (id, or name in any case). */
  forProject?: string;
  /**
   * `flow drain --items`: only these identifiers, picked in this order (still
   * subject to the dispatch policy and the WIP cap).
   */
  items?: readonly string[];
  /** Whether to assign each pick its account (`--no-account` turns it off). */
  accounts: boolean;
}

/** What {@link planNext} found. */
export interface NextPlan {
  /** The picks, in order. */
  picked: WorkItem[];
  /** Each pick's account, in pick order; absent when accounts were not asked for or nothing was picked. */
  accounts?: ItemAccount[];
  /** The dispatch outcome over the candidates. */
  outcome: ReturnType<typeof classifyDispatchOutcome>;
  /** Nothing is eligible only because work in progress fills the WIP cap. */
  atWipCap: boolean;
  /** The WIP load. */
  wip: WipLoad;
  /** The checkout's `owner/name`, when accounts were assigned. */
  repo: string | null;
  /** What accounts were assigned from (with each account's path), when they were. */
  assignment?: AssignmentInput;
}

/**
 * The shared half of `flow next` and `flow drain`'s slot filling (spec
 * `flow-handoff-dispatch` §4.2 step 4): pull the backlog, rank it with the
 * dispatch policy, keep the first `count` picks, and assign each its account.
 * Config warnings are flushed; the no-account message is left to the caller.
 *
 * @param ctx - The verb's context.
 * @param project - The loaded project config.
 * @param request - The count, filters and whether to assign accounts.
 * @returns The picks, their accounts and the dispatch signals.
 */
export async function planNext(
  ctx: VerbContext,
  project: ReturnType<typeof loadProjectConfig>,
  request: PlanRequest
): Promise<NextPlan> {
  const { config } = project.loaded;
  const snapshot = await readBacklog(ctx, project.adapter);
  const identity: Identity = {
    agent: await resolveAgentId(project),
    reviewer: config.identity.reviewer,
    marker: config.identity.marker,
  };
  project.flushWarnings();

  const scope: OwnershipScope = config.ownership.scope.includes('issues') ? 'issues' : 'projects';
  const wip = wipLoad(snapshot.items);
  const projectId =
    request.forProject === undefined
      ? undefined
      : resolveProjectFilter(snapshot, request.forProject);
  const wanted = request.items === undefined ? undefined : new Set(request.items);
  const candidates = snapshot.items.filter(
    (item) =>
      (projectId === undefined || item.project?.id === projectId) &&
      (wanted === undefined || wanted.has(item.identifier))
  );

  const ownershipOf = Object.fromEntries(
    candidates.map((item) => [item.identifier, classifyOwnership(item, identity, scope)])
  );
  const outcome = classifyDispatchOutcome(
    candidates,
    { dispatch: config.dispatch, ownership: config.ownership, wipCap: config.autonomy.wipCap },
    { ownershipOf, inProgressByProject: wip.byProject, inProgressTotal: wip.total }
  );

  // Starvation counts claimed in-flight items as shapeable, so a full WIP cap
  // also reads as "starved". Rank again with no cap: if that finds work, the
  // cap is the only thing in the way, and triage would not help.
  const uncapped = classifyDispatchOutcome(
    candidates,
    {
      dispatch: config.dispatch,
      ownership: config.ownership,
      wipCap: { global: Infinity, perProject: Infinity },
    },
    { ownershipOf, inProgressByProject: wip.byProject, inProgressTotal: wip.total }
  );
  const atWipCap = outcome.eligibleCount === 0 && uncapped.eligibleCount > 0;

  const order = request.items;
  const ranked =
    order === undefined
      ? outcome.picked
      : [...outcome.picked].sort(
          (a, b) => order.indexOf(a.identifier) - order.indexOf(b.identifier)
        );
  const picked = ranked.slice(0, request.count);
  let accounts: ItemAccount[] | undefined;
  let assignment: AssignmentInput | undefined;
  if (request.accounts && picked.length > 0) {
    assignment = await gatherAssignmentInput(ctx, config);
    accounts = assignAccounts(picked, assignment);
  }
  return { picked, accounts, outcome, atWipCap, wip, repo: assignment?.repo ?? null, assignment };
}

/**
 * Run `flow next`.
 *
 * @param ctx - The verb's context.
 * @returns The picks and the starvation signals.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const count = parseCount(ctx.args.flags.count);
  const project = loadProjectConfig(ctx);
  const { config, paused } = project.loaded;
  if (paused !== null && !ctx.manual) {
    project.flushWarnings();
    throw new PausedError(
      `flow is paused${paused.pausedAt ? ` (since ${paused.pausedAt})` : ''}; /flow:resume lifts it, or pass --manual when a person is driving`
    );
  }

  const plan = await planNext(ctx, project, {
    count,
    forProject:
      typeof ctx.args.flags['for-project'] === 'string' ? ctx.args.flags['for-project'] : undefined,
    accounts: ctx.args.flags['no-account'] !== true,
  });
  const { picked, accounts, outcome, atWipCap, wip } = plan;
  const blocked = accounts?.find((account) => account.pick === null);
  if (blocked !== undefined) ctx.warn(noAccountMessage(plan.repo, blocked));
  return {
    json: {
      picked:
        accounts === undefined
          ? picked
          : picked.map((item, i) => ({ ...item, account: jsonAccount(accounts[i]) })),
      eligibleCount: outcome.eligibleCount,
      starved: outcome.starved,
      shapeableCount: outcome.shapeableCount,
      atWipCap,
      wip,
    },
    text: renderNext({
      ...outcome,
      picked,
      accounts,
      atWipCap,
      wip,
      wipCap: config.autonomy.wipCap,
    }),
  };
}

/** The JSON shape of one assignment: `{ runtime, pick, ranked, ineligible, reason }`. */
function jsonAccount(account: ItemAccount): Omit<ItemAccount, 'label'> {
  const { runtime, pick, ranked, ineligible, reason } = account;
  return { runtime, pick, ranked, ineligible, reason };
}

/** The project config `flow next` reads. */
export type NextConfig = ReturnType<typeof loadProjectConfig>['loaded']['config'];

/**
 * Read what account assignment needs: the registry, `fleet.json` and each
 * account's ledger under `<dorkHome>` (warnings go to stderr), the checkout's
 * origin, and the run store. A folder that is not a git checkout has no origin
 * and no run store, and assigns from the registry alone.
 *
 * @param ctx - The verb's context.
 * @param config - The project config.
 * @returns The assignment input.
 */
export async function gatherAssignmentInput(
  ctx: VerbContext,
  config: NextConfig
): Promise<AssignmentInput> {
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const registry = loadAccounts(dorkHome, { home: ctx.io.osHome });
  for (const warning of registry.warnings) ctx.warn(warning.message);
  const policy = loadFleetPolicy(dorkHome, registry.accounts);
  for (const warning of policy.warnings) ctx.warn(warning.message);

  const accounts = registry.accounts.flatMap((account: RuntimeAccount) => {
    const resolved = policy.accounts.find(
      (entry) => entry.runtime === account.runtime && entry.id === account.id
    );
    if (resolved === undefined) return [];
    const ledger =
      account.ledgerId === null ? null : readLedger(dorkHome, account.runtime, account.ledgerId);
    for (const warning of ledger?.warnings ?? []) ctx.warn(warning.message);
    return [
      {
        runtime: account.runtime,
        id: account.id,
        path: account.path,
        implicit: account.implicit,
        isDefault: account.isDefault,
        routable: account.routable,
        policy: resolved,
        windows: ledger?.ledger?.windows ?? null,
        spend: ledger?.ledger?.spend,
        label: account.label,
      },
    ];
  });

  const origin = await ctx.runProcess('git', ['remote', 'get-url', 'origin'], {
    cwd: ctx.projectDir,
  });
  let runs: Record<string, FlowRun> = {};
  try {
    runs = openFlowStateFile(ctx.projectDir).read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  const model = config.models.bindings[config.models.tiers.implementation] ?? null;
  return {
    now: ctx.now(),
    repo: origin.code === 0 ? parseOriginRepo(origin.stdout) : null,
    model,
    accounts,
    runtimes: policy.runtimes,
    crossRuntimeFallback: policy.crossRuntimeFallback,
    runs,
    opts: {
      warnMarginPct: config.drain.warnMarginPct,
      maxLivePerAccount: config.drain.maxLivePerAccount,
    },
  };
}
