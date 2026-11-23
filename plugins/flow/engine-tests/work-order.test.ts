/**
 * The work order (DOR-5063), pinned by `conformance/work-order/work-order.cases.json`:
 * every case's expected order, the same output whatever the input order, and
 * one flip per field showing where it moves an item.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FlowConfigSchema } from '../scripts/config-schema.ts';
import type { ProjectInfo, WorkItem } from '../scripts/work-item.ts';
import {
  computeWorkOrder,
  explainIssue,
  orderConfigOf,
  rankOfIssue,
  type OrderConfig,
  type WorkOrder,
  type WorkOrderInput,
} from '../scripts/work-order.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(here, '..', 'conformance', 'work-order', 'work-order.cases.json');

/** An item as the case file writes it. */
interface ShortItem {
  id: string;
  p?: number;
  state?: 'backlog' | 'unstarted' | 'started';
  size?: number;
  project?: string | null;
  labels?: string[];
  blockedBy?: string[];
  blocks?: string[];
  due?: string;
  created?: string;
  triage?: boolean;
  pin?: WorkItem['pin'] | null;
}

/** A project as the case file writes it. */
interface ShortProject {
  id: string;
  name: string;
  status: ProjectInfo['statusType'];
  priority?: number;
  target?: string;
  labels?: string[];
}

interface CaseFile {
  now: string;
  base: { projects: ShortProject[]; items: ShortItem[] };
  cases: {
    name: string;
    orderKeys?: OrderConfig['orderKeys'];
    patch?: Record<string, Partial<ShortItem>>;
    expected: {
      issues: string[];
      held?: Record<string, string>;
      needsTriage?: Record<string, string[]>;
      inFlight?: string[];
      dorian?: string[];
      inherits?: Record<string, string>;
      banners?: string[];
    };
  }[];
  flips: { name: string; item: string; set: Partial<ShortItem>; expected: string }[];
}

const file = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as CaseFile;
const CONFIG = orderConfigOf(FlowConfigSchema.parse({}));

/** Expand one short project. */
function project(short: ShortProject): ProjectInfo {
  return {
    id: short.id,
    name: short.name,
    slugId: `slug-${short.id}`,
    statusType: short.status,
    labels: short.labels ?? [],
    blockedBy: [],
    ...(short.priority === undefined ? {} : { priority: short.priority as 1 }),
    ...(short.target === undefined ? {} : { targetDate: short.target }),
  };
}

/** Expand one short item. */
function item(short: ShortItem, projects: readonly ShortProject[]): WorkItem {
  const state = short.state ?? 'unstarted';
  const proj = projects.find((p) => p.id === short.project);
  const out: WorkItem = {
    id: `id-${short.id}`,
    identifier: short.id,
    title: `Title of ${short.id}`,
    description: '',
    type: 'task',
    stateCategory: state,
    stateName: state === 'started' ? 'In Progress' : state === 'unstarted' ? 'Todo' : 'Backlog',
    parent: null,
    relations: {
      blocks: short.blocks ?? [],
      blockedBy: short.blockedBy ?? [],
      children: [],
      relatedTo: [],
    },
    labels: short.labels ?? [],
  };
  if (short.p !== undefined) out.priority = short.p as WorkItem['priority'];
  if (short.size !== undefined) out.size = short.size;
  if (proj !== undefined) {
    out.project = {
      id: proj.id,
      name: proj.name,
      stateCategory:
        proj.status === 'started' ? 'started' : proj.status === 'planned' ? 'unstarted' : 'backlog',
    };
  }
  if (short.due !== undefined) out.dueDate = short.due;
  if (short.created !== undefined) out.createdAt = short.created;
  if (short.triage === true) out.triage = true;
  if (short.pin) out.pin = short.pin;
  return out;
}

/** Build the input for the base fixture with patches applied. */
function input(
  patch: Record<string, Partial<ShortItem>> = {},
  orderKeys?: OrderConfig['orderKeys']
): WorkOrderInput {
  const shortItems = file.base.items.map((short) => ({ ...short, ...(patch[short.id] ?? {}) }));
  return {
    items: shortItems.map((short) => item(short, file.base.projects)),
    projects: file.base.projects.map(project),
    config: orderKeys === undefined ? CONFIG : { ...CONFIG, orderKeys },
    now: file.now,
  };
}

