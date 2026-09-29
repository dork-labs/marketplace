/**
 * Moving "Only for these repos" into DorkOS (spec `flow-multiproject` §8.5,
 * N6). Before, a kept-out account could list `owner/name` repos in flow's
 * `fleet.json`, and only flow's own routing honoured them. DorkOS now keeps an
 * account to projects itself, for every launch.
 *
 * **Nothing moves by itself, and nothing ever widens.** Opening Settings → Flow
 * only works out, read-only, what could move ({@link planMoves}); each account
 * row then offers it in words, and only a person's click runs it
 * ({@link runMove}):
 *
 * - DorkOS is written only when it has **no rule at all** for the account, and
 *   then to **exactly** the projects the repos match. An account DorkOS already
 *   limits is left alone, and says so: its rule was a person's choice, and
 *   merging lists could let it work somewhere neither side allowed.
 * - flow's own role stays as it was (kept out, only these repos) until every
 *   known project's flow understands DorkOS's rule (behaviour level 2, flow
 *   0.52): an older flow's terminal runs would otherwise spend the account
 *   wherever DorkOS allows. Until then both rules apply. Once every project is
 *   current, a second click lets flow use DorkOS's rule (Rotation).
 * - A repo not on this computer yet is remembered; once it is, the row offers
 *   to add its project, but only while DorkOS's rule is still exactly the one
 *   flow set.
 *
 * @module @dorkos/flow/extension/ui/migrate-repos
 */

import type { FleetAccount, FleetView } from '../lib/fleet.ts';
import type { AccountMove, RepoMigration } from '../lib/repo-migration.ts';
import type { AccountPatch } from './api.ts';
import type { AccountEligibility, CoreProject } from './core-api.ts';
import { joinNames } from './account-checkboxes.ts';

/** The behaviour level whose flow honours DorkOS's account rule in the terminal. */
export const RULE_BEHAVIOUR = 2;

/** Said while an older flow still runs somewhere. */
export const WAITING_FOR_FLOW_TEXT =
  "Until every project runs flow 0.52 or newer, flow keeps its own list too; then a button here lets flow switch to DorkOS's rule.";

/** Said when DorkOS was written but flow could not note the move. */
function unrecordedText(label: string, names: string): string {
  return `DorkOS now keeps ${label} to ${names}, but flow couldn't note that it moved it there. Try again so flow can finish the move later.`;
}

/** What the move needs, so tests can stand in for flow and DorkOS. */
export interface MigrationDeps {
  /** Whether DorkOS keeps account rules per project: yes, no, or it could not be asked. */
  hasEligibilityRoutes(): Promise<boolean | null>;
  /** flow's accounts and their roles. */
  getFleet(): Promise<FleetView>;
  /** Every project DorkOS knows. */
  listProjects(): Promise<CoreProject[]>;
  /** Every Claude account's own rule, as DorkOS holds it. */
  getEligibility(): Promise<AccountEligibility>;
  /** Keep an account to projects (DorkOS, person only). */
  putOnlyProjects(id: string, projects: string[]): Promise<unknown>;
  /** Change an account's role in flow. */
  putAccount(key: string, patch: AccountPatch): Promise<unknown>;
  /** The record of earlier moves. */
  getRecord(): Promise<RepoMigration>;
  /** Store the record. */
  putRecord(record: RepoMigration): Promise<unknown>;
  /** The clock. */
  now(): Date;
}

/** Where one account stands. */
export type MoveKind =
  /** DorkOS has no rule; some repos are here. A click keeps it to exactly those projects. */
  | 'ready'
  /** Moved; flow's own rule is held until every project runs a current flow. */
  | 'held'
  /** Moved, and every project is current now. A click lets flow use DorkOS's rule. */
  | 'finish'
  /** A remembered repo is here now. A click adds its project to the rule flow set. */
  | 'add'
  /** DorkOS already limits the account: nothing to do. */
  | 'core-has-rule'
  /**
   * DorkOS holds exactly the rule a move would set, but flow's note of the move
   * was never saved. A click saves it, so the move can finish later.
   */
  | 'unrecorded'
  /** DorkOS does not list the account: nothing to do. */
  | 'not-in-dorkos';

