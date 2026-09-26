/**
 * A stateful Linear stand-in for the code-adapter contract suite: a transport
 * that answers the Linear adapter's GraphQL documents from an in-memory team,
 * in the exact shapes recorded from Linear (the write-read and comment-target
 * answers in this folder, and the helpers in `recorded.ts`).
 *
 * It exists so one contract suite can run against the real Linear adapter and
 * the fake tracker alike: whatever the fake does, the Linear adapter does
 * against a Linear-shaped answer. It is a test fixture, not a Linear clone; it
 * answers only the operations the adapter sends and refuses any other.
 */

import { readFileSync } from 'node:fs';

import type { TrackerTransport } from '../../../scripts/tracker/types.ts';
import { failedEnvelope, issueNode, okEnvelope, TEAM, VIEWER } from './recorded.ts';

/** A recorded label, as Linear gives it. */
interface RecordedLabel {
  id: string;
  name: string;
  isGroup?: boolean;
  parent: { name: string } | null;
}

/** A recorded workflow state. */
interface RecordedState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/** The recorded write-read answer: the team's real states and labels. */
const WRITE_READ = JSON.parse(
  readFileSync(new URL('./write-read.recorded.json', import.meta.url), 'utf8')
) as {
  response: {
    data: {
      data: {
        team: { states: { nodes: RecordedState[] }; teamLabels: { nodes: RecordedLabel[] } };
      };
    };
  };
};

const RECORDED_TEAM = WRITE_READ.response.data.data.team;

/** The recorded team's labels by namespaced name (`agent/ready`, or a bare `Bug`). */
const LABELS = new Map(
  RECORDED_TEAM.teamLabels.nodes
    .filter((label) => !label.isGroup)
    .map((label) => [label.parent ? `${label.parent.name}/${label.name}` : label.name, label])
);

/** The same labels by id. */
const LABELS_BY_ID = new Map([...LABELS].map(([name, label]) => [label.id, name]));

/** One issue the simulated team holds. */
export interface SimIssue {
  identifier: string;
  title: string;
  /** The team it belongs to; another team's key makes it foreign. */
  team: { id: string; key: string };
  /** A recorded state id, for example `st-todo`. */
  stateId: string;
  /** Namespaced label names; each must be a recorded team label. */
  labels: string[];
  /** Comments, oldest first. */
  comments: { id: string; body: string; createdAt: string; userId: string }[];
}

/** What {@link simulateLinear} returns. */
export interface LinearSimulation {
  /** The transport to hand the Linear adapter. */
  transport: TrackerTransport;
  /** The live issues. */
  issues: SimIssue[];
  /** How many writes (updates and comments) Linear accepted. */
  writes(): number;
}

/** The recorded team state with this id. */
function state(id: string): RecordedState {
  const found = RECORDED_TEAM.states.nodes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`the recorded team has no state ${id}`);
  return found;
}

/** The label nodes for namespaced names, as an issue's `labels` connection carries them. */
function labelNodes(names: readonly string[]) {
  return names.map((name) => {
    const label = LABELS.get(name);
    if (label === undefined) throw new Error(`the recorded team has no ${name} label`);
    const { isGroup: _group, ...node } = label;
    return node;
  });
}

/** The recorded team's state id for a category's first state (for seeding). */
export function seedStateId(category: string, name?: string): string {
  const states = RECORDED_TEAM.states.nodes
    .filter(
      (candidate) => candidate.type === category && (name === undefined || candidate.name === name)
    )
    .sort((a, b) => a.position - b.position);
  if (states.length === 0) throw new Error(`the recorded team has no ${category} state`);
  return states[0].id;
}

/**
 * Build a simulated Linear team over `issues`.
 *
 * @param issues - The team's issues (changed in place by writes).
 * @returns The transport, the live issues and a write counter.
 */
