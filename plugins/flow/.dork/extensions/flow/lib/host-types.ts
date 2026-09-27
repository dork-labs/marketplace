/**
 * The DorkOS host types this extension uses, mirrored from
 * `@dorkos/extension-api/server` (DorkOS `packages/extension-api/src/server-extension-api.ts`,
 * spec `claude-account-fleet` §X) because that package is not published to npm.
 *
 * Only the subset the Flow extension touches is here, spelled exactly as the
 * host spells it. The DorkOS harness check (UI task 4.3) is the drift guard.
 * Types only: nothing here exists at run time.
 *
 * @module @dorkos/flow/extension/host-types
 */

/**
 * The longest `seedContext` DorkOS accepts on a carried-over session
 * (`SEED_CONTEXT_MAX_LENGTH` in DorkOS `packages/shared/src/schemas.ts`).
 */
export const SEED_CONTEXT_MAX_LENGTH = 10_000;

/** One usage window as DorkOS serves it (`AccountUsage.windows[]`). */
export interface AccountUsageWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, or `model:<slug>`. */
  key: string;
  /** The window's display label. */
  label: string;
  /** Share used, or `null` when unknown. */
  usedPct: number | null;
  /** When it resets, or `null`. */
  resetsAt: string | null;
  /** The reported status. */
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  /** True when the window already reset. */
  expired: boolean;
  /** When the source observed it. */
  observedAt: string;
  /** Which source produced it. */
  source: string;
}

/** One account's usage as an extension sees it (DorkOS `AccountUsage` without `path`). */
export interface AccountUsage {
  /** The runtime the account belongs to. */
  runtime: string;
  /** Registry id, `default`, or `null` for an unregistered root. */
  accountId: string | null;
  /** What the operator calls it, or `null`. */
  label: string | null;
  /** The resolved display color. */
  color: string;
  /** The readable windows. */
  windows: AccountUsageWindow[];
  /** One state for a chip. */
  state: 'ok' | 'warning' | 'limited' | 'unknown';
  /** The first window that rejected work, or `null`. */
  limit: { window: string; resetsAt: string | null } | null;
  /** The ledger's last write, or `null`. */
  updatedAt: string | null;
  /** The plan a usage call reported (Claude Code), or `null`. */
  subscriptionType?: string | null;
  /** The plan the ledger holds (Codex `plan_type`), or `null`. */
  plan?: { name: string } | null;
}

/** One account an agent runtime can run on, as {@link AccountsApi.list} reports it. */
export interface AccountSummary {
  /** `claude-code`, `codex` or `opencode`. */
  readonly runtime: string;
  /** The registry id, or `default` for the runtime's own implicit account. */
  readonly id: string;
  /** What the operator calls the account, or `null` when unnamed. */
  readonly label: string | null;
  /** The resolved display color (`#rrggbb`). */
  readonly color: string;
  /** True for a runtime's implicit `default` account. */
  readonly implicit: boolean;
}

/** One account the advisor is asked to rank. */
export interface AccountCandidate {
  /** The registry id, or `default`. */
  id: string;
  /** What the operator calls the account, or `null`. */
  label: string | null;
  /** The resolved display color. */
  color: string;
  /** The account's usage as DorkOS last read it. */
  usage: AccountUsage;
}

/** What core is deciding when it asks the advisor to rank accounts. */
export interface AdvisorContext {
  /** `launch` or `continue`. */
  purpose: 'launch' | 'continue';
  /** Who is asking. Only `agent` and `relay` picks are refused on the advisor's word. */
  caller: 'person' | 'agent' | 'relay' | 'advisor';
  /** The working directory of the session. */
  cwd: string;
  /** The runtime the ranked accounts belong to. */
  runtime: string;
  /** The session being continued, when there is one. */
  sessionId?: string;
  /** An account to leave out, such as the one that just ran out. */
  excludeAccountId?: string;
}

/** One row of an {@link AdvisorRanking}. */
export interface AdvisorRankingRow {
  /** Defaults to the context's runtime; another runtime is a cross-runtime fallback. */
  runtime?: string;
  /** The account id. */
  id: string;
  /** Whether the account may take the work. */
  eligible: boolean;
  /** Why, in plain words. */
  reason: string;
  /** A badge for the picker. */
  badge?: 'recommended' | 'reserved';
}

/** The advisor's ordered answer to {@link AccountAdvisor.rank}. */
export interface AdvisorRanking {
  /** Accounts in the order to offer them; an id left out is hidden. */
  accounts: AdvisorRankingRow[];
  /** The account to suggest first, or `null`. */
  recommendedId: string | null;
}

/** A session core may move or park. */
export interface SessionInfo {
  /** The session's id. */
  sessionId: string;
  /** Its working directory. */
  cwd: string;
  /** Its runtime. */
  runtime: string;
  /** The account it runs on, or `null`. */
  accountId: string | null;
  /** The tracker item it serves, when known. */
  trackerItem?: { id: string };
}

