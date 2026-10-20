/**
 * The board the panel draws, read from GitHub and kept for a short time.
 *
 * Each read asks GitHub for the file and its commits, works out what every
 * commit changed by comparing it with the version before, and answers one
 * {@link BoardView}. GitHub is asked at most once a minute (a person's Retry
 * at most every ten seconds), and callers who ask at the same time share one
 * read. Old versions are read once each, by commit sha, since they never change.
 *
 * The last board that parsed is kept in the extension's storage with the
 * token's expiry, so a bad edit, a lost network or a dead token shows the
 * last good board, dimmed, never a blank panel. The token is read from the
 * secret store on each read and kept in memory only; it is never stored,
 * logged or answered.
 *
 * @module @dorkos/roadmap/extension/lib/board-service
 */

import { diffBoards, type Change } from './changes.ts';
import { GitHubClient, validRepo, type CommitInfo, type FileRead } from './github.ts';
import { parseRoadmap, type Board, type ParseError, type Skipped } from './roadmap.ts';

/** Fresh enough to answer without asking GitHub again. */
export const CACHE_MS = 60_000;
/** The soonest a Retry asks GitHub again. */
export const REFRESH_MIN_MS = 10_000;
/** The most old versions kept in memory. */
const VERSION_CACHE_MAX = 64;
/** The most version reads in flight at once. */
const READ_CONCURRENCY = 4;

/**
 * What the panel shows.
 *
 * - `setup`: no valid repo in the settings yet.
 * - `no-token`: no GitHub token in the settings yet.
 * - `no-file`: the repo has no `roadmap/roadmap.json` the token can see.
 * - `ok`: the board, fresh.
 * - `invalid`: the file does not parse; the last good board, dimmed.
 * - `unreachable`: GitHub refused or did not answer; the last good board, dimmed.
 * - `auth-expired`: the token passed its expiry date; the last good board, dimmed.
 * - `auth-failed`: GitHub refused the token before its expiry date (or with none known).
 */
export type BoardStatus =
  | 'setup'
  | 'no-token'
  | 'no-file'
  | 'ok'
  | 'invalid'
  | 'unreachable'
  | 'auth-expired'
  | 'auth-failed';

/** One commit in the history feed, with what it changed. */
export interface HistoryEntry extends CommitInfo {
  /** Empty when the version before it couldn't be read. */
  changes: Change[];
}

/** The `GET /board` answer. */
export interface BoardView {
  status: BoardStatus;
  /** `owner/name`, or null before setup. */
  repo: string | null;
  /** The board to draw: fresh when `stale` is false, else the last good one. */
  board: Board | null;
  /** Items and asks the board left out, and why. */
  skipped: Skipped[];
  /** True when `board` is the last good copy, not the file as it is now. */
  stale: boolean;
  /** When `board` was read from GitHub. */
  asOf: string | null;
  /** The newest commit that touched the file: what "changed 2h ago by …" names. */
  head: CommitInfo | null;
  /** The commit `board` was read at, for telling a new version from the one on screen. */
  revision: string | null;
  /** The newest commits first. */
  history: HistoryEntry[];
  /** Where the file stops parsing, when `status` is `invalid`. */
  parseError: ParseError | null;
  /** One plain line, such as "GitHub refused (401)", when GitHub refused or was not reached. */
  problem: string | null;
  /** When the token expires, if GitHub has said. */
  tokenExpiresAt: string | null;
  /** The file on github.com. */
  fileUrl: string | null;
  /** When this answer was made. */
  checkedAt: string;
}

/** What the extension keeps in its storage. Never the token. */
interface Stored {
  lastGood?: {
    repo: string;
    board: Board;
    skipped: Skipped[];
    head: CommitInfo | null;
    revision: string | null;
    fileUrl: string | null;
    asOf: string;
  };
  /**
   * Keyed by repo. Set from GitHub's header on every answer that wasn't a 401,
   * and cleared when an answer carries none, so a replaced token never keeps
   * the old one's date.
   */
  tokenExpiresAt?: { repo: string; at: string };
  /** The newest commit the person marked seen. */
  seen?: string;
}

const SHA = /^[0-9a-f]{40}$/;

/** What {@link BoardService} needs from the host. */
export interface BoardServiceOptions {
  /** The fetch to use. */
  fetch: typeof fetch;
  /** The extension's secret store. */
  secrets: { get(key: string): Promise<string | null> };
  /** The extension's settings. */
  settings: { get(key: string): Promise<string | number | boolean | null> };
  /** The extension's storage. */
  storage: {
    loadData<T = unknown>(): Promise<T | null>;
    saveData<T = unknown>(data: T): Promise<void>;
  };
  /** The clock. */
  now?: () => Date;
  /** Where to log. Only fixed words reach it. */
  log?: (message: string) => void;
}

/** One version of the file: a board, `null` when it doesn't parse, or `missing`. */
type Version = Board | null | 'missing';

