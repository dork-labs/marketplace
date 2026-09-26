/**
 * Recorded Composio responses for the Linear code adapter tests.
 *
 * The SHAPES are recorded: read-only calls to `composio execute
 * LINEAR_RUN_QUERY_OR_MUTATION` (composio v0.2.31, 2026-09-26) against a real
 * team, capturing the envelope (`successful`, `data.data`, `errors`, `logId`),
 * a spilled answer (`storedInFile`, `outputFilePath`, `tokenCount`, with the
 * same envelope inside the file), a GraphQL failure (exit 0,
 * `successful: false`, the message in `error`), labels as a leaf plus a
 * `parent` group, `triage` and `duplicate` state types, and team states with
 * `position`. The write-read and comment-target answers are stored whole, with
 * the query they were captured with, in the `*.recorded.json` files beside this. The VALUES are synthesized: ids, titles and people are made up,
 * and only a handful of items are kept, so nothing private is in this file.
 *
 * One SHAPE is synthesized too: the closed page's `completedAt` and `canceledAt`
 * (contract 2.1.0) were added after the recording, following Linear's schema;
 * see {@link CLOSED_PAGE}.
 */

/** The envelope Composio prints for a successful GraphQL read. */
export function okEnvelope(data: unknown): Record<string, unknown> {
  return {
    successful: true,
    data: { composio_execution_message: null, data, errors: null, extensions: null },
    error: null,
    logId: 'log_recorded0001',
  };
}

/** The envelope Composio prints when the answer is too large to print. */
export function spilledEnvelope(outputFilePath: string): Record<string, unknown> {
  return {
    successful: true,
    error: null,
    logId: 'log_recorded0002',
    storedInFile: true,
    tokenCount: 89332,
    outputFilePath,
  };
}

/** The envelope Composio prints when Linear rejects a query (the process still exits 0). */
export function failedEnvelope(message: string): Record<string, unknown> {
  const text = `Message: ${message} | Code: INPUT_ERROR | Path: issue | EXPLANATION: The provided issue ID parameter does not correspond to an existing issue.`;
  return {
    successful: false,
    data: { message: text, status_code: 400 },
    error: text,
    logId: 'log_recorded0003',
  };
}

/** The configured team. */
export const TEAM = { id: '00000000-0000-4000-8000-00000000team', key: 'DOR' };

/** Group labels as Linear returns them on an issue: the leaf name plus a parent group. */
export const LABEL = {
  typeTask: { id: 'lbl-type-task', name: 'task', parent: { name: 'type' } },
  typeResearch: { id: 'lbl-type-research', name: 'research', parent: { name: 'type' } },
  agentReady: { id: 'lbl-agent-ready', name: 'ready', parent: { name: 'agent' } },
  agentClaimed: { id: 'lbl-agent-claimed', name: 'claimed', parent: { name: 'agent' } },
  stageExecute: { id: 'lbl-stage-execute', name: 'execute', parent: { name: 'stage' } },
  originAgent: { id: 'lbl-origin-agent', name: 'from-agent', parent: { name: 'origin' } },
  bareBug: { id: 'lbl-bug', name: 'Bug', parent: null },
} as const;

/** Build one issue node in the core-fields shape. */
export function issueNode(
  identifier: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    assignee: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    description: `Body of ${identifier}.\n\n## Validation criteria\n\n* It works.`,
    estimate: null,
    id: `uuid-${identifier}`,
    identifier,
    labels: { nodes: [LABEL.typeTask] },
    parent: null,
    priority: 3,
    project: { id: 'proj-1', name: 'Example project' },
    state: { name: 'Todo', type: 'unstarted' },
    title: `Title of ${identifier}`,
    ...overrides,
  };
}

