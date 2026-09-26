/**
 * The Linear code adapter: what the `flow` CLI calls to reach Linear (spec
 * `flow-cli-core` §4, adapter contract 1.4.0 "The code realization").
 *
 * The recipes in `SKILL.md` beside this file, as tested code. Every call is
 *
 * ```
 * composio execute <SLUG> --account <secrets.trackerAccount> -d <json>
 * ```
 *
 * through the transport the CLI hands in (no shell). The gotchas the skill
 * records, each verified against `composio` v0.2.31, are built in here:
 *
 * - Reads go through `LINEAR_RUN_QUERY_OR_MUTATION`, whose input key is
 *   `query_or_mutation` (not `query`), and whose result nests under
 *   `.data.data` (two `data`s). A GraphQL failure exits 0 with
 *   `successful: false`, so the envelope is checked, not the exit code.
 * - Every value reaches GraphQL as a variable, never interpolated into the
 *   query text: Composio rejects a query holding a literal `$word` it has no
 *   variable for, and a title or comment may hold one.
 * - A large result spills to a file (`storedInFile: true`, `outputFilePath`)
 *   with no inline data; it is read from that file.
 * - Every issue read goes through `team(id:)`, never a top-level `issues`, and
 *   every identifier is checked against the `<teamKey>-` prefix: one account
 *   reaches every team in the workspace, and another team's items must never
 *   reach a write pass.
 * - Labels arrive as leaf names with their group as a separate `parent`; they
 *   are re-namespaced `parent/name`. A leaf with no group stays bare, so the
 *   audit (GRM-12) can flag it.
 * - `relations` are expensive (the complexity cap is 10 000), so the snapshot
 *   pulls core fields 150 at a time and the relation graph 40 at a time, then
 *   merges them by identifier.
 * - `issueUpdate`'s `labelIds` replaces the whole label set, so the set is
 *   computed from a read taken immediately before the write.
 *
 * Inside the tracker-confinement carve-out (`skills/linear-adapter/`), the one
 * place in the plugin a tracker string may live.
 *
 * @module @dorkos/flow/skills/linear-adapter/adapter
 */

import { readFileSync } from 'node:fs';

import { ConfigError, PreconditionError, TrackerError } from '../../scripts/errors.ts';
import type {
  AdapterContext,
  BacklogSnapshot,
  ClosedItem,
  CodeAdapter,
  ItemComment,
  ItemWithComments,
  StateCategory,
  WorkItem,
  WorkItemProject,
  WorkStateChange,
} from '../../scripts/tracker/types.ts';
import { labelsAfterChange } from '../../scripts/work-state.ts';

/** The adapter contract version this code targets. */
export const CONTRACT_VERSION = '2.1.0';

/** The Composio slug every read and write goes through. */
export const GRAPHQL_SLUG = 'LINEAR_RUN_QUERY_OR_MUTATION';

/** Issues per page when pulling core fields (cheap). */
export const CORE_PAGE_SIZE = 150;
/** Issues per page when pulling the relation graph (about 230 complexity points each). */
export const RELATION_PAGE_SIZE = 40;
/** Issues per page when pulling closed titles. */
export const CLOSED_PAGE_SIZE = 250;
/** Project ids per projects query. */
const PROJECT_CHUNK = 100;
/** A backstop against a cursor that never ends. */
const MAX_PAGES = 200;

/** The seven work types, from the `type/*` label family. */
const WORK_ITEM_TYPES = [
  'idea',
  'research',
  'hypothesis',
  'task',
  'monitor',
  'signal',
  'meta',
] as const;
/** The four dispositions, from the `agent/*` label family. */
const DISPOSITIONS = ['ready', 'claimed', 'completed', 'needs-input'] as const;

// ---------------------------------------------------------------------------
// The GraphQL documents. Constant text only: every value is a variable.
// ---------------------------------------------------------------------------

