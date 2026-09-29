/**
 * One live Flow model for the whole client extension (spec `flow-multiproject`
 * §3.5). `activate` starts it once; the Flow tab, the palette commands and
 * their dialog read it, so there is one event stream however many Flow tabs
 * are open.
 *
 * - It reads `GET /model` (with the chat's folder, so flow looks there too and
 *   says which project it is on a DorkOS that does not), then follows the
 *   server's `ext:flow:model` event on DorkOS's `/api/events` stream.
 * - While that stream is not open it re-reads every 30 s, and it reads once
 *   each time the stream opens (events sent while it was down are lost).
 * - It reads again when the chat's folder changes.
 * - When a pause that had switched DorkOS schedules off is over, it switches
 *   them back on, as the person whose browser this is (the server half has no
 *   way to), then tells flow.
 *
 * @module @dorkos/flow/extension/ui/store
 */

import type { FlowModel, FlowProject } from '../lib/model.ts';
import type { ClientApi, ProjectRef, ReadableState } from '../lib/host-types.ts';
import { getModel, resolveApiBaseUrl, schedulesRestored } from './api.ts';
import { enableSchedule, type EnableResult } from './core-api.ts';
import { useEffect, useState } from './react.ts';

/** How often the model is read again while the live stream is down, in ms. */
export const FALLBACK_POLL_MS = 30_000;

/** The host event the server's `ctx.emit('model', …)` arrives as. */
export const MODEL_EVENT = 'ext:flow:model';

/** How long after a schedule could not be switched back on the store tries again, in ms. */
export const RESTORE_RETRY_MS = 5 * 60_000;

/** `EventSource.OPEN`, spelled out so a stand-in without the constant still compares. */
const OPEN_STATE = 1;

/** Where the store is. */
export type StorePhase = 'loading' | 'ready' | 'failed';

/** What the store holds. */
export interface StoreSnapshot {
  /** Loading, ready, or failed to load (then `failures` counts the attempts). */
  phase: StorePhase;
  /** The last model read, or `null` before one. */
  model: FlowModel | null;
  /** Failed loads in a row. */
  failures: number;
  /** The chat's folder. */
  cwd: string | null;
  /**
   * The chat's project as DorkOS resolves it, `null` for none, or `undefined`
   * on a DorkOS that does not say (then `model.cwdProject` answers).
   */
  currentProject: ProjectRef | null | undefined;
  /** Projects whose schedules could not be switched back on, by name. */
  schedulesStuck: ReadonlySet<string>;
  /** When a model last arrived (ms since the epoch), or `null` before one. */
  heardAt: number | null;
  /** Whether the live stream is open, so a quiet model is still current. */
  live: boolean;
}

/** How long without a model, while the live stream is down, before flow's facts count as old, in ms. */
export const STALE_STORE_MS = 5 * 60_000;

/**
 * Whether the store's facts are current: the live stream is open (the server
 * sends a model whenever one changes), or a model arrived in the last five
 * minutes.
 *
 * @param snapshot - The store.
 * @param now - The clock, in ms.
 * @returns True when current.
 */
export function storeIsFresh(
  snapshot: Pick<StoreSnapshot, 'heardAt' | 'live'>,
  now: number
): boolean {
  if (snapshot.live) return true;
  return snapshot.heardAt !== null && now - snapshot.heardAt <= STALE_STORE_MS;
}

/** The live Flow model. */
export class FlowStore {
  private snapshot: StoreSnapshot = {
    phase: 'loading',
    model: null,
    failures: 0,
    cwd: null,
    currentProject: undefined,
    schedulesStuck: new Set(),
    heardAt: null,
    live: false,
  };
  private readonly listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopState: (() => void) | null = null;
  private started = false;
  private loading: Promise<void> | null = null;
  /** Schedule ids already being switched back on, so no two tries overlap. */
  private readonly restoring = new Set<string>();
  /**
   * When switching a schedule back on was last tried, by id: a schedule is
   * tried at most every few minutes, whether it failed or flow has not yet
   * heard that it worked.
   */
  private readonly triedAt = new Map<string, number>();

  /**
   * The project Settings → Flow opens on, when ⚙ asked for one on a DorkOS
   * without flow's pages (§10); `null` for the chat's project.
   */
  settingsProject: string | null = null;

  /**
   * @param api - DorkOS's client API (state and its changes).
   * @param clock - The clock, in ms, for when a model last arrived (tests).
   */
  constructor(
    private readonly api: Pick<ClientApi, 'getState' | 'subscribe'>,
    private readonly clock: () => number = Date.now
  ) {}

  /** What the store holds now. */
  get(): StoreSnapshot {
    return this.snapshot;
  }

