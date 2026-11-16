/**
 * One live Flow model per frame (spec `flow-multiproject` §3.5). On DorkOS
 * client API version 2 each screen runs `activate` in a frame of its own, and
 * so does the hidden registration run that keeps the tab's dot and the palette
 * commands; each starts one store, which the screens in it read.
 *
 * - Its first read for a chat's folder is `POST /folders`, as the person, so
 *   flow looks for a project there too (DOR-3581); after that it reads
 *   `GET /model` with the folder, so flow says which project it is on a
 *   DorkOS that does not.
 * - A frame has no network of its own and DorkOS passes it no extension
 *   events, so the store reads the model again every 15 s, and whenever the
 *   chat's folder changes. While DorkOS's window is hidden it skips those
 *   reads, and reads once when it shows again. Every change a screen makes
 *   answers the new model, which shows at once.
 * - It never switches DorkOS schedules back on after a pause: only a person
 *   can, in Schedules, and the project's screens say so.
 *
 * @module @dorkos/flow/extension/ui/store
 */

import type { FlowModel } from '../lib/model.ts';
import type { ClientApi, ProjectRef, ReadableState } from '../lib/host-types.ts';
import { addFolder, getModel } from './api.ts';
import { useEffect, useState } from './react.ts';

/** How often the model is read again, in ms. */
export const POLL_MS = 15_000;

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
  /** When a model last arrived (ms since the epoch), or `null` before one. */
  heardAt: number | null;
}

/** How long without a model before flow's facts count as old, in ms. */
export const STALE_STORE_MS = 5 * 60_000;

/**
 * Whether the store's facts are current: a model arrived in the last five
 * minutes.
 *
 * @param snapshot - The store.
 * @param now - The clock, in ms.
 * @returns True when current.
 */
export function storeIsFresh(snapshot: Pick<StoreSnapshot, 'heardAt'>, now: number): boolean {
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
    heardAt: null,
  };
  private readonly listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopVisibility: (() => void) | null = null;
  private stopState: (() => void) | null = null;
  private started = false;
  private loading: Promise<void> | null = null;
  /** The folder flow was last told to look in, so later reads only read. */
  private told: string | null = null;

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
    const state: ReadableState = this.api.getState();
    return {
      cwd: state.currentCwd ?? null,
      currentProject: 'currentProject' in state ? (state.currentProject ?? null) : undefined,
    };
  }

  /**
   * Take a model (from a route's answer or a read).
   *
   * @param model - The model.
   */
  apply(model: FlowModel): void {
    this.set({ model, phase: 'ready', failures: 0, heardAt: this.clock() });
  }

  /**
   * Read the model now. A read already under way is shared.
   *
   * @returns When it is done; it never rejects.
   */
  refresh(): Promise<void> {
    this.loading ??= this.read()
      .then(
        (model) => this.apply(model),
        () => {
          // The server may be restarting and forget the folder: tell it again
          // on the next read.
          this.told = null;
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

  /**
   * The model. The first read for a chat's folder tells flow, as the person,
   * to look there (only a person can, DOR-3581); when that is refused it
   * still reads, and tells flow on the next read.
   */
  private read(): Promise<FlowModel> {
    const cwd = this.snapshot.cwd;
    if (cwd === null || cwd === this.told) return getModel(cwd);
    return addFolder(cwd).then(
      (model) => {
        this.told = cwd;
        return model;
      },
      () => getModel(cwd)
    );
  }

  /** Try the first load again after it failed. */
  retry(): void {
    this.set({ phase: 'loading' });
    void this.refresh();
  }

  /** Start: read the model now and every {@link POLL_MS}, and follow the chat's folder. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.set(this.readState());
    void this.refresh();
    this.stopState = this.api.subscribe(
      (state) => `${state.currentCwd ?? ''}\n${state.currentProject?.root ?? ''}`,
      () => {
        const next = this.readState();
        const moved = next.cwd !== this.snapshot.cwd;
        this.set(next);
        if (moved) void this.refresh();
      }
    );
    this.poll = setInterval(() => {
      if (!pageHidden()) void this.refresh();
    }, POLL_MS);
    if (typeof document !== 'undefined') {
      const shown = () => {
        if (!pageHidden()) void this.refresh();
      };
      document.addEventListener('visibilitychange', shown);
      this.stopVisibility = () => document.removeEventListener('visibilitychange', shown);
    }
  }

  /** Stop reading and following the chat's folder. */
  stop(): void {
    this.started = false;
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.stopState?.();
    this.stopState = null;
  }
}

/** Whether DorkOS's window is hidden (a frame shares its window's visibility). */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
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
