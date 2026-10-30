/**
 * `flow status`'s Health block end to end (DOR-3260, F4): the two read-only
 * DorkOS calls it makes, which schedules count as this project's, and that
 * anything it cannot read is unknown, never healthy. The DorkOS is a fake
 * fetch: no test reaches a real server.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../../scripts/flow.ts';
import { createFakeAdapter } from '../fixtures/cli/fake-adapter/adapter.ts';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-health-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
  writeFileSync(
    path.join(project, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake', connection: { intake: [{ id: 'q-1', name: 'Support' }] } })
  );
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** A task row as DorkOS's `GET /api/tasks` sends it. */
function task(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `task-${name}`,
    name,
    prompt: 'Run the tick.',
    cron: '0 8 * * *',
    timezone: 'America/Los_Angeles',
    enabled: true,
    status: 'active',
    filePath: path.join(project, '.dork', 'tasks', name, 'SKILL.md'),
    ...overrides,
  };
}

/** A fake DorkOS: the task list, and each schedule's last completed run (or an HTTP status). */
function dorkos(tasks: unknown, runs: Record<string, unknown[] | number> = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    expect(init?.redirect).toBe('manual');
    if (url.pathname === '/api/tasks') return Response.json(tasks);
    if (url.pathname === '/api/tasks/runs') {
      const answer = runs[url.searchParams.get('scheduleId') ?? ''] ?? [];
      return typeof answer === 'number'
        ? new Response('no', { status: answer })
        : Response.json(answer);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

async function status(fetchImpl: typeof fetch, env: Record<string, string> = {}) {
  let stdout = '';
  const deps: MainDeps = {
    env,
    cwd: project,
    now: () => NOW,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: () => undefined },
    createAdapter: async () => createFakeAdapter({ items: [] }).adapter,
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    io: { osHome: path.join(project, 'home'), fetch: fetchImpl },
  };
  const code = await main(['status', '--json'], deps);
  expect(code).toBe(0);
  return JSON.parse(stdout).health;
}

const completed = (startedAt: string) => [
  { id: 'run-1', status: 'completed', startedAt, finishedAt: startedAt },
];

describe('flow status: Health', () => {
  it('shows each flow schedule as fresh, stale, never ran, disabled or pending approval', async () => {
    const { fetchImpl, urls } = dorkos(
      [
        task('flow-drain', { cron: '0 * * * *' }),
        task('flow-groom', { cron: '0 9 * * 1' }),
        task('flow-triage'),
        task('flow-retro', { enabled: false }),
        task('my-continue', {
          prompt: 'Run /flow continue on this project.',
          status: 'pending_approval',
        }),
      ],
      {
        'task-flow-drain': completed(ago(30 * 60_000)),
        'task-flow-triage': completed(ago(72 * HOUR)),
        'task-flow-groom': [],
      }
    );
    const health = await status(fetchImpl);
    expect(health.schedulesUnknown).toBeNull();
    expect(health.schedules.map((s: { name: string; state: string }) => [s.name, s.state])).toEqual(
      [
        ['flow-drain', 'fresh'],
        ['flow-groom', 'never-ran'],
        ['flow-retro', 'disabled'],
        ['flow-triage', 'stale'],
        ['my-continue', 'pending-approval'],
      ]
    );
    expect(health.schedules[3].detail).toBe(
      'stale: last successful run started 3d ago, runs daily'
    );
    // Run history is read only for schedules that are on, and only completed runs.
    expect(urls.filter((u) => u.startsWith('/api/tasks/runs')).sort()).toEqual([
      '/api/tasks/runs?scheduleId=task-flow-drain&status=completed&limit=1',
      '/api/tasks/runs?scheduleId=task-flow-groom&status=completed&limit=1',
      '/api/tasks/runs?scheduleId=task-flow-triage&status=completed&limit=1',
    ]);
  });

  it("keeps only this project's flow schedules", async () => {
    const { fetchImpl } = dorkos([
      task('flow-drain'),
      task('flow-groom', { filePath: `${project}-2/.dork/tasks/flow-groom/SKILL.md` }),
      task('nightly-backup'),
    ]);
    const health = await status(fetchImpl);
    expect(health.schedules.map((s: { name: string }) => s.name)).toEqual(['flow-drain']);
  });

  it('a run history it cannot read makes that schedule unknown, never healthy', async () => {
    const { fetchImpl } = dorkos([task('flow-triage')], { 'task-flow-triage': 500 });
    const [row] = (await status(fetchImpl)).schedules;
    expect(row.state).toBe('unknown');
    expect(row.detail).toMatch(
      /^unknown \(its run history could not be read: DorkOS answered .* with 500\)$/
    );
  });

  it('a DorkOS too old for the run route is unknown, never "no runs"', async () => {
    const { fetchImpl } = dorkos([task('flow-triage')], { 'task-flow-triage': 400 });
    const [row] = (await status(fetchImpl)).schedules;
    expect(row.state).toBe('unknown');
    expect(row.detail).toBe(
      'unknown (its run history could not be read: DorkOS answered /api/tasks/runs with 400: it is too old for it, or its Tasks are switched off)'
    );
  });

  it('no DorkOS: the schedules are unknown, with why', async () => {
    const health = await status((async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(health.schedules).toBeNull();
    expect(health.schedulesUnknown).toMatch(/^DorkOS is not reachable at http:\/\/localhost:4242$/);
  });

  it('an answer it cannot read, or a redirect, is unknown too', async () => {
    const odd = await status((async () => Response.json({ tasks: 'nope' })) as typeof fetch);
    expect(odd.schedulesUnknown).toBe('DorkOS sent a schedule list flow could not read');
    const moved = await status(
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example' },
        })) as typeof fetch
    );
    expect(moved.schedulesUnknown).toMatch(/with a redirect, which flow does not follow/);
  });

  it('never asks a DorkOS off this machine', async () => {
    let asked = false;
    const health = await status(
      (async () => {
        asked = true;
        return Response.json([]);
      }) as typeof fetch,
      { FLOW_DORKOS_URL: 'https://dorkos.example.com' }
    );
    expect(asked).toBe(false);
    expect(health.schedules).toBeNull();
    expect(health.schedulesUnknown).toBe(
      'flow only asks a DorkOS on this machine, and https://dorkos.example.com is not one'
    );
  });

  it('lists the team, then each intake source; with no read recorded, each is unknown', async () => {
    const { fetchImpl } = dorkos([]);
    const health = await status(fetchImpl);
    expect(health.intake).toEqual([
      {
        id: 'fake',
        name: null,
        lastReadAt: null,
        detail: 'unknown (flow records no read of this source yet)',
      },
      {
        id: 'q-1',
        name: 'Support',
        lastReadAt: null,
        detail: 'unknown (flow records no read of this source yet)',
      },
    ]);
  });
});