/** The fields every normalized issue needs, except its project and relations. */
const ISSUE_FIELDS = `id identifier title description priority estimate createdAt
  state { name type } assignee { id } parent { identifier }
  labels(first: 100) { nodes { id name parent { name } } }`;

/** The typed relation graph of one issue. */
const RELATION_FIELDS = `relations { nodes { type relatedIssue { identifier } } }
  inverseRelations { nodes { type issue { identifier } } }
  children { nodes { identifier } }`;

/** Open issues of the team: every category but completed and canceled. */
const OPEN_FILTER = `filter: { state: { type: { nin: ["completed", "canceled"] } } }`;

/** Snapshot pull 1: core fields of every open issue, paged at {@link CORE_PAGE_SIZE}. */
export const SNAPSHOT_CORE_QUERY = `query FlowSnapshotCore($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    issues(first: $first, after: $after, ${OPEN_FILTER}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} project { id name } }
    }
  }
}`;

/** Snapshot pull 2: the relation graph of every open issue, paged at {@link RELATION_PAGE_SIZE}. */
export const SNAPSHOT_RELATIONS_QUERY = `query FlowSnapshotRelations($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    issues(first: $first, after: $after, ${OPEN_FILTER}) {
      pageInfo { hasNextPage endCursor }
      nodes { identifier ${RELATION_FIELDS} }
    }
  }
}`;

/** Snapshot pull 3: closed issues as titles, paged at {@link CLOSED_PAGE_SIZE}. */
export const SNAPSHOT_CLOSED_QUERY = `query FlowSnapshotClosed($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    issues(first: $first, after: $after, filter: { state: { type: { in: ["completed", "canceled"] } } }) {
      pageInfo { hasNextPage endCursor }
      nodes { identifier title state { type } completedAt canceledAt }
    }
  }
}`;

/** The projects the snapshot's items reference, with their status (a direct query returns it). */
export const PROJECTS_QUERY = `query FlowProjects($ids: [ID!]) {
  projects(first: ${PROJECT_CHUNK}, filter: { id: { in: $ids } }) {
    nodes { id name state status { type } lead { id } }
  }
}`;

/** One issue, fully normalized, with its team for the scope check. */
const ITEM_FIELDS = `${ISSUE_FIELDS} ${RELATION_FIELDS}
  team { id key }
  project { id name state status { type } lead { id } }`;

/** One issue by id or identifier. */
export const ITEM_QUERY = `query FlowItem($id: String!) {
  issue(id: $id) { ${ITEM_FIELDS} }
}`;

/** One issue with its latest comments (Linear returns them newest first). */
export const ITEM_WITH_COMMENTS_QUERY = `query FlowItemComments($id: String!, $comments: Int!) {
  issue(id: $id) {
    ${ITEM_FIELDS}
    comments(first: $comments, orderBy: createdAt) { nodes { id body createdAt user { id } } }
  }
}`;

/** The read `applyWorkState` takes immediately before its write. */
export const WRITE_READ_QUERY = `query FlowWriteRead($id: String!, $teamId: String!) {
  issue(id: $id) {
    id identifier team { id key } state { id type }
    issueLabels: labels(first: 100) { nodes { id name parent { name } } }
  }
  team(id: $teamId) {
    teamLabels: labels(first: 250) { nodes { id name isGroup parent { name } } }
    states(first: 100) { nodes { id name type position } }
  }
}`;

/** The read `comment` takes to confirm the item is the team's before posting. */
export const COMMENT_TARGET_QUERY = `query FlowCommentTarget($id: String!) {
  issue(id: $id) { id identifier team { id key } }
}`;

/** The one write `applyWorkState` sends: labels and state together. */
export const ISSUE_UPDATE_MUTATION = `mutation FlowApplyWorkState($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

/** A comment, body as a variable. */
export const COMMENT_MUTATION = `mutation FlowComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