  /**
   * Listen for changes.
   *
   * @param listener - Called after each change.
   * @returns A function that stops listening.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Replace part of the snapshot and tell every listener. */
  private set(patch: Partial<StoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** The chat's folder and project, as the host says now. */
  private readState(): Pick<StoreSnapshot, 'cwd' | 'currentProject'> {
    const state: ReadableState | undefined = this.api.getState?.();
    return {
      cwd: state?.currentCwd ?? null,
      currentProject:
        state !== undefined && 'currentProject' in state
          ? (state.currentProject ?? null)
          : undefined,
    };
  }

  /**
   * Take a model (from a route's answer or the stream).
   *
   * @param model - The model.
   */
  apply(model: FlowModel): void {
    this.set({ model, phase: 'ready', failures: 0, heardAt: this.clock() });
    void this.restoreSchedules(model);
  }

  /**
   * Read the model now. A read already under way is shared.
   *
   * @returns When it is done; it never rejects.
   */
  refresh(): Promise<void> {
    this.loading ??= getModel(this.snapshot.cwd)
      .then(
        (model) => this.apply(model),
        () => {
          // Only a failed first load (or one after a failure) is shown; a
          // failed re-read keeps the model already on screen.
          if (this.snapshot.phase !== 'ready') {
            this.set({ phase: 'failed', failures: this.snapshot.failures + 1 });
          }
        }
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Try the first load again after it failed. */
  retry(): void {
    this.set({ phase: 'loading' });
    void this.refresh();
  }

  /** Start: read the model, follow the stream and the chat's folder. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.set(this.readState());
    void this.refresh();
    this.stopState =
      this.api.subscribe?.(
        (state) => `${state.currentCwd ?? ''}\n${state.currentProject?.root ?? ''}`,
        () => {
          const next = this.readState();
          const moved = next.cwd !== this.snapshot.cwd;
          this.set(next);
          if (moved) void this.refresh();
        }
      ) ?? null;
    const startPolling = () => {
      this.poll ??= setInterval(() => void this.refresh(), FALLBACK_POLL_MS);
    };
    const stopPolling = () => {
      if (this.poll !== null) clearInterval(this.poll);
      this.poll = null;
    };
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    const stream = new EventSource(`${resolveApiBaseUrl()}/events`);
    this.source = stream;
    stream.addEventListener(MODEL_EVENT, (event) => {
      try {
        this.apply(JSON.parse((event as MessageEvent<string>).data) as FlowModel);
      } catch {
        // A frame that is not a model is ignored; the next one replaces it.
      }
    });
    stream.addEventListener('error', () => {
      if (stream.readyState !== OPEN_STATE) {
        if (this.snapshot.live) this.set({ live: false });
        startPolling();
      }
    });
    stream.addEventListener('open', () => {
      stopPolling();
      this.set({ live: true });
      void this.refresh();
    });
  }

  /** Stop following the stream and the chat's folder. */
  stop(): void {
    this.started = false;
    this.source?.close();
    this.source = null;
    if (this.snapshot.live) this.set({ live: false });
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    this.stopState?.();
    this.stopState = null;
  }

  /**
   * Switch back on the DorkOS schedules a finished pause had switched off,
   * then tell flow which are done. A schedule deleted since counts as done; one
   * DorkOS would not switch on stays on the list, and the project says so.
   */
  private async restoreSchedules(model: FlowModel): Promise<void> {
    if (!model.canChange) return;
    for (const project of model.projects) {
      const now = Date.now();
      const ids = project.restoreSchedules.filter(
        (id) =>
          !this.restoring.has(id) && now - (this.triedAt.get(id) ?? -Infinity) >= RESTORE_RETRY_MS
      );
      if (ids.length === 0) continue;
      for (const id of ids) this.restoring.add(id);
      try {
        const results: EnableResult[] = await Promise.all(ids.map((id) => enableSchedule(id)));
        const done = ids.filter((_, i) => results[i] !== 'failed');
        for (const id of ids) this.triedAt.set(id, now);
        this.markStuck(project, results.includes('failed'));
        if (done.length > 0) this.apply(await schedulesRestored(project.name, done));
      } catch {
        for (const id of ids) this.triedAt.set(id, now);
        this.markStuck(project, true);
      } finally {
        for (const id of ids) this.restoring.delete(id);
      }
    }
  }

  /** Note whether a project's schedules could not be switched back on. */
  private markStuck(project: FlowProject, stuck: boolean): void {
    const next = new Set(this.snapshot.schedulesStuck);
    if (stuck) next.add(project.name);
    else next.delete(project.name);
    this.set({ schedulesStuck: next });
  }
}

/**
 * Read the store in a component, re-rendering on each change.
 *
 * @param store - The store.
 * @returns Its snapshot now.
 */
export function useStore(store: FlowStore): StoreSnapshot {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n: number) => n + 1)), [store]);
  return store.get();
}