/** A session that stopped because its account or model ran out. */
export interface LimitedSessionInfo {
  /** The session's id. */
  sessionId: string;
  /** Its working directory. */
  cwd: string;
  /** The account that ran out, or `null`. */
  accountId: string | null;
  /** The window that stopped the turn. */
  window: string;
  /** When that window resets, or `null`. */
  resetsAt: string | null;
  /** `model` when only one model's bucket ran out. */
  scope: 'account' | 'model';
  /** The session's model, or `null`. */
  model: string | null;
  /** The tracker item it serves, when known. */
  trackerItem?: { id: string };
}

/** What to do when a session runs out. */
export type LimitedPlan =
  | { mode: 'auto'; target: string; delaySeconds: number }
  | { mode: 'wait'; resumeAt?: string }
  | { mode: 'ask' };

/** The background and first message of a carried-over session. */
export interface CarryOverSeed {
  /** Background for the new session, at most {@link SEED_CONTEXT_MAX_LENGTH} characters. */
  seedContext: string;
  /** The first message; core's default when absent. */
  prompt?: string;
}

/** An extension's say in account decisions (DorkOS `AccountAdvisor`). */
export interface AccountAdvisor {
  /** Order and filter the accounts a session may launch or continue on. */
  rank(
    candidates: AccountCandidate[],
    ctx: AdvisorContext
  ): AdvisorRanking | Promise<AdvisorRanking>;
  /** Choose what happens when a session runs out. */
  onLimited?(info: LimitedSessionInfo): LimitedPlan | Promise<LimitedPlan>;
  /** Offer another model when only one model's bucket ran out. */
  modelFallback?(
    info: LimitedSessionInfo
  ): { model: string } | null | Promise<{ model: string } | null>;
  /** Seed the new session when work moves to another account. */
  carryOver?(
    info: LimitedSessionInfo,
    targetAccountId: string
  ): CarryOverSeed | Promise<CarryOverSeed>;
  /** Whether this extension owns the session. */
  claims?(info: SessionInfo): boolean | Promise<boolean>;
  /** Accept (within 2 s) a move of a claimed session; report it later with `markContinued`. */
  move?(info: SessionInfo, target: { runtime: string; accountId: string }): void | Promise<void>;
  /** Cancel a pending automatic handoff on a claimed session. */
  cancelAuto?(info: SessionInfo): void | Promise<void>;
  /** A person chose to wait for the reset on a claimed session. */
  wait?(info: SessionInfo, resumeAt: string | null, autoResume: boolean): void | Promise<void>;
}

/** Read access to the agent accounts DorkOS knows, and the advisor seam. */
export interface AccountsApi {
  /** Every runtime's accounts: registered rows, then each runtime's implicit `default`. */
  list(): Promise<AccountSummary[]>;
  /** Every account's current usage, or one runtime's. */
  usage(runtime?: string): Promise<AccountUsage[]>;
  /** Listen for usage changes; returns a function that stops listening. */
  onUsage(listener: (usage: AccountUsage) => void): () => void;
  /** Tell DorkOS a claimed session moved to a new session. */
  markContinued(
    sourceSessionId: string,
    to: { sessionId: string; runtime: string; accountId: string }
  ): Promise<void>;
  /** Become the account advisor; returns a function that removes this advisor. */
  registerAdvisor(advisor: AccountAdvisor): () => void;
}

/** The request fields the Flow routes read (a subset of Express's `Request`). */
export interface RouteRequest {
  /** Route parameters, decoded. */
  params: Record<string, string>;
  /** The parsed JSON body; `undefined` on an empty body (Express 5). */
  body?: unknown;
  /** The query string, parsed. */
  query?: Record<string, unknown>;
}

/** The response calls the Flow routes make (a subset of Express's `Response`). */
export interface RouteResponse {
  /** Set the status code. */
  status(code: number): RouteResponse;
  /** Send a JSON body. */
  json(body: unknown): unknown;
}

/** A route handler. */
export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void | Promise<void>;

/** The scoped router DorkOS mounts at `/api/ext/<id>/` (a subset of Express's `Router`). */
export interface ExtensionRouter {
  /** Register a GET route. */
  get(path: string, handler: RouteHandler): unknown;
  /** Register a PUT route. */
  put(path: string, handler: RouteHandler): unknown;
  /** Register a POST route. */
  post(path: string, handler: RouteHandler): unknown;
}

/**
 * The server context DorkOS injects (DorkOS `DataProviderContext`), as an
 * older host may deliver it: `dorkHome` and `accounts` arrived with DorkOS
 * 0.88.0, so both are optional here and checked before use.
 */
export interface DataProviderContext {
  /** Scoped persistent storage for extension data. */
  readonly storage: {
    loadData<T = unknown>(): Promise<T | null>;
    saveData<T = unknown>(data: T): Promise<void>;
  };
  /** Run `fn` every `intervalSeconds` (at least 5); returns a cancel function. */
  schedule(intervalSeconds: number, fn: () => Promise<void>): () => void;
  /** Broadcast `ext:<id>:<event>` on DorkOS's `/api/events` stream. */
  emit(event: string, data: unknown): void;
  /** This extension's id. */
  readonly extensionId: string;
  /** Absolute path of this extension's folder. */
  readonly extensionDir: string;
  /** The resolved DorkOS data folder. Missing on hosts older than 0.88.0. */
  readonly dorkHome?: string;
  /** The accounts API. Missing on hosts older than 0.88.0. */
  readonly accounts?: Partial<AccountsApi>;
}