/** The account the adapter acts as. */
export const VIEWER_QUERY = `query FlowViewer { viewer { id name } }`;

/** Resolve the team id from its key. */
export const TEAM_BY_KEY_QUERY = `query FlowTeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }) { nodes { id key } }
}`;

/** Resolve the team key from its id. */
export const TEAM_BY_ID_QUERY = `query FlowTeamById($teamId: String!) {
  team(id: $teamId) { id key }
}`;

// ---------------------------------------------------------------------------
// Response shapes (only the fields read).
// ---------------------------------------------------------------------------

/** A label on an issue, as Linear returns it: a leaf plus its group. */
interface RawLabel {
  id: string;
  name: string;
  isGroup?: boolean;
  parent?: { name: string } | null;
}

/** An issue node from {@link SNAPSHOT_CORE_QUERY} or {@link ITEM_QUERY}. */
interface RawIssue {
  id: string;
  identifier: string;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  estimate?: number | null;
  createdAt?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  assignee?: { id?: string | null } | null;
  parent?: { identifier?: string | null } | null;
  labels?: { nodes?: RawLabel[] | null } | null;
  project?: RawProject | null;
  team?: { id?: string | null; key?: string | null } | null;
  comments?: { nodes?: RawComment[] | null } | null;
}

/** An issue node's relation graph. */
interface RawRelations {
  identifier: string;
  relations?: { nodes?: { type?: string; relatedIssue?: { identifier?: string } | null }[] } | null;
  inverseRelations?: { nodes?: { type?: string; issue?: { identifier?: string } | null }[] } | null;
  children?: { nodes?: { identifier?: string }[] } | null;
}

/** A project node. */
interface RawProject {
  id: string;
  name?: string | null;
  state?: string | null;
  status?: { type?: string | null } | null;
  lead?: { id?: string | null } | null;
}

/** A comment node. */
interface RawComment {
  id: string;
  body?: string | null;
  createdAt?: string | null;
  user?: { id?: string | null } | null;
}

/** A page of a connection. */
interface RawPage<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: T[] | null;
}

/** What {@link WRITE_READ_QUERY} returns. */
interface WriteReadResponse {
  issue?: (RawIssue & { issueLabels?: RawPage<RawLabel> | null }) | null;
  team?: {
    teamLabels?: RawPage<RawLabel> | null;
    states?: RawPage<{ id: string; name?: string; type: string; position: number }> | null;
  } | null;
}

