/**
 * The dashboard's server side (spec "Flow Dashboard", M1): which project a page
 * shows, what each of its sources is, and the 5-minute timer. Reads only: it
 * never writes to the tracker or to GitHub.
 *
 * - **Which projects:** every flow project whose config has a `dashboard`
 *   block (`scripts/dashboard-config.ts`). A page names one with `?project=`;
 *   without it, the first such project by name.
 * - **Issues:** each team in `teams` (empty: the project's own team) and each
 *   repository in `repos`. A team is read from the copy of the tracker flow's
 *   tracker reads already keep (`tracker-reads.ts`, `snapshot.json`), so the
 *   dashboard adds no tracker call. That copy holds the project's own team
 *   only: `flow snapshot` reads the team in `connection.team`, so any other
 *   team says it cannot be read yet.
 * - **Pull requests:** each repository, one `gh` call each.
 * - **Releases:** each product: one `gh` call for its repository, one per
 *   watched workflow, and the local checkout when the product's repository is
 *   this project's `origin`.
 * - **Freshness:** a page that asks reads again when its last read is over a
 *   minute old; the timer reads every page of every project with a dashboard
 *   every 5 minutes, one project at a time.
 *
 * @module @dorkos/flow/extension/dashboard/service
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  linkKeysOf,
  readProjectDashboard,
  type DashboardProduct,
  type DashboardRead,
} from '../../../../../scripts/dashboard-config.ts';
import type { GithubReads } from '../../../../../scripts/forge/github.ts';
import { forgeTargetFor } from '../../../../../scripts/forge/types.ts';
import { RouteError } from '../fleet.ts';
import type { FlowProjectEntry } from '../projects.ts';
import { projectIdOf } from '../tracker-reads.ts';
import {
  DASHBOARD_REFRESH_MS,
  DASHBOARD_STALE_ON_VIEW_MS,
  DashboardCache,
  type CachedPage,
  type SourcePlan,
} from './cache.ts';
import {
  countUnreleased,
  githubIssues,
  readVersion,
  releaseOf,
  toDashboardPr,
  trackerIssues,
} from './parse.ts';
import {
  DASHBOARD_KINDS,
  type DashboardBody,
  type DashboardIndex,
  type DashboardIssue,
  type DashboardKind,
  type DashboardPr,
  type DashboardRelease,
} from './types.ts';

/** Said for a team other than the project's own: `flow snapshot` reads one team. */
export function otherTeamText(own: string | null): string {
  return own === null
    ? "Flow reads only this project's own team, and none is set."
    : `Flow reads only this project's own team (${own}) so far.`;
}

/** Said before the tracker reads have left a copy of the tracker. */
export const NOT_READ_YET_TEXT = "Flow hasn't read the tracker yet. Try again in a minute.";

/**
 * Said for a project the dashboard asks about by a name flow does not know.
 *
 * @param name - The name asked for.
 * @returns The words.
 */
export function unknownDashboardProjectText(name: string): string {
  return `No flow project is called ${name} on this computer.`;
}

/** What the service needs. */
export interface DashboardServiceDeps {
  /** The DorkOS home, for the cache and flow's tracker copy. */
  dorkHome: string;
  /** Every flow project now. */
  projects: () => Promise<FlowProjectEntry[]>;
  /** Whether a person allowed a project's own tracker adapter. */
  adapterAllowed: (entry: FlowProjectEntry) => Promise<boolean>;
  /** Ask the tracker reads to read a project soon. */
  viewTracker: (root: string) => void;
  /** The GitHub reads. */
  reads: GithubReads;
  /** The `origin` URL of a checkout, or `null`. */
  originOf: (root: string) => string | null;
  /** The clock. */
  now: () => Date;
  /** Where to log. */
  log: (message: string) => void;
  /** Whether this DorkOS lets a person ask for a fresh read (it has the person guard). */
  canRefresh: boolean;
}

/** One project with its block. */
interface Dashboarded {
  entry: FlowProjectEntry;
  read: DashboardRead;
}

/** The dashboard's server side. */
export class DashboardService {
  private readonly cache: DashboardCache;
  private readonly origins = new Map<string, string | null>();
  private ticking = false;
  private disposed = false;

  /**
   * @param deps - The projects, the reads, the clock and a logger.
   */
  constructor(private readonly deps: DashboardServiceDeps) {
    this.cache = new DashboardCache({ dorkHome: deps.dorkHome, now: deps.now, log: deps.log });
  }

  /** Every flow project with its block, by name. */
  private async all(): Promise<Dashboarded[]> {
    const entries = await this.deps.projects();
    return entries.map((entry) => ({ entry, read: readProjectDashboard(entry.root) }));
  }

