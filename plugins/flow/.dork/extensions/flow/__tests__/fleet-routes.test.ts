/**
 * The Flow tab's routes (spec `claude-account-ui` §8.2): `GET /fleet` over
 * every runtime DorkOS lists, the three `PUT`s through flow's locked writer,
 * and `501 host-too-old` on an older DorkOS.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateFleetPolicy } from '../../../../scripts/fleet/accounts.ts';
import { IMPLICIT_ACCOUNT_COLOR, type FleetView } from '../lib/fleet.ts';
import { createFlowExtension } from '../server.ts';
import {
  fakeCtx,
  fakeRouter,
  makeWorld,
  readFleet,
  writeFleet,
  writeLedger,
  type World,
} from './fixtures.ts';

const NOW = new Date('2026-09-27T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

/** Build the extension over the fixture world. */
function setup(opts: Parameters<typeof fakeCtx>[1] = {}) {
  const router = fakeRouter();
  const host = fakeCtx(world, opts);
  const writer = vi.fn(updateFleetPolicy);
  const ext = createFlowExtension(router, host.ctx, {
    writer,
    now: () => NOW,
    originOf: () => null,
    log: () => {},
  });
  return { router, host, writer, ext };
}

/** GET /fleet's body. */
async function fleet(router: ReturnType<typeof fakeRouter>): Promise<FleetView> {
  const sent = await router.call('get', '/fleet');
  expect(sent.status).toBe(200);
  return sent.body as FleetView;
}

describe('GET /fleet', () => {
  it('groups every runtime DorkOS lists, with flow defaults, labels and colors', async () => {
    const { router } = setup();
    const view = await fleet(router);
    expect(view.handoff).toBe('auto');
    expect(view.crossRuntimeFallback).toBe('off');
    expect(view.anyRoleStored).toBe(false);
    expect(view.groups.map((g) => [g.runtime, g.label, g.supportsAccounts])).toEqual([
      ['claude-code', 'Claude Code', true],
      ['codex', 'Codex', false],
    ]);
    const [claude, codex] = view.groups;
    expect(claude.accounts.map((a) => [a.key, a.label, a.color, a.role])).toEqual([
      ['claude-code:work', 'Work', '#2563eb', 'kept-out'],
      ['claude-code:personal', 'personal', '#16a34a', 'kept-out'],
    ]);
    expect(codex.accounts).toEqual([
      {
        key: 'codex:default',
        id: 'default',
        label: "Codex (this computer's sign-in)",
        color: IMPLICIT_ACCOUNT_COLOR,
        implicit: true,
        role: 'rotation',
        reservePct: 0,
        spendDownWindowHours: 24,
        repos: [],
        effectiveReservePct: 0,
      },
    ]);
    expect(IMPLICIT_ACCOUNT_COLOR).toBe('#78716c');
  });

  it('reads the effective reserve from the raw ledger', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:work': { role: 'main' } } });
    // Inside the 24 h spend-down window before the weekly reset: no reserve.
    writeLedger(
      world.dorkHome,
      'claude-code',
      'work',
      { seven_day: { usedPct: 40, resetsAt: '2026-09-28T00:00:00.000Z' } },
      '2026-09-27T11:00:00.000Z'
    );
    const { router } = setup();
    const work = (await fleet(router)).groups[0].accounts[0];
    expect([work.role, work.reservePct, work.effectiveReservePct]).toEqual(['main', 50, 0]);
  });

  it('turns anyRoleStored on after the first role is stored', async () => {
    const { router } = setup();
    expect((await fleet(router)).anyRoleStored).toBe(false);
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { role: 'rotation' },
    });
    expect(sent.status).toBe(200);
    expect((sent.body as FleetView).anyRoleStored).toBe(true);
  });
});

describe('an older DorkOS', () => {
  it.each([
    ['no accounts API', { accounts: 'none' as const }],
    ['no markContinued', { accounts: 'no-mark-continued' as const }],
    ['no dorkHome', { dorkHome: false }],
  ])('answers 501 host-too-old and registers no advisor (%s)', async (_name, opts) => {
    const { router, host, ext } = setup(opts);
    expect(await router.call('get', '/fleet')).toEqual({
      status: 501,
      body: { reason: 'host-too-old' },
    });
    expect(host.accounts.registerAdvisor).not.toHaveBeenCalled();
    expect(ext.advisor).toBeNull();
  });
});

