/**
 * Unsupervised lanes (DOR-3263): drain lanes no `flow drain` watches, because
 * no live drain holds the lock and no scheduled pass ran within the stall time.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readLastPass, unsupervisedLanes, writeLastPass } from '../../scripts/drain/last-pass.ts';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const HOUR = 60 * 60_000;

/** A stored run with a drain in `phase`. */
function lane(identifier: string, phase = 'working', status = 'running') {
  return { identifier, status, drain: { v: 1, phase } };
}

const RUNS = {
  'i-1': lane('ACME-1'),
  'i-2': lane('ACME-2', 'parked'),
  'i-3': { identifier: 'ACME-3', status: 'running' },
  'i-4': lane('ACME-4', 'reviewing', 'queued'),
};

describe('unsupervisedLanes', () => {
  it('lists live drain lanes when no drain is live and no pass ran within twice the stall time', () => {
    const last = new Date(NOW.getTime() - 2 * HOUR - 60_000).toISOString();
    expect(
      unsupervisedLanes({
        runs: RUNS,
        livePid: null,
        lastPassAt: last,
        now: NOW,
        stallAfterMs: HOUR,
      })
    ).toEqual({ identifiers: ['ACME-1', 'ACME-4'], lastPassAt: last });
  });

  it('a lane is watched while a drain is live, or a scheduled pass ran recently', () => {
    // An hourly schedule: the last pass ended a little over an hour ago.
    const recent = new Date(NOW.getTime() - HOUR - 5 * 60_000).toISOString();
    expect(
      unsupervisedLanes({
        runs: RUNS,
        livePid: 4242,
        lastPassAt: null,
        now: NOW,
        stallAfterMs: HOUR,
      })
    ).toBeNull();
    expect(
      unsupervisedLanes({
        runs: RUNS,
        livePid: null,
        lastPassAt: recent,
        now: NOW,
        stallAfterMs: HOUR,
      })
    ).toBeNull();
  });

  it('never stamped counts as no pass; no lanes is nothing to say', () => {
    expect(
      unsupervisedLanes({
        runs: RUNS,
        livePid: null,
        lastPassAt: null,
        now: NOW,
        stallAfterMs: HOUR,
      })?.identifiers
    ).toEqual(['ACME-1', 'ACME-4']);
    expect(
      unsupervisedLanes({ runs: {}, livePid: null, lastPassAt: null, now: NOW, stallAfterMs: HOUR })
    ).toBeNull();
  });
});

describe('the last-pass stamp', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads back what a pass wrote, and null when there is none', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'flow-last-pass-'));
    expect(readLastPass(dir)).toBeNull();
    writeLastPass(dir, NOW);
    expect(readLastPass(dir)).toBe(NOW.toISOString());
  });
});
