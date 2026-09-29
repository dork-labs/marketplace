/**
 * The restore list and the expiry sweep under concurrency (spec
 * `flow-multiproject` §5.2, review of DOR-2529):
 *
 * - a sweep adding one project's schedules while the Flow tab reports another
 *   project's done loses neither change (read-modify-write inside the storage
 *   queue), and brings back nothing already reported;
 * - the sweep reads the flag again in the command queue, so a pause a person
 *   just made is never lifted as if it were the old one;
 * - a sweep that cannot end a pause says so once, then waits longer each time.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileLike } from '../lib/advisor.ts';
import { pauseFlagPath } from '../lib/model.ts';
import { ModelService, RESTORE_KEY, SWEEP_RETRY_MS } from '../lib/model-service.ts';
import { SharedStorage } from '../lib/shared-storage.ts';
import { git, makeWorld, type World } from './fixtures.ts';

let world: World;
let other: string;

beforeEach(() => {
  world = makeWorld();
  other = path.join(world.root, 'other');
  mkdirSync(other);
  git(other, 'init', '-q');
  for (const root of [world.main, other]) {
    mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'flow', 'config.json'), '{"tracker":"fake"}');
  }
});

afterEach(() => {
  world.cleanup();
});

/** Write a project's pause flag. */
function flag(root: string, until: string): void {
  writeFileSync(pauseFlagPath(root), JSON.stringify({ pausedAt: '2026-09-28T08:00:00Z', until }));
}

/** A host storage whose saves wait until released. */
function heldStorage(initial: Record<string, unknown>) {
  const box: { data: unknown } = { data: initial };
  const pending: (() => void)[] = [];
  let hold = false;
  const storage = new SharedStorage({
    loadData: async <T>() => box.data as T,
    saveData: async <T>(data: T) => {
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
      box.data = JSON.parse(JSON.stringify(data));
    },
  });
  return {
    box,
    storage,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const resolve of pending.splice(0)) resolve();
    },
    waiting: () => pending.length,
  };
}

/** A service over the two fixture projects, with a scripted command runner. */
function service(
  storage: SharedStorage,
  exec: ExecFileLike,
  opts: { now?: () => Date; log?: (line: string) => void } = {}
) {
  return new ModelService({
    dorkHome: world.dorkHome,
    flowRoot: path.join(world.root, 'flow'),
    accounts: { list: async () => [] },
    storage,
    emit: () => {},
    execFile: exec,
    now: opts.now ?? (() => new Date('2026-09-28T12:00:00Z')),
    canChange: true,
    log: opts.log ?? (() => {}),
    pidAlive: () => true,
  });
}

/** Let promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the restore list', () => {
  it('keeps a sweep’s new schedules when the Flow tab reports others done at the same time', async () => {
    const held = heldStorage({ [RESTORE_KEY]: { [world.main]: ['x-1'] } });
    flag(other, '2026-09-28T11:00:00Z');
    const exec: ExecFileLike = (_file, args, _opts, callback) => {
      queueMicrotask(() =>
        callback(null, args.includes('resume') ? '{"ok":true,"hostSchedules":["z-1"]}' : '{}', '')
      );
      return undefined;
    };
    const model = service(held.storage, exec);
    model.noteCwd(world.worktree);
    model.noteCwd(other);
    await model.projects();
    held.hold();
    // The sweep ends other's pause and saves z-1; its save is held.
    const polled = model.poll();
    await vi.waitFor(() => expect(held.waiting()).toBe(1));
    // Meanwhile the Flow tab reports main's x-1 done.
    const reported = model.schedulesRestored('main', ['x-1']);
    await settle();
    held.release();
    await polled;
    await reported;
    expect((held.box.data as Record<string, unknown>)[RESTORE_KEY]).toEqual({ [other]: ['z-1'] });
    model.dispose();
  });
});

describe('the expiry sweep', () => {
  it('never lifts a pause a person made while the sweep waited its turn', async () => {
    flag(world.main, '2026-09-28T11:00:00Z');
    const calls: string[] = [];
    let releasePause = () => {};
    const exec: ExecFileLike = (_file, args, _opts, callback) => {
      const verb = args.includes('pause') ? 'pause' : args.includes('resume') ? 'resume' : 'other';
      calls.push(verb);
      if (verb === 'pause') {
        releasePause = () => {
          // The person's new pause ends tomorrow.
          flag(world.main, '2026-09-29T09:00:00Z');
          callback(null, '{}', '');
        };
        return undefined;
      }
      queueMicrotask(() => callback(null, '{}', ''));
      return undefined;
    };
    const { storage } = heldStorage({});
    const model = service(storage, exec);
    model.noteCwd(world.worktree);
    const paused = model.pause({ project: 'main', until: '2026-09-29T09:00:00Z' });
    await vi.waitFor(() => expect(calls).toEqual(['pause']));
    // The old flag has ended, so the sweep queues a resume behind the pause.
    const polled = model.poll();
    await settle();
    releasePause();
    await paused;
    await polled;
    expect(calls).toEqual(['pause']);
    model.dispose();
  });

  it('says once that it could not end a pause, then waits longer before each try', async () => {
    flag(world.main, '2026-09-28T11:00:00Z');
    let now = Date.parse('2026-09-28T12:00:00Z');
    const tries: number[] = [];
    const exec: ExecFileLike = (_file, args, _opts, callback) => {
      if (args.includes('resume')) tries.push(now);
      queueMicrotask(() => callback(Object.assign(new Error('locked'), { code: 1 }), '', ''));
      return undefined;
    };
    const log = vi.fn();
    const { storage } = heldStorage({});
    const model = service(storage, exec, { now: () => new Date(now), log });
    model.noteCwd(world.worktree);
    const start = now;
    await model.poll();
    now = start + SWEEP_RETRY_MS[0] - 1;
    await model.poll();
    now = start + SWEEP_RETRY_MS[0];
    await model.poll();
    now += SWEEP_RETRY_MS[1] - 1;
    await model.poll();
    expect(tries).toEqual([start, start + SWEEP_RETRY_MS[0]]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/could not end the pause in main on time/);
    model.dispose();
  });
});
