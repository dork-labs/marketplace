/**
 * The Health block's judgement (DOR-3260, F4): reading a cron, its longest
 * gap, and each schedule state — fresh, stale, never ran, disabled, pending
 * approval and unknown — plus the intake sources.
 */

import { describe, expect, it } from 'vitest';

import {
  intakeHealth,
  longestGapMs,
  parseCron,
  scheduleHealth,
  type ScheduleFacts,
} from '../scripts/health.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function facts(overrides: Partial<ScheduleFacts> = {}): ScheduleFacts {
  return {
    name: 'flow-triage',
    cron: '0 8 * * *',
    timezone: 'America/Los_Angeles',
    enabled: true,
    status: 'active',
    lastSuccess: ago(2 * HOUR),
    ...overrides,
  };
}

describe('reading a cron', () => {
  it('measures the longest gap between firings', () => {
    const gap = (cron: string) => longestGapMs(parseCron(cron)!, NOW);
    expect(gap('0 * * * *')).toBe(HOUR);
    expect(gap('*/15 * * * *')).toBe(15 * 60_000);
    expect(gap('0 8 * * *')).toBe(DAY);
    expect(gap('0 9 * * 1')).toBe(7 * DAY);
    expect(gap('0 9 * * 1-5')).toBe(3 * DAY);
    expect(gap('0 9,17 * * *')).toBe(16 * HOUR);
  });

  it('treats a day of week of 7 as Sunday', () => {
    expect(longestGapMs(parseCron('0 9 * * 7')!, NOW)).toBe(7 * DAY);
  });

  it('refuses what it cannot read rather than guessing', () => {
    for (const cron of ['@daily', '0 9 * * MON', '61 * * * *', '* * *', '0 8-2 * * *']) {
      expect(parseCron(cron), cron).toBeNull();
    }
  });
});

describe('a schedule', () => {
  it('fresh: its last success is within one interval', () => {
    const row = scheduleHealth(facts({ lastSuccess: ago(20 * HOUR) }), NOW);
    expect(row.state).toBe('fresh');
    expect(row.detail).toBe('fresh: last success 20 h ago, runs daily');
  });

  it('stale: its last success is older than one interval allows', () => {
    const row = scheduleHealth(facts({ lastSuccess: ago(3 * DAY) }), NOW);
    expect(row).toMatchObject({ state: 'stale', lastSuccess: ago(3 * DAY) });
    expect(row.detail).toBe('stale: last success 3d ago, runs daily');
  });

  it('one interval plus an hour of grace is still fresh; past it is stale', () => {
    expect(scheduleHealth(facts({ lastSuccess: ago(DAY + 59 * 60_000) }), NOW).state).toBe('fresh');
    expect(scheduleHealth(facts({ lastSuccess: ago(DAY + 61 * 60_000) }), NOW).state).toBe('stale');
  });

  it('never ran: on, with no successful run', () => {
    const row = scheduleHealth(facts({ lastSuccess: null }), NOW);
    expect(row).toMatchObject({ state: 'never-ran', detail: 'never ran: no successful run yet' });
  });

  it('disabled: switched off, or paused by DorkOS; not stale, whatever its last run', () => {
    expect(scheduleHealth(facts({ enabled: false, lastSuccess: ago(30 * DAY) }), NOW).state).toBe(
      'disabled'
    );
    expect(scheduleHealth(facts({ status: 'paused' }), NOW).state).toBe('disabled');
  });

  it('pending approval: its own wording, never stale or never ran', () => {
    const row = scheduleHealth(facts({ status: 'pending_approval', lastSuccess: null }), NOW);
    expect(row.state).toBe('pending-approval');
    expect(row.detail).toMatch(/^pending approval/);
  });

  it('unknown, with why, whenever something could not be read', () => {
    const cases: [Partial<ScheduleFacts>, RegExp][] = [
      [
        { lastSuccess: { error: 'DorkOS answered 500' } },
        /run history could not be read: DorkOS answered 500/,
      ],
      [{ cron: '@daily' }, /cannot read its cron "@daily"/],
      [{ cron: null }, /cannot read its cron/],
      [{ status: 'archived' }, /status flow does not know: "archived"/],
      [{ lastSuccess: 'yesterday' }, /not a time/],
    ];
    for (const [overrides, detail] of cases) {
      const row = scheduleHealth(facts(overrides), NOW);
      expect(row.state, JSON.stringify(overrides)).toBe('unknown');
      expect(row.detail).toMatch(/^unknown \(/);
      expect(row.detail).toMatch(detail);
    }
  });
});

describe('intake sources', () => {
  it('lists each configured source; with no mark recorded, each is unknown with why', () => {
    expect(intakeHealth([{ id: 'q-1', name: 'Support' }, { id: 'q-2' }], 'linear', NOW)).toEqual([
      {
        id: 'q-1',
        name: 'Support',
        lastReadAt: null,
        detail: 'unknown (flow records no read of this source yet)',
      },
      {
        id: 'q-2',
        name: null,
        lastReadAt: null,
        detail: 'unknown (flow records no read of this source yet)',
      },
    ]);
  });

  it('with none configured, lists the plain tracker intake', () => {
    expect(intakeHealth([], 'linear', NOW)).toEqual([
      {
        id: 'linear',
        name: null,
        lastReadAt: null,
        detail: 'unknown (flow records no read of this source yet)',
      },
    ]);
  });

  it('shows a source mark once one is recorded (the shape F2/F3 fill)', () => {
    const [row] = intakeHealth([{ id: 'q-1', lastReadAt: ago(2 * HOUR) }], 'linear', NOW);
    expect(row).toMatchObject({ lastReadAt: ago(2 * HOUR), detail: 'last read 2 h ago' });
  });
});
