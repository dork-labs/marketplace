/**
 * The Linear code adapter (`skills/linear-adapter/adapter.ts`, spec
 * `flow-cli-core` §4, task 2.2), driven by recorded Composio responses through
 * a stubbed transport. No test reaches Linear, and no write is ever sent
 * anywhere but the stub.
 *
 * @see specs/flow-cli-core/02-specification.md §4
 * @see fixtures/linear-adapter/recorded.ts for what was recorded and what was synthesized
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../scripts/config-load.ts';
import { FlowConfigSchema } from '../scripts/config-schema.ts';
import { ConfigError, EXIT, PreconditionError, TrackerError } from '../scripts/errors.ts';
import { loadCodeAdapter } from '../scripts/tracker/load.ts';
import type { AdapterContext, TrackerTransport, WorkItem } from '../scripts/tracker/types.ts';
import { validate } from '../scripts/validate-adapter.ts';
import * as linear from '../skills/linear-adapter/adapter.ts';
import {
  CLOSED_PAGE,
  CORE_PAGE_1,
  CORE_PAGE_2,
  failedEnvelope,
  issueNode,
  LABEL,
  okEnvelope,
  PROJECTS,
  RELATIONS_PAGE,
  spilledEnvelope,
  TEAM,
  TEAM_LABELS,
  TEAM_STATES,
  VIEWER,
} from './fixtures/linear-adapter/recorded.ts';

/** One call the adapter made through the transport. */
interface Call {
  cmd: string;
  args: readonly string[];
  slug: string;
  account: string;
  query: string;
  variables: Record<string, unknown>;
  operation: string;
}

/** What the stub answers for one call: an envelope, or a raw process result. */
type Answer = Record<string, unknown> | { raw: { code: number; stdout: string; stderr: string } };

/** A transport that records every call and answers from `route`. */
function stubTransport(route: (call: Call) => Answer): {
  transport: TrackerTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: TrackerTransport = {
    kind: 'cli',
    async run(cmd, args) {
      const input = JSON.parse(args[args.indexOf('-d') + 1]) as {
        query_or_mutation: string;
        variables: Record<string, unknown>;
      };
      const call: Call = {
        cmd,
        args,
        slug: args[1],
        account: args[args.indexOf('--account') + 1],
        query: input.query_or_mutation,
        variables: input.variables,
        operation: /^(?:query|mutation) (\w+)/.exec(input.query_or_mutation)?.[1] ?? '?',
      };
      calls.push(call);
      const answer = route(call);
      if ('raw' in answer) return answer.raw as { code: number; stdout: string; stderr: string };
      return { code: 0, stdout: `\n${JSON.stringify(answer, null, 2)}\n`, stderr: '' };
    },
  };
  return { transport, calls };
}

/** The recorded snapshot tracker: two core pages, one relation page, projects, closed titles. */
function snapshotRoute(call: Call): Answer {
  switch (call.operation) {
    case 'FlowSnapshotCore':
      return okEnvelope(call.variables.after === 'cursor-page-1' ? CORE_PAGE_2 : CORE_PAGE_1);
    case 'FlowSnapshotRelations':
      return okEnvelope(RELATIONS_PAGE);
    case 'FlowProjects':
      return okEnvelope(PROJECTS);
    case 'FlowSnapshotClosed':
      return okEnvelope(CLOSED_PAGE);
    case 'FlowViewer':
      return okEnvelope(VIEWER);
    default:
      throw new Error(`unexpected operation ${call.operation}`);
  }
}