/** The key secret name. */
export const TOKEN_SECRET = 'github_token';

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Reads the board, keeps it briefly, and remembers the last good one. */
export class BoardService {
  readonly #options: BoardServiceOptions;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  /** The last answer, and what it was read with. The key holds the token in memory only. */
  #cached: { key: string; view: BoardView; at: number } | null = null;
  #inFlight: { key: string; promise: Promise<BoardView> } | null = null;
  /** Old versions by `<repo>@<sha>`. */
  readonly #versions = new Map<string, Version>();
  /** The last storage change, which the next one waits for. */
  #writes: Promise<void> = Promise.resolve();

  /** @param options - The host's stores, a fetch and a clock. */
  constructor(options: BoardServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? ((message) => console.warn(message));
  }

  /**
   * The board, from the cache when it is fresh.
   *
   * @param options - `refresh` asks GitHub again unless it was asked in the last ten seconds.
   * @returns What the panel shows.
   */
  async view(options: { refresh?: boolean } = {}): Promise<BoardView> {
    const repoSetting = await this.#options.settings.get('repo');
    const repo = typeof repoSetting === 'string' ? repoSetting.trim() : '';
    if (!validRepo(repo)) return this.#bare('setup', null);
    const token = (await this.#options.secrets.get(TOKEN_SECRET))?.trim() ?? '';
    if (!token) return this.#bare('no-token', repo);

    const key = `${repo}\n${token}`;
    const now = this.#now().getTime();
    const cached = this.#cached;
    if (cached && cached.key === key) {
      const age = now - cached.at;
      if (age < (options.refresh ? REFRESH_MIN_MS : CACHE_MS)) return cached.view;
    }
    if (this.#inFlight && this.#inFlight.key === key) return this.#inFlight.promise;
    const promise = this.#read(repo, token).then((view) => {
      this.#cached = { key, view, at: now };
      return view;
    });
    this.#inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.#inFlight?.promise === promise) this.#inFlight = null;
    }
  }

  /** An answer with nothing read. */
  #bare(status: BoardStatus, repo: string | null): BoardView {
    return {
      status,
      repo,
      board: null,
      skipped: [],
      stale: false,
      asOf: null,
      head: null,
      revision: null,
      history: [],
      parseError: null,
      problem: null,
      tokenExpiresAt: null,
      fileUrl: null,
      checkedAt: this.#now().toISOString(),
    };
  }

  async #load(): Promise<Stored> {
    try {
      const data = await this.#options.storage.loadData<Stored>();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  /**
   * Change the stored data. Changes run one at a time, each on a fresh read,
   * so a board read and a "Mark seen" never overwrite each other.
   */
  #update(change: (data: Stored) => void): Promise<void> {
    const run = this.#writes.then(async () => {
      const data = await this.#load();
      change(data);
      try {
        await this.#options.storage.saveData(data);
      } catch {
        this.#log('Roadmap: could not save its data');
      }
    });
    // One failed change must never block every later one.
    this.#writes = run.catch(() => {});
    return run;
  }

  /**
   * The newest commit the person marked seen.
   *
   * @returns Its sha, or null when they never have.
   */
  async seen(): Promise<string | null> {
    await this.#writes;
    const seen = (await this.#load()).seen;
    return typeof seen === 'string' && SHA.test(seen) ? seen : null;
  }

  /**
   * Mark the board seen up to a commit.
   *
   * @param sha - A full commit sha.
   * @throws Error when it isn't one.
   */
  async markSeen(sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('seen must be a full commit sha');
    await this.#update((data) => {
      data.seen = sha;
    });
  }

  /** One version of the file, read once per sha. */
  async #version(github: GitHubClient, repo: string, sha: string): Promise<Version | undefined> {
    const key = `${repo}@${sha}`;
    if (this.#versions.has(key)) return this.#versions.get(key);
    const read = await github.readFile(sha);
    let version: Version;
    if (read.kind === 'ok') {
      const parsed = parseRoadmap(read.text);
      version = parsed.ok ? parsed.board : null;
    } else if (read.kind === 'missing') {
      version = 'missing';
    } else {
      return undefined; // Not kept: try again next time.
    }
    this.#versions.set(key, version);
    if (this.#versions.size > VERSION_CACHE_MAX) {
      this.#versions.delete(this.#versions.keys().next().value!);
    }
    return version;
  }

  /** What each commit changed, newest first. */
  async #history(github: GitHubClient, repo: string, commits: CommitInfo[]) {
    const shas = new Set<string>();
    commits.forEach((c, i) => {
      shas.add(c.sha);
      const before = commits[i + 1]?.sha ?? c.parentSha;
      if (before) shas.add(before);
    });
    const list = [...shas];
    const read = await mapLimited(list, READ_CONCURRENCY, (sha) =>
      this.#version(github, repo, sha)
    );
    const versions = new Map(list.map((sha, i) => [sha, read[i]]));
    const beforeShas = commits.map((c, i) => commits[i + 1]?.sha ?? c.parentSha);
    return commits.map((commit, i): HistoryEntry => {
      const after = versions.get(commit.sha);
      const beforeSha = beforeShas[i];
      const before: Version | undefined = beforeSha ? versions.get(beforeSha) : 'missing';
      if (after === undefined || after === 'missing' || before === undefined) {
        return { ...commit, changes: [] };
      }
      if (before === 'missing') return { ...commit, changes: diffBoards(null, after) };
      if (before !== null) return { ...commit, changes: diffBoards(before, after) };
      // The version before didn't parse: this commit fixed the file. Compare it
      // with the last version that did parse, when there is one in reach.
      if (after === null) return { ...commit, changes: [{ kind: 'unreadable' }] };
      const lastGood = beforeShas
        .slice(i + 1)
        .map((sha) => (sha ? versions.get(sha) : undefined))
        .find((v): v is Board => v !== null && v !== undefined && v !== 'missing');
      const changes = lastGood ? diffBoards(lastGood, after) : [];
      return { ...commit, changes: [{ kind: 'fixed' }, ...changes] };
    });
  }

  async #read(repo: string, token: string): Promise<BoardView> {
    const github = new GitHubClient({ fetch: this.#options.fetch, token, repo });
    const stored = await this.#load();
    const [file, commits] = await Promise.all([github.readFile(), github.listCommits()]);
    const now = this.#now();

    // GitHub answered for this token unless the read failed outright or was a
    // 401: then its header (or its absence) is the truth about the expiry.
    const answered =
      file.kind !== 'unreachable' && !(file.kind === 'refused' && file.status === 401);
    const seenExpiry = file.expiresAt ?? commits.expiresAt;
    let expiry = stored.tokenExpiresAt?.repo === repo ? stored.tokenExpiresAt.at : null;
    if (answered) expiry = seenExpiry;
    else if (seenExpiry) expiry = seenExpiry;
    const tokenExpiresAt = expiry;
    let newLastGood: Stored['lastGood'] | undefined;

    const commitList = commits.kind === 'ok' ? commits.commits : [];
    const head = commitList[0] ?? null;
    const history = commits.kind === 'ok' ? await this.#history(github, repo, commitList) : [];
    const lastGood = stored.lastGood?.repo === repo ? stored.lastGood : undefined;
    const view: BoardView = {
      ...this.#bare('ok', repo),
      head,
      history,
      tokenExpiresAt,
      fileUrl: (file.kind === 'ok' ? file.htmlUrl : null) ?? lastGood?.fileUrl ?? null,
    };
    const fallBack = (status: BoardStatus, extra: Partial<BoardView>): BoardView => ({
      ...view,
      status,
      board: lastGood?.board ?? null,
      skipped: lastGood?.skipped ?? [],
      revision: lastGood?.revision ?? null,
      asOf: lastGood?.asOf ?? null,
      stale: lastGood !== undefined,
      ...extra,
    });

    let result: BoardView;
    if (file.kind === 'ok') {
      const parsed = parseRoadmap(file.text);
      if (parsed.ok) {
        result = {
          ...view,
          board: parsed.board,
          skipped: parsed.skipped,
          revision: head?.sha ?? null,
          asOf: now.toISOString(),
        };
        newLastGood = {
          repo,
          board: parsed.board,
          skipped: parsed.skipped,
          head,
          revision: result.revision,
          fileUrl: result.fileUrl,
          asOf: result.asOf!,
        };
      } else {
        result = fallBack('invalid', { parseError: parsed.error });
      }
    } else {
      result = this.#failure(file, fallBack, tokenExpiresAt, now);
    }
    await this.#update((data) => {
      data.tokenExpiresAt = tokenExpiresAt ? { repo, at: tokenExpiresAt } : undefined;
      if (newLastGood) data.lastGood = newLastGood;
    });
    return result;
  }

  /** The answer for a file read that failed. */
  #failure(
    file: Exclude<FileRead, { kind: 'ok' }>,
    fallBack: (status: BoardStatus, extra: Partial<BoardView>) => BoardView,
    tokenExpiresAt: string | null,
    now: Date
  ): BoardView {
    if (file.kind === 'missing') {
      return { ...fallBack('no-file', {}), board: null, skipped: [], stale: false };
    }
    if (file.kind === 'unreachable') {
      this.#log("Roadmap: GitHub didn't answer");
      return fallBack('unreachable', { problem: "GitHub didn't answer" });
    }
    const problem =
      file.status >= 300 && file.status < 400
        ? 'The repo has moved. Update the Repo setting'
        : `GitHub refused (${file.status})`;
    this.#log(`Roadmap: ${problem}`);
    if (file.status === 401) {
      const expired = tokenExpiresAt !== null && now.getTime() >= Date.parse(tokenExpiresAt);
      return fallBack(expired ? 'auth-expired' : 'auth-failed', { problem });
    }
    return fallBack('unreachable', { problem });
  }
}
