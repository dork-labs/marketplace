/**
 * The live tier's cases: a short prompt for a real session, and an outcome
 * oracle that reads ONLY the fake tracker's store and the sandbox, never what
 * the agent said (spec `specs/flow-self-improvement` §1, tier `live`, DOR-2390).
 *
 * What an agent can do against the fake is bounded by the `flow` command: the
 * fake adapter's skill routes every tracker read and write through it, and it
 * has no verb to set an item's type or priority, or to park an item with
 * `agent/needs-input`. So:
 *
 * - `capture` checks the spec's outcome: exactly one new item (`flow create`),
 *   with an `origin/*` label and no `agent/ready`.
 * - `triage` and `done/follow-up` are skips that say what is missing.
 * - `decompose` and `done` run as the spec describes them.
 *
 * @module @dorkos/flow/selftest/live/cases
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FakeBacklog } from '../../tracker/fake.ts';
import type { WorkItem } from '../../tracker/types.ts';
import type { ToolUse } from './breach.ts';

/** What an oracle reads. */
export interface OracleInput {
  /** The sandbox project, after the run. */
  sandbox: string;
  /** The backlog the case started from. */
  before: FakeBacklog;
  /** The fake's store after the run. */
  after: FakeBacklog;
  /** What the session loaded and did, from its stream. */
  stream: { slashCommands?: string[]; toolUses: readonly ToolUse[] };
}

/** A case that cannot run today, with the reason; reported as a skip, never a pass. */
export interface SkippedCase {
  /** The check id, after `live/`. */
  id: string;
  /** Why it cannot run: which verb or command is missing. */
  skip: string;
}

/** A case that runs a real session. */
export interface RunnableCase {
  /** The check id, after `live/`. */
  id: string;
  /** Never set on a runnable case. */
  skip?: undefined;
  /** The prompt for `claude -p`. */
  prompt: string;
  /** `--max-turns`. */
  maxTurns: number;
  /** Fixture files, by path in the project. */
  files: Readonly<Record<string, string>>;
  /** The fake tracker's starting backlog. */
  backlog: FakeBacklog;
  /**
   * The outcome oracle.
   *
   * @returns `undefined` on a pass, otherwise what was wrong, in one line.
   */
  oracle(input: OracleInput): Promise<string | undefined> | string | undefined;
}

/** One live case. */
export type LiveCase = SkippedCase | RunnableCase;

/** Added to every prompt: the breach check fails a case that works outside its folder. */
const STAY_INSIDE = 'Work only inside the current folder, and write any file you need there.';

/** A work item with every field a reader needs. */
function item(identifier: string, overrides: Partial<WorkItem>): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: [],
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

/** The project items in the fixtures belong to. */
const PROJECT = {
  id: 'proj-selftest',
  name: 'Self-test project',
  stateCategory: 'started' as const,
  lead: 'user-human',
};

/** A backlog of the given items, acting as the fake's agent user. */
function backlog(items: WorkItem[]): FakeBacklog {
  return {
    tracker: 'fake',
    team: { key: 'FAKE', id: 'team-fake' },
    user: { id: 'user-flow-agent', name: 'Flow agent' },
    projects: [PROJECT],
    items,
  };
}

/** One item in a store, or `undefined`. */
function find(store: FakeBacklog, identifier: string): WorkItem | undefined {
  return store.items.find((i) => i.identifier === identifier);
}

/** The phrases the decomposing-work skill forbids in a task description. */
export const FORBIDDEN_PHRASES: readonly string[] = [
  'as specified',
  'from the spec',
  'see specification',
  'as described above',
  'implement according to spec',
];

/** The small, frozen spec the decompose case breaks into tasks. */
const FIXTURE_SPEC = `---
provenance: { tracker: fake, issue: FAKE-1 }
---

# Greeting command

## Overview

Add a \`greet\` command-line script that prints a greeting.

## Detailed Design

1. \`scripts/greet.mjs\` prints \`Hello, <name>!\` where \`<name>\` is its first argument,
   or \`Hello, world!\` with no argument. It exits 0.
2. \`scripts/greet.test.mjs\` runs the script with and without a name, using
   \`node:test\`, and checks both lines.

## Acceptance criteria

- \`node scripts/greet.mjs Ada\` prints \`Hello, Ada!\`.
- \`node --test scripts/\` passes.

## Changelog

- 2026-09-20: frozen.
`;