/** Build the adapter over a stub, with the team configured by key and id unless overridden. */
function build(
  route: (call: Call) => Answer,
  options: { team?: { key: string | null; id: string | null }; account?: string } = {}
) {
  const { transport, calls } = stubTransport(route);
  const warnings: string[] = [];
  const ctx: AdapterContext = {
    config: FlowConfigSchema.parse({ connection: { team: options.team ?? TEAM } }),
    secrets: { trackerAccount: options.account ?? 'flow-bot' },
    transport,
    warn: (message) => warnings.push(message),
  };
  return { adapter: linear.createAdapter(ctx), calls, warnings };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-linear-adapter-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Every GraphQL document the adapter may send: data never becomes query text. */
const DOCUMENTS = new Set(
  Object.entries(linear)
    .filter(([name, value]) => /_(QUERY|MUTATION)$/.test(name) && typeof value === 'string')
    .map(([, value]) => value as string)
);

describe('the module', () => {
  it('declares contract 1.4.0 and all five capabilities', () => {
    // Purpose: the loader requires CONTRACT_VERSION and the capability list;
    // the shipped adapter serves every verb.
    expect(linear.CONTRACT_VERSION).toBe('1.4.0');
    const { adapter } = build(snapshotRoute);
    expect([...adapter.capabilities].sort()).toEqual(
      ['applyWorkState', 'comment', 'getBacklogSnapshot', 'getCurrentUser', 'getItem'].sort()
    );
  });

  it('is the adapter the loader finds for a project on the shipped Linear adapter', async () => {
    // Purpose: the real plugin layout; tracker "linear" with no project adapter
    // resolves to skills/linear-adapter/, and its adapter.ts loads and runs.
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const project = path.join(base, 'project');
    mkdirSync(path.join(project, '.agents/flow'), { recursive: true });
    writeFileSync(
      path.join(project, '.agents/flow/config.json'),
      JSON.stringify({ tracker: 'linear' })
    );
    writeFileSync(
      path.join(project, '.agents/flow/config.local.json'),
      JSON.stringify({ connection: { team: TEAM }, secrets: { trackerAccount: 'flow-bot' } })
    );
    const roots = { checkout: project, mainCheckout: null, inGit: true, pluginRoot };
    const { transport, calls } = stubTransport(snapshotRoute);
    const adapter = await loadCodeAdapter({
      roots,
      loaded: loadConfig(roots, {}),
      warn: () => {},
      transport,
    });
    expect(await adapter.getCurrentUser()).toEqual({ id: 'user-agent', name: 'Flow bot' });
    expect(calls[0].account).toBe('flow-bot');
  });

  it('refuses to build without an account to act as', () => {
    // Purpose: the account pins the acting identity; without it a write could
    // land as whoever else is connected, so it is a config error up front.
    let error: unknown;
    try {
      build(snapshotRoute, { account: '' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(EXIT.config);
  });
});

describe('getBacklogSnapshot', () => {
  it('pages core fields at 150 and relations at 40, through the team node, and merges them', async () => {
    // Purpose: the complexity cap forces two pulls; they must be paginated with
    // the cursor, scoped by team(id:), and merged back by identifier.
    const { adapter, calls } = build(snapshotRoute);
    const snapshot = await adapter.getBacklogSnapshot();

    const core = calls.filter((call) => call.operation === 'FlowSnapshotCore');
    expect(core.map((call) => call.variables)).toEqual([
      { teamId: TEAM.id, first: 150, after: null },
      { teamId: TEAM.id, first: 150, after: 'cursor-page-1' },
    ]);
    const relations = calls.filter((call) => call.operation === 'FlowSnapshotRelations');
    expect(relations.map((call) => call.variables)).toEqual([
      { teamId: TEAM.id, first: 40, after: null },
    ]);
    for (const call of [...core, ...relations]) {
      expect(call.query).toMatch(/team\(id: \$teamId\) \{\s*issues\(/);
    }

    const byId = new Map(snapshot.items.map((item) => [item.identifier, item]));
    expect(byId.get('DOR-101')?.relations).toEqual({
      blocks: ['DOR-105'],
      blockedBy: [],
      children: ['DOR-102'],
      relatedTo: [],
    });
    expect(byId.get('DOR-105')?.relations).toEqual({
      blocks: [],
      blockedBy: ['DOR-101'],
      children: [],
      relatedTo: ['OPS-3'],
      duplicateOf: 'DOR-91',
    });
    expect(snapshot).toMatchObject({ v: 1, tracker: 'linear', team: { key: 'DOR', id: TEAM.id } });
  });

  it('sends every call as composio execute with the pinned account and query_or_mutation', async () => {
    // Purpose: the verified Composio gotchas: the input key is query_or_mutation
    // (not query), and --account is on every call.
    const { adapter, calls } = build(snapshotRoute);
    await adapter.getBacklogSnapshot({ includeClosed: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cmd).toBe('composio');
      expect(call.args.slice(0, 4)).toEqual([
        'execute',
        'LINEAR_RUN_QUERY_OR_MUTATION',
        '--account',
        'flow-bot',
      ]);
      const input = JSON.parse(call.args[call.args.indexOf('-d') + 1]);
      expect(Object.keys(input).sort()).toEqual(['query_or_mutation', 'variables']);
    }
  });

  it('reads a spilled answer from its output file', async () => {
    // Purpose: a large page arrives as storedInFile with no inline data; the
    // adapter must read the file, not report an empty backlog.
    const file = path.join(base, 'LINEAR_RUN_QUERY_OR_MUTATION_OUTPUT.json');
    writeFileSync(file, JSON.stringify(okEnvelope(CORE_PAGE_1)));
    const { adapter } = build((call) => {
      if (call.operation === 'FlowSnapshotCore' && call.variables.after === null) {
        return spilledEnvelope(file);
      }
      return snapshotRoute(call);
    });
    const snapshot = await adapter.getBacklogSnapshot();
    expect(snapshot.items.map((item) => item.identifier)).toEqual([
      'DOR-101',
      'DOR-102',
      'DOR-103',
      'DOR-105',
    ]);
  });

  it('drops an identifier from another team, with a warning', async () => {
    // Purpose: one account reaches every team; another team's item must never
    // reach a write pass, so it is left out and named.
    const { adapter, warnings } = build(snapshotRoute);
    const snapshot = await adapter.getBacklogSnapshot();
    expect(snapshot.items.some((item) => item.identifier === 'FB-7')).toBe(false);
    expect(warnings.join('\n')).toMatch(/outside team DOR \(FB-7\)/);
    // Its project is not in the snapshot either: projects are narrowed to the kept items.
    expect(snapshot.projects.map((project) => project.id).sort()).toEqual(['proj-1', 'proj-2']);
  });

  it('re-namespaces flattened labels and keeps a parentless leaf bare', async () => {
    // Purpose: Linear returns "ready" with a separate "agent" parent; the
    // dispatch gate matches the literal agent/ready. A leaf with no group stays
    // bare so the audit (GRM-12) can flag it.
    const { adapter } = build((call) =>
      call.operation === 'FlowSnapshotCore'
        ? okEnvelope({
            team: {
              issues: {
                nodes: [
                  issueNode('DOR-200', {
                    labels: {
                      nodes: [LABEL.typeTask, LABEL.agentReady, LABEL.stageExecute, LABEL.bareBug],
                    },
                  }),
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          })
        : call.operation === 'FlowSnapshotRelations'
          ? okEnvelope({ team: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } })
          : snapshotRoute(call)
    );
    const [item] = (await adapter.getBacklogSnapshot()).items;
    expect(item.labels).toEqual(['type/task', 'agent/ready', 'stage/execute', 'Bug']);
    expect(item.agentDisposition).toBe('ready');
    expect(item.type).toBe('task');
  });

  it('maps triage to backlog and leaves out a duplicate-state item with a warning', async () => {
    // Purpose: Linear's triage type is the un-triaged holding state (backlog);
    // its duplicate type maps to no category, so it is named for the groom.
    const { adapter, warnings } = build(snapshotRoute);
    const snapshot = await adapter.getBacklogSnapshot();
    const triaged = snapshot.items.find((item) => item.identifier === 'DOR-103');
    expect(triaged).toMatchObject({ stateCategory: 'backlog', stateName: 'Triage' });
    expect(snapshot.items.some((item) => item.identifier === 'DOR-104')).toBe(false);
    expect(warnings.join('\n')).toMatch(
      /DOR-104 is in a Linear state flow cannot represent \(duplicate\)/
    );
  });

  it('normalizes fields and projects, and passes the conformance invariants INV-1..5', async () => {
    // Purpose: the code must produce exactly what the prose adapter promises,
    // proved by the same harness every adapter must pass.
    const { adapter } = build(snapshotRoute);
    const snapshot = await adapter.getBacklogSnapshot();
    const first = snapshot.items.find((item) => item.identifier === 'DOR-101') as WorkItem;
    expect(first).toMatchObject({
      id: 'uuid-DOR-101',
      type: 'task',
      stateCategory: 'unstarted',
      priority: 2,
      size: 3,
      assignee: 'user-agent',
      agentDisposition: 'ready',
      createdAt: '2026-09-20T10:00:00.000Z',
      project: {
        id: 'proj-1',
        name: 'Example project',
        stateCategory: 'started',
        lead: 'user-lead',
      },
    });
    expect(
      'size' in (snapshot.items.find((item) => item.identifier === 'DOR-102') as WorkItem)
    ).toBe(false);
    expect(snapshot.items.find((item) => item.identifier === 'DOR-102')?.parent).toBe('DOR-101');
    expect(snapshot.projects.find((project) => project.id === 'proj-2')?.stateCategory).toBe(
      'unstarted'
    );

    expect(validate(snapshot.items)).toEqual({ ok: true, failures: [] });
  });

  it('returns closed titles only when asked, through the same team node', async () => {
    // Purpose: the groom's duplicate and shipped passes need closed titles;
    // other callers should not pay for them.
    const plain = build(snapshotRoute);
    expect((await plain.adapter.getBacklogSnapshot()).closed).toEqual([]);
    expect(plain.calls.some((call) => call.operation === 'FlowSnapshotClosed')).toBe(false);

    const withClosed = build(snapshotRoute);
    const snapshot = await withClosed.adapter.getBacklogSnapshot({ includeClosed: true });
    expect(snapshot.closed).toEqual([
      { identifier: 'DOR-90', title: 'An earlier shipped change', stateCategory: 'completed' },
      { identifier: 'DOR-91', title: 'A canceled idea', stateCategory: 'canceled' },
    ]);
    const closedCall = withClosed.calls.find((call) => call.operation === 'FlowSnapshotClosed');
    expect(closedCall?.variables).toEqual({ teamId: TEAM.id, first: 250, after: null });
  });

  it('resolves the team id from the key when only the key is set', async () => {
    // Purpose: config.local.json often carries only the key; the id comes from
    // one teams read, and every issue read is still scoped by team(id:).
    const { adapter, calls } = build(
      (call) =>
        call.operation === 'FlowTeamByKey'
          ? okEnvelope({ teams: { nodes: [{ id: TEAM.id, key: 'DOR' }] } })
          : snapshotRoute(call),
      { team: { key: 'DOR', id: null } }
    );
    await adapter.getBacklogSnapshot();
    expect(calls[0]).toMatchObject({ operation: 'FlowTeamByKey', variables: { key: 'DOR' } });
    expect(calls.filter((call) => call.operation === 'FlowTeamByKey')).toHaveLength(1);
    expect(calls.find((call) => call.operation === 'FlowSnapshotCore')?.variables.teamId).toBe(
      TEAM.id
    );
  });

  it('refuses when no team is configured', async () => {
    // Purpose: an unscoped read would be workspace-wide, so no team is a config error.
    const { adapter } = build(snapshotRoute, { team: { key: null, id: null } });
    const error = await rejection(adapter.getBacklogSnapshot());
    expect(error).toBeInstanceOf(ConfigError);
  });
});

describe('failures', () => {
  it('turns a GraphQL failure (exit 0, successful false) into a TrackerError', async () => {
    // Purpose: Composio exits 0 when Linear rejects a query; checking only the
    // exit code would read the failure as an empty answer.
    const { adapter } = build(() => failedEnvelope('Cannot query field "bogus" on type "Issue".'));
    const error = await rejection(adapter.getBacklogSnapshot());
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/Cannot query field "bogus"/);
    expect((error as Error).message).not.toMatch(/EXPLANATION/);
  });

  it('turns a non-zero exit into a TrackerError that hides the account', async () => {
    // Purpose: an unknown account exits 1 with a message naming it; the account
    // is a secret and must not reach stderr.
    const { adapter } = build(() => ({
      raw: {
        code: 1,
        stdout: '',
        stderr:
          '\u001b[40m Error \u001b[39m No connected account matched "flow-bot" for toolkit "linear".',
      },
    }));
    const error = await rejection(adapter.getCurrentUser());
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/No connected account matched "<trackerAccount>"/);
    expect((error as Error).message).not.toContain('flow-bot');
  });

  it('turns a GraphQL errors array into a TrackerError', async () => {
    // Purpose: a partial answer with errors must not pass as a complete read.
    const { adapter } = build(() => ({
      successful: true,
      data: { data: { viewer: null }, errors: [{ message: 'Authentication required' }] },
      error: null,
    }));
    expect(((await rejection(adapter.getCurrentUser())) as Error).message).toMatch(
      /Authentication required/
    );
  });
});

describe('getCurrentUser and getItem', () => {
  it('reads the viewer', async () => {
    // Purpose: identity "auto" resolves to this account.
    const { adapter } = build(snapshotRoute);
    expect(await adapter.getCurrentUser()).toEqual({ id: 'user-agent', name: 'Flow bot' });
  });

  it('reads one item with its latest comments, oldest first', async () => {
    // Purpose: flow status shows a parked question from the latest comments;
    // Linear returns them newest first, the contract wants them oldest first.
    const { adapter, calls } = build(() =>
      okEnvelope({
        issue: {
          ...issueNode('DOR-101', { labels: { nodes: [LABEL.typeTask, LABEL.agentClaimed] } }),
          state: { name: 'In Progress', type: 'started' },
          team: TEAM,
          project: {
            id: 'proj-1',
            name: 'Example project',
            state: 'started',
            status: { type: 'started' },
            lead: null,
          },
          relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'DOR-105' } }] },
          inverseRelations: { nodes: [] },
          children: { nodes: [] },
          comments: {
            nodes: [
              {
                id: 'c2',
                body: 'second',
                createdAt: '2026-09-21T10:00:00.000Z',
                user: { id: 'user-a' },
              },
              { id: 'c1', body: 'first', createdAt: '2026-09-20T10:00:00.000Z', user: null },
            ],
          },
        },
      })
    );
    const item = await adapter.getItem('DOR-101', { comments: 2 });
    expect(calls[0]).toMatchObject({
      operation: 'FlowItemComments',
      variables: { id: 'DOR-101', comments: 2 },
    });
    expect(item).toMatchObject({
      identifier: 'DOR-101',
      stateCategory: 'started',
      labels: ['type/task', 'agent/claimed'],
      relations: { blocks: ['DOR-105'] },
      project: { id: 'proj-1', stateCategory: 'started' },
    });
    expect(item.comments).toEqual([
      { id: 'c1', author: '', body: 'first', createdAt: '2026-09-20T10:00:00.000Z' },
      { id: 'c2', author: 'user-a', body: 'second', createdAt: '2026-09-21T10:00:00.000Z' },
    ]);
  });

  it("reports a missing item and another team's item as precondition failures", async () => {
    // Purpose: "not found" is exit 5 (the item), not exit 4 (the tracker); and
    // an item from another team is never acted on.
    const missing = build(() => failedEnvelope('Entity not found: Issue'));
    const notFound = await rejection(missing.adapter.getItem('DOR-999'));
    expect(notFound).toBeInstanceOf(PreconditionError);

    const foreign = build(() =>
      okEnvelope({
        issue: {
          ...issueNode('FB-7'),
          team: { id: 'other-team', key: 'FB' },
          relations: { nodes: [] },
        },
      })
    );
    const elsewhere = await rejection(foreign.adapter.getItem('FB-7'));
    expect(elsewhere).toBeInstanceOf(PreconditionError);
    expect((elsewhere as Error).message).toMatch(/another Linear team/);
  });
});

/** A write-read answer: the issue as it is NOW, plus the team's labels and states. */
function writeRead(labels: object[], state = { id: 'st-todo', type: 'unstarted' }) {
  return okEnvelope({
    issue: {
      id: 'uuid-DOR-101',
      identifier: 'DOR-101',
      team: TEAM,
      state,
      labels: { nodes: labels },
    },
    team: { labels: { nodes: TEAM_LABELS }, states: { nodes: TEAM_STATES } },
  });
}

/** The item as the caller last saw it (older than the tracker). */
const STALE_ITEM: WorkItem = {
  id: 'uuid-DOR-101',
  identifier: 'DOR-101',
  title: 'Title of DOR-101',
  description: '',
  type: 'task',
  stateCategory: 'unstarted',
  stateName: 'Todo',
  parent: null,
  relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
  labels: ['type/task', 'agent/ready', 'stage/execute'],
};

describe('applyWorkState', () => {
  it('sends ONE issueUpdate whose labelIds come from a fresh read, with the lowest-position state', async () => {
    // Purpose: labelIds replaces the whole set, so it must be the union from a
    // read taken just before the write (keeping a label another session added,
    // repo/app), with only the named families replaced; the state is the team's
    // lowest-position state of the target category (In Progress, not In Review).
    const { adapter, calls } = build((call) =>
      call.operation === 'FlowWriteRead'
        ? writeRead([LABEL.typeTask, LABEL.agentReady, LABEL.stageExecute, LABEL.repoApp])
        : okEnvelope({ issueUpdate: { success: true } })
    );
    await adapter.applyWorkState(STALE_ITEM, {
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
      stageLabel: null,
    });

    expect(calls.map((call) => call.operation)).toEqual(['FlowWriteRead', 'FlowApplyWorkState']);
    expect(calls[0].variables).toEqual({ id: 'uuid-DOR-101', teamId: TEAM.id });
    const update = calls[1];
    expect(update.variables).toEqual({
      id: 'uuid-DOR-101',
      input: {
        labelIds: [LABEL.typeTask.id, LABEL.repoApp.id, LABEL.agentClaimed.id],
        stateId: 'st-progress',
      },
    });
  });

  it('leaves the state alone when the item is already in the target category', async () => {
    // Purpose: moving an In Review item to "started" would drag it back to In
    // Progress; a same-category change sends labels only.
    const { adapter, calls } = build((call) =>
      call.operation === 'FlowWriteRead'
        ? writeRead([LABEL.typeTask, LABEL.agentClaimed], { id: 'st-review', type: 'started' })
        : okEnvelope({ issueUpdate: { success: true } })
    );
    await adapter.applyWorkState(STALE_ITEM, {
      stateCategory: 'started',
      stageLabel: 'stage/verify',
    });
    expect(calls[1].variables.input).toEqual({
      labelIds: [LABEL.typeTask.id, LABEL.agentClaimed.id, 'lbl-stage-verify'],
    });
  });

  it('sends nothing when the tracker already matches the change', async () => {
    // Purpose: a re-run converges without a write.
    const { adapter, calls } = build(() =>
      writeRead([LABEL.typeTask, LABEL.agentClaimed], { id: 'st-progress', type: 'started' })
    );
    await adapter.applyWorkState(STALE_ITEM, {
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
    });
    expect(calls.map((call) => call.operation)).toEqual(['FlowWriteRead']);
  });

  it('refuses a label the team does not have, naming it, and writes nothing', async () => {
    // Purpose: flow never creates labels; a missing one is a failed write that
    // says which label to create.
    const { adapter, calls } = build(() => writeRead([LABEL.typeTask]));
    const error = await rejection(
      adapter.applyWorkState(STALE_ITEM, { stageLabel: 'stage/nonexistent' })
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/no "stage\/nonexistent" label/);
    expect(calls.map((call) => call.operation)).toEqual(['FlowWriteRead']);
  });

  it('fails loudly when Linear does not confirm the update', async () => {
    // Purpose: a write is never reported as success unless Linear says so.
    const { adapter } = build((call) =>
      call.operation === 'FlowWriteRead'
        ? writeRead([LABEL.typeTask, LABEL.agentReady])
        : okEnvelope({ issueUpdate: { success: false } })
    );
    const error = await rejection(
      adapter.applyWorkState(STALE_ITEM, { agentLabel: 'agent/claimed' })
    );
    expect(error).toBeInstanceOf(TrackerError);
  });
});

describe('comment', () => {
  it('posts through commentCreate with the issue id and body as variables', async () => {
    // Purpose: the body goes in a variable, so a `$word` or a provenance line in
    // it can never break or alter the query.
    const { adapter, calls } = build(() => okEnvelope({ commentCreate: { success: true } }));
    const body = 'Released: run `echo $sessionId` first.\n<!-- agent:provenance {"v":1} -->';
    await adapter.comment(STALE_ITEM, body);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'FlowComment',
      variables: { issueId: 'uuid-DOR-101', body },
    });
  });
});