/** A small seeded shuffle, so a failure reproduces. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('work order cases (conformance/work-order/work-order.cases.json)', () => {
  for (const testCase of file.cases) {
    describe(testCase.name, () => {
      const given = input(testCase.patch, testCase.orderKeys);
      const order = computeWorkOrder(given);
      const { expected } = testCase;

      it('ranks the expected order', () => {
        expect(order.issues.map((issue) => issue.identifier)).toEqual(expected.issues);
        expect(order.issues.map((issue) => issue.place)).toEqual(
          expected.issues.map((_, i) => i + 1)
        );
      });

      it('lists what does not rank, with reasons', () => {
        if (expected.held) {
          expect(Object.fromEntries(order.held.map((h) => [h.identifier, h.reason]))).toEqual(
            expected.held
          );
        }
        if (expected.needsTriage) {
          expect(
            Object.fromEntries(order.needsTriage.map((n) => [n.identifier, n.missing]))
          ).toEqual(expected.needsTriage);
        }
        if (expected.inFlight) {
          expect(order.inFlight.map((f) => f.identifier)).toEqual(expected.inFlight);
        }
        if (expected.dorian) {
          expect(order.dorian.map((d) => d.identifier)).toEqual(expected.dorian);
        }
        if (expected.banners) expect(order.banners).toEqual(expected.banners);
      });

      it('names inherited places', () => {
        for (const [heir, from] of Object.entries(expected.inherits ?? {})) {
          const issue = order.issues.find((i) => i.identifier === heir);
          expect(issue?.inheritsFrom).toBe(from);
          expect(issue?.why[0]).toEqual({ key: 'inherits', text: `inherits ${from}'s place` });
        }
      });

      it('gives the same output whatever the input order', () => {
        for (const seed of [1, 7, 42, 1234, 99991]) {
          const again = computeWorkOrder({
            ...given,
            items: shuffled(given.items, seed),
            projects: shuffled(given.projects, seed + 1),
          });
          expect(again).toEqual(order);
        }
      });
    });
  }
});

describe('one flip per field moves the item where the case file says', () => {
  const base = computeWorkOrder(input());
  for (const flip of file.flips) {
    it(flip.name, () => {
      const before = rankOfIssue(base, flip.item);
      const after = rankOfIssue(computeWorkOrder(input({ [flip.item]: flip.set })), flip.item);
      expect(after).toBe(flip.expected);
      expect(after).not.toBe(before);
    });
  }
});

describe('the base order, in words', () => {
  const order: WorkOrder = computeWorkOrder(input());

  it('shows who pinned and why, beside the reason', () => {
    expect(order.issues[0].why[0]).toEqual({
      key: 'pin',
      text: 'pinned: ships with 0.142 (by Ana Fictional, Nov 22)',
    });
  });

  it('writes each key in plain words', () => {
    const six = order.issues.find((i) => i.identifier === 'ABC-6');
    expect(six?.why.map((r) => r.text)).toEqual([
      'Must (High, Todo)',
      'due Nov 30',
      'project #2 Search',
      'size 2',
      'filed Nov 10',
    ]);
    const nine = order.issues.find((i) => i.identifier === 'ABC-9');
    expect(nine?.why.map((r) => r.text)).toContain('unblocks ABC-8');
    expect(nine?.band).toBe('must');
  });

  it('Urgent skips the project key', () => {
    const three = order.issues.find((i) => i.identifier === 'ABC-3');
    expect(three?.why.some((r) => r.key === 'projectRank')).toBe(false);
  });

  it('carries readiness on every ranked item without moving it', () => {
    expect(order.issues.every((i) => typeof i.readiness.ready === 'boolean')).toBe(true);
    // ABC-9 is ranked and unblocked: ready. A pinned item with no size still ranks, unready.
    expect(order.issues.find((i) => i.identifier === 'ABC-9')?.readiness).toEqual({
      ready: true,
      reasons: [],
    });
    const unsizedPin = computeWorkOrder(input({ 'ABC-16': { size: undefined } }));
    expect(unsizedPin.issues[0]).toMatchObject({
      identifier: 'ABC-16',
      readiness: { ready: false, reasons: ['needs a size'] },
    });
  });

  it('stamps the time it was given, never the clock', () => {
    expect(order.generatedAt).toBe(file.now);
  });

  it('compares issue numbers as numbers: ABC-99 before ABC-100', () => {
    const ids = order.issues.map((i) => i.identifier);
    expect(ids.indexOf('ABC-99')).toBeLessThan(ids.indexOf('ABC-100'));
  });

  it('explains a place and what would move it up', () => {
    const lines = explainIssue(input(), 'ABC-1');
    expect(lines[0]).toBe('ABC-1 is #7: Title of ABC-1');
    expect(lines.at(-1)).toContain('Above it: ABC-9.');
    expect(explainIssue(input(), 'ABC-8')).toEqual(['unranked: held by ABC-9']);
  });

  it('prints the place, or unranked with the reason', () => {
    expect(rankOfIssue(order, 'ABC-16')).toBe('1');
    expect(rankOfIssue(order, 'ABC-13')).toBe('unranked: waits for project Mobile');
    expect(rankOfIssue(order, 'ABC-404')).toBe('unranked: not an open item of the team');
  });
});

describe('degrades on bad adapter data instead of throwing', () => {
  const fields = Object.keys(input().items[0]) as (keyof WorkItem)[];
  for (const field of fields) {
    for (const bad of [undefined, null, 42, 'x', {}]) {
      it(`${String(field)} = ${JSON.stringify(bad)}`, () => {
        const given = input();
        const broken = given.items.map((it, i) =>
          i % 2 === 0 ? ({ ...it, [field]: bad } as unknown as WorkItem) : it
        );
        expect(() => computeWorkOrder({ ...given, items: broken })).not.toThrow();
      });
    }
  }

  it('survives a missing project list and junk entries', () => {
    const given = input();
    expect(() =>
      computeWorkOrder({
        ...given,
        items: [...given.items, null as unknown as WorkItem],
        projects: null as unknown as ProjectInfo[],
      })
    ).not.toThrow();
  });
});
