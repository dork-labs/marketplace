/**
 * Sorting new ideas every morning on its own (spec `flow-multiproject` §7.7,
 * §7.9): from 09:00 local, only at Tell me after or Just do it, with ideas
 * waiting, not paused and nothing sorted in 20 hours; most ideas first, one
 * every 15 minutes, at most 4 an hour, none while 2 started chats run; a
 * project not reached by 13:00 waits for tomorrow; each start is recorded.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DailySort,
  MAX_AUTO_STARTS_PER_HOUR,
  RUNNING_FOR_MS,
  SORT_GAP_MS,
  type SortCandidate,
} from '../lib/daily-sort.ts';
import { SharedStorage } from '../lib/shared-storage.ts';

/** A local time today. */
function at(hours: number, minutes = 0): Date {
  const date = new Date(2026, 8, 28, hours, minutes, 0, 0);
  return date;
}

/** A project due for sorting. */
function candidate(name: string, extra: Partial<SortCandidate> = {}): SortCandidate {
  return { root: `/work/${name}`, name, waiting: 5, paused: false, stop: 'tell', ...extra };
}

/** The sort over fakes, with a clock the test moves. */
function setup(opts: { sessions?: boolean; lastSort?: string | null } = {}) {
  let now = at(8, 59);
  const data = { value: null as unknown };
  const storage = new SharedStorage({
    loadData: async <T>() => data.value as T,
    saveData: async (value) => {
      data.value = JSON.parse(JSON.stringify(value));
    },
  });
  let n = 0;
  const start = vi.fn(async () => ({ sessionId: `chat-${(n += 1)}` }));
  const record = vi.fn(async () => {});
  const sort = new DailySort({
    storage,
    sessions: opts.sessions === false ? undefined : { start },
    now: () => now,
    log: () => {},
    record,
    lastSort: () => opts.lastSort ?? null,
  });
  return {
    sort,
    start,
    record,
    set: (next: Date) => {
      now = next;
    },
    later: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('the morning sort', () => {
  it('starts nothing before 09:00, then the project with the most ideas first', async () => {
    const { sort, start, record, set } = setup();
    const projects = [candidate('blintz', { waiting: 3 }), candidate('dorkos', { waiting: 12 })];
    await sort.tick(projects);
    expect(start).not.toHaveBeenCalled();
    set(at(9, 0));
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      project: '/work/dorkos',
      prompt: '/flow:triage',
      title: 'Sorting new ideas in dorkos',
      reason: 'Your settings sort new ideas every morning',
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ name: 'dorkos' }), 'chat-1');
  });

  it('waits 15 minutes between starts and sorts each project once a day', async () => {
    const { sort, start, set, later } = setup();
    const projects = [candidate('a'), candidate('b')];
    set(at(9, 0));
    await sort.tick(projects);
    later(SORT_GAP_MS - 1);
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(1);
    later(1);
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(2);
    expect(
      start.mock.calls.map((call) => (call as unknown as [{ project: string }])[0].project)
    ).toEqual(['/work/a', '/work/b']);
    later(SORT_GAP_MS);
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('never has more than 2 of its chats running, nor more than 4 starts an hour', async () => {
    const { sort, start, set, later } = setup();
    const projects = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => candidate(name));
    set(at(9, 0));
    await sort.tick(projects);
    // A person's click from the inbox starts a second chat meanwhile.
    later(5 * 60_000);
    await sort.noteStart();
    later(SORT_GAP_MS - 5 * 60_000);
    // Two of flow's chats run: the next project waits, leaving room for clicks.
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(1);
    later(RUNNING_FOR_MS);
    await sort.tick(projects);
    expect(start).toHaveBeenCalledTimes(2);
    expect(MAX_AUTO_STARTS_PER_HOUR).toBe(4);
  });

  it('stops at 4 starts in an hour even when none of them is still running', async () => {
    const { sort, start, set, later } = setup();
    set(at(9, 0));
    for (let i = 0; i < 4; i++) await sort.noteStart();
    later(RUNNING_FOR_MS);
    await sort.tick([candidate('a')]);
    expect(start).not.toHaveBeenCalled();
    later(60 * 60_000 - RUNNING_FOR_MS);
    await sort.tick([candidate('a')]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('counts starts from the inbox against the same limits', async () => {
    const { sort, start, set } = setup();
    set(at(9, 0));
    await sort.noteStart();
    await sort.tick([candidate('a')]);
    expect(start).not.toHaveBeenCalled();
  });

  it('leaves out Ask me first, a paused project, one with nothing waiting, and one sorted in 20 hours', async () => {
    const { sort, start, set } = setup();
    set(at(9, 0));
    await sort.tick([
      candidate('a', { stop: 'ask' }),
      candidate('b', { paused: true }),
      candidate('c', { waiting: 0 }),
    ]);
    expect(start).not.toHaveBeenCalled();
    const recent = setup({ lastSort: new Date(at(9, 0).getTime() - 60 * 60_000).toISOString() });
    recent.set(at(9, 0));
    await recent.sort.tick([candidate('d')]);
    expect(recent.start).not.toHaveBeenCalled();
  });

  it('gives up at 13:00 and says the project waits for tomorrow', async () => {
    const { sort, start, set } = setup();
    set(at(13, 0));
    expect(await sort.tick([candidate('a')])).toEqual(new Set(['/work/a']));
    expect(start).not.toHaveBeenCalled();
  });

  it('starts nothing on a DorkOS that cannot start a chat', async () => {
    const { sort, start, set } = setup({ sessions: false });
    set(at(9, 0));
    expect(await sort.tick([candidate('a')])).toEqual(new Set());
    expect(start).not.toHaveBeenCalled();
  });

  it("tries again at the next slot when DorkOS's start limit refuses", async () => {
    const { sort, start, set, later } = setup();
    set(at(9, 0));
    start.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'start_limit' }));
    await sort.tick([candidate('a')]);
    later(60_000);
    await sort.tick([candidate('a')]);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
