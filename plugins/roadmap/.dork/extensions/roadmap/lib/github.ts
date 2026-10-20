/**
 * The extension's only way out: two GitHub REST reads, both about one file.
 *
 * - `GET /repos/{repo}/contents/roadmap/roadmap.json[?ref=<sha>]`
 * - `GET /repos/{repo}/commits?path=roadmap/roadmap.json`
 *
 * The path is fixed here and never comes from a caller. The repo is checked to
 * be `owner/name`, and a ref must be a full commit sha. The token goes in the
 * `Authorization` header and nowhere else: every answer is reduced to plain
 * data and a status, so no header, token or GitHub error text reaches a caller,
 * a response or a log line.
 *
 * @module @dorkos/roadmap/extension/lib/github
 */

import { cleanText } from './roadmap.ts';

/** The one file this extension reads. Never taken from a request. */
export const ROADMAP_PATH = 'roadmap/roadmap.json';

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** How many commits the history reads. */
export const HISTORY_LENGTH = 20;
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Whether a repo setting is `owner/name` and nothing more.
 *
 * @param repo - The setting.
 * @returns True when it is safe to put in a GitHub URL.
 */
export function validRepo(repo: unknown): repo is string {
  if (typeof repo !== 'string') return false;
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length > 0 || owner === undefined || name === undefined) return false;
  return OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * Read GitHub's `github-authentication-token-expiration` header
 * (`2030-01-20 12:00:00 UTC`, or with a `-0800` offset).
 *
 * @param header - The header's value, or null.
 * @returns The moment as an ISO string, or null when it can't be read.
 */
export function parseExpiry(header: string | null): string | null {
  if (!header) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(header.trim());
  if (!match) return null;
  const zone = match[3] === 'UTC' ? 'Z' : `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** One commit that touched the file. */
export interface CommitInfo {
  sha: string;
  /** The first parent, or null for a root commit. */
  parentSha: string | null;
  /** The commit's page on github.com, or null when GitHub sent something else. */
  url: string | null;
  /** The git author's name (or GitHub login), as plain text. */
  author: string;
  /** ISO time the change was authored. */
  date: string;
  /** The commit subject: the reason for the change. Null when there is none. */
  reason: string | null;
}

/** How a read ended, beyond its data. */
export type Failure =
  { kind: 'missing' } | { kind: 'refused'; status: number } | { kind: 'unreachable' };

/** What every read answers with: the token's expiry, when GitHub said. */
interface Answer {
  expiresAt: string | null;
}

/** What {@link GitHubClient.readFile} answers. */
export type FileRead = Answer & ({ kind: 'ok'; text: string; htmlUrl: string | null } | Failure);

/** What {@link GitHubClient.listCommits} answers. */
export type CommitsRead = Answer & ({ kind: 'ok'; commits: CommitInfo[] } | Failure);

/** What {@link GitHubClient} needs. */
export interface GitHubClientOptions {
  /** The fetch to use (the extension's own process's, behind its allow.net). */
  fetch: typeof fetch;
  /** A fine-grained token with Contents: read on the repo. */
  token: string;
  /** `owner/name`. */
  repo: string;
}

type Got = { kind: 'ok'; body: unknown; expiresAt: string | null } | (Failure & Answer);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A github.com URL GitHub itself sent, or null. */
function githubUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(value)
    ? value
    : null;
}

/** Map one commit from GitHub's list into plain data, or null when it is malformed. */
function readCommit(raw: unknown): CommitInfo | null {
  if (!isObject(raw) || typeof raw.sha !== 'string' || !SHA.test(raw.sha)) return null;
  const commit = isObject(raw.commit) ? raw.commit : {};
  const gitAuthor = isObject(commit.author) ? commit.author : {};
  const login = isObject(raw.author) ? raw.author.login : null;
  const date = typeof gitAuthor.date === 'string' ? Date.parse(gitAuthor.date) : NaN;
  if (Number.isNaN(date)) return null;
  const parents = Array.isArray(raw.parents) ? raw.parents : [];
  const parent = isObject(parents[0]) ? parents[0].sha : null;
  const subject = typeof commit.message === 'string' ? commit.message.split('\n')[0] : '';
  return {
    sha: raw.sha,
    parentSha: typeof parent === 'string' && SHA.test(parent) ? parent : null,
    url: githubUrl(raw.html_url),
    author: cleanText(gitAuthor.name, 60) || cleanText(login, 60) || 'someone',
    date: new Date(date).toISOString(),
    reason: cleanText(subject, 200) || null,
  };
}

/** Reads `roadmap/roadmap.json` and its history from one GitHub repo. */
export class GitHubClient {
  readonly #fetch: typeof fetch;
  readonly #token: string;
  readonly #repo: string;

  /**
   * @param options - The fetch, the token and the repo.
   * @throws Error when the repo is not `owner/name`.
   */
  constructor(options: GitHubClientOptions) {
    if (!validRepo(options.repo)) throw new Error('The repo setting must be owner/name');
    this.#fetch = options.fetch;
    this.#token = options.token;
    this.#repo = options.repo;
  }

  /** GET one API path. Never throws; never puts the token anywhere but the header. */
  async #get(path: string): Promise<Got> {
    let response: Response;
    try {
      response = await this.#fetch(`${API}/repos/${this.#repo}${path}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'User-Agent': 'dorkos-roadmap-extension',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      return { kind: 'unreachable', expiresAt: null };
    }
    const expiresAt = parseExpiry(response.headers.get('github-authentication-token-expiration'));
    if (response.status === 404) return { kind: 'missing', expiresAt };
    if (!response.ok) return { kind: 'refused', status: response.status, expiresAt };
    try {
      return { kind: 'ok', body: await response.json(), expiresAt };
    } catch {
      return { kind: 'refused', status: response.status, expiresAt };
    }
  }

  /**
   * Read the file, at the default branch or at one commit.
   *
   * @param ref - A full commit sha, or nothing for the default branch.
   * @returns The text, or how the read failed.
   * @throws Error when `ref` is not a full commit sha.
   */
  async readFile(ref?: string): Promise<FileRead> {
    if (ref !== undefined && !SHA.test(ref)) throw new Error('ref must be a full commit sha');
    const got = await this.#get(`/contents/${ROADMAP_PATH}${ref ? `?ref=${ref}` : ''}`);
    if (got.kind !== 'ok') return got;
    const body = got.body;
    // A folder, a symlink or a file too large for the contents API has no base64 content.
    if (!isObject(body) || body.type !== 'file' || body.encoding !== 'base64') {
      return { kind: 'refused', status: 200, expiresAt: got.expiresAt };
    }
    const text = Buffer.from(String(body.content ?? ''), 'base64').toString('utf8');
    return { kind: 'ok', text, htmlUrl: githubUrl(body.html_url), expiresAt: got.expiresAt };
  }

  /**
   * List the newest commits that touched the file.
   *
   * @returns Up to {@link HISTORY_LENGTH} commits, newest first, or how the read failed.
   */
  async listCommits(): Promise<CommitsRead> {
    const query = `path=${encodeURIComponent(ROADMAP_PATH)}&per_page=${HISTORY_LENGTH}`;
    const got = await this.#get(`/commits?${query}`);
    if (got.kind !== 'ok') return got;
    if (!Array.isArray(got.body)) return { kind: 'refused', status: 200, expiresAt: got.expiresAt };
    const commits = got.body.map(readCommit).filter((c): c is CommitInfo => c !== null);
    return { kind: 'ok', commits, expiresAt: got.expiresAt };
  }
}