describe('PUT /fleet/accounts/:key', () => {
  it('makes one account main and demotes the old main of its runtime in ONE write', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:work': { role: 'main' } } });
    const { router, writer } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:personal' },
      body: { role: 'main' },
    });
    expect(sent.status).toBe(200);
    expect(writer).toHaveBeenCalledTimes(1);
    const accounts = (sent.body as FleetView).groups[0].accounts;
    expect(accounts.map((a) => [a.id, a.role])).toEqual([
      ['work', 'rotation'],
      ['personal', 'main'],
    ]);
    expect(readFleet(world.dorkHome).accounts).toEqual({
      'claude-code:work': { role: 'rotation' },
      'claude-code:personal': { role: 'main' },
    });
  });

  it('refuses a repo that is not owner/name, naming it', async () => {
    const { router, writer } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { role: 'kept-out', repos: ['acme/app', 'not a repo'] },
    });
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toContain('"not a repo"');
    expect(writer).not.toHaveBeenCalled();
  });

  it('resets a field to its default with null', async () => {
    const { router } = setup();
    const put = (body: unknown) =>
      router.call('put', '/fleet/accounts/:key', { params: { key: 'claude-code:work' }, body });
    await put({ role: 'main', reservePct: 30 });
    expect((await fleet(router)).groups[0].accounts[0].reservePct).toBe(30);
    const sent = await put({ reservePct: null });
    expect((sent.body as FleetView).groups[0].accounts[0].reservePct).toBe(50);
    expect(readFleet(world.dorkHome).accounts).toEqual({ 'claude-code:work': { role: 'main' } });
  });

  it('answers 404 for a key no account has', async () => {
    const { router, writer } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:nobody' },
      body: { role: 'rotation' },
    });
    expect(sent.status).toBe(404);
    expect(writer).not.toHaveBeenCalled();
  });

  it('keeps a write the flow CLI made between two requests', async () => {
    const { router } = setup();
    await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { role: 'rotation' },
    });
    // The CLI edits the file on its own.
    const raw = readFleet(world.dorkHome);
    writeFileSync(
      path.join(world.dorkHome, 'flow', 'fleet.json'),
      JSON.stringify({ ...raw, runtimes: ['codex'], note: 'kept' })
    );
    await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:personal' },
      body: { role: 'rotation' },
    });
    const after = readFleet(world.dorkHome);
    expect(after.runtimes).toEqual(['codex']);
    expect(after.note).toBe('kept');
    expect(after.accounts).toEqual({
      'claude-code:work': { role: 'rotation' },
      'claude-code:personal': { role: 'rotation' },
    });
  });

  it('answers 409 with flow’s message when the lock never frees', async () => {
    mkdirSync(path.join(world.dorkHome, 'flow'), { recursive: true });
    writeFileSync(path.join(world.dorkHome, 'flow', 'fleet.json.lock'), 'someone-else');
    const { router } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { role: 'rotation' },
    });
    expect(sent.status).toBe(409);
    expect((sent.body as { error: string }).error).toMatch(/^Could not lock .*fleet\.json/);
  });

  it('answers 409 with flow’s message for a newer fleet.json', async () => {
    writeFleet(world.dorkHome, { v: 2 });
    const { router } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { role: 'rotation' },
    });
    expect(sent.status).toBe(409);
    expect((sent.body as { error: string }).error).toContain('will not downgrade it');
  });

  it('answers 400 with flow’s message for a value the contract refuses', async () => {
    const { router } = setup();
    const sent = await router.call('put', '/fleet/accounts/:key', {
      params: { key: 'claude-code:work' },
      body: { reservePct: 140 },
    });
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toBe(
      'reserve must be a number from 0 to 100 (got 140).'
    );
  });
});

describe('fleet-wide settings', () => {
  it('writes handoff and crossRuntimeFallback and answers the new body', async () => {
    const { router } = setup();
    const handoff = await router.call('put', '/fleet/handoff', { body: { handoff: 'ask' } });
    expect((handoff.body as FleetView).handoff).toBe('ask');
    const cross = await router.call('put', '/fleet/cross-runtime', {
      body: { crossRuntimeFallback: 'on' },
    });
    expect((cross.body as FleetView).crossRuntimeFallback).toBe('on');
    expect(readFleet(world.dorkHome)).toEqual({ v: 1, handoff: 'ask', crossRuntimeFallback: 'on' });
  });

  it('refuses values outside the contract', async () => {
    const { router } = setup();
    expect(
      (await router.call('put', '/fleet/handoff', { body: { handoff: 'never' } })).status
    ).toBe(400);
    expect((await router.call('put', '/fleet/cross-runtime', { body: {} })).status).toBe(400);
  });
});