/** Core page 1 of 2 (a real `pageInfo` with a cursor). */
export const CORE_PAGE_1 = {
  team: {
    issues: {
      nodes: [
        issueNode('DOR-101', {
          labels: {
            nodes: [LABEL.typeTask, LABEL.agentReady, LABEL.stageExecute, LABEL.originAgent],
          },
          estimate: 3,
          priority: 2,
          assignee: { id: 'user-agent' },
        }),
        issueNode('DOR-102', {
          labels: { nodes: [LABEL.typeResearch, LABEL.agentClaimed] },
          state: { name: 'In Progress', type: 'started' },
          parent: { identifier: 'DOR-101' },
        }),
        issueNode('DOR-103', {
          state: { name: 'Triage', type: 'triage' },
          project: null,
          priority: 0,
        }),
      ],
      pageInfo: { endCursor: 'cursor-page-1', hasNextPage: true },
    },
  },
};

/** Core page 2 of 2: one duplicate-state item, and one from another team leaking in. */
export const CORE_PAGE_2 = {
  team: {
    issues: {
      nodes: [
        issueNode('DOR-104', { state: { name: 'Duplicate', type: 'duplicate' } }),
        issueNode('FB-7', { project: { id: 'proj-2', name: 'Another team project' } }),
        issueNode('DOR-105', { project: { id: 'proj-2', name: 'Another project' } }),
      ],
      pageInfo: { endCursor: 'cursor-page-2', hasNextPage: false },
    },
  },
};

/** The relation graph, one page. DOR-101 blocks DOR-105; DOR-102 is related to a closed item. */
export const RELATIONS_PAGE = {
  team: {
    issues: {
      nodes: [
        {
          identifier: 'DOR-101',
          relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'DOR-105' } }] },
          inverseRelations: { nodes: [] },
          children: { nodes: [{ identifier: 'DOR-102' }] },
        },
        {
          identifier: 'DOR-102',
          relations: { nodes: [{ type: 'related', relatedIssue: { identifier: 'DOR-90' } }] },
          inverseRelations: { nodes: [] },
          children: { nodes: [] },
        },
        {
          identifier: 'DOR-105',
          relations: { nodes: [{ type: 'duplicate', relatedIssue: { identifier: 'DOR-91' } }] },
          inverseRelations: {
            nodes: [
              { type: 'blocks', issue: { identifier: 'DOR-101' } },
              { type: 'related', issue: { identifier: 'OPS-3' } },
            ],
          },
          children: { nodes: [] },
        },
      ],
      pageInfo: { endCursor: 'cursor-rel-1', hasNextPage: false },
    },
  },
};

/** The referenced projects, from a direct `projects` query (which carries status). */
export const PROJECTS = {
  projects: {
    nodes: [
      {
        id: 'proj-1',
        name: 'Example project',
        state: 'started',
        status: { type: 'started' },
        lead: { id: 'user-lead' },
      },
      {
        id: 'proj-2',
        name: 'Another project',
        state: 'planned',
        status: { type: 'planned' },
        lead: null,
      },
    ],
  },
};

/**
 * Closed titles, one page. `completedAt` and `canceledAt` are SYNTHESIZED for
 * contract 2.1.0's `closedAt`, not recorded: the recorded page predates the
 * query asking for them. They follow Linear's schema (an ISO date-time on the
 * matching field, `null` on the other).
 */
export const CLOSED_PAGE = {
  team: {
    issues: {
      nodes: [
        {
          identifier: 'DOR-90',
          title: 'An earlier shipped change',
          state: { type: 'completed' },
          completedAt: '2026-09-01T10:00:00.000Z',
          canceledAt: null,
        },
        {
          identifier: 'DOR-91',
          title: 'A canceled idea',
          state: { type: 'canceled' },
          completedAt: null,
          canceledAt: '2026-09-02T11:00:00.000Z',
        },
      ],
      pageInfo: { endCursor: 'cursor-closed-1', hasNextPage: false },
    },
  },
};

/** `viewer`, as recorded. */
export const VIEWER = { viewer: { id: 'user-agent', name: 'Flow bot' } };