/** One account row's line. */
export interface MovePlan {
  /** The account's `fleet.json` key. */
  key: string;
  /** Where it stands. */
  kind: MoveKind;
  /** What the row says. */
  text: string;
  /** The button's words, or `null` when there is nothing to click. */
  action: string | null;
}

/** Whether `value` names the same repo as `other`, ignoring case. */
function sameRepo(value: string, other: string | null): boolean {
  return other !== null && value.toLowerCase() === other.toLowerCase();
}

/** The projects a repo became on this computer. */
function projectsOf(repo: string, projects: readonly CoreProject[]): CoreProject[] {
  return projects.filter((project) => sameRepo(repo, project.originRepo));
}

/** `values` without repeats, in order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Whether two lists hold the same roots. */
function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  const left = unique(a).sort();
  const right = unique(b).sort();
  return left.length === right.length && left.every((root, i) => root === right[i]);
}

/** Everything a plan is worked out from. */
interface World {
  fleet: FleetView;
  projects: CoreProject[];
  eligibility: AccountEligibility;
  record: RepoMigration;
  /** Every known project runs a flow that honours DorkOS's rule. */
  allCurrent: boolean;
}

/** One account's situation, with what a click would do. */
interface Situation {
  plan: MovePlan;
  account: FleetAccount;
  matched: CoreProject[];
  pending: string[];
  move: AccountMove | undefined;
}

/** Work out one account's situation, or `null` when there is nothing to say. */
function situationOf(account: FleetAccount, world: World): Situation | null {
  const move = world.record.accounts[account.key];
  const row = world.eligibility.accounts.find((entry) => entry.id === account.id);
  const kept = row?.onlyProjects?.map((project) => project.root) ?? null;
  const matched = account.repos.flatMap((repo) => projectsOf(repo, world.projects));
  const pending = account.repos.filter((repo) => projectsOf(repo, world.projects).length === 0);
  const names = (list: readonly CoreProject[]) => joinNames(unique(list.map((p) => p.name)));
  const plan = (kind: MoveKind, text: string, action: string | null = null) => ({
    plan: { key: account.key, kind, text, action },
    account,
    matched,
    pending,
    move,
  });

  if (account.role === 'kept-out' && account.repos.length > 0) {
    if (row === undefined) {
      return plan(
        'not-in-dorkos',
        `DorkOS doesn't list ${account.label} as a Claude account, so flow keeps its own repo list as it is.`
      );
    }
    if (move?.held === true && kept !== null && sameRoots(kept, move.movedRoots)) {
      const where = joinNames((row.onlyProjects ?? []).map((project) => project.name));
      return world.allCurrent
        ? plan(
            'finish',
            `DorkOS keeps ${account.label} to ${where}, and every project now runs flow 0.52 or newer. Let flow follow DorkOS's rule for ${account.label} too?`,
            'Switch to DorkOS’s rule'
          )
        : plan('held', `DorkOS keeps ${account.label} to ${where}. ${WAITING_FOR_FLOW_TEXT}`);
    }
    const matchedRoots = unique(matched.map((project) => project.root));
    if (
      kept !== null &&
      move === undefined &&
      matched.length > 0 &&
      sameRoots(kept, matchedRoots)
    ) {
      return plan('unrecorded', unrecordedText(account.label, names(matched)), 'Try again');
    }
    if (kept !== null) {
      return plan(
        'core-has-rule',
        `${account.label} already has project limits in DorkOS, so flow keeps its own repo list as it is.`
      );
    }
    if (matched.length === 0) return null;
    const waiting =
      pending.length === 0
        ? ''
        : ` ${joinNames(pending)} ${pending.length === 1 ? "isn't" : "aren't"} on this computer yet.`;
    const later = world.allCurrent ? '' : ` ${WAITING_FOR_FLOW_TEXT}`;
    return plan(
      'ready',
      `Move "Only for these repos" into DorkOS? DorkOS will keep ${account.label} to ${names(matched)}.${waiting}${later}`,
      'Move it'
    );
  }

  if (move !== undefined && move.held !== true && move.pendingRepos.length > 0) {
    const found = move.pendingRepos.filter((repo) => projectsOf(repo, world.projects).length > 0);
    if (found.length === 0 || kept === null || !sameRoots(kept, move.movedRoots)) return null;
    const added = found.flatMap((repo) => projectsOf(repo, world.projects));
    return plan(
      'add',
      `${joinNames(found)} ${found.length === 1 ? 'is' : 'are'} on this computer now. Let DorkOS keep ${account.label} to ${names(added)} too?`,
      'Add it'
    );
  }
  return null;
}

