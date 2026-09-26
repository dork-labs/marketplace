/**
 * Reading a cli session's stream log and transcript (spec
 * `flow-handoff-dispatch` §2.3, task 2.1): `ingestStreamLog` maps a recorded
 * `rate_limit_event` to S1's `sdk_event` observation, writes it to the
 * account's ledger (never for the ambient account) and advances the offset
 * over complete lines only; `streamLimit` and `transcriptLimit` read recorded
 * tails.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRANSCRIPT_TAIL_BYTES,
  ingestStreamLog,
  streamLimit,
  transcriptLimit,
} from '../../scripts/drain/stream-log.ts';
import type { SessionHandle } from '../../scripts/launchers/types.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flow-stream-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const init = line({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none' });
/** A recorded event, shaped as Claude Code 2.1.282's `SDKRateLimitEvent`. */
const event = line({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1790000000,
    rateLimitType: 'five_hour',
    utilization: 0.83,
    isUsingOverage: false,
  },
  uuid: 'u1',
  session_id: 's1',
});
const NOW = new Date('2026-09-26T18:10:00.000Z');

function handle(logFile: string, account: string | null, logOffset = 0): SessionHandle {
  return {
    host: 'cli',
    runtime: 'claude-code',
    sessionId: 's1',
    account,
    cwd: dir,
    logFile,
    logOffset,
  };
}