  /**
   * Every flow project and the pages it has on.
   *
   * @returns The `GET /dashboard` body.
   */
  async index(): Promise<DashboardIndex> {
    return {
      projects: (await this.all()).map(({ entry, read }) => ({
        name: entry.name,
        configured: read.configured,
        views: read.settings.views,
      })),
    };
  }

  /** The project a page asks for: by name, else the first with a dashboard. */
  private async pick(name: unknown): Promise<{ all: Dashboarded[]; chosen: Dashboarded | null }> {
    const all = await this.all();
    if (typeof name === 'string' && name !== '') {
      const chosen = all.find(({ entry }) => entry.name === name);
      if (chosen === undefined) throw new RouteError(404, unknownDashboardProjectText(name));
      return { all, chosen };
    }
    return { all, chosen: all.find(({ read }) => read.configured) ?? null };
  }

  /**
   * One page of one project, read again first when its last read is over a minute old.
   *
   * @param kind - The page.
   * @param project - The project's name, or nothing for the first with a dashboard.
   * @returns The page's body.
   */
  async view(kind: DashboardKind, project: unknown): Promise<DashboardBody<unknown>> {
    return this.answer(kind, project, (chosen) =>
      this.cache.fresh(
        chosen.entry.root,
        kind,
        () => this.plans(kind, chosen),
        DASHBOARD_STALE_ON_VIEW_MS
      )
    );
  }

  /**
   * Read a page now (a person pressed Refresh), and answer it.
   *
   * @param kind - The page.
   * @param project - The project's name.
   * @returns The page's body.
   */
  async refresh(kind: unknown, project: unknown): Promise<DashboardBody<unknown>> {
    if (!DASHBOARD_KINDS.includes(kind as DashboardKind)) {
      throw new RouteError(400, 'Refresh issues, prs or releases.');
    }
    const page = kind as DashboardKind;
    return this.answer(page, project, (chosen) => {
      if (page === 'issues') this.deps.viewTracker(chosen.entry.root);
      return this.cache.refresh(chosen.entry.root, page, this.plans(page, chosen));
    });
  }

  /** Build a page's body, reading through `read` only when the page is on. */
  private async answer(
    kind: DashboardKind,
    project: unknown,
    read: (chosen: Dashboarded) => Promise<CachedPage<unknown>>
  ): Promise<DashboardBody<unknown>> {
    const { all, chosen } = await this.pick(project);
    const projects = all.filter(({ read: r }) => r.configured).map(({ entry }) => entry.name);
    const body: DashboardBody<unknown> = {
      project: chosen?.entry.name ?? null,
      projects,
      configured: chosen?.read.configured ?? false,
      views: chosen?.read.settings.views ?? [],
      problems: chosen?.read.problems ?? [],
      sources: [],
      items: [],
      viewer: null,
      teams: [],
      repos: [],
      canRefresh: this.deps.canRefresh,
    };
    if (chosen === null || !chosen.read.configured || !body.views.includes(kind)) return body;
    const page = await read(chosen);
    body.sources = page.sources.map(({ id, label, fetchedAt, error, note }) => ({
      id,
      label,
      fetchedAt,
      error,
      note,
    }));
    body.items = page.sources.flatMap((source) => source.items);
    body.viewer = page.sources.find((source) => source.viewer !== null)?.viewer ?? null;
    const settings = chosen.read.settings;
    body.teams = kind === 'issues' ? this.teamsOf(chosen) : [];
    body.repos =
      kind === 'releases'
        ? [...new Set(settings.products.map((product) => product.repo))]
        : settings.repos;
    return body;
  }

  /** The teams a project's Issues page lists: its block's, else its own. */
  private teamsOf({ entry, read }: Dashboarded): string[] {
    if (read.settings.teams.length > 0) return read.settings.teams;
    const own = entry.tracker?.team ?? null;
    return own === null ? [] : [own];
  }

  /** A page's sources. */
  private plans(kind: DashboardKind, chosen: Dashboarded): SourcePlan<unknown>[] {
    if (kind === 'issues') return this.issuePlans(chosen);
    if (kind === 'prs') return this.prPlans(chosen);
    return this.releasePlans(chosen);
  }