/** Every live case, in run order. */
export const LIVE_CASES: readonly LiveCase[] = [
  {
    id: 'capture',
    prompt: `/flow:capture Let people export the monthly report as a CSV file. ${STAY_INSIDE}`,
    maxTurns: 20,
    files: {},
    backlog: backlog([
      item('FAKE-1', { title: 'An item already in the tracker', stateCategory: 'backlog' }),
    ]),
    oracle: ({ before, after, stream }) => {
      // The capture counts only when flow was really there: the session
      // loaded /flow:capture, or ran the flow command.
      const loaded = stream.slashCommands?.includes('flow:capture') === true;
      const ranFlow = stream.toolUses.some(
        (u) => typeof u.input.command === 'string' && /scripts\/flow\.ts\b/.test(u.input.command)
      );
      if (!loaded && !ranFlow) {
        return 'the session neither loaded /flow:capture nor ran the flow command: the plugin may not have loaded';
      }
      const added = after.items.filter((i) => find(before, i.identifier) === undefined);
      if (added.length !== 1) {
        return `the tracker gained ${added.length} items (${added.map((i) => i.identifier).join(', ') || 'none'}), not exactly one`;
      }
      const [captured] = added;
      if (!captured.labels.some((label) => label.startsWith('origin/'))) {
        return `${captured.identifier} has no origin/* label (labels: ${captured.labels.join(', ') || 'none'})`;
      }
      if (captured.labels.includes('agent/ready')) {
        return `${captured.identifier} carries agent/ready: readiness is triage's decision`;
      }
      return undefined;
    },
  },
  {
    id: 'triage',
    skip:
      'flow has no command to set an item type or priority, or to park an item with agent/needs-input ' +
      '(only "flow release --to ready"), so a triage cannot be finished against the fake',
  },
  {
    id: 'decompose',
    prompt: `/flow:decompose specs/fixture/02-specification.md ${STAY_INSIDE}`,
    maxTurns: 40,
    files: { 'specs/fixture/02-specification.md': FIXTURE_SPEC },
    backlog: backlog([
      item('FAKE-1', {
        title: 'Add a greeting command',
        description: 'Spec: specs/fixture/02-specification.md',
        stateCategory: 'backlog',
        stateName: 'Backlog',
        priority: 3,
        project: PROJECT,
        labels: ['type/task', 'origin/human', 'stage/specify'],
      }),
    ]),
    oracle: async ({ sandbox, after }) => {
      const file = path.join(sandbox, 'specs', 'fixture', '03-tasks.json');
      if (!existsSync(file)) return 'no specs/fixture/03-tasks.json was written';
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        return `03-tasks.json is not JSON: ${(error as Error).message}`;
      }
      const { TasksFileSchema } = await import('../../tasks-schema.ts');
      const parsed = TasksFileSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `03-tasks.json fails tasks-schema.ts at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
      }
      if (parsed.data.tasks.length === 0) return '03-tasks.json has no tasks';
      for (const task of parsed.data.tasks) {
        const text = task.description.toLowerCase();
        const phrase = FORBIDDEN_PHRASES.find((p) => text.includes(p));
        if (phrase !== undefined) return `task ${task.id} summarizes with "${phrase}"`;
      }
      const labels = find(after, 'FAKE-1')?.labels ?? [];
      if (!labels.includes('stage/decompose')) {
        return `FAKE-1 does not carry stage/decompose (labels: ${labels.join(', ') || 'none'})`;
      }
      return undefined;
    },
  },
  {
    id: 'done',
    prompt: `/flow:done FAKE-2 ${STAY_INSIDE}`,
    maxTurns: 30,
    files: {},
    backlog: backlog([
      item('FAKE-2', {
        title: 'Add a greeting command',
        description:
          'Add a greeting command.\n\n## Validation criteria\n\n- It prints a greeting.\n\n' +
          '## On Completion\n\n- File a follow-up task: translate the greeting into French.',
        stateCategory: 'started',
        stateName: 'In Review',
        priority: 3,
        project: PROJECT,
        labels: ['type/task', 'origin/human', 'agent/claimed'],
      }),
    ]),
    oracle: ({ after }) => {
      const done = find(after, 'FAKE-2');
      if (done === undefined) return 'FAKE-2 is gone from the store';
      if (done.stateCategory !== 'completed') {
        return `FAKE-2 is ${done.stateCategory}, not completed`;
      }
      if (!done.labels.includes('agent/completed')) {
        return `FAKE-2 is completed without agent/completed (labels: ${done.labels.join(', ')})`;
      }
      return undefined;
    },
  },
  {
    id: 'done/follow-up',
    skip:
      'the closing-work skill does not file follow-ups through "flow create" yet, so the follow-up ' +
      'the done case asks for cannot be checked for a type, a priority, a project and a triage',
  },
];
