/**
 * One extension storage for several owners. DorkOS gives the extension a
 * single stored value (`ctx.storage`); the continued-watcher, the project list
 * and the schedule restores each keep their own top-level keys in it. Each
 * owner gets a view whose `saveData` merges its keys into the stored object
 * and leaves every other key as it was, so one owner's save never drops
 * another's data. Saves run one at a time, in order.
 *
 * @module @dorkos/flow/extension/shared-storage
 */

import type { DataProviderContext } from './host-types.ts';

/** The storage an owner sees. */
export type StorageView = DataProviderContext['storage'];

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shares the extension's one stored value between its owners. */
export class SharedStorage {
  private cache: Record<string, unknown> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param storage - The host's storage.
   */
  constructor(private readonly storage: StorageView) {}

  /** The stored object, read once; anything that is not an object reads as empty. */
  private async read(): Promise<Record<string, unknown>> {
    if (this.cache === null) {
      const value = await this.storage.loadData<unknown>();
      this.cache ??= isObject(value) ? { ...value } : {};
    }
    return this.cache;
  }

  /**
   * A view for one owner: `loadData` answers the whole stored object (an
   * owner reads the keys it knows), and `saveData` merges the object it is
   * given into it.
   *
   * @returns The view.
   */
  view(): StorageView {
    return {
      loadData: async <T>() => (await this.read()) as T,
      saveData: async <T>(data: T) => {
        const run = this.queue.then(async () => {
          const current = await this.read();
          const next = { ...current, ...(isObject(data) ? data : {}) };
          await this.storage.saveData(next);
          this.cache = next;
        });
        this.queue = run.catch(() => {});
        await run;
      },
    };
  }

  /**
   * Read one key.
   *
   * @param key - The key.
   * @returns Its value, or `undefined`.
   */
  async get(key: string): Promise<unknown> {
    return (await this.read())[key];
  }

  /**
   * Change one key from its current value, leaving the others as they are.
   * The read, the change and the save run inside the save queue, so two
   * changes to one key never lose each other's work.
   *
   * @param key - The key.
   * @param change - Its new value, from its current one (`undefined` when unset).
   * @returns The new value.
   */
  update<T>(key: string, change: (current: unknown) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const value = change(current[key]);
      const next = { ...current, [key]: value };
      await this.storage.saveData(next);
      this.cache = next;
      return value;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Write one key, leaving the others as they are.
   *
   * @param key - The key.
   * @param value - Its new value.
   */
  async set(key: string, value: unknown): Promise<void> {
    await this.update(key, () => value);
  }
}
