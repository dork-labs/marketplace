/**
 * Reporting the moves flow makes on its own (spec `claude-account-ui` §8.4,
 * "MARK CONTINUED"): one `markContinued` per (old, new) pair, never twice (not
 * even across a re-created extension), and never for an unclaimed session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_ATTEMPTS } from '../lib/continued-watcher.ts';
import { createFlowExtension } from '../server.ts';
import { fakeCtx, fakeRouter, makeWorld, runRecord, writeRuns, type World } from './fixtures.ts';

let world: World;
let session: { sessionId: string; cwd: string; runtime: string; accountId: string };

beforeEach(() => {
  world = makeWorld();
  session = { sessionId: 's-old', cwd: world.worktree, runtime: 'claude-code', accountId: 'work' };
  writeRuns(world, {
    i1: runRecord(world),
    i2: { ...runRecord(world), issueId: 'i2', identifier: 'ACME-2', sessionId: 's-unclaimed' },
  });
});

afterEach(() => {
  world.cleanup();
});

/** Build the extension over a shared storage. */
function setup(storage: { data: unknown }) {
  const host = fakeCtx(world, { storage });
  const log = vi.fn();
  const ext = createFlowExtension(fakeRouter(), host.ctx, {
    originOf: () => null,
    log,
  });
  return { host, ext, log, advisor: ext.advisor!, watcher: ext.watcher! };
}

/** Flow's supervisor moves both runs to new sessions. */
function flowMovesRuns(suffix: string): void {
  writeRuns(world, {
    i1: runRecord(world, { sessionId: `s-new${suffix}`, account: 'personal' }),
    i2: { ...runRecord(world), issueId: 'i2', identifier: 'ACME-2', sessionId: `s-other${suffix}` },
  });
}

describe('the watcher', () => {
  it('reports a claimed run flow moved on its own, once', async () => {
    const storage = { data: null };
    const { advisor, watcher, host } = setup(storage);
    expect(await advisor.claims!(session)).toBe(true);
    await watcher.check();
    expect(host.accounts.markContinued).not.toHaveBeenCalled();

    flowMovesRuns('');
    await watcher.check();
    await watcher.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(1);
    expect(host.accounts.markContinued).toHaveBeenCalledWith('s-old', {
      sessionId: 's-new',
      runtime: 'claude-code',
      accountId: 'personal',
    });
  });

  it('never reports a pair twice, even from a re-created extension', async () => {
    const storage: { data: unknown } = { data: null };
    const first = setup(storage);
    await first.advisor.claims!(session);
    const claimedBefore = (storage.data as { claimed: unknown }).claimed;
    flowMovesRuns('');
    await first.watcher.check();
    expect(first.host.accounts.markContinued).toHaveBeenCalledTimes(1);
    first.ext.dispose();

    // A restart that still finds the claim recorded (say, saved before the report).
    storage.data = { ...(storage.data as object), claimed: claimedBefore };
    const second = setup(storage);
    await second.watcher.check();
    expect(second.host.accounts.markContinued).not.toHaveBeenCalled();
  });

  it('finds the claimed runs again after a restart', async () => {
    const storage = { data: null };
    const first = setup(storage);
    await first.advisor.claims!(session);
    first.ext.dispose();

    const second = setup(storage);
    flowMovesRuns('');
    await second.watcher.check();
    expect(second.host.accounts.markContinued).toHaveBeenCalledTimes(1);
  });

  it('tries a report DorkOS refused again on the next pass, then never again', async () => {
    const { advisor, watcher, host } = setup({ data: null });
    await advisor.claims!(session);
    host.accounts.markContinued.mockRejectedValueOnce(new Error('DorkOS is restarting'));
    flowMovesRuns('');
    await watcher.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(1);
    await watcher.check();
    await watcher.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(2);
  });

  it('gives up on a pair DorkOS keeps refusing, after 5 tries, and logs once', async () => {
    const storage: { data: unknown } = { data: null };
    const { advisor, watcher, host, log } = setup(storage);
    await advisor.claims!(session);
    host.accounts.markContinued.mockRejectedValue(
      new Error('not a session this extension may move')
    );
    flowMovesRuns('');
    for (let pass = 0; pass < 8; pass++) await watcher.check();
    expect(host.accounts.markContinued).toHaveBeenCalledTimes(REPORT_ATTEMPTS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('gave up');
    const data = storage.data as { claimed: Record<string, unknown>; reported: string[] };
    expect(data.claimed).toEqual({});
    expect(data.reported).toEqual(['s-old→s-new']);
  });

  it('never reports a session the advisor did not claim', async () => {
    const { watcher, host } = setup({ data: null });
    await watcher.check();
    flowMovesRuns('');
    await watcher.check();
    expect(host.accounts.markContinued).not.toHaveBeenCalled();
  });
});
