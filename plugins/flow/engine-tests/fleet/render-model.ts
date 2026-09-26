/** A fixed model for the `flow fleet` render golden (spec `flow-usage` §2.6). */

import type { FleetAccount, FleetModel } from '../../scripts/fleet/render.ts';
import type { FleetSession } from '../../scripts/fleet/sessions.ts';

/** The fixed clock the golden is drawn at. */
export const NOW = '2026-09-26T16:00:00.000Z';

const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const M = 60_000;
const H = 60 * M;
const D = 24 * H;

function account(partial: Partial<FleetAccount> & Pick<FleetAccount, 'id'>): FleetAccount {
  return {
    label: null,
    color: null,
    path: `/home/example/.${partial.id}`,
    validId: true,
    role: 'rotation',
    reservePct: 0,
    effectiveReservePct: 0,
    scopeRepos: [],
    fiveHourRoom: null,
    weeklyRoom: null,
    lastSeen: null,
    windows: {},
    ...partial,
  };
}

function session(
  partial: Partial<FleetSession> & Pick<FleetSession, 'sessionId' | 'state'>
): FleetSession {
  return {
    account: 'claude2',
    item: null,
    stage: null,
    host: 'cli',
    pid: null,
    cwd: null,
    startedAt: null,
    sources: ['claude-code'],
    ...partial,
  };
}

/** Every case the golden must show: expired, stale, rejected, no reading, spend-down, an invalid id, an unknown account, every state. */
export function goldenModel(): FleetModel {
  return {
    home: '/home/example',
    handoff: 'auto',
    dorkos: { url: 'http://127.0.0.1:4242', reachable: false, sessionsShown: 0 },
    dorkosListed: false,
    accounts: [
      account({
        id: 'claude2',
        role: 'main',
        reservePct: 50,
        effectiveReservePct: 50,
        lastSeen: at(-3 * M),
        windows: {
          five_hour: {
            usedPct: 41,
            resetsAt: at(2 * H + 14 * M),
            status: 'allowed',
            observedAt: at(-3 * M),
            source: 'statusline',
            expired: false,
          },
          seven_day: {
            usedPct: 72,
            resetsAt: at(3 * D + 4 * H),
            status: 'allowed',
            observedAt: at(-3 * M),
            source: 'statusline',
            expired: false,
          },
        },
      }),
      account({
        id: 'claude3',
        lastSeen: at(-H),
        windows: {
          // Rejected: reads "out", with a sub-hour countdown.
          five_hour: {
            usedPct: 100,
            resetsAt: at(42 * M),
            status: 'rejected',
            observedAt: at(-H),
            source: 'transcript',
            expired: false,
          },
          seven_day: {
            usedPct: 31,
            resetsAt: at(5 * D + 11 * H),
            status: 'allowed',
            observedAt: at(-H),
            source: 'statusline',
            expired: false,
          },
        },
      }),
      account({
        id: 'claude4',
        role: 'kept-out',
        lastSeen: at(-6 * D),
        windows: {
          // five_hour was stale, so it is absent: "no reading". seven_day has expired.
          seven_day: {
            usedPct: 0,
            resetsAt: at(-H),
            status: 'allowed',
            observedAt: at(-6 * D),
            source: 'statusline',
            expired: true,
          },
        },
      }),
      account({
        id: 'spend-down12',
        reservePct: 20,
        effectiveReservePct: 0,
        lastSeen: at(-30 * 1000),
        windows: {
          // No reset time known: "-". A rejected weekly window with no percent reads full.
          five_hour: {
            usedPct: 5,
            resetsAt: null,
            status: null,
            observedAt: at(-30 * 1000),
            source: 'sdk_usage',
            expired: false,
          },
          seven_day: {
            usedPct: null,
            resetsAt: at(10 * H + 30 * 1000),
            status: 'rejected',
            observedAt: at(-30 * 1000),
            source: 'transcript',
            expired: false,
          },
        },
      }),
      account({ id: 'Bad_Id', validId: false, role: 'kept-out' }),
    ],
    sessions: [
      session({
        sessionId: '1a2b3c4d-0000-4000-8000-000000000001',
        item: 'DOR-2369',
        stage: 'execute',
        state: 'busy',
        cwd: '/home/example/Keep/dork-os/marketplace-worktrees/spec-flow-usage',
        startedAt: at(-3 * H),
        sources: ['claude-code', 'flow-run'],
      }),
      session({
        sessionId: '2b3c4d5e-0000-4000-8000-000000000002',
        state: 'idle',
        cwd: '/home/example/Keep/dork-os/dorkos',
        startedAt: at(-40 * 1000),
      }),
      session({
        sessionId: '5e4d3c2b-0000-4000-8000-000000000003',
        item: 'DOR-2370',
        state: 'unseen',
        host: 'dorkos',
        sources: ['flow-run'],
      }),
      session({
        sessionId: '6f5e4d3c-0000-4000-8000-000000000004',
        item: 'DOR-2371',
        state: 'parked',
        host: 'dorkos',
        cwd: '/srv/app',
        startedAt: at(-2 * D),
        sources: ['dorkos', 'flow-run'],
      }),
      session({
        sessionId: '9f8e7d6c-0000-4000-8000-000000000005',
        account: 'claude3',
        state: 'limited',
        cwd: '/home/example/Keep/dork-os/dorkos',
        startedAt: at(-12 * M),
      }),
      session({
        sessionId: 'a0b1c2d3-0000-4000-8000-000000000006',
        account: 'claude3',
        item: 'DOR-2372',
        state: 'stale',
        host: 'cmux',
        cwd: '/home/example/wt',
        startedAt: at(-5 * H),
        sources: ['flow-run'],
      }),
      session({
        sessionId: 'b1c2d3e4-0000-4000-8000-000000000007',
        account: 'claude4',
        state: 'unknown',
        cwd: '/tmp/x',
        startedAt: at(-M),
      }),
      session({
        sessionId: 'c2d3e4f5-0000-4000-8000-000000000008',
        account: null,
        state: 'interrupted',
        host: 'dorkos',
        cwd: '/very/long/path/that/keeps/going/and/going/to/the/final-folder-name-that-is-long',
        sources: ['dorkos'],
      }),
      session({
        sessionId: 'd3e4f5a6-0000-4000-8000-000000000009',
        account: null,
        item: 'DOR-2373',
        state: 'unseen',
        host: null,
        sources: ['flow-run'],
      }),
    ],
  };
}
