/**
 * Moving "Only for these repos" into DorkOS (spec `flow-multiproject` §8.5,
 * N6, A9). Before, a kept-out account could list `owner/name` repos in flow's
 * `fleet.json`, and only flow's own routing honoured them. DorkOS now keeps an
 * account to projects itself, for every launch, so each such account moves
 * there once.
 *
 * It runs in the person's browser when they open Settings → Flow, because
 * DorkOS's account rules are changed only by a person, and it says what moved:
 *
 * 1. Each repo is matched to the projects DorkOS knows from that repo
 *    (`originRepo`, ignoring case).
 * 2. With at least one match, DorkOS keeps the account to the matched projects
 *    (added to any it was already kept to), and only then does flow's role
 *    become Rotation with no repos: "kept out, except these repos" and
 *    "rotation, but DorkOS keeps it to these projects" mean the same. DorkOS
 *    first, so a failure between the two leaves the account narrower, never
 *    wider; the next visit finishes it.
 * 3. With no match, nothing changes yet: flow's own rule stays in force.
 * 4. Repos not on this computer yet are remembered, and a later visit adds
 *    each one's project once DorkOS knows it.
 *
 * Kept out with no repos stays kept out: flow never uses it anywhere. A second
 * visit with nothing new changes nothing.
 *
 * @module @dorkos/flow/extension/ui/migrate-repos
 */

import type { FleetView } from '../lib/fleet.ts';
import type { RepoMigration } from '../lib/repo-migration.ts';
import type { AccountPatch } from './api.ts';
import type { AccountEligibility, CoreProject } from './core-api.ts';
import { joinNames } from './account-checkboxes.ts';

/** What the move needs, so tests can stand in for flow and DorkOS. */
export interface MigrationDeps {
  /** Whether DorkOS keeps account rules per project. */
  hasEligibilityRoutes(): Promise<boolean>;
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

/** One line to show at the top of Settings → Flow. */
export interface MigrationLine {
  /** `moved` or `added` went through; `failed` changed nothing (or only half, said so). */
  kind: 'moved' | 'added' | 'failed';
  /** The words. */
  text: string;
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

/**
 * Move every account's repo limits that can move, and say what moved.
 *
 * @param deps - flow's and DorkOS's routes.
 * @returns The lines to show; empty when there was nothing to move.
 */
export async function migrateRepos(deps: MigrationDeps): Promise<MigrationLine[]> {
  if (!(await deps.hasEligibilityRoutes())) return [];
  const fleet = await deps.getFleet();
  const claude = fleet.groups.find((group) => group.runtime === 'claude-code');
  const record = await deps.getRecord();
  const toMove = (claude?.accounts ?? []).filter(
    (account) => account.role === 'kept-out' && account.repos.length > 0
  );
  const pendingKeys = Object.entries(record.accounts)
    .filter(([, move]) => move.pendingRepos.length > 0)
    .map(([key]) => key);
  if (toMove.length === 0 && pendingKeys.length === 0) return [];

  const [projects, eligibility] = await Promise.all([deps.listProjects(), deps.getEligibility()]);
  const keptTo = (id: string) =>
    eligibility.accounts.find((row) => row.id === id)?.onlyProjects ?? null;
  const at = deps.now().toISOString();
  const lines: MigrationLine[] = [];
  const next: RepoMigration = { accounts: { ...record.accounts } };
  let changed = false;

  for (const account of toMove) {
    const matched = account.repos.flatMap((repo) => projectsOf(repo, projects));
    if (matched.length === 0) continue;
    const pending = account.repos.filter((repo) => projectsOf(repo, projects).length === 0);
    const existing = (keptTo(account.id) ?? []).map((project) => project.root);
    const roots = unique([...existing, ...matched.map((project) => project.root)]);
    let dorkosDone = false;
    try {
      await deps.putOnlyProjects(account.id, roots);
      dorkosDone = true;
      await deps.putAccount(account.key, { role: 'rotation', repos: null });
    } catch (failure) {
      const why = failure instanceof Error && failure.message !== '' ? ` ${failure.message}` : '';
      lines.push({
        kind: 'failed',
        text: dorkosDone
          ? `Couldn't finish moving ${account.label}'s repo limits to DorkOS. DorkOS keeps it to ${joinNames(unique(matched.map((p) => p.name)))} now; flow will finish next time.${why}`
          : `Couldn't move ${account.label}'s repo limits to DorkOS. Nothing changed.${why}`,
      });
      continue;
    }
    next.accounts[account.key] = {
      movedRoots: unique(matched.map((project) => project.root)),
      pendingRepos: pending,
      at,
    };
    changed = true;
    const names = joinNames(unique(matched.map((project) => project.name)));
    const waiting =
      pending.length === 0
        ? ''
        : ` ${joinNames(pending)} ${pending.length === 1 ? "isn't" : "aren't"} on this computer yet; ${pending.length === 1 ? 'it' : 'they'} will be added when ${pending.length === 1 ? 'it is' : 'they are'}.`;
    lines.push({
      kind: 'moved',
      text: `Moved to DorkOS: ${account.label} is now only for ${names}.${waiting}`,
    });
  }

  for (const key of pendingKeys) {
    if (toMove.some((account) => account.key === key)) continue;
    const move = record.accounts[key];
    const id = key.startsWith('claude-code:') ? key.slice('claude-code:'.length) : null;
    if (id === null) continue;
    const found = move.pendingRepos.filter((repo) => projectsOf(repo, projects).length > 0);
    if (found.length === 0) continue;
    const kept = keptTo(id);
    if (kept === null) {
      // A person freed the account in Settings → Runtimes since: nothing to add to.
      next.accounts[key] = { ...move, pendingRepos: [], at };
      changed = true;
      continue;
    }
    const added = found.flatMap((repo) => projectsOf(repo, projects));
    try {
      await deps.putOnlyProjects(
        id,
        unique([...kept.map((project) => project.root), ...added.map((project) => project.root)])
      );
    } catch (failure) {
      const why = failure instanceof Error && failure.message !== '' ? ` ${failure.message}` : '';
      lines.push({
        kind: 'failed',
        text: `Couldn't add ${joinNames(found)} to where ${labelOf(fleet, key)} may work. Nothing changed.${why}`,
      });
      continue;
    }
    next.accounts[key] = {
      movedRoots: unique([...move.movedRoots, ...added.map((project) => project.root)]),
      pendingRepos: move.pendingRepos.filter((repo) => !found.includes(repo)),
      at,
    };
    changed = true;
    lines.push({
      kind: 'added',
      text: `Added to DorkOS: ${labelOf(fleet, key)} may now also work in ${joinNames(unique(added.map((project) => project.name)))}.`,
    });
  }

  // The record is a courtesy for later visits: failing to keep it never undoes a move.
  if (changed) await deps.putRecord(next).catch(() => null);
  return lines;
}

/** What flow calls an account, by its key. */
function labelOf(fleet: FleetView, key: string): string {
  for (const group of fleet.groups) {
    const account = group.accounts.find((entry) => entry.key === key);
    if (account !== undefined) return account.label;
  }
  return key.split(':').pop() ?? key;
}
