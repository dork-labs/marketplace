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
    // UTC, so the cases below read in plain UTC; the timezone cases set one.
    timezone: null,
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
  // NOW is Thursday 2026-10-29 12:00 UTC; the daily cron fires at 08:00 UTC.
  it('fresh: its last success started at or after the firing it was due for', () => {
    const row = scheduleHealth(facts({ lastSuccess: ago(4 * HOUR) }), NOW);
    expect(row.state).toBe('fresh');
    expect(row.detail).toBe('fresh: last successful run started 4 h ago, runs daily');
  });

  it('stale: a firing came and went with no successful run after it', () => {
    const row = scheduleHealth(facts({ lastSuccess: ago(3 * DAY) }), NOW);
    expect(row).toMatchObject({ state: 'stale', lastSuccess: ago(3 * DAY) });
    expect(row.detail).toBe('stale: last successful run started 3d ago, runs daily');
  });

  it('a firing gets an hour of grace before it counts as missed', () => {
    // Yesterday's 08:00 run; today's 08:00 firing is due until 09:00.
    const yesterday = facts({ lastSuccess: ago(28 * HOUR) });
    expect(scheduleHealth(yesterday, new Date('2026-10-29T08:59:00Z')).state).toBe('fresh');
    expect(scheduleHealth(yesterday, new Date('2026-10-29T09:01:00Z')).state).toBe('stale');
  });

  it("a long run is not stale: the grace is the schedule's max runtime", () => {
    // The hourly drain may run 2 h. Its 10:00 run completed; the 11:00 one is
    // still going at 12:00 and DorkOS skipped the 12:00 firing meanwhile.
    const drain = facts({ name: 'flow-drain', cron: '0 * * * *', lastSuccess: ago(2 * HOUR) });
    expect(scheduleHealth({ ...drain, maxRuntimeMs: 2 * HOUR }, NOW).state).toBe('fresh');
    // With no max runtime, the hour of grace alone marks the missed 11:00 firing.
    expect(scheduleHealth(drain, NOW).state).toBe('stale');
  });

  it('an uneven cron is judged by the firing it missed, not its longest quiet stretch', () => {
    // Weekdays 09:00 to 17:00 hourly; the last success was Monday 09:00.
    const office = facts({ cron: '0 9-17 * * 1-5', lastSuccess: '2026-10-26T09:00:00.000Z' });
    expect(scheduleHealth(office, NOW).state).toBe('stale');
  });

  it('never ran: on, with no successful run', () => {
    const row = scheduleHealth(facts({ lastSuccess: null }), NOW);
    expect(row).toMatchObject({
      state: 'never-ran',
      detail: 'never ran: DorkOS records no completed run for it',
    });
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

describe("a schedule's timezone", () => {
  const la = (overrides: Partial<ScheduleFacts>) =>
    facts({ timezone: 'America/Los_Angeles', ...overrides });

  it('a daily 08:00 Los Angeles run that ran on time is fresh until its next firing', () => {
    // 08:00 PDT yesterday is 15:00 UTC; at 12:00 UTC today the next one is hours away.
    expect(scheduleHealth(la({ lastSuccess: '2026-10-28T15:00:05Z' }), NOW).state).toBe('fresh');
    // An hour after today's 15:00 UTC firing, with no run since, it is stale.
    expect(
      scheduleHealth(la({ lastSuccess: '2026-10-28T15:00:05Z' }), new Date('2026-10-29T16:01:00Z'))
        .state
    ).toBe('stale');
  });

  it("a weekly Monday 09:00 Los Angeles run is fresh on Monday morning UTC, before this week's firing", () => {
    const groom = la({
      name: 'flow-groom',
      cron: '0 9 * * 1',
      lastSuccess: '2026-10-19T16:00:05Z',
    });
    expect(scheduleHealth(groom, new Date('2026-10-26T12:00:00Z')).state).toBe('fresh');
  });

  it('follows the daylight-saving change (Los Angeles leaves PDT on 1 November 2026)', () => {
    // 08:00 PST on 1 and 2 November is 16:00 UTC.
    const run = la({ lastSuccess: '2026-11-01T16:00:05Z' });
    expect(scheduleHealth(run, new Date('2026-11-02T16:59:00Z')).state).toBe('fresh');
    expect(scheduleHealth(run, new Date('2026-11-02T17:01:00Z')).state).toBe('stale');
  });

  it('a timezone flow cannot read is unknown, never judged in UTC', () => {
    const row = scheduleHealth(facts({ timezone: 'Mars/Olympus_Mons' }), NOW);
    expect(row.state).toBe('unknown');
    expect(row.detail).toBe('unknown (flow cannot read its timezone "Mars/Olympus_Mons")');
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
