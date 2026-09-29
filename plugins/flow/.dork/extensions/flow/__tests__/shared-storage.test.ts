/**
 * One extension storage for several owners: the continued-watcher's save
 * must never drop the project list, and the other way round.
 */

import { describe, expect, it } from 'vitest';
import { SharedStorage } from '../lib/shared-storage.ts';

/** An in-memory host storage that counts its reads. */
function hostStorage(initial: unknown) {
  const box = { data: initial, loads: 0 };
  return {
    box,
    storage: {
      loadData: async <T>() => {
        box.loads += 1;
        return box.data as T | null;
      },
      saveData: async <T>(data: T) => {
        box.data = JSON.parse(JSON.stringify(data));
      },
    },
  };
}

describe('SharedStorage', () => {
  it("keeps every owner's keys when one of them saves", async () => {
    const { box, storage } = hostStorage({ claimed: { s1: {} }, reported: [] });
    const shared = new SharedStorage(storage);
    const watcher = shared.view();
    await shared.set('flowProjects', ['/a']);
    await watcher.saveData({ claimed: {}, reported: ['x→y'] });
    expect(box.data).toEqual({ claimed: {}, reported: ['x→y'], flowProjects: ['/a'] });
    expect(await shared.get('flowProjects')).toEqual(['/a']);
    expect(await watcher.loadData()).toEqual(box.data);
    // Read once, then served from memory.
    expect(box.loads).toBe(1);
  });

  it('runs saves one at a time, in order', async () => {
    const { box, storage } = hostStorage(null);
    const shared = new SharedStorage(storage);
    await Promise.all([shared.set('a', 1), shared.set('b', 2), shared.set('a', 3)]);
    expect(box.data).toEqual({ a: 3, b: 2 });
  });

  it('starts empty from anything that is not an object', async () => {
    const { storage } = hostStorage(['not', 'an', 'object']);
    const shared = new SharedStorage(storage);
    expect(await shared.get('a')).toBeUndefined();
  });
});
