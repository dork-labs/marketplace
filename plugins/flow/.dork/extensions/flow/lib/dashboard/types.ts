/**
 * What the dashboard's routes answer (spec "Flow Dashboard", M1): the shapes
 * the server half writes and the pages read, and the list of pages with data.
 *
 * @module @dorkos/flow/extension/dashboard/types
 */

import type { DashboardView } from '../../../../../scripts/dashboard-config.ts';

export type { DashboardView } from '../../../../../scripts/dashboard-config.ts';

/** One dashboard page's data. */
export type DashboardKind = 'issues' | 'prs' | 'releases';

/** Every page with data, in the order they are shown. */
export const DASHBOARD_KINDS: readonly DashboardKind[] = ['issues', 'prs', 'releases'];

/** Where one part of a page's data comes from, and how fresh it is. */
export interface SourceStatus {
  /** `tracker:<team>`, `github:<owner/name>` or `product:<id>`. */
  id: string;
  /** What to call it: the team key, the repository, the product. */
  label: string;
  /** When it was last read, or `null` before a read worked. */
  fetchedAt: string | null;
  /** Why the last read failed, or `null` when it worked. */
  error: string | null;
  /** Something else worth saying, such as "Showing 50 of 120", or `null`. */
  note: string | null;
}

/** Where an item sits, the same words for every tracker. */
export type IssueState = 'backlog' | 'todo' | 'in-progress';

/** One open issue, from the tracker or from GitHub. */
export interface DashboardIssue {
  /** Unique across the page: the key. */
  id: string;
  /** The source it came from. */
  source: string;
  /** `ACME-12`, or `owner/name#7`. */
  key: string;
  /** Its title, as written (rendered as text, never as HTML). */
  title: string;
  /** Where it sits. */
  state: IssueState;
  /** The tracker's own name for the state. */
  stateName: string;
  /** The team it belongs to, for a tracker item. */
  team: string | null;
  /** The repository, for a GitHub issue. */
  repo: string | null;
  /** Where to open it, or `null`. */
  url: string | null;
  /** Who it is assigned to, when the source names people. */
  assignee: string | null;
  /** Its labels. */
  labels: string[];
  /** An agent asked a person about it, or it is assigned to you. */
  waitingOnYou: boolean;
  /** When it was opened, or `null`. */
  createdAt: string | null;
}

/** One open pull request. */
export interface DashboardPr {
  /** `owner/name#n`. */
  id: string;
  /** The source it came from. */
  source: string;
  /** The repository. */
  repo: string;
  /** The PR number. */
  number: number;
  /** Its title, as written (rendered as text). */
  title: string;
  /** Where to open it, or `null`. */
  url: string | null;
  /** Who opened it. */
  author: string | null;
  /** Whether it is a draft. */
  draft: boolean;
  /** Its checks. */
  checks: {
    state: 'passing' | 'failing' | 'pending' | 'none';
    failing: { name: string; url: string | null }[];
    pending: number;
    total: number;
  };
  /** Its review state. */
  review: 'approved' | 'changes-requested' | 'review-required' | 'none';
  /** Whether a review is asked of you by name. */
  reviewRequestedFromYou: boolean;
  /** Its place in the merge queue, and whether auto-merge is armed. */
  queue: { queued: boolean; position: number | null; armed: boolean };
  /** Whether it conflicts with its base. */
  conflicting: boolean;
  /** The tracker ids it names, from its title, description and branch. */
  linked: string[];
  /** When it was opened. */
  createdAt: string | null;
  /** A review is asked of you, or it is yours and stuck (changes asked, failing, conflicting). */
  waitingOnYou: boolean;
}

/** One watched workflow's latest run. */
export interface WatchedWorkflow {
  /** The workflow's name, or the file asked for when it never ran. */
  name: string;
  /** How its latest run went. */
  state: 'passing' | 'failing' | 'running' | 'never' | 'error';
  /** The run's address. */
  url: string | null;
  /** When the run started. */
  at: string | null;
  /** Why it could not be read. */
  error: string | null;
}

/** One product's release state. */
export interface DashboardRelease {
  /** The product id. */
  id: string;
  /** The source it came from. */
  source: string;
  /** The repository it is released from. */
  repo: string;
  /** The latest published release. */
  lastRelease: { tag: string; publishedAt: string | null; url: string | null } | null;
  /** The newest tag, which may be newer than the release. */
  lastTag: string | null;
  /** The released version: the release's tag without a leading `v`. */
  version: string | null;
  /** The version in `versionFile` in the local checkout, or `null`. */
  fileVersion: string | null;
  /** Whether the repository has a local checkout here. */
  checkout: boolean;
  /** How many changes wait in `unreleased`, or `null` when it cannot be counted. */
  unreleased: number | null;
  /** Why it cannot be counted, or `null`. */
  unreleasedNote: string | null;
  /** The checks on the default branch. */
  ci: { branch: string | null; state: 'passing' | 'failing' | 'pending' | 'none' };
  /** Each watched workflow. */
  workflows: WatchedWorkflow[];
}

/** One project with a dashboard, for the pages' project picker and Flow home's links. */
export interface DashboardProjectRef {
  /** Core's name for the project. */
  name: string;
  /** Whether its config has a `dashboard` block. */
  configured: boolean;
  /** Which pages are on. */
  views: DashboardView[];
}

/** `GET /dashboard`. */
export interface DashboardIndex {
  /** Every flow project, by name. */
  projects: DashboardProjectRef[];
}

/** `GET /dashboard/<kind>`, and `POST /dashboard/refresh`. */
export interface DashboardBody<T> {
  /** The project shown, or `null` when no project has a dashboard. */
  project: string | null;
  /** Every project with a dashboard, by name. */
  projects: string[];
  /** Whether this project's config has a `dashboard` block. */
  configured: boolean;
  /** Which pages are on in this project. */
  views: DashboardView[];
  /** What is wrong in the block; each wrong entry was left out. */
  problems: string[];
  /** Each source and how fresh it is. */
  sources: SourceStatus[];
  /** The items, every source's together. */
  items: T[];
  /** The `gh` sign-in "waiting on you" is about, or `null`. */
  viewer: string | null;
  /** The teams the filter offers. */
  teams: string[];
  /** The repositories the filter offers. */
  repos: string[];
  /** Whether this DorkOS lets a person ask for a fresh read. */
  canRefresh: boolean;
}