/** Read everything a plan needs, or `null` on a DorkOS without the account rules. */
async function worldOf(deps: MigrationDeps, allCurrent: boolean): Promise<World | null> {
  if ((await deps.hasEligibilityRoutes()) !== true) return null;
  const [fleet, record] = await Promise.all([deps.getFleet(), deps.getRecord()]);
  const claude = fleet.groups.find((group) => group.runtime === 'claude-code');
  const interesting = (claude?.accounts ?? []).some(
    (account) =>
      (account.role === 'kept-out' && account.repos.length > 0) ||
      (record.accounts[account.key]?.pendingRepos.length ?? 0) > 0
  );
  if (!interesting) return null;
  const [projects, eligibility] = await Promise.all([deps.listProjects(), deps.getEligibility()]);
  return { fleet, projects, eligibility, record, allCurrent };
}

/** Every Claude Code account's situation. */
function situations(world: World): Situation[] {
  const claude = world.fleet.groups.find((group) => group.runtime === 'claude-code');
  return (claude?.accounts ?? []).flatMap((account) => situationOf(account, world) ?? []);
}

/**
 * What each account row could offer. Reads only: nothing is written.
 *
 * @param deps - flow's and DorkOS's routes.
 * @param allCurrent - Whether every known project's flow is at {@link RULE_BEHAVIOUR} or above.
 * @returns One plan per account with something to say.
 */
export async function planMoves(deps: MigrationDeps, allCurrent: boolean): Promise<MovePlan[]> {
  const world = await worldOf(deps, allCurrent);
  return world === null ? [] : situations(world).map((entry) => entry.plan);
}

/** What a click came to. */
export interface MoveResult {
  /** Whether it did what the row offered. */
  ok: boolean;
  /** What to say. */
  text: string;
}

/**
 * Do what one account's row offered, after a person clicked it. Everything is
 * read again first, so a click never acts on a stale plan: if the account's
 * situation changed, nothing is written and the new line says why.
 *
 * @param deps - flow's and DorkOS's routes.
 * @param key - The account's `fleet.json` key.
 * @param allCurrent - Whether every known project's flow is current.
 * @returns What happened.
 */