describe('ingestStreamLog', () => {
  // The observation follows S1's sdk_event row exactly, lands in the account's
  // ledger file, and the offset moves to the end of what was read.
  it('maps a rate_limit_event to an sdk_event observation and writes the ledger', async () => {
    const logFile = path.join(dir, 's1.jsonl');
    writeFileSync(logFile, init + event);
    const result = await ingestStreamLog(handle(logFile, 'claude3'), {
      dorkHome: dir,
      now: () => NOW,
    });
    expect(result.observations).toEqual([
      {
        key: 'five_hour',
        usedPct: 83,
        resetsAt: new Date(1790000000 * 1000).toISOString(),
        status: 'allowed_warning',
        observedAt: NOW.toISOString(),
        source: 'sdk_event',
      },
    ]);
    expect(result.offset).toBe(Buffer.byteLength(init + event));
    expect(result.status).toBe('written');
    const ledger = JSON.parse(
      readFileSync(path.join(dir, 'runtimes', 'claude-code', 'usage', 'claude3.json'), 'utf8')
    );
    expect(ledger.windows.five_hour).toMatchObject({ usedPct: 83, source: 'sdk_event' });
  });

  // A second call reads only what was appended, and a half-written line
  // waits for the next call instead of being skipped.
  it('reads from logOffset and stops before a torn line', async () => {
    const logFile = path.join(dir, 's1.jsonl');
    writeFileSync(logFile, init);
    const first = await ingestStreamLog(handle(logFile, 'claude3'), {
      dorkHome: dir,
      now: () => NOW,
    });
    expect(first.observations).toEqual([]);
    appendFileSync(logFile, event + event.slice(0, 20));
    const record = vi.fn(async () => ({ status: 'written' as const, warnings: [] }));
    const second = await ingestStreamLog(handle(logFile, 'claude3', first.offset), {
      dorkHome: dir,
      now: () => NOW,
      record,
    });
    expect(second.observations).toHaveLength(1);
    expect(second.offset).toBe(Buffer.byteLength(init + event));
    expect(record).toHaveBeenCalledTimes(1);
    // The reading lands in Claude Code's per-runtime ledger for that account.
    expect(record).toHaveBeenCalledWith(dir, 'claude-code', 'claude3', expect.any(Array), NOW);
  });

  // The ambient account has no registry id and so no ledger file.
  it('writes nothing for the ambient account', async () => {
    const logFile = path.join(dir, 's1.jsonl');
    writeFileSync(logFile, init + event);
    const record = vi.fn();
    const result = await ingestStreamLog(handle(logFile, null), {
      dorkHome: dir,
      now: () => NOW,
      record,
    });
    expect(result.observations).toHaveLength(1);
    expect(result.status).toBe('skipped');
    expect(record).not.toHaveBeenCalled();
  });
  // A codex or opencode handle is skipped: S1's ledger here is Claude Code's,
  // and the per-runtime ledger is not written by this function (RUNTIMES.md R2).
  it('skips a non-Claude handle without touching the ledger', async () => {
    const logFile = path.join(dir, 's1.jsonl');
    writeFileSync(logFile, init + event);
    const record = vi.fn();
    const result = await ingestStreamLog(
      { ...handle(logFile, 'codex2'), runtime: 'codex' },
      { dorkHome: dir, now: () => NOW, record }
    );
    expect(result).toMatchObject({ status: 'skipped', observations: [] });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('streamLimit', () => {
  // A rejected event after the last init is a limit with its window and reset.
  it('reads a rejected rate_limit_event after the last init', () => {
    const logFile = path.join(dir, 's1.jsonl');
    const rejected = line({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1790000000, rateLimitType: 'seven_day' },
    });
    writeFileSync(logFile, init + rejected);
    expect(streamLimit(logFile)).toEqual({
      window: 'seven_day',
      resetsAt: new Date(1790000000 * 1000).toISOString(),
    });
  });

  // A resume starts a new run: a limit before its init no longer counts.
  it('ignores a limit from before the last init, and a warning is not a limit', () => {
    const logFile = path.join(dir, 's1.jsonl');
    const rejected = line({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
    });
    writeFileSync(logFile, init + rejected + init + event);
    expect(streamLimit(logFile)).toBeNull();
  });

  // A result with HTTP 429 and no event is a limit with an unknown window.
  it('reads a 429 result with no event as a limit of unknown window', () => {
    const logFile = path.join(dir, 's1.jsonl');
    writeFileSync(logFile, init + line({ type: 'result', is_error: true, api_error_status: 429 }));
    expect(streamLimit(logFile)).toEqual({ window: null, resetsAt: null });
  });
});

describe('transcriptLimit', () => {
  const hit = (text: string, extra: Record<string, unknown> = {}) =>
    line({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'rate_limit',
      timestamp: '2026-09-26T18:05:00.000Z',
      message: { content: [{ type: 'text', text }] },
      ...extra,
    });
  const user = line({ type: 'user', message: { role: 'user', content: 'go on' } });

  // The recorded tail's structured entry: the window from quotaLimits.
  it('finds the latest rate_limit entry after the last user message', () => {
    const file = path.join(dir, 't.jsonl');
    writeFileSync(
      file,
      user +
        hit("You've hit your weekly limit", {
          quotaLimits: { rateLimitType: 'seven_day', resetsAt: 1790000000 },
        })
    );
    expect(transcriptLimit(file)).toEqual({
      window: 'seven_day',
      resetsAt: new Date(1790000000 * 1000).toISOString(),
    });
  });

  // A user message after the hit means the session went on: no limit.
  it('returns null when a user message follows the hit', () => {
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, hit("You've hit your session limit") + user);
    expect(transcriptLimit(file)).toBeNull();
  });

  // The window comes from the text when there is no structure; a limit naming
  // no window is still a limit, with window null.
  it('reads the window from the text, and a model limit as window null', () => {
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, user + hit("You've hit your session limit"));
    expect(transcriptLimit(file)?.window).toBe('five_hour');
    writeFileSync(file, user + hit("You've reached your Fable limit"));
    expect(transcriptLimit(file)).toEqual({ window: null, resetsAt: null });
  });

  // Only the last 64 KB is read: a hit further back than that is not seen.
  it('reads only the last 64 KB', () => {
    const file = path.join(dir, 't.jsonl');
    const filler = line({
      type: 'assistant',
      message: { content: 'x'.repeat(TRANSCRIPT_TAIL_BYTES) },
    });
    writeFileSync(file, user + hit("You've hit your session limit") + filler);
    expect(transcriptLimit(file)).toBeNull();
    expect(transcriptLimit(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});