describe('GraphQL hygiene', () => {
  it('never puts data into query text: every document is a constant and every $variable is declared and passed', async () => {
    // Purpose: Composio rejects a query holding a `$word` with no matching
    // variable, and interpolated text is an injection path. Drive every method,
    // including titles and bodies that contain `$`, and check each call.
    const routes = (call: Call): Answer => {
      switch (call.operation) {
        case 'FlowWriteRead':
          return writeRead([LABEL.typeTask, LABEL.agentReady]);
        case 'FlowApplyWorkState':
          return okEnvelope({ issueUpdate: { success: true } });
        case 'FlowComment':
          return okEnvelope({ commentCreate: { success: true } });
        case 'FlowItem':
          return okEnvelope({
            issue: {
              ...issueNode('DOR-101', { title: 'Costs $5 and ${x}' }),
              team: TEAM,
              relations: { nodes: [] },
            },
          });
        default:
          return snapshotRoute(call);
      }
    };
    const { adapter, calls } = build(routes, { team: { key: 'DOR', id: TEAM.id } });
    await adapter.getCurrentUser();
    await adapter.getBacklogSnapshot({ includeClosed: true });
    await adapter.getItem('DOR-101');
    await adapter.applyWorkState(
      { ...STALE_ITEM, title: '$title' },
      { agentLabel: 'agent/claimed' }
    );
    await adapter.comment(STALE_ITEM, 'body with $sessionId and ${client}');

    expect(new Set(calls.map((call) => call.operation)).size).toBeGreaterThanOrEqual(9);
    for (const call of calls) {
      expect(
        DOCUMENTS.has(call.query),
        `${call.operation} sent a query that is not a constant`
      ).toBe(true);
      const header = /^(?:query|mutation) \w+(\([^)]*\))?/.exec(call.query)?.[1] ?? '';
      const declared = new Set([...header.matchAll(/\$(\w+)/g)].map((m) => m[1]));
      const used = new Set([...call.query.matchAll(/\$(\w+)/g)].map((m) => m[1]));
      expect([...used].sort(), `${call.operation} uses an undeclared $variable`).toEqual(
        [...declared].sort()
      );
      for (const name of declared) {
        expect(
          Object.hasOwn(call.variables, name),
          `${call.operation} does not pass $${name}`
        ).toBe(true);
      }
    }
  });
});
