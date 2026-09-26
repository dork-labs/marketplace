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
import { failedEnvelope, issueNode, okEnvelope, PROJECTS, TEAM, VIEWER } from './recorded.ts';

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
  /** The body, when set. */
  description?: string;
  /** Linear priority 0-4, when set. */
  priority?: number;
  /** A recorded project id (`PROJECTS`), when set. */
  projectId?: string;
  /** The parent's identifier, when set. */
  parent?: string;
  /** The issue id, when a create chose it; else `uuid-<identifier>`. */
  id?: string;
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
  const idOf = (issue: SimIssue) => issue.id ?? `uuid-${issue.identifier}`;
  const find = (id: unknown) =>
    issues.find((issue) => issue.identifier === id || idOf(issue) === id);
  const isOpen = (issue: SimIssue) =>
    !['completed', 'canceled'].includes(state(issue.stateId).type);

  const fullNode = (issue: SimIssue) => ({
    ...issueNode(issue.identifier, {
      id: idOf(issue),
      title: issue.title,
      labels: { nodes: labelNodes(issue.labels) },
      state: { name: state(issue.stateId).name, type: state(issue.stateId).type },
      description: issue.description ?? '',
      priority: issue.priority ?? 0,
      parent: issue.parent === undefined ? null : { identifier: issue.parent },
      project:
        issue.projectId === undefined
          ? null
          : (PROJECTS.projects.nodes.find((project) => project.id === issue.projectId) ?? null),
    }),
    team: issue.team,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    children: { nodes: [] },
  });

  const answer = (operation: string, variables: Record<string, unknown>): unknown => {
    switch (operation) {
      case 'FlowCreateRead':
        // The recorded create-read shape (create.recorded.json), under its alias.
        return okEnvelope({ team: { createLabels: { nodes: RECORDED_TEAM.teamLabels.nodes } } });
      case 'FlowCreateProject':
      case 'FlowCreateProjectById': {
        const want = operation === 'FlowCreateProject' ? variables.name : variables.id;
        const nodes = PROJECTS.projects.nodes
          .filter(
            (project) => (operation === 'FlowCreateProject' ? project.name : project.id) === want
          )
          .map((project) => ({ id: project.id, name: project.name }));
        return okEnvelope({ team: { createProjects: { nodes } } });
      }
      case 'FlowCreatedRead': {
        const issue = find(variables.id);
        if (issue === undefined) return failedEnvelope('Entity not found: Issue');
        return okEnvelope({
          issue: {
            id: idOf(issue),
            identifier: issue.identifier,
            team: issue.team,
            url: `https://linear.app/example/issue/${issue.identifier}/new-item`,
          },
        });
      }
      case 'FlowCreateItem': {
        const input = variables.input as {
          id?: string;
          teamId: string;
          title: string;
          description: string;
          labelIds: string[];
          projectId?: string;
          parentId?: string;
          priority?: number;
        };
        // As recorded: a second insert with the same id is refused.
        if (input.id !== undefined && find(input.id) !== undefined) {
          return failedEnvelope(
            `conflict on insert of Issue | Details: Entity Issue with id ${input.id} already exists.`
          );
        }
        const names = input.labelIds.map((id) => {
          const name = LABELS_BY_ID.get(id);
          if (name === undefined) throw new Error(`unknown label id ${id}`);
          return name;
        });
        // As recorded: one label per group.
        const groups = names.filter((name) => name.includes('/')).map((name) => name.split('/')[0]);
        if (new Set(groups).size !== groups.length) {
          return failedEnvelope('labelIds not exclusive child labels');
        }
        const next =
          Math.max(0, ...issues.map((issue) => Number(issue.identifier.split('-')[1]))) + 1;
        const identifier = `${TEAM.key}-${next}`;
        const parent = input.parentId === undefined ? undefined : find(input.parentId);
        issues.push({
          identifier,
          title: input.title,
          team: TEAM,
          // New issues land in Triage (recorded 2026-09-26).
          stateId: 'st-triage',
          labels: names,
          comments: [],
          description: input.description,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(parent !== undefined ? { parent: parent.identifier } : {}),
        });
        writes += 1;
        return okEnvelope({
          issueCreate: {
            issue: {
              id: input.id ?? `uuid-${identifier}`,
              identifier,
              url: `https://linear.app/example/issue/${identifier}/new-item`,
            },
            success: true,
          },
        });
      }
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
            id: idOf(issue),
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
          issue: { id: idOf(issue), identifier: issue.identifier, team: issue.team },
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