export function simulateLinear(issues: SimIssue[]): LinearSimulation {
  let writes = 0;
  let commentSeq = 0;
  const find = (id: unknown) =>
    issues.find((issue) => issue.identifier === id || `uuid-${issue.identifier}` === id);
  const isOpen = (issue: SimIssue) =>
    !['completed', 'canceled'].includes(state(issue.stateId).type);

  const fullNode = (issue: SimIssue) => ({
    ...issueNode(issue.identifier, {
      title: issue.title,
      labels: { nodes: labelNodes(issue.labels) },
      state: { name: state(issue.stateId).name, type: state(issue.stateId).type },
      project: null,
    }),
    team: issue.team,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    children: { nodes: [] },
  });

  const answer = (operation: string, variables: Record<string, unknown>): unknown => {
    switch (operation) {
      case 'FlowViewer':
        return okEnvelope(VIEWER);
      case 'FlowItem':
      case 'FlowItemComments': {
        const issue = find(variables.id);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        const node: Record<string, unknown> = fullNode(issue);
        if (operation === 'FlowItemComments') {
          // Linear returns the latest `first` comments, newest first.
          const latest = [...issue.comments].reverse().slice(0, Number(variables.comments));
          node.comments = {
            nodes: latest.map((c) => ({
              id: c.id,
              body: c.body,
              createdAt: c.createdAt,
              user: { id: c.userId },
            })),
          };
        }
        return okEnvelope({ issue: node });
      }
      case 'FlowWriteRead': {
        const issue = find(variables.id);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        return okEnvelope({
          issue: {
            id: `uuid-${issue.identifier}`,
            identifier: issue.identifier,
            team: issue.team,
            state: { id: issue.stateId, type: state(issue.stateId).type },
            issueLabels: { nodes: labelNodes(issue.labels) },
          },
          team: structuredClone(RECORDED_TEAM),
        });
      }
      case 'FlowApplyWorkState': {
        const issue = find(variables.id);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        const input = variables.input as { labelIds: string[]; stateId?: string };
        issue.labels = input.labelIds.map((id) => {
          const name = LABELS_BY_ID.get(id);
          if (name === undefined) throw new Error(`unknown label id ${id}`);
          return name;
        });
        if (input.stateId !== undefined) issue.stateId = state(input.stateId).id;
        writes += 1;
        return okEnvelope({ issueUpdate: { success: true } });
      }
      case 'FlowCommentTarget': {
        const issue = find(variables.id);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        return okEnvelope({
          issue: { id: `uuid-${issue.identifier}`, identifier: issue.identifier, team: issue.team },
        });
      }
      case 'FlowComment': {
        const issue = find(variables.issueId);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        commentSeq += 1;
        issue.comments.push({
          id: `sim-comment-${commentSeq}`,
          body: String(variables.body),
          createdAt: new Date(Date.UTC(2026, 8, 26, 12, 0, commentSeq)).toISOString(),
          userId: VIEWER.viewer.id,
        });
        writes += 1;
        return okEnvelope({ commentCreate: { success: true } });
      }
      case 'FlowSnapshotCore': {
        const nodes = issues
          .filter((issue) => issue.team.key === TEAM.key && isOpen(issue))
          .map((issue) => {
            const {
              team: _team,
              relations: _r,
              inverseRelations: _i,
              children: _c,
              ...node
            } = fullNode(issue);
            return node;
          });
        return okEnvelope({
          team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      case 'FlowSnapshotRelations': {
        const nodes = issues
          .filter((issue) => issue.team.key === TEAM.key && isOpen(issue))
          .map((issue) => ({
            identifier: issue.identifier,
            relations: { nodes: [] },
            inverseRelations: { nodes: [] },
            children: { nodes: [] },
          }));
        return okEnvelope({
          team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      case 'FlowSnapshotClosed': {
        const nodes = issues
          .filter((issue) => issue.team.key === TEAM.key && !isOpen(issue))
          .map((issue) => ({
            identifier: issue.identifier,
            title: issue.title,
            state: { type: state(issue.stateId).type },
          }));
        return okEnvelope({
          team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      case 'FlowProjects':
        return okEnvelope({ projects: { nodes: [] } });
      default:
        throw new Error(`the Linear simulator does not answer ${operation}`);
    }
  };

  const transport: TrackerTransport = {
    kind: 'cli',
    async run(_cmd, args) {
      const input = JSON.parse(args[args.indexOf('-d') + 1]) as {
        query_or_mutation: string;
        variables: Record<string, unknown>;
      };
      const operation = /^(?:query|mutation) (\w+)/.exec(input.query_or_mutation)?.[1] ?? '?';
      return {
        code: 0,
        stdout: `${JSON.stringify(answer(operation, input.variables))}\n`,
        stderr: '',
      };
    },
  };
  return { transport, issues, writes: () => writes };
}

export { TEAM };
