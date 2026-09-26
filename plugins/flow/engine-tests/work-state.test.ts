/**
 * The work-state rule (spec `flow-cli-core` §5, F10; task 1.3).
 *
 * `scripts/work-state.ts` is the only place the rule "state category = progress,
 * one `agent/*` = ownership, one `stage/*` = where the next session resumes
 * (only while not started)" is written. The writers (`flow claim`, `release`,
 * `done`, `stage`) use {@link projectionFor} and nothing else; the audit uses
 * {@link stateCoherence}. So these tests pin:
 *
 *   - every row of the §5 projection table, plus the resume-stage precedence;
 *   - every `STATE-n` check red on a seeded item and green on its fixed twin;
 *   - `deriveStage`, the recovery rule for a run with no local record;
 *   - that the module stays import-free apart from the zero-dependency
 *     `errors.ts`, so `audit-backlog.ts` can import it before `npm install`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  deriveStage,
  projectionFor,
  stateCoherence,
  type StageTable,
  type WorkStateItem,
} from '../scripts/work-state.ts';
import { PreconditionError } from '../scripts/errors.ts';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** The default `stages` table, as `StagesSchema` resolves it (labels and categories only). */
const STAGES: StageTable = {
  capture: { label: 'stage/capture' },
  triage: { label: 'stage/triage' },
  ideate: { label: 'stage/ideate' },
  specify: { label: 'stage/specify' },
  decompose: { label: 'stage/decompose' },
  execute: { label: 'stage/execute', stateCategory: 'started' },
  verify: { label: 'stage/verify', stateCategory: 'started' },
  review: { stateCategory: 'started' },
  done: { label: 'stage/done', stateCategory: 'completed' },
};

describe('projectionFor: the §5 table', () => {
  // Purpose: a claim starts the item, marks it claimed and clears every stage
  // label, because the stage lives on FlowRun.stage while the item is started.
  it('claim -> started, agent/claimed, stage removed', () => {
    expect(projectionFor({ type: 'claim' }, { stages: STAGES })).toEqual({
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
      stageLabel: null,
    });
  });

  // Purpose: releasing to ready must leave a stage label, or GRM-10 fails.
  it('release --to ready -> unstarted, agent/ready, stage/<resume stage>', () => {
    expect(
      projectionFor({ type: 'release', to: 'ready', stage: 'verify' }, { stages: STAGES })
    ).toEqual({
      stateCategory: 'unstarted',
      agentLabel: 'agent/ready',
      stageLabel: 'stage/verify',
    });
  });

  // Purpose: releasing to ready with no known resume stage is refused with a
  // precondition error (exit 5, "pass --stage"), never a write GRM-10 rejects.
  it('release --to ready with no resume stage throws PreconditionError', () => {
    expect(() => projectionFor({ type: 'release', to: 'ready' }, { stages: STAGES })).toThrow(
      PreconditionError
    );
    expect(() => projectionFor({ type: 'release', to: 'ready' }, { stages: STAGES })).toThrow(
      /--stage/
    );
  });

  // Purpose: releasing to none clears ownership and still records where to
  // resume when that is known.
  it('release --to none with a resume stage -> unstarted, agent removed, stage label', () => {
    expect(
      projectionFor({ type: 'release', to: 'none' }, { stages: STAGES, runStage: 'execute' })
    ).toEqual({
      stateCategory: 'unstarted',
      agentLabel: null,
      stageLabel: 'stage/execute',
    });
  });

  // Purpose: releasing to none with no known stage leaves stage labels alone
  // (the key is absent, not null), and does not throw.
  it('release --to none with no resume stage leaves the stage label absent', () => {
    const change = projectionFor({ type: 'release', to: 'none' }, { stages: STAGES });
    expect(change).toEqual({ stateCategory: 'unstarted', agentLabel: null });
    expect('stageLabel' in change).toBe(false);
  });

  // Purpose: done closes the item, marks it completed and clears every stage label.
  it('done -> completed, agent/completed, stage removed', () => {
    expect(projectionFor({ type: 'done' }, { stages: STAGES })).toEqual({
      stateCategory: 'completed',
      agentLabel: 'agent/completed',
      stageLabel: null,
    });
  });

  // Purpose: moving to a started stage sets the category and removes every
  // stage label instead of setting one (the 2.0.0 contract change).
  it('stage to a started stage -> started, agent untouched, stage removed', () => {
    const change = projectionFor({ type: 'stage', stage: 'verify' }, { stages: STAGES });
    expect(change).toEqual({ stateCategory: 'started', stageLabel: null });
    expect('agentLabel' in change).toBe(false);
  });

  // Purpose: a started stage with no label (review) behaves the same way.
  it('stage to review (started, no label) -> started, stage removed', () => {
    expect(projectionFor({ type: 'stage', stage: 'review' }, { stages: STAGES })).toEqual({
      stateCategory: 'started',
      stageLabel: null,
    });
  });

  // Purpose: moving to a completed stage closes the item and clears stage labels.
  it('stage to a completed stage -> completed, stage removed', () => {
    expect(projectionFor({ type: 'stage', stage: 'done' }, { stages: STAGES })).toEqual({
      stateCategory: 'completed',
      stageLabel: null,
    });
  });

  // Purpose: moving to a not-started stage with no category leaves the state
  // alone and sets that stage's label.
  it('stage to a stage with no category -> state absent, its label', () => {
    const change = projectionFor({ type: 'stage', stage: 'specify' }, { stages: STAGES });
    expect(change).toEqual({ stageLabel: 'stage/specify' });
    expect('stateCategory' in change).toBe(false);
    expect('agentLabel' in change).toBe(false);
  });

  // Purpose: a not-started stage that does carry a category (a custom config)
  // sets it alongside the label.
  it('stage to a stage whose category is unstarted -> unstarted, its label', () => {
    const stages: StageTable = {
      ...STAGES,
      triage: { label: 'stage/triage', stateCategory: 'unstarted' },
    };
    expect(projectionFor({ type: 'stage', stage: 'triage' }, { stages })).toEqual({
      stateCategory: 'unstarted',
      stageLabel: 'stage/triage',
    });
  });

  // Purpose: the stage label comes from config, not a guessed `stage/<key>`.
  it('uses the configured label, not stage/<key>', () => {
    const stages: StageTable = { ...STAGES, specify: { label: 'stage/spec' } };
    expect(projectionFor({ type: 'stage', stage: 'specify' }, { stages })).toEqual({
      stageLabel: 'stage/spec',
    });
  });

  // Purpose: a stage that is not a key of config `stages` is refused.
  it('stage to an unknown stage throws PreconditionError', () => {
    expect(() => projectionFor({ type: 'stage', stage: 'nope' }, { stages: STAGES })).toThrow(
      PreconditionError
    );
  });
});

