/**
 * `GET /accounts/eligibility` and `GET /known-projects` (client API v2): the
 * reads the screens used to make of DorkOS's own routes, served by flow from
 * `<dorkHome>/config.json` and `ctx.projects`. They answer DorkOS's shape for
 * flow's projects only, list only Claude accounts with Main last, and nothing
 * here writes a rule: only a person does, in Settings → Runtimes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNKNOWN_PROJECT_TEXT } from '../lib/account-rules.ts';
import type { AccountSummary } from '../lib/host-types.ts';
import { createFlowExtension } from '../server.ts';
import { fakeCtx, fakeProjects, makeWorld, send, type World } from './fixtures.ts';

let world: World;
let other: string;

beforeEach(() => {
  world = makeWorld();
  other = path.join(world.root, 'client-app');
  mkdirSync(other);
});

afterEach(() => world.cleanup());

/** Claude's two accounts and its implicit Main, listed Main first, and Codex's. */
const SUMMARIES: AccountSummary[] = [
  { runtime: 'claude-code', id: 'default', label: null, color: '#78716c', implicit: true },
  { runtime: 'claude-code', id: 'work', label: 'Work', color: '#2563eb', implicit: false },
  { runtime: 'claude-code', id: 'personal', label: null, color: '#16a34a', implicit: false },
  { runtime: 'codex', id: 'default', label: null, color: '#a855f7', implicit: true },
];

/** Write DorkOS's `config.json` with these Claude rules. */
function rules(claudeCode: Record<string, unknown>): void {
  writeFileSync(
    path.join(world.dorkHome, 'config.json'),
    JSON.stringify({ runtimes: { claudeCode } })
  );
}

/** flow's routes over a DorkOS that lists the main checkout and client-app. */
function routes() {
  const projects = fakeProjects([
    { root: world.main, name: 'app', originRepo: 'acme/app', lastSeenAt: '2026-11-16T00:00:00Z' },
    { root: other, name: 'client-app', originRepo: null, lastSeenAt: '2026-11-16T00:00:00Z' },
  ]);
  const { ctx } = fakeCtx(world, { summaries: SUMMARIES, projects: projects.api });
  return createFlowExtension(ctx);
}

describe('GET /accounts/eligibility', () => {
  it('answers each Claude account as the project’s rules see it, Main last', async () => {
    rules({
      accounts: [{ id: 'work', onlyProjects: [other] }],
      projectAccounts: { [world.main]: { allow: ['personal', 'default'] } },
    });
    const flow = routes();
    const answer = await send(
      flow.app,
      'GET',
      `/accounts/eligibility?project=${encodeURIComponent(world.main)}`
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      project: { root: world.main, name: 'app' },
      allow: ['personal', 'default'],
      accounts: [
        {
          id: 'work',
          label: 'Work',
          color: '#2563eb',
          implicit: false,
          onlyProjects: [{ root: other, name: 'client-app' }],
          allowedByAccount: false,
          allowedByProject: false,
          eligible: false,
        },
        {
          id: 'personal',
          label: null,
          color: '#16a34a',
          implicit: false,
          onlyProjects: null,
          allowedByAccount: true,
          allowedByProject: true,
          eligible: true,
        },
        {
          id: 'default',
          label: null,
          color: '#78716c',
          implicit: true,
          onlyProjects: null,
          allowedByAccount: true,
          allowedByProject: true,
          eligible: true,
        },
      ],
    });
    flow.dispose();
  });

  it('with no project, answers each account’s own rule alone, and reads Main’s from its own key', async () => {
    rules({ defaultAccountOnlyProjects: [world.main] });
    const flow = routes();
    const answer = await send(flow.app, 'GET', '/accounts/eligibility', { agent: true });
    expect(answer.status).toBe(200);
    const body = answer.body as { project: unknown; allow: unknown; accounts: { id: string }[] };
    expect(body.project).toBeNull();
    expect(body.allow).toBeNull();
    expect(body.accounts.map((row) => row.id)).toEqual(['work', 'personal', 'default']);
    expect(body.accounts[2]).toMatchObject({
      onlyProjects: [{ root: world.main, name: 'app' }],
      allowedByAccount: false,
    });
    flow.dispose();
  });

  it('with no config.json, every account may work everywhere', async () => {
    const flow = routes();
    const answer = await send(
      flow.app,
      'GET',
      `/accounts/eligibility?project=${encodeURIComponent(other)}`
    );
    const body = answer.body as { accounts: { eligible: boolean }[] };
    expect(body.accounts.every((row) => row.eligible)).toBe(true);
    flow.dispose();
  });

  it('refuses a folder that is not one of flow’s projects, in flow’s words', async () => {
    const flow = routes();
    const answer = await send(
      flow.app,
      'GET',
      `/accounts/eligibility?project=${encodeURIComponent(path.join(world.root, 'elsewhere'))}`
    );
    expect(answer).toEqual({
      status: 404,
      body: { error: UNKNOWN_PROJECT_TEXT, refusedBy: 'flow' },
    });
    flow.dispose();
  });

  it('has no way to write a rule', async () => {
    const flow = routes();
    for (const route of ['/accounts/eligibility', '/known-projects']) {
      expect((await send(flow.app, 'PUT', route, { body: { allow: null } })).status).toBe(404);
      expect((await send(flow.app, 'POST', route, { body: { allow: null } })).status).toBe(404);
    }
    flow.dispose();
  });
});

describe('GET /known-projects', () => {
  it('answers DorkOS’s projects with the repo each comes from', async () => {
    const flow = routes();
    expect(await send(flow.app, 'GET', '/known-projects')).toEqual({
      status: 200,
      body: {
        projects: [
          { root: world.main, name: 'app', originRepo: 'acme/app' },
          { root: other, name: 'client-app', originRepo: null },
        ],
      },
    });
    flow.dispose();
  });

  it('answers none on a DorkOS without the project registry', async () => {
    const { ctx } = fakeCtx(world, { summaries: SUMMARIES });
    const flow = createFlowExtension(ctx);
    expect(await send(flow.app, 'GET', '/known-projects')).toEqual({
      status: 200,
      body: { projects: [] },
    });
    flow.dispose();
  });
});
