/**
 * The source mappers behind `flow usage record | scan | probe` (spec `flow-usage`
 * §2.1, §2.4, §2.5). Each fixture is shaped like what Claude Code really writes,
 * with made-up ids and paths.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fromRateLimitEvent,
  fromStatusLine,
  fromTranscriptEntry,
  parseResetText,
} from '../../scripts/fleet/observations.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/usage');
const NOW = new Date('2026-09-26T16:04:10.000Z');

function statusLine(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'statusline', name), 'utf8'));
}

function transcript(name: string): unknown[] {
  return readFileSync(path.join(FIXTURES, 'transcripts', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
}

describe('fromStatusLine', () => {
  it('keeps both windows with their reset times (DOR-2369 validation 1)', () => {
    // Purpose: the whole point of the recorder is keeping resets_at, which the old scraper lost.
    expect(fromStatusLine(statusLine('full.json'), NOW)).toEqual([
      {
        key: 'five_hour',
        usedPct: 41.5,
        resetsAt: '2026-09-26T19:00:00.000Z',
        status: null,
        observedAt: NOW.toISOString(),
        source: 'statusline',
      },
      {
        key: 'seven_day',
        usedPct: 72,
        resetsAt: '2026-09-30T19:00:00.000Z',
        status: null,
        observedAt: NOW.toISOString(),
        source: 'statusline',
      },
    ]);
  });

  it('converts ISO reset times to UTC', () => {
    // Purpose: the contract accepts epoch seconds or ISO; the ledger holds UTC with Z.
    const out = fromStatusLine(statusLine('iso-resets.json'), NOW);
    expect(out.map((o) => o.resetsAt)).toEqual([
      '2026-09-27T00:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
    ]);
  });

  it('records nothing before the first response', () => {
    // Purpose: rate_limits is absent until the first API answer.
    expect(fromStatusLine(statusLine('no-rate-limits.json'), NOW)).toEqual([]);
  });

  it('skips a window with no numeric used_percentage', () => {
    // Purpose: an entry needs usedPct or status, and the status line gives no status.
    expect(fromStatusLine(statusLine('partial.json'), NOW).map((o) => o.key)).toEqual([
      'five_hour',
    ]);
  });

  it('keeps an extra window the contract does not name', () => {
    // Purpose: a new window must flow through with no code change.
    expect(fromStatusLine(statusLine('extra-window.json'), NOW).map((o) => o.key)).toEqual([
      'five_hour',
      'seven_day_opus',
    ]);
  });

  it('clamps, drops bad reset times, and skips bad keys and values', () => {
    // Purpose: a malformed payload must never produce an entry the ledger would refuse.
    expect(fromStatusLine(statusLine('bad-values.json'), NOW)).toEqual([
      expect.objectContaining({ key: 'seven_day', usedPct: 100, resetsAt: null }),
      expect.objectContaining({ key: 'seven_day_opus', usedPct: 0, resetsAt: null }),
    ]);
  });

  it('reads a pretty-printed payload the same way', () => {
    // Purpose: whitespace changes nothing on the Node side.
    expect(fromStatusLine(statusLine('pretty.json'), NOW)).toHaveLength(2);
  });

  it('returns nothing for non-objects', () => {
    // Purpose: the recorder must survive any stdin.
    expect(fromStatusLine(null, NOW)).toEqual([]);
    expect(fromStatusLine('text', NOW)).toEqual([]);
    expect(fromStatusLine({ rate_limits: [] }, NOW)).toEqual([]);
  });
});

describe('fromTranscriptEntry', () => {
  it('reads structured quotaLimits hits (DOR-2369 validation 2)', () => {
    // Purpose: every hit since Claude Code 2.1.263 carries the window and reset as data.
    expect(transcript('structured.jsonl').map(fromTranscriptEntry)).toEqual([
      {
        kind: 'hit',
        observation: {
          key: 'five_hour',
          usedPct: null,
          resetsAt: '2026-09-18T20:30:00.000Z',
          status: 'rejected',
          observedAt: '2026-09-18T20:11:48.382Z',
          source: 'transcript',
        },
      },
      {
        kind: 'hit',
        observation: expect.objectContaining({
          key: 'seven_day',
          resetsAt: '2026-09-25T20:00:00.000Z',
        }),
      },
    ]);
  });

  it('prefers quotaLimits over the text when they disagree', () => {
    // Purpose: the structured field is the authority; the text is only a fallback.
    const [entry] = transcript('structured.jsonl') as Record<string, unknown>[];
    const edited = {
      ...entry,
      quotaLimits: { status: 'rejected', resetsAt: 1789770000, rateLimitType: 'seven_day' },
    };
    expect(fromTranscriptEntry(edited)).toEqual({
      kind: 'hit',
      observation: expect.objectContaining({
        key: 'seven_day',
        resetsAt: '2026-09-18T22:20:00.000Z',
      }),
    });
  });

  it('falls back to the text for older hits', () => {
    // Purpose: hits from 2.1.224/2.1.231 carry only the message.
    expect(
      transcript('text-only.jsonl').map((entry) => {
        const found = fromTranscriptEntry(entry);
        return found?.kind === 'hit' ? [found.observation.key, found.observation.resetsAt] : found;
      })
    ).toEqual([
      ['five_hour', '2026-08-13T20:30:00.000Z'],
      ['seven_day', '2026-08-18T20:00:00.000Z'],
      ['seven_day', '2026-08-14T17:00:00.000Z'],
    ]);
  });

  it('never records a model-limit message', () => {
    // Purpose: with no reset it would read as rejected for 7 days.
    expect(transcript('model-limit.jsonl').map(fromTranscriptEntry)).toEqual([
      { kind: 'unidentified' },
    ]);
  });

  it('ignores lines that only look like hits', () => {
    // Purpose: a user quoting the error, or a non-error line, is not a limit hit.
    expect(transcript('decoy.jsonl').map(fromTranscriptEntry)).toEqual([null, null, null]);
  });
});

describe('fromRateLimitEvent', () => {
  it('maps the sdk_event row: utilization x 100, epoch reset, status', () => {
    // Purpose: the probe records the SDK's own event by the contract's mapping.
    expect(
      fromRateLimitEvent(
        { status: 'allowed', resetsAt: 1790449200, rateLimitType: 'five_hour', utilization: 0.415 },
        NOW
      )
    ).toEqual({
      key: 'five_hour',
      usedPct: 41.5,
      resetsAt: '2026-09-26T19:00:00.000Z',
      status: 'allowed',
      observedAt: NOW.toISOString(),
      source: 'sdk_event',
    });
  });

  it('skips an event with no window type or nothing to record', () => {
    // Purpose: an entry needs a key and a usedPct or a status.
    expect(fromRateLimitEvent({ status: 'allowed' }, NOW)).toBeNull();
    expect(fromRateLimitEvent({ rateLimitType: 'five_hour', status: 'odd' }, NOW)).toBeNull();
    expect(fromRateLimitEvent({ rateLimitType: 'seven_day', status: 'rejected' }, NOW)).toEqual(
      expect.objectContaining({ usedPct: null, status: 'rejected' })
    );
  });
});

describe('parseResetText', () => {
  const chicago = (time: string) =>
    `You've hit your session limit · resets ${time} (America/Chicago)`;

  it('rolls a time-only reset past midnight', () => {
    // Purpose: "resets 1am" seen at 11pm is tomorrow, not today.
    expect(parseResetText(chicago('1am'), '2026-09-26T04:00:00.000Z', 'five_hour')).toBe(
      '2026-09-26T06:00:00.000Z'
    );
  });

  it('reads 12am as hour 0 and 12pm as hour 12', () => {
    // Purpose: a naive conversion puts 12:50am twelve hours off, and the bound then drops it.
    expect(parseResetText(chicago('12:50am'), '2026-09-26T03:00:00.000Z', 'five_hour')).toBe(
      '2026-09-26T05:50:00.000Z'
    );
    expect(parseResetText(chicago('12pm'), '2026-09-26T14:00:00.000Z', 'five_hour')).toBe(
      '2026-09-26T17:00:00.000Z'
    );
    expect(
      parseResetText(
        "You've hit your weekly limit · resets Sep 18 at 12am (America/Chicago)",
        '2026-09-15T12:00:00.000Z',
        'seven_day'
      )
    ).toBe('2026-09-18T05:00:00.000Z');
  });

  it('moves a dated reset into the next year when it would be long past', () => {
    // Purpose: a hit on Dec 30 that resets Jan 2.
    expect(
      parseResetText(
        "You've hit your weekly limit · resets Jan 2 at 3pm (America/Chicago)",
        '2026-12-30T18:00:00.000Z',
        'seven_day'
      )
    ).toBe('2027-01-02T21:00:00.000Z');
  });

  it('takes the earlier instant for a repeated wall time', () => {
    // Purpose: 1:30am happens twice on 2026-11-01 in Chicago; the first one comes first.
    expect(parseResetText(chicago('1:30am'), '2026-11-01T04:00:00.000Z', 'five_hour')).toBe(
      '2026-11-01T06:30:00.000Z'
    );
  });

  it('gives null for a wall time that does not exist', () => {
    // Purpose: 2:30am is skipped on 2027-03-14 in Chicago.
    expect(
      parseResetText(
        "You've hit your weekly limit · resets Mar 14 at 2:30am (America/Chicago)",
        '2027-03-10T12:00:00.000Z',
        'seven_day'
      )
    ).toBeNull();
  });

  it('gives null when the next such time is skipped, rather than a day later', () => {
    // Purpose: "resets 2:30am" seen just before the spring-forward jump has no reading.
    expect(
      parseResetText(
        "You've hit your weekly limit · resets 2:30am (America/Chicago)",
        '2027-03-14T06:00:00.000Z',
        'seven_day'
      )
    ).toBeNull();
  });

  it('gives null for an unknown zone, no match, or a reset outside the window', () => {
    // Purpose: a bad parse must be absent, never wrong.
    expect(
      parseResetText('resets 3pm (Mars/Olympus)', '2026-09-26T12:00:00.000Z', 'five_hour')
    ).toBeNull();
    expect(parseResetText('no reset here', '2026-09-26T12:00:00.000Z', 'five_hour')).toBeNull();
    expect(parseResetText(chicago('11am'), '2026-09-26T17:00:00.000Z', 'five_hour')).toBeNull();
  });
});