describe('projectionFor: resume-stage precedence', () => {
  // Purpose: an explicit --stage beats the run record and the removed label.
  it('explicit stage wins over FlowRun.stage and the removed label', () => {
    expect(
      projectionFor(
        { type: 'release', to: 'ready', stage: 'specify' },
        { stages: STAGES, runStage: 'execute', removedStageLabel: 'stage/verify' }
      ).stageLabel
    ).toBe('stage/specify');
  });

  // Purpose: with no --stage, FlowRun.stage beats the removed label.
  it('FlowRun.stage wins over the removed label', () => {
    expect(
      projectionFor(
        { type: 'release', to: 'ready' },
        { stages: STAGES, runStage: 'execute', removedStageLabel: 'stage/verify' }
      ).stageLabel
    ).toBe('stage/execute');
  });

  // Purpose: the stage label the claim removed is the last resort.
  it('falls back to the stage label the claim removed', () => {
    expect(
      projectionFor(
        { type: 'release', to: 'ready' },
        { stages: STAGES, removedStageLabel: 'stage/decompose' }
      ).stageLabel
    ).toBe('stage/decompose');
  });

  // Purpose: a run parked at a stage with no label (review) cannot name a
  // stage label, so the next source is used.
  it('skips a FlowRun.stage that has no label', () => {
    expect(
      projectionFor(
        { type: 'release', to: 'ready' },
        { stages: STAGES, runStage: 'review', removedStageLabel: 'stage/verify' }
      ).stageLabel
    ).toBe('stage/verify');
  });

  // Purpose: an explicit --stage that names no labelled stage is an error, not
  // a silent fall-through to another source.
  it('an explicit stage with no label throws PreconditionError', () => {
    expect(() =>
      projectionFor(
        { type: 'release', to: 'none', stage: 'review' },
        { stages: STAGES, runStage: 'execute' }
      )
    ).toThrow(PreconditionError);
  });
});

