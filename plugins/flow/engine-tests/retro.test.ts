/**
 * The retro (DOR-2392, spec `specs/flow-self-improvement` §3): every measure
 * against a fixture journal with a known answer, overall and per runtime; an
 * empty window reading "no data", never 0; usageTrend per account and window;
 * each proposal rule firing at its threshold and not just below it; and
 * fingerprints that stay the same from run to run.
 *
 * The fixture journal (`fixtures/retro/journal.jsonl`) carries the kind of
 * note the journal exists to catch: `flow usage probe` could not see the main
 * account because DorkOS registered it as its implicit default, and the probe
 * had to be pointed at the account by hand. With a second `flow-usage` note,
 * the note-cluster rule surfaces it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { JournalLineSchema, type JournalLine } from '../scripts/journal-schema.ts';
import {
  CAPTURE_MIN_SAMPLES,
  CLEAN_DROP_POINTS,
  NO_DATA,
  computeMeasures,
  durationMs,
  median,
  noteClusters,
  noteKey,
  parseProposals,
  proposalFingerprint,
  repeatedOracleErrors,
  runRetro,
  selftestRegressions,
  splitWindows,
  usageTrend,
  windowFor,
  worseMeasures,
  type HistoryEntry,
  type Measures,
  type RetroInput,
} from '../scripts/retro.ts';
import type { WorkItem } from '../scripts/work-item.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'retro');
const NOW = new Date('2026-09-26T12:00:00.000Z');
const WINDOW = windowFor('7d', NOW)!;

/** Read a JSONL fixture. */
function jsonl<T>(name: string): T[] {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

const LINES = jsonl<JournalLine>('journal.jsonl');
const HISTORY = jsonl<HistoryEntry>('selftest-history.jsonl');

/** An open item in the snapshot. */
function item(identifier: string, labels: string[], createdAt?: string): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: identifier,
    description: '',
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

const SNAPSHOT: WorkItem[] = [
  item('FAKE-1', ['type/task', 'agent/ready'], '2026-09-19T12:00:00.000Z'),
  item('FAKE-2', ['type/task', 'agent/ready'], '2026-09-19T12:00:00.000Z'),
  item('FAKE-3', [], '2026-09-24T00:00:00.000Z'),
  item('FAKE-5', ['type/research'], '2026-09-13T12:00:00.000Z'),
  item('FAKE-6', ['origin/from-agent']),
];

/** The fixture as retro input. */
function fixtureInput(over: Partial<RetroInput> = {}): RetroInput {
  const { journal, prevJournal } = splitWindows(LINES, WINDOW);
  return {
    window: WINDOW,
    journal,
    prevJournal,
    selftestHistory: HISTORY,
    snapshot: SNAPSHOT,
    words: { total: 1000, overTarget: 50 },
    previous: { pluginWords: { total: 990, overTarget: 40 } },
    ...over,
  };
}

/** A journal line for a threshold case. */
function line(fields: Record<string, unknown>, ts = '2026-09-22T00:00:00.000Z'): JournalLine {
  return { v: 1, ts, flow: '0.26.0', runtime: 'claude-code', ...fields } as JournalLine;
}

describe('the fixture', () => {
  it('holds only lines the journal schema accepts', () => {
    for (const l of LINES)
      expect(JournalLineSchema.safeParse(l).success, JSON.stringify(l)).toBe(true);
  });

  it('splits into this window and the one before', () => {
    const { journal, prevJournal } = splitWindows(LINES, WINDOW);
    expect(prevJournal).toHaveLength(6);
    expect(journal).toHaveLength(28);
  });
});

describe('measures, against the fixture', () => {
  const m = computeMeasures(fixtureInput());

  it('readyVsUntriaged counts open ready items and open items with no type', () => {
    expect(m.readyVsUntriaged).toEqual({
      now: { ready: 2, untriaged: 2 },
      prev: NO_DATA,
      byRuntime: null,
    });
  });

  it('captureToReadyDaysMedian: median days from creation to readied, per runtime', () => {
    const c = m.captureToReadyDaysMedian;
    expect([c.now, c.prev]).toEqual([2, 1]);
    expect(c.byRuntime['claude-code']).toEqual({ now: 1.5, prev: 1 });
    expect(c.byRuntime.codex).toEqual({ now: 4, prev: NO_DATA });
    expect(c.byRuntime.opencode).toEqual({ now: NO_DATA, prev: NO_DATA });
  });

  it('firstReviewCleanPct: share of round-1 reviews that came back clean', () => {
    const r = m.firstReviewCleanPct;
    expect([r.now, r.prev]).toEqual([33.33, 100]);
    expect(r.byRuntime['claude-code'].now).toBe(50);
    expect(r.byRuntime.codex.now).toBe(0);
    expect(r.byRuntime.unknown.now).toBe(NO_DATA);
  });

  it('reviewCatchCount: blockers plus should-fix over every review; zero is not no data', () => {
    const r = m.reviewCatchCount;
    expect([r.now, r.prev]).toEqual([6, 0]);
    expect(r.byRuntime['claude-code'].now).toBe(3);
    expect(r.byRuntime.codex.now).toBe(3);
  });

  it('innocentEjections: ejected and innocent only', () => {
    const r = m.innocentEjections;
    expect([r.now, r.prev]).toEqual([3, NO_DATA]);
    expect(r.byRuntime.codex.now).toBe(0);
    expect(r.byRuntime.opencode.now).toBe(NO_DATA);
  });

  it('pluginWords: the word counts, with the earlier report beside them', () => {
    expect(m.pluginWords).toEqual({
      now: { total: 1000, overTarget: 50 },
      prev: { total: 990, overTarget: 40 },
      byRuntime: null,
    });
  });

  it('oracleErrors: counted by oracle, per runtime', () => {
    const r = m.oracleErrors;
    expect(r.now).toEqual({ 'flow.ts next': 2, 'flow.ts audit': 1 });
    expect(r.prev).toEqual({});
    expect(r.byRuntime.opencode.now).toEqual({ 'flow.ts next': 1 });
    expect(r.byRuntime.codex.now).toEqual({});
    expect(r.byRuntime.unknown.now).toBe(NO_DATA);
  });

  it('captureToReadySamples: how many readied items the median could see', () => {
    const r = m.captureToReadySamples;
    expect([r.now, r.prev]).toEqual([3, 1]);
    expect(r.byRuntime['claude-code'].now).toBe(2);
  });

  it('operatorWaitHoursMedian: median of the ended waits', () => {
    const r = m.operatorWaitHoursMedian;
    expect([r.now, r.prev]).toEqual([2, NO_DATA]);
  });

  it('usageTrend: first, last and peak usedPct, and each time the window ran out', () => {
    const { journal, prevJournal } = splitWindows(LINES, WINDOW);
    expect(usageTrend(journal, prevJournal)).toEqual({
      'claude-code:default': {
        five_hour: {
          now: { first: 20, last: 100, peak: 100, hitLimit: 2, samples: 6 },
          prev: { first: 30, last: 30, peak: 30, hitLimit: 0, samples: 1 },
        },
        seven_day: {
          now: { first: 40, last: 55, peak: 55, hitLimit: 0, samples: 2 },
          prev: NO_DATA,
        },
      },
    });
  });
});

describe('usageTrend counting', () => {
  it('counts a window that ran out again after a reset it never sampled below 100', () => {
    const snap = (ts: string, usedPct: number, resetsAt: string) =>
      line(
        {
          kind: 'usage.snapshot',
          accountRuntime: 'codex',
          account: 'work',
          windows: { five_hour: { usedPct, resetsAt } },
        },
        ts
      );
    const trend = usageTrend(
      [
        snap('2026-09-21T01:00:00.000Z', 100, '2026-09-21T05:00:00.000Z'),
        snap('2026-09-21T02:00:00.000Z', 100, '2026-09-21T05:00:00.000Z'),
        snap('2026-09-21T06:00:00.000Z', 100, '2026-09-21T10:00:00.000Z'),
      ],
      []
    );
    expect(trend['codex:work'].five_hour.now).toMatchObject({ hitLimit: 2, samples: 3 });
    expect(trend['codex:work'].five_hour.prev).toBe(NO_DATA);
  });
});

describe('an empty window', () => {
  it('reads "no data" for every measure, never 0', () => {
    const empty = computeMeasures({
      window: WINDOW,
      journal: [],
      prevJournal: [],
      selftestHistory: [],
      snapshot: null,
      words: null,
    });
    for (const [name, measure] of Object.entries(empty)) {
      expect([name, measure.now, measure.prev]).toEqual([name, NO_DATA, NO_DATA]);
      if (measure.byRuntime !== null) {
        for (const pair of Object.values(measure.byRuntime)) {
          expect(pair).toEqual({ now: NO_DATA, prev: NO_DATA });
        }
      }
    }
    expect(usageTrend([], [])).toEqual({});
    expect(median([])).toBe(NO_DATA);
  });
});

describe('proposal rules', () => {
  it('rule 1 fires at two notes on one skill and not at one', () => {
    const note = (text: string, skill?: string) =>
      line({ kind: 'note', noteKind: 'friction', text, ...(skill ? { skill } : {}) });
    expect(noteClusters([note('a', 'flow-usage')])).toEqual([]);
    const two = noteClusters([note('a', 'flow-usage'), note('b', 'flow-usage')]);
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({
      rule: 'note-cluster',
      fingerprint: proposalFingerprint('note-cluster', 'skill:flow-usage'),
    });
  });

  it('rule 1 groups notes with no skill by their first five content words', () => {
    expect(noteKey('The probe could NOT see the main account, again!')).toBe(
      'probe see main account again'
    );
    const note = (text: string) => line({ kind: 'note', noteKind: 'confusion', text });
    expect(
      noteClusters([
        note('The probe could not see the main account'),
        note('Probe: could not see the MAIN account.'),
      ])
    ).toHaveLength(1);
    expect(
      noteClusters([note('The probe could not see'), note('A different thing broke')])
    ).toEqual([]);
  });

  it('rule 2 fires at two repeats of one oracle error and not at one', () => {
    const err = (errorClass: string) =>
      line({ kind: 'oracle.error', oracle: 'flow.ts next', exit: 4, errorClass });
    expect(repeatedOracleErrors([err('down'), err('other')])).toEqual([]);
    expect(repeatedOracleErrors([err('down'), err('down')])).toEqual([
      expect.objectContaining({
        rule: 'oracle-error',
        fingerprint: proposalFingerprint('oracle-error', 'flow.ts next:down'),
      }),
    ]);
  });

  it('rule 3 fires on pass-then-fail, skipping a fast-only run, and never on a check no earlier run ran', () => {
    const found = selftestRegressions(HISTORY, WINDOW).map((p) => p.title);
    expect(found).toEqual([
      'self-test check config passed before and fails now',
      'self-test check scenarios/lifecycle/codex passed before and fails now',
    ]);
    // Without the full run on 09-10, the only earlier run was --tier fast: no regression.
    const fastOnly = selftestRegressions(HISTORY.slice(1), WINDOW).map((p) => p.title);
    expect(fastOnly).toEqual(['self-test check config passed before and fails now']);
  });

  it('rule 3 makes one proposal per check id, however many places it fails in', () => {
    const entry = (startedAt: string, checks: HistoryEntry['checks']): HistoryEntry => ({
      startedAt,
      tiers: ['fast'],
      checks,
    });
    const history = [
      entry('2026-09-18T12:00:00.000Z', [
        { id: 'doc-lint/words', status: 'pass', fingerprint: 'aaaaaaaaaaaa' },
      ]),
      entry('2026-09-25T12:00:00.000Z', [
        { id: 'doc-lint/words', status: 'fail', fingerprint: 'bbbbbbbbbbbb', detail: 'a.md grew' },
        { id: 'doc-lint/words', status: 'fail', fingerprint: 'cccccccccccc' },
      ]),
    ];
    const found = selftestRegressions(history, WINDOW);
    expect(found).toHaveLength(1);
    expect(found[0].fingerprint).toBe(proposalFingerprint('selftest-regression', 'doc-lint/words'));
    expect(found[0].evidence.map((e) => e.text)).toEqual([
      'doc-lint/words passed',
      'doc-lint/words failed: a.md grew',
      'doc-lint/words failed: fingerprint cccccccccccc',
    ]);
    // So the weekly skill's --input round trip is accepted, not refused as a repeat.
    expect(parseProposals(found)).toEqual(found);
  });

  it('rule 3 does not fire on fail then fail', () => {
    const history: HistoryEntry[] = [
      {
        startedAt: '2026-09-18T12:00:00.000Z',
        tiers: ['fast'],
        checks: [{ id: 'config', status: 'fail' }],
      },
      {
        startedAt: '2026-09-25T12:00:00.000Z',
        tiers: ['fast'],
        checks: [{ id: 'config', status: 'fail' }],
      },
    ];
    expect(selftestRegressions(history, WINDOW)).toEqual([]);
  });

  it('rule 3 ignores a latest run outside the window', () => {
    const later = windowFor('7d', new Date('2026-10-20T00:00:00.000Z'))!;
    expect(selftestRegressions(HISTORY, later)).toEqual([]);
  });

  /** Measures with only the rule-4 inputs set. */
  function measures(over: {
    clean?: [number, number];
    ready?: [number, number];
    samples?: [number, number];
    ejections?: number;
    words?: [number, number];
  }): Measures {
    const base = computeMeasures({
      window: WINDOW,
      journal: [],
      prevJournal: [],
      selftestHistory: [],
      snapshot: null,
      words: null,
    });
    if (over.clean) {
      base.firstReviewCleanPct.prev = over.clean[0];
      base.firstReviewCleanPct.now = over.clean[1];
    }
    if (over.ready) {
      base.captureToReadyDaysMedian.prev = over.ready[0];
      base.captureToReadyDaysMedian.now = over.ready[1];
      const [prev, now] = over.samples ?? [CAPTURE_MIN_SAMPLES, CAPTURE_MIN_SAMPLES];
      base.captureToReadySamples.prev = prev;
      base.captureToReadySamples.now = now;
    }
    if (over.ejections !== undefined) base.innocentEjections.now = over.ejections;
    if (over.words) {
      base.pluginWords.prev = { total: over.words[0], overTarget: 0 };
      base.pluginWords.now = { total: over.words[1], overTarget: 0 };
    }
    return base;
  }
  const subjects = (m: Measures) => worseMeasures(m, WINDOW.until).map((p) => p.title);

  it('rule 4: first-review clean share down 15 points fires, 14.99 does not', () => {
    expect(subjects(measures({ clean: [50, 50 - CLEAN_DROP_POINTS] }))).toHaveLength(1);
    expect(subjects(measures({ clean: [50, 35.01] }))).toEqual([]);
  });

  it('rule 4: a drop of exactly 15 points fires even when float subtraction lands just short', () => {
    // 70.1 - 55.1 is 14.999999999999993 in floating point.
    expect(70.1 - 55.1).toBeLessThan(CLEAN_DROP_POINTS);
    expect(subjects(measures({ clean: [70.1, 55.1] }))).toHaveLength(1);
  });

  it('rule 4: capture-to-ready up 50% fires, 49% does not, and a zero baseline never does', () => {
    expect(subjects(measures({ ready: [2, 3] }))).toHaveLength(1);
    expect(subjects(measures({ ready: [2, 2.98] }))).toEqual([]);
    expect(subjects(measures({ ready: [0, 5] }))).toEqual([]);
  });

  it('rule 4: capture-to-ready needs 5 samples in each window, since its median is biased', () => {
    expect(subjects(measures({ ready: [2, 3], samples: [5, 5] }))).toHaveLength(1);
    expect(subjects(measures({ ready: [2, 3], samples: [4, 5] }))).toEqual([]);
    expect(subjects(measures({ ready: [2, 3], samples: [5, 4] }))).toEqual([]);
  });

  it('rule 4: three innocent ejections fire, two do not', () => {
    expect(subjects(measures({ ejections: 3 }))).toHaveLength(1);
    expect(subjects(measures({ ejections: 2 }))).toEqual([]);
  });

  it('rule 4: prose words up by one fires, unchanged does not, no data never does', () => {
    expect(subjects(measures({ words: [1000, 1001] }))).toHaveLength(1);
    expect(subjects(measures({ words: [1000, 1000] }))).toEqual([]);
    expect(subjects(measures({}))).toEqual([]);
  });
});

describe('the whole retro on the fixture', () => {
  it('proposes the flow-usage cluster, the repeated error, two regressions and three worse measures', () => {
    const { proposals } = runRetro(fixtureInput());
    expect(proposals.map((p) => p.rule)).toEqual([
      'note-cluster',
      'oracle-error',
      'selftest-regression',
      'selftest-regression',
      'measure-worse',
      'measure-worse',
      'measure-worse',
    ]);
    const cluster = proposals[0];
    expect(cluster.title).toBe('2 agent notes about the flow-usage skill');
    expect(cluster.evidence[0].text).toMatch(/implicit default account/);
    // The note from the previous window is not evidence.
    expect(cluster.evidence.map((e) => e.ts)).toEqual([
      '2026-09-22T09:00:00.000Z',
      '2026-09-24T09:00:00.000Z',
    ]);
  });

  it('gives the same fingerprints on every run, from rule and subject alone', () => {
    const a = runRetro(fixtureInput()).proposals.map((p) => p.fingerprint);
    const b = runRetro(fixtureInput()).proposals.map((p) => p.fingerprint);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a[0]).toBe(
      createHash('sha1').update('note-cluster:skill:flow-usage').digest('hex').slice(0, 12)
    );
    // A third note changes the evidence, never the fingerprint.
    const more = runRetro(
      fixtureInput({
        journal: [
          ...splitWindows(LINES, WINDOW).journal,
          line({ kind: 'note', noteKind: 'friction', text: 'again', skill: 'flow-usage' }),
        ],
      })
    ).proposals[0];
    expect(more.fingerprint).toBe(a[0]);
    expect(more.evidence).toHaveLength(3);
  });
});

describe('durations and edited proposals', () => {
  it('reads 7d, 48h and 2w, and refuses anything else', () => {
    expect(durationMs('48h')).toBe(48 * 3600 * 1000);
    expect(durationMs('2w')).toBe(14 * 24 * 3600 * 1000);
    expect(durationMs('7')).toBeNull();
    expect(windowFor('0d', NOW)).toBeNull();
  });

  it('accepts a report or a list, and names the first problem otherwise', () => {
    const { proposals } = runRetro(fixtureInput());
    expect(parseProposals({ proposals })).toEqual(proposals);
    expect(parseProposals(proposals)).toEqual(proposals);
    expect(parseProposals({})).toMatch(/list of proposals/);
    expect(parseProposals([{ ...proposals[0], fingerprint: 'nope' }])).toMatch(/fingerprint/);
    expect(parseProposals([{ ...proposals[0], rule: 'vibes' }])).toMatch(/rule/);
    expect(parseProposals([{ ...proposals[0], evidence: [] }])).toMatch(/evidence/);
    expect(parseProposals([proposals[0], proposals[0]])).toMatch(/repeats/);
  });
});