export async function runMove(
  deps: MigrationDeps,
  key: string,
  allCurrent: boolean
): Promise<MoveResult> {
  const world = await worldOf(deps, allCurrent);
  const found = world === null ? undefined : situations(world).find((s) => s.plan.key === key);
  if (world === null || found === undefined || found.plan.action === null) {
    return {
      ok: false,
      text: found?.plan.text ?? 'There is nothing to move for this account now.',
    };
  }
  const { account, matched, pending, move, plan } = found;
  const at = deps.now().toISOString();
  const why = (failure: unknown) =>
    failure instanceof Error && failure.message !== '' ? ` ${failure.message}` : '';
  /** Save flow's note of the move; false when it could not be saved (the move itself stands). */
  const store = async (next: AccountMove): Promise<boolean> =>
    deps.putRecord({ accounts: { ...world.record.accounts, [key]: next } }).then(
      () => true,
      () => false
    );
  const flipToRotation = async (movedRoots: string[], pendingRepos: string[], names: string) => {
    try {
      await deps.putAccount(key, { role: 'rotation', repos: null });
    } catch (failure) {
      await store({ movedRoots, pendingRepos: [], at, held: true });
      return {
        ok: false,
        text: `DorkOS keeps ${account.label} to ${names} now, but flow couldn't switch to DorkOS's rule, so both rules still apply. Try again.${why(failure)}`,
      };
    }
    const noted = await store({ movedRoots, pendingRepos, at, held: false });
    const later =
      noted || pendingRepos.length === 0
        ? ''
        : ` Flow couldn't note ${joinNames(pendingRepos)} for later, so add ${pendingRepos.length === 1 ? 'it' : 'them'} in Settings → Runtimes once ${pendingRepos.length === 1 ? "it's" : "they're"} on this computer.`;
    return {
      ok: true,
      text: `Moved to DorkOS: ${account.label} is now only for ${names}.${later}`,
    };
  };

  if (plan.kind === 'ready') {
    const roots = unique(matched.map((project) => project.root));
    const names = joinNames(unique(matched.map((project) => project.name)));
    try {
      await deps.putOnlyProjects(account.id, roots);
    } catch (failure) {
      return {
        ok: false,
        text: `Couldn't move ${account.label}'s repo limits to DorkOS. Nothing changed.${why(failure)}`,
      };
    }
    if (!allCurrent) {
      if (!(await store({ movedRoots: roots, pendingRepos: [], at, held: true }))) {
        return { ok: false, text: unrecordedText(account.label, names) };
      }
      return {
        ok: true,
        text: `DorkOS now keeps ${account.label} to ${names}, and flow's own repo list stays too. ${WAITING_FOR_FLOW_TEXT}`,
      };
    }
    return flipToRotation(roots, pending, names);
  }

  if (plan.kind === 'unrecorded') {
    const roots = unique(matched.map((project) => project.root));
    const names = joinNames(unique(matched.map((project) => project.name)));
    if (!(await store({ movedRoots: roots, pendingRepos: [], at, held: true }))) {
      return { ok: false, text: unrecordedText(account.label, names) };
    }
    return {
      ok: true,
      text: allCurrent
        ? `DorkOS keeps ${account.label} to ${names}. Flow can now switch to DorkOS's rule.`
        : `DorkOS keeps ${account.label} to ${names}. ${WAITING_FOR_FLOW_TEXT}`,
    };
  }

  if (plan.kind === 'finish') {
    const kept = world.eligibility.accounts.find((row) => row.id === account.id);
    const names = joinNames((kept?.onlyProjects ?? []).map((project) => project.name));
    return flipToRotation(move?.movedRoots ?? [], pending, names);
  }

  // 'add': only while DorkOS's rule is still exactly the one flow set.
  const moved = move!;
  const here = moved.pendingRepos.filter((repo) => projectsOf(repo, world.projects).length > 0);
  const added = here.flatMap((repo) => projectsOf(repo, world.projects));
  const roots = unique([...moved.movedRoots, ...added.map((project) => project.root)]);
  try {
    await deps.putOnlyProjects(account.id, roots);
  } catch (failure) {
    return {
      ok: false,
      text: `Couldn't add ${joinNames(here)} to where ${account.label} may work. Nothing changed.${why(failure)}`,
    };
  }
  const noted = await store({
    movedRoots: roots,
    pendingRepos: moved.pendingRepos.filter((repo) => !here.includes(repo)),
    at,
    held: false,
  });
  return {
    ok: true,
    text: `Added to DorkOS: ${account.label} may now also work in ${joinNames(unique(added.map((p) => p.name)))}.${noted ? '' : " Flow couldn't note it, so it won't offer the rest of the repos here; add them in Settings → Runtimes."}`,
  };
}