describe('stateCoherence: STATE-1..5', () => {
  /** Build an item with just the fields the rule reads. */
  function item(stateCategory: string, labels: string[]): WorkStateItem {
    return { stateCategory, labels };
  }

  /** The check ids a set of violations names. */
  function checks(target: WorkStateItem): string[] {
    return stateCoherence(target).map((v) => v.check);
  }

  // Purpose: each case seeds exactly one breach (red), and its fixed twin is
  // the same item with the one change that repairs it (green).
  const cases: { check: string; bad: WorkStateItem; fixed: WorkStateItem }[] = [
    {
      check: 'STATE-1',
      bad: item('unstarted', ['stage/specify', 'stage/decompose', 'agent/ready']),
      fixed: item('unstarted', ['stage/decompose', 'agent/ready']),
    },
    {
      check: 'STATE-2',
      bad: item('started', ['stage/execute', 'agent/claimed']),
      fixed: item('started', ['agent/claimed']),
    },
    {
      check: 'STATE-3',
      bad: item('unstarted', ['agent/claimed', 'stage/execute']),
      fixed: item('started', ['agent/claimed']),
    },
    {
      check: 'STATE-4',
      bad: item('started', ['agent/ready']),
      fixed: item('started', ['agent/claimed']),
    },
    {
      check: 'STATE-5',
      bad: item('started', ['agent/completed']),
      fixed: item('completed', ['agent/completed']),
    },
  ];

  for (const { check, bad, fixed } of cases) {
    it(`${check} is red on the seeded item and green on its fixed twin`, () => {
      expect(checks(bad)).toEqual([check]);
      expect(checks(fixed)).toEqual([]);
    });
  }

  // Purpose: STATE-5 applies on every open category, backlog included.
  it('STATE-5 fires on a backlog item', () => {
    expect(checks(item('backlog', ['agent/completed']))).toEqual(['STATE-5']);
  });

  // Purpose: closed items are out of scope; a canceled item with stray labels
  // reports nothing.
  it('ignores closed items', () => {
    expect(checks(item('completed', ['stage/a', 'stage/b', 'agent/ready']))).toEqual([]);
    expect(checks(item('canceled', ['stage/execute', 'agent/claimed']))).toEqual([]);
  });

  // Purpose: more than one agent/* is GRM-13's job and is not repeated here.
  it('does not report two agent/* labels', () => {
    expect(checks(item('unstarted', ['agent/ready', 'agent/needs-input', 'stage/x']))).toEqual([]);
  });

  // Purpose: every breach on one item is reported, each with a detail line.
  it('reports every breach on one item', () => {
    const violations = stateCoherence(item('started', ['stage/a', 'stage/b', 'agent/ready']));
    expect(violations.map((v) => v.check)).toEqual(['STATE-1', 'STATE-2', 'STATE-4']);
    for (const v of violations) expect(v.detail.length).toBeGreaterThan(0);
  });

  // Purpose: the audit feeds this raw snapshot data, so a malformed item
  // degrades to "no violations" rather than throwing.
  it('degrades on a malformed item', () => {
    expect(stateCoherence({ stateCategory: 'started', labels: 'agent/ready' })).toEqual([]);
    expect(stateCoherence({})).toEqual([]);
  });
});

describe('deriveStage', () => {
  // Purpose: with no run record, an open PR on the item's branch means verify.
  it('open PR -> verify', () => {
    expect(deriveStage({ hasOpenPr: true })).toBe('verify');
  });

  // Purpose: otherwise the work is still being built.
  it('no open PR -> execute', () => {
    expect(deriveStage({ hasOpenPr: false })).toBe('execute');
  });
});

describe('work-state.ts stays dependency-free', () => {
  // Purpose: audit-backlog.ts imports this module and must run before
  // `npm install`, so the only import allowed is the zero-dependency errors.ts,
  // which itself imports nothing.
  it('imports only ./errors.ts, which imports nothing', () => {
    const importPattern =
      /^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
    const specifiers = (file: string): string[] =>
      [...readFileSync(path.join(scriptsDir, file), 'utf8').matchAll(importPattern)].map(
        (m) => m[1] ?? m[2]
      );
    expect(specifiers('work-state.ts')).toEqual(['./errors.ts']);
    expect(specifiers('errors.ts')).toEqual([]);
  });
});