/** The configured team, resolved. */
interface Team {
  id: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Pure normalization (exported for tests).
// ---------------------------------------------------------------------------

/**
 * Map a Linear state type to a flow state category: the five categories map to
 * themselves, `triage` (the un-triaged holding state) to `backlog`, and
 * anything else (`duplicate`) to `null`, which flow cannot represent.
 *
 * @param type - Linear's `state.type`.
 * @returns The category, or `null`.
 */
export function stateCategoryOf(type: unknown): StateCategory | null {
  switch (type) {
    case 'triage':
    case 'backlog':
      return 'backlog';
    case 'unstarted':
    case 'started':
    case 'completed':
    case 'canceled':
      return type;
    default:
      return null;
  }
}

/**
 * Map a Linear project status to a flow state category. `planned` is not
 * started yet (`unstarted`); `paused` is open but not active (`backlog`).
 *
 * @param project - The project node.
 * @returns The category, or `undefined` when Linear gives none.
 */
export function projectCategoryOf(project: RawProject): StateCategory | undefined {
  switch (project.status?.type ?? project.state) {
    case 'backlog':
    case 'paused':
      return 'backlog';
    case 'planned':
      return 'unstarted';
    case 'started':
      return 'started';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    default:
      return undefined;
  }
}

/**
 * Re-namespace a label: a grouped leaf becomes `group/leaf`; a leaf with no
 * group stays bare.
 *
 * @param label - The label as Linear returns it.
 * @returns The generic label string.
 */
export function namespacedLabel(label: RawLabel): string {
  const group = label.parent?.name;
  return group ? `${group}/${label.name}` : label.name;
}

/**
 * Normalize a project node.
 *
 * @param project - The project node.
 * @returns The generic project.
 */
export function normalizeProject(project: RawProject): WorkItemProject {
  const out: WorkItemProject = { id: project.id, name: project.name ?? '' };
  const category = projectCategoryOf(project);
  if (category !== undefined) out.stateCategory = category;
  if (project.lead?.id) out.lead = project.lead.id;
  return out;
}

/**
 * Normalize an issue's relation graph into identifiers.
 *
 * @param raw - The relation fields, or `undefined` when none were read.
 * @returns The generic relations (empty arrays when unknown).
 */
export function normalizeRelations(
  raw: RawRelations | RawIssue | undefined
): WorkItem['relations'] {
  const relations: WorkItem['relations'] = {
    blocks: [],
    blockedBy: [],
    children: [],
    relatedTo: [],
  };
  const add = (list: string[], id: string | undefined) => {
    if (id && !list.includes(id)) list.push(id);
  };
  const graph = raw as RawRelations | undefined;
  for (const edge of graph?.relations?.nodes ?? []) {
    const other = edge.relatedIssue?.identifier;
    if (edge.type === 'blocks') add(relations.blocks, other);
    else if (edge.type === 'related') add(relations.relatedTo, other);
    else if (edge.type === 'duplicate' && other) relations.duplicateOf = other;
  }
  for (const edge of graph?.inverseRelations?.nodes ?? []) {
    const other = edge.issue?.identifier;
    if (edge.type === 'blocks') add(relations.blockedBy, other);
    else if (edge.type === 'related') add(relations.relatedTo, other);
  }
  for (const child of graph?.children?.nodes ?? []) add(relations.children, child.identifier);
  return relations;
}

/**
 * Normalize one issue into a {@link WorkItem}.
 *
 * @param node - The issue's core fields.
 * @param relations - Its relation graph, when read.
 * @param project - Its project, normalized, when known.
 * @returns The item, or `null` when its state cannot be represented (`duplicate`).
 */
export function normalizeIssue(
  node: RawIssue,
  relations: RawRelations | RawIssue | undefined,
  project: WorkItemProject | undefined
): WorkItem | null {
  const category = stateCategoryOf(node.state?.type);
  if (category === null) return null;
  const labels = [...new Set((node.labels?.nodes ?? []).map(namespacedLabel))];
  const typeLeaf = labels
    .filter((label) => label.startsWith('type/'))
    .map((label) => label.slice('type/'.length))
    .find((leaf): leaf is WorkItem['type'] =>
      (WORK_ITEM_TYPES as readonly string[]).includes(leaf)
    );
  const disposition = labels
    .filter((label) => label.startsWith('agent/'))
    .map((label) => label.slice('agent/'.length))
    .find((leaf): leaf is NonNullable<WorkItem['agentDisposition']> =>
      (DISPOSITIONS as readonly string[]).includes(leaf)
    );

  const item: WorkItem = {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? '',
    description: node.description ?? '',
    // WorkItem.type is required; an item with no type/* label reads as a task,
    // and the audit (GRM-1) reports the missing label from `labels`.
    type: typeLeaf ?? 'task',
    stateCategory: category,
    stateName: node.state?.name ?? '',
    parent: node.parent?.identifier ?? null,
    relations: normalizeRelations(relations),
    labels,
  };
  const priority = node.priority;
  if (
    typeof priority === 'number' &&
    Number.isInteger(priority) &&
    priority >= 0 &&
    priority <= 4
  ) {
    item.priority = priority as WorkItem['priority'];
  }
  if (typeof node.estimate === 'number' && Number.isFinite(node.estimate) && node.estimate >= 0) {
    item.size = node.estimate;
  }
  if (project !== undefined) item.project = project;
  if (node.assignee?.id) item.assignee = node.assignee.id;
  if (disposition !== undefined) item.agentDisposition = disposition;
  if (typeof node.createdAt === 'string') item.createdAt = node.createdAt;
  return item;
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

/**
 * Strip terminal color codes, collapse whitespace, cut to a readable length and
 * hide the account handle.
 */
function cleanMessage(text: string, secrets: readonly string[]): string {
  let out = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Composio appends a long "EXPLANATION" of how to fix a query; the message before it is the error.
  out = out.split(' | EXPLANATION:')[0];
  for (const secret of secrets) if (secret) out = out.split(secret).join('<trackerAccount>');
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/**
 * Refuse an issue that is missing or belongs to another team; flow acts only
 * on its own team's items.
 *
 * @param issue - The issue as read, or null.
 * @param identifier - What the caller asked for, for the message.
 * @param team - The configured team.
 * @returns The issue.
 * @throws {PreconditionError} When missing or foreign.
 */
function ownIssue<T extends RawIssue>(
  issue: T | null | undefined,
  identifier: string,
  team: Team
): T {
  if (issue === null || issue === undefined) {
    throw new PreconditionError(`${identifier} was not found in Linear`);
  }
  if (issue.team?.id !== team.id || !issue.identifier.startsWith(`${team.key}-`)) {
    throw new PreconditionError(
      `${issue.identifier} belongs to another Linear team, not ${team.key}; flow only acts on its own team`
    );
  }
  return issue;
}

/**
 * Build the Linear code adapter.
 *
 * @param ctx - The CLI's context: config, secrets, transport and warning sink.
 * @returns The adapter.
 * @throws {ConfigError} When `secrets.trackerAccount` is not set.
 */
export function createAdapter(ctx: AdapterContext): CodeAdapter {
  const account = ctx.secrets.trackerAccount;
  if (account === undefined || account === '') {
    throw new ConfigError(
      'the Linear adapter needs secrets.trackerAccount (the Composio account flow acts as); set it in .agents/flow/config.local.json or FLOW_TRACKER_ACCOUNT'
    );
  }
  const { transport, warn } = ctx;
  const configuredTeam = ctx.config.connection.team;

  /** Run one Composio slug and return its (possibly spilled) envelope's `data`. */
  async function execute(slug: string, input: Record<string, unknown>): Promise<unknown> {
    const result = await transport.run('composio', [
      'execute',
      slug,
      '--account',
      account as string,
      '-d',
      JSON.stringify(input),
    ]);
    if (result.code !== 0) {
      throw new TrackerError(
        `composio ${slug} failed (exit ${result.code}): ${cleanMessage(result.stderr || result.stdout, [account as string])}`
      );
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new TrackerError(`composio ${slug} did not answer with JSON`);
    }
    if (envelope.storedInFile === true) {
      const file = envelope.outputFilePath;
      if (typeof file !== 'string') {
        throw new TrackerError(`composio ${slug} spilled its answer to a file but named none`);
      }
      try {
        envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch (error) {
        throw new TrackerError(
          `composio ${slug} spilled its answer to ${file}, which could not be read: ${(error as Error).message}`
        );
      }
    }
    if (envelope.successful !== true) {
      const detail = typeof envelope.error === 'string' ? envelope.error : 'no detail given';
      throw new TrackerError(
        `Linear refused the request: ${cleanMessage(detail, [account as string])}`
      );
    }
    return envelope.data;
  }

  /**
   * Run one GraphQL document with variables and return `.data.data`, typed by
   * the caller as the shape its document selects (every field optional, since
   * Linear may leave any of them null).
   */
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const data = (await execute(GRAPHQL_SLUG, { query_or_mutation: query, variables })) as {
      data?: unknown;
      errors?: unknown;
    } | null;
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const first = data.errors[0] as { message?: unknown };
      throw new TrackerError(
        `Linear returned an error: ${cleanMessage(String(first?.message ?? 'unknown'), [account as string])}`
      );
    }
    if (
      data === null ||
      typeof data !== 'object' ||
      data.data === null ||
      typeof data.data !== 'object'
    ) {
      throw new TrackerError('Linear returned no data');
    }
    return data.data as T;
  }

  let teamPromise: Promise<Team> | undefined;
  /** The configured team, with its id resolved from its key (or the reverse). */
  function team(): Promise<Team> {
    teamPromise ??= (async () => {
      const { id, key } = configuredTeam;
      if (id && key) return { id, key };
      if (id) {
        const data = await graphql<{ team?: { key?: string } | null }>(TEAM_BY_ID_QUERY, {
          teamId: id,
        });
        if (!data.team?.key)
          throw new ConfigError(`no Linear team has the id in connection.team.id`);
        return { id, key: data.team.key };
      }
      if (key) {
        const data = await graphql<{ teams?: RawPage<Team> | null }>(TEAM_BY_KEY_QUERY, { key });
        const found = data.teams?.nodes ?? [];
        const match = found.find((node) => node.key === key);
        if (match === undefined) {
          throw new ConfigError(
            `no Linear team with the key ${key} is visible to the configured account; check connection.team.key`
          );
        }
        return { id: match.id, key };
      }
      throw new ConfigError(
        'connection.team.key is not set, so flow does not know which Linear team to read; run /flow:init'
      );
    })();
    return teamPromise;
  }

  /** Pull every page of a team-scoped issue connection. */
  async function paginate<T>(query: string, teamId: string, first: number): Promise<T[]> {
    const nodes: T[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data: { team?: { issues?: RawPage<T> | null } | null } = await graphql(query, {
        teamId,
        first,
        after,
      });
      const connection: RawPage<T> | null | undefined = data.team?.issues;
      if (connection === undefined || connection === null) {
        throw new TrackerError('Linear returned no team; check connection.team.id');
      }
      nodes.push(...(connection.nodes ?? []));
      if (connection.pageInfo?.hasNextPage !== true) return nodes;
      after = connection.pageInfo.endCursor ?? null;
      if (after === null)
        throw new TrackerError('Linear said there was another page but gave no cursor');
    }
    throw new TrackerError(`the backlog is larger than ${MAX_PAGES} pages; flow stopped reading`);
  }

  /** Drop every node whose identifier is not the team's, warning once. */
  function inTeam<T extends { identifier: string }>(nodes: T[], key: string, what: string): T[] {
    const prefix = `${key}-`;
    const foreign = nodes.filter((node) => !node.identifier.startsWith(prefix));
    if (foreign.length > 0) {
      warn(
        `Linear returned ${foreign.length} ${what} from outside team ${key} (${foreign.map((node) => node.identifier).join(', ')}); flow left them out`
      );
    }
    return nodes.filter((node) => node.identifier.startsWith(prefix));
  }

  /** The projects with these ids, normalized. */
  async function projects(ids: string[]): Promise<Map<string, WorkItemProject>> {
    const out = new Map<string, WorkItemProject>();
    for (let start = 0; start < ids.length; start += PROJECT_CHUNK) {
      const data = await graphql<{ projects?: RawPage<RawProject> | null }>(PROJECTS_QUERY, {
        ids: ids.slice(start, start + PROJECT_CHUNK),
      });
      for (const node of data.projects?.nodes ?? []) {
        out.set(node.id, normalizeProject(node));
      }
    }
    return out;
  }

  /** Read one issue, refusing one that is missing or outside the team. */
  async function readIssue(identifier: string, comments?: number): Promise<RawIssue> {
    const { id: teamId, key } = await team();
    let data: { issue?: RawIssue | null };
    try {
      data =
        comments !== undefined && comments > 0
          ? await graphql(ITEM_WITH_COMMENTS_QUERY, { id: identifier, comments })
          : await graphql(ITEM_QUERY, { id: identifier });
    } catch (error) {
      if (error instanceof TrackerError && /Entity not found/.test(error.message)) {
        throw new PreconditionError(`${identifier} was not found in Linear`);
      }
      throw error;
    }
    return ownIssue(data.issue, identifier, { id: teamId, key });
  }

  return {
    capabilities: ['getCurrentUser', 'getBacklogSnapshot', 'getItem', 'applyWorkState', 'comment'],

    async getCurrentUser() {
      const data = await graphql<{ viewer?: { id?: string; name?: string } | null }>(
        VIEWER_QUERY,
        {}
      );
      const viewer = data.viewer;
      if (!viewer?.id) throw new TrackerError('Linear did not say which account flow acts as');
      return viewer.name ? { id: viewer.id, name: viewer.name } : { id: viewer.id };
    },

    async getBacklogSnapshot(opts = {}): Promise<BacklogSnapshot> {
      const { id: teamId, key } = await team();
      const core = inTeam(
        await paginate<RawIssue>(SNAPSHOT_CORE_QUERY, teamId, CORE_PAGE_SIZE),
        key,
        'open items'
      );
      const graph = new Map(
        (await paginate<RawRelations>(SNAPSHOT_RELATIONS_QUERY, teamId, RELATION_PAGE_SIZE)).map(
          (node) => [node.identifier, node]
        )
      );

      const unrepresentable = core.filter((node) => stateCategoryOf(node.state?.type) === null);
      if (unrepresentable.length > 0) {
        warn(
          `${unrepresentable.map((node) => node.identifier).join(', ')} ${unrepresentable.length === 1 ? 'is' : 'are'} in a Linear state flow cannot represent (${[...new Set(unrepresentable.map((node) => node.state?.type))].join(', ')}); a groom should move ${unrepresentable.length === 1 ? 'it' : 'them'} to a canceled or open state`
        );
      }
      const open = core.filter((node) => stateCategoryOf(node.state?.type) !== null);
      const projectIds = [
        ...new Set(open.flatMap((node) => (node.project?.id ? [node.project.id] : []))),
      ];
      const projectMap = await projects(projectIds);

      const items = open.flatMap((node) => {
        const project = node.project?.id
          ? (projectMap.get(node.project.id) ?? {
              id: node.project.id,
              name: node.project.name ?? '',
            })
          : undefined;
        const item = normalizeIssue(node, graph.get(node.identifier), project);
        return item === null ? [] : [item];
      });

      let closed: ClosedItem[] = [];
      if (opts.includeClosed) {
        const nodes = inTeam(
          await paginate<{
            identifier: string;
            title?: string;
            state?: { type?: string };
            completedAt?: string | null;
            canceledAt?: string | null;
          }>(SNAPSHOT_CLOSED_QUERY, teamId, CLOSED_PAGE_SIZE),
          key,
          'closed items'
        );
        closed = nodes.flatMap((node) => {
          const category = node.state?.type;
          if (category !== 'completed' && category !== 'canceled') return [];
          const closedAt = category === 'completed' ? node.completedAt : node.canceledAt;
          return [
            {
              identifier: node.identifier,
              title: node.title ?? '',
              stateCategory: category,
              ...(typeof closedAt === 'string' && closedAt !== '' ? { closedAt } : {}),
            },
          ];
        });
      }

      return {
        v: 1,
        tracker: ctx.config.tracker,
        team: { key, id: teamId },
        fetchedAt: new Date().toISOString(),
        items,
        closed,
        projects: projectIds.flatMap((id) => {
          const project = projectMap.get(id);
          return project === undefined ? [] : [project];
        }),
      };
    },

    async getItem(identifier, opts = {}): Promise<ItemWithComments> {
      const issue = await readIssue(identifier, opts.comments);
      const item = normalizeIssue(
        issue,
        issue,
        issue.project?.id ? normalizeProject(issue.project) : undefined
      );
      if (item === null) {
        throw new PreconditionError(
          `${issue.identifier} is in Linear's ${issue.state?.type ?? 'unknown'} state, which flow cannot represent; move it to a canceled or open state`
        );
      }
      if (opts.comments !== undefined && opts.comments > 0) {
        const comments: ItemComment[] = (issue.comments?.nodes ?? []).map((node) => ({
          id: node.id,
          author: node.user?.id ?? '',
          body: node.body ?? '',
          createdAt: node.createdAt ?? '',
        }));
        comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { ...item, comments };
      }
      return item;
    },

    async applyWorkState(item: WorkItem, change: WorkStateChange) {
      const { id: teamId, key } = await team();
      const data = await graphql<WriteReadResponse>(WRITE_READ_QUERY, {
        id: item.id || item.identifier,
        teamId,
      });
      const issue = ownIssue(data.issue, item.identifier, { id: teamId, key });

      // The label set comes from this read, never from `item`. A missing
      // connection is a failed read, never an empty set: written back as
      // labelIds it would strip every label. (Both label connections carry an
      // alias: Composio renames a field asked for twice to labels_1/labels_2.)
      const issueLabels = issue.issueLabels?.nodes;
      const teamLabelNodes = data.team?.teamLabels?.nodes;
      if (!Array.isArray(issueLabels) || !Array.isArray(teamLabelNodes)) {
        throw new TrackerError(
          `Linear's answer for ${issue.identifier} carried no label list; flow wrote nothing`
        );
      }
      const current = new Map<string, string>();
      for (const label of issueLabels) current.set(namespacedLabel(label), label.id);
      const next = labelsAfterChange([...current.keys()], change);

      const teamLabels = new Map<string, string>();
      for (const label of teamLabelNodes) {
        if (label.isGroup) continue;
        if (!teamLabels.has(namespacedLabel(label)))
          teamLabels.set(namespacedLabel(label), label.id);
      }
      const labelIds = next.map((name) => {
        const id = current.get(name) ?? teamLabels.get(name);
        if (id === undefined) {
          throw new TrackerError(
            `Linear team ${key} has no "${name}" label; create it in Linear (flow never creates labels)`
          );
        }
        return id;
      });

      const input: { labelIds: string[]; stateId?: string } = { labelIds };
      if (
        change.stateCategory !== undefined &&
        stateCategoryOf(issue.state?.type) !== change.stateCategory
      ) {
        const states = [...(data.team?.states?.nodes ?? [])]
          .filter((state) => state.type === change.stateCategory)
          .sort((a, b) => a.position - b.position);
        if (states.length === 0) {
          throw new TrackerError(
            `Linear team ${key} has no ${change.stateCategory} state to move ${issue.identifier} to`
          );
        }
        input.stateId = states[0].id;
      }

      const unchangedLabels =
        next.length === current.size && next.every((name) => current.has(name));
      if (unchangedLabels && input.stateId === undefined) return;

      const result = await graphql<{ issueUpdate?: { success?: boolean } | null }>(
        ISSUE_UPDATE_MUTATION,
        { id: issue.id, input }
      );
      if (result.issueUpdate?.success !== true) {
        throw new TrackerError(`Linear did not confirm the update to ${issue.identifier}`);
      }
    },

    async comment(item: WorkItem, body: string) {
      const target = await graphql<{ issue?: RawIssue | null }>(COMMENT_TARGET_QUERY, {
        id: item.id || item.identifier,
      });
      const issue = ownIssue(target.issue, item.identifier, await team());
      const result = await graphql<{ commentCreate?: { success?: boolean } | null }>(
        COMMENT_MUTATION,
        { issueId: issue.id, body }
      );
      if (result.commentCreate?.success !== true) {
        throw new TrackerError(`Linear did not confirm the comment on ${item.identifier}`);
      }
    },
  };
}