  /** The Issues page's sources: each team, then each repository. */
  private issuePlans(chosen: Dashboarded): SourcePlan<DashboardIssue>[] {
    const { entry, read } = chosen;
    const own = entry.tracker?.team ?? null;
    const teams: SourcePlan<DashboardIssue>[] = this.teamsOf(chosen).map((team) => ({
      id: `tracker:${team}`,
      label: team,
      read: async () => {
        if (team !== own) throw new Error(otherTeamText(own));
        const blocked = await this.trackerBlocked(entry);
        if (blocked !== null) throw new Error(blocked);
        const file = path.join(this.deps.dorkHome, 'flow', 'cache', projectIdOf(entry.root), 'snapshot.json');
        let snapshot: unknown;
        try {
          snapshot = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          this.deps.viewTracker(entry.root);
          throw new Error(NOT_READ_YET_TEXT);
        }
        return trackerIssues(snapshot, team);
      },
    }));
    const repos: SourcePlan<DashboardIssue>[] = read.settings.repos.map((repo) => ({
      id: `github:${repo}`,
      label: repo,
      read: async () => {
        const list = await this.deps.reads.openIssues(repo);
        return {
          items: githubIssues(list, repo),
          note: shownOf(list.issues.length, list.total),
          viewer: list.viewer,
        };
      },
    }));
    return [...teams, ...repos];
  }

  /** Why flow cannot read a project's tracker from here, or `null` when it can. */
  private async trackerBlocked(entry: FlowProjectEntry): Promise<string | null> {
    const tracker = entry.tracker;
    if (entry.setup !== 'ready' || tracker === null) return "Flow isn't set up in this project.";
    if (tracker.transport === 'mcp') {
      return 'This project reaches its tracker over MCP, so only a chat can read it.';
    }
    if (tracker.adapter === 'project' && !(await this.deps.adapterAllowed(entry))) {
      return "Allow this project's own tracker adapter on its Flow page first.";
    }
    if (tracker.adapter === 'other') return "Flow can't run this project's tracker adapter here.";
    return null;
  }

  /** The PRs page's sources: each repository. */
  private prPlans({ entry, read }: Dashboarded): SourcePlan<DashboardPr>[] {
    const keys = linkKeysOf(read.settings, entry.tracker?.team ?? null);
    return read.settings.repos.map((repo) => ({
      id: `github:${repo}`,
      label: repo,
      read: async () => {
        const list = await this.deps.reads.openPrs(repo);
        return {
          items: list.prs.map((pr) => toDashboardPr(pr, repo, list.viewer, keys)),
          note: shownOf(list.prs.length, list.total),
          viewer: list.viewer,
        };
      },
    }));
  }

  /** The Releases page's sources: each product. */
  private releasePlans({ entry, read }: Dashboarded): SourcePlan<DashboardRelease>[] {
    return read.settings.products.map((product) => ({
      id: `product:${product.id}`,
      label: product.id,
      read: async () => {
        const state = await this.deps.reads.releaseState(product.repo);
        const workflows: { name: string; run: Awaited<ReturnType<GithubReads['latestRun']>>; error: string | null }[] = [];
        for (const name of product.watchWorkflows) {
          try {
            workflows.push({ name, run: await this.deps.reads.latestRun(product.repo, name), error: null });
          } catch (error) {
            workflows.push({ name, run: null, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { items: [releaseOf({ product, state, local: this.local(entry, product), workflows })] };
      },
    }));
  }

  /** What this project's checkout says about a product, when it is the product's repository. */
  private local(entry: FlowProjectEntry, product: DashboardProduct) {
    if (this.repoOf(entry.root) !== product.repo.toLowerCase()) {
      return {
        checkout: false,
        fileVersion: null,
        unreleased: null,
        unreleasedNote: `No local checkout of ${product.repo} here.`,
      };
    }
    const unreleased = countUnreleased(path.join(entry.root, product.unreleased));
    return {
      checkout: true,
      fileVersion: readVersion(path.join(entry.root, product.versionFile)),
      unreleased,
      unreleasedNote: unreleased === null ? `No folder ${product.unreleased} in this checkout.` : null,
    };
  }

  /** A checkout's GitHub repository, lowercased, from its `origin`; asked once per root. */
  private repoOf(root: string): string | null {
    if (!this.origins.has(root)) {
      const url = this.deps.originOf(root);
      let repo: string | null = null;
      try {
        repo = url === null ? null : forgeTargetFor(url, {}).repo.toLowerCase();
      } catch {
        repo = null;
      }
      this.origins.set(root, repo);
    }
    return this.origins.get(root) ?? null;
  }

  /**
   * The timer: read each page of each project with a dashboard whose last
   * read is 5 minutes old, one project at a time. A tick still running is not
   * doubled.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      for (const chosen of await this.all()) {
        if (!chosen.read.configured) continue;
        for (const kind of DASHBOARD_KINDS) {
          if (this.disposed) return;
          if (!chosen.read.settings.views.includes(kind)) continue;
          await this.cache.fresh(chosen.entry.root, kind, () => this.plans(kind, chosen), DASHBOARD_REFRESH_MS);
        }
      }
    } catch (error) {
      this.deps.log(`[flow] could not refresh the dashboard: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Stop the timer's reads. */
  dispose(): void {
    this.disposed = true;
  }
}

/** "Showing 50 of 120" when a list was cut short, else `null`. */
function shownOf(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total}` : null;
}
