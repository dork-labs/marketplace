/**
 * The dashboard's cache (spec "Flow Dashboard", M1): what each page last read,
 * kept so a page opens at once and a failing source never blanks it.
 *
 * - One small JSON file per project and page, at
 *   `<dorkHome>/flow/cache/<projectId>/dashboard/{issues,prs,releases}.json`,
 *   beside the tracker snapshot `tracker-reads.ts` keeps. It is only ever a
 *   copy: deleting it loses nothing, and a file that cannot be read is rebuilt.
 * - Each source (a team, a repository, a product) has its own `fetchedAt` and
 *   `error`. A source that fails keeps what it last read and when, and records
 *   why; the others are served as usual.
 * - {@link DashboardCache.fresh} reads again only when the last attempt is
 *   older than the age it is given, so a page asks at most once a minute, and
 *   the 5-minute timer reads what nobody looked at. Two asks at once share one read.
 * - At most {@link SOURCES_AT_ONCE} sources of one page are read at once, so a
 *   dashboard of many repositories never fires every `gh` call together.
 *
 * Node builtins only: DorkOS bundles this module.
 *
 * @module @dorkos/flow/extension/dashboard/cache
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectIdOf } from '../tracker-reads.ts';
import type { DashboardKind } from './types.ts';

/** How often the timer reads every page again, in ms. */
export const DASHBOARD_REFRESH_MS = 5 * 60_000;

/** How old a page's last read may be before a page asking for it reads again, in ms. */
export const DASHBOARD_STALE_ON_VIEW_MS = 60_000;

/** The most sources of one page read at once. */
export const SOURCES_AT_ONCE = 2;

/** What one source's read found. */
export interface SourceRead<T> {
  /** The items. */
  items: T[];
  /** When the data itself was read, when that is not now (flow's tracker snapshot). */
  fetchedAt?: string | null;
  /** Something worth saying, such as "Showing 50 of 120". */
  note?: string | null;
  /** The `gh` login the read ran as. */
  viewer?: string | null;
}

/** One source of a page: its id, its name, and how to read it. */
export interface SourcePlan<T> {
  /** `tracker:<team>`, `github:<owner/name>` or `product:<id>`. */
  id: string;
  /** What to call it. */
  label: string;
  /** Read it; a throw is recorded as the source's error. */
  read(): Promise<SourceRead<T>>;
}

/** One source as cached. */
export interface CachedSource<T> {
  /** Its id. */
  id: string;
  /** What to call it. */
  label: string;
  /** When it last read, or `null` before a read worked. */
  fetchedAt: string | null;
  /** Why its last read failed, or `null`. */
  error: string | null;
  /** Its note, or `null`. */
  note: string | null;
  /** The `gh` login it read as, or `null`. */
  viewer: string | null;
  /** What it last read. */
  items: T[];
}

/** One page as cached. */
export interface CachedPage<T> {
  /** When it was last read, whatever came of it, or `null`. */
  attemptedAt: string | null;
  /** Each source, in the order of the plans. */
  sources: CachedSource<T>[];
}

/** The file's shape. */
interface StoredPage {
  v: 1;
  attemptedAt: string | null;
  sources: Record<string, Omit<CachedSource<unknown>, 'id'>>;
}

/** What the cache needs. */
export interface DashboardCacheDeps {
  /** The DorkOS home. */
  dorkHome: string;
  /** The clock. */
  now: () => Date;
  /** Where to log. */
  log: (message: string) => void;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string, or `null`. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An empty page. */
function emptyPage<T>(): CachedPage<T> {
  return { attemptedAt: null, sources: [] };
}

/** Read a page file leniently: anything it cannot read is no page. */
function parsePage<T>(text: string): CachedPage<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return emptyPage();
  }
  if (!isObject(value) || value.v !== 1 || !isObject(value.sources)) return emptyPage();
  const sources: CachedSource<T>[] = [];
  for (const [id, raw] of Object.entries(value.sources)) {
    if (!isObject(raw) || !Array.isArray(raw.items)) continue;
    sources.push({
      id,
      label: stringOrNull(raw.label) ?? id,
      fetchedAt: stringOrNull(raw.fetchedAt),
      error: stringOrNull(raw.error),
      note: stringOrNull(raw.note),
      viewer: stringOrNull(raw.viewer),
      items: raw.items as T[],
    });
  }
  return { attemptedAt: stringOrNull(value.attemptedAt), sources };
}

/** Run `fns` with at most `limit` at once, keeping their order in the results. */
async function limited<R>(fns: readonly (() => Promise<R>)[], limit: number): Promise<R[]> {
  const results: R[] = new Array(fns.length);
  let next = 0;
  const worker = async () => {
    while (next < fns.length) {
      const index = next;
      next += 1;
      results[index] = await fns[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

/** What each page last read, per project, in memory and on disk. */
export class DashboardCache {
  private readonly pages = new Map<string, CachedPage<unknown>>();
  private readonly inFlight = new Map<string, Promise<CachedPage<unknown>>>();
  private readonly unwritable = new Set<string>();

  /**
   * @param deps - The DorkOS home, the clock and a logger.
   */
  constructor(private readonly deps: DashboardCacheDeps) {}

  /**
   * The file a project's page is kept in.
   *
   * @param root - The project's main checkout.
   * @param kind - The page.
   * @returns The file's path.
   */
  file(root: string, kind: DashboardKind): string {
    return path.join(
      this.deps.dorkHome,
      'flow',
      'cache',
      projectIdOf(root),
      'dashboard',
      `${kind}.json`
    );
  }

  /**
   * What a page last read: from memory, else from its file, else nothing.
   *
   * @param root - The project's main checkout.
   * @param kind - The page.
   * @returns The page.
   */
  load<T>(root: string, kind: DashboardKind): CachedPage<T> {
    const file = this.file(root, kind);
    let page = this.pages.get(file);
    if (page === undefined) {
      try {
        page = parsePage(readFileSync(file, 'utf8'));
      } catch {
        page = emptyPage();
      }
      this.pages.set(file, page);
    }
    return page as CachedPage<T>;
  }

  /**
   * How long ago a page was last read, whatever came of it.
   *
   * @param root - The project's main checkout.
   * @param kind - The page.
   * @returns The age in ms, or `null` when it was never read.
   */
  ageMs(root: string, kind: DashboardKind): number | null {
    const at = this.load(root, kind).attemptedAt;
    const ms = at === null ? NaN : Date.parse(at);
    return Number.isFinite(ms) ? Math.max(0, this.deps.now().getTime() - ms) : null;
  }

  /**
   * A page, read again first when its last read is older than `maxAgeMs`.
   *
   * @param root - The project's main checkout.
   * @param kind - The page.
   * @param plans - Its sources, built only when a read is due.
   * @param maxAgeMs - How old the last read may be.
   * @returns The page.
   */
  async fresh<T>(
    root: string,
    kind: DashboardKind,
    plans: () => SourcePlan<T>[],
    maxAgeMs: number
  ): Promise<CachedPage<T>> {
    const file = this.file(root, kind);
    const running = this.inFlight.get(file);
    if (running !== undefined) return (await running) as CachedPage<T>;
    const age = this.ageMs(root, kind);
    if (age !== null && age < maxAgeMs) return this.load(root, kind);
    return this.refresh(root, kind, plans());
  }

  /**
   * Read every source of a page now, and keep the result. A source that throws
   * keeps what it last read; one no longer planned is dropped. A read already
   * running is shared.
   *
   * @param root - The project's main checkout.
   * @param kind - The page.
   * @param plans - Its sources.
   * @returns The page.
   */
  refresh<T>(root: string, kind: DashboardKind, plans: SourcePlan<T>[]): Promise<CachedPage<T>> {
    const file = this.file(root, kind);
    const running = this.inFlight.get(file);
    if (running !== undefined) return running as Promise<CachedPage<T>>;
    const work = this.read(root, kind, plans).finally(() => this.inFlight.delete(file));
    this.inFlight.set(file, work as Promise<CachedPage<unknown>>);
    return work;
  }

  /** Read the sources and keep the page. */
  private async read<T>(
    root: string,
    kind: DashboardKind,
    plans: SourcePlan<T>[]
  ): Promise<CachedPage<T>> {
    const attemptedAt = this.deps.now().toISOString();
    const before = new Map(this.load<T>(root, kind).sources.map((source) => [source.id, source]));
    const sources = await limited(
      plans.map((plan) => async (): Promise<CachedSource<T>> => {
        const previous = before.get(plan.id);
        try {
          const read = await plan.read();
          return {
            id: plan.id,
            label: plan.label,
            fetchedAt: read.fetchedAt ?? this.deps.now().toISOString(),
            error: null,
            note: read.note ?? null,
            viewer: read.viewer ?? null,
            items: read.items,
          };
        } catch (error) {
          return {
            id: plan.id,
            label: plan.label,
            fetchedAt: previous?.fetchedAt ?? null,
            error: error instanceof Error ? error.message : String(error),
            note: previous?.note ?? null,
            viewer: previous?.viewer ?? null,
            items: previous?.items ?? [],
          };
        }
      }),
      SOURCES_AT_ONCE
    );
    const page: CachedPage<T> = { attemptedAt, sources };
    const file = this.file(root, kind);
    this.pages.set(file, page as CachedPage<unknown>);
    this.write(file, page);
    return page;
  }

  /** Write a page through a temp file and a rename; a failure is logged once per file. */
  private write(file: string, page: CachedPage<unknown>): void {
    const stored: StoredPage = { v: 1, attemptedAt: page.attemptedAt, sources: {} };
    for (const { id, ...rest } of page.sources) stored.sources[id] = rest;
    const temp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(stored)}\n`);
      renameSync(temp, file);
      this.unwritable.delete(file);
    } catch (error) {
      if (!this.unwritable.has(file)) {
        this.unwritable.add(file);
        this.deps.log(`[flow] could not save the dashboard's copy at ${file}: ${String(error)}`);
      }
    }
  }
}
