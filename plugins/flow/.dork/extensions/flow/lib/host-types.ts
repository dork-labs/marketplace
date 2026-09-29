/**
 * The DorkOS host types this extension uses, mirrored from
 * `@dorkos/extension-api` (DorkOS `packages/extension-api/src/`) because that
 * package is not published to npm.
 *
 * Only the subset the Flow extension touches is here, spelled exactly as the
 * host spells it. The seams the multi-project work added (spec
 * `flow-multiproject` §10) are optional, because an older DorkOS lacks them and
 * the extension probes for each before use. `__tests__/host-types.contract.test.ts`
 * is the drift guard: it checks these against core's vendored seam contract
 * (`lib/__contract__/seams.contract.ts`). Types only: nothing here exists at
 * run time.
 *
 * @module @dorkos/flow/extension/host-types
 */

import type { ComponentType } from 'react';

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
  /**
   * The tracker items it serves, newest first (DorkOS with multi-item chats):
   * `this-chat` runs in this session, `own-chat` was launched from it and runs
   * in its own chat. Read this first.
   */
  trackerItems?: { id: string; via: 'this-chat' | 'own-chat' }[];
  /** The tracker item it serves, when known. Deprecated in DorkOS for {@link trackerItems}. */
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
  /**
   * The tracker items it serves, newest first (DorkOS with multi-item chats):
   * `this-chat` runs in this session, `own-chat` was launched from it and runs
   * in its own chat. Read this first.
   */
  trackerItems?: { id: string; via: 'this-chat' | 'own-chat' }[];
  /** The tracker item it serves, when known. Deprecated in DorkOS for {@link trackerItems}. */
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

/**
 * Method syntax keeps a middleware's parameters bivariant, so Express's own
 * `RequestHandler` fits {@link RouteMiddleware}. The request is any object:
 * flow never reads it in a middleware, and Express's `params` (which may hold
 * arrays) is wider than {@link RouteRequest}'s.
 */
interface RouteMiddlewareShape {
  run(req: object, res: RouteResponse, next: (error?: unknown) => void): unknown;
}

/** Express middleware, such as the host's `requirePerson`: it answers, or calls `next`. */
export type RouteMiddleware = RouteMiddlewareShape['run'];

/** The scoped router DorkOS mounts at `/api/ext/<id>/` (a subset of Express's `Router`). */
export interface ExtensionRouter {
  /** Register a GET route. */
  get(path: string, ...handlers: (RouteHandler | RouteMiddleware)[]): unknown;
  /** Register a PUT route. */
  put(path: string, ...handlers: (RouteHandler | RouteMiddleware)[]): unknown;
  /** Register a POST route. */
  post(path: string, ...handlers: (RouteHandler | RouteMiddleware)[]): unknown;
}

/** A project as core knows it: a git main checkout (DorkOS `ProjectRef`). */
export interface ProjectRef {
  /** Absolute, canonical path of the main checkout. */
  readonly root: string;
  /** Short display name: URL-safe, unique, and stable once assigned. */
  readonly name: string;
}

/** A known project, with what core learned about it (DorkOS `ProjectInfo`). */
export interface ProjectInfo extends ProjectRef {
  /** "owner/name" from the origin remote, or null. */
  readonly originRepo: string | null;
  /** ISO-8601 time core last saw it. */
  readonly lastSeenAt: string;
}

/** Core's project registry, as one extension sees it (`ctx.projects`, DorkOS `ProjectsApi`). */
export interface ProjectsApi {
  /** The project a folder belongs to. */
  resolve(cwd: string): Promise<ProjectRef | null>;
  /** Known projects that hold a copy of this extension or were reported by it. */
  list(): Promise<ProjectInfo[]>;
  /** Tell core about a project it may not have seen. */
  report(path: string): Promise<ProjectRef | null>;
  /** Called when the list changes; returns a function that stops listening. */
  onChange(listener: () => void): () => void;
}

/**
 * The client state the extension reads (a subset of DorkOS
 * `ExtensionReadableState`). `currentProject` is missing on a DorkOS from
 * before the project registry, so it is optional here.
 */
export interface ReadableState {
  /** The folder of the chat the UI is beside, or null. */
  currentCwd: string | null;
  /** The project of `currentCwd`; null for no project or while resolving. */
  currentProject?: ProjectRef | null;
  /** Whether Require login is on. Missing on a DorkOS from before it. */
  requireLogin?: boolean;
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
  /** Core's project registry. Missing on a DorkOS from before it; probe before use. */
  readonly projects?: ProjectsApi;
  /**
   * Middleware that admits only a person (a person's browser, not an agent or
   * a relay message). Missing on a DorkOS from before it: then no route that
   * changes something is registered at all (spec `flow-multiproject` §10).
   */
  readonly requirePerson?: RouteMiddleware;
  /** Core's inbox. Missing on a DorkOS from before it: then flow raises nothing (§7.6). */
  readonly inbox?: InboxApi;
  /** flow's per-project settings, read-only. Missing on a DorkOS from before them. */
  readonly projectSettings?: ProjectSettingsReader;
  /**
   * Starting work in a new chat (contract 1.3.0). Missing on a DorkOS from
   * before it: then an ask's button opens the project's page, which says what
   * to type (§7.9).
   */
  readonly sessions?: SessionsApi;
}

/**
 * How a person can answer an inbox decision (DorkOS `DecisionActions`): 👎/👍
 * each labelled as its outcome, one word button (an in-app `href`, or an
 * inline text field), or a question's chips with the agent's pick and deadline.
 */
export type DecisionActions =
  | { kind: 'yes-no'; approveLabel: string; rejectLabel: string; rejectAsksForNote?: boolean }
  | {
      kind: 'word';
      label: string;
      /** In-app path; core route or '/x/<this extension id>/…'. Ignored when `input` is set. */
      href?: string;
      /** Show an inline text field; its text reaches onAction. maxLength ≤ 2000. */
      input?: { placeholder: string; maxLength: number };
    }
  | {
      kind: 'choice';
      /** 2-5 choices; label ≤ 40. */
      choices: { id: string; label: string }[];
      /** The agent's pick. Required when decideBy is set. */
      defaultChoice?: string;
      /** ISO deadline; at it core calls onAction with defaultChoice, decidedBy 'deadline'. */
      decideBy?: string;
      /** Offer "Reply…". */
      allowReply?: boolean;
    };

/** What `ctx.inbox.raise` takes (DorkOS `DecisionInput`). */
export interface DecisionInput {
  /** Extension-local; core namespaces it. */
  key: string;
  /** A question or an outcome, never a command or id. ≤ 120. */
  title: string;
  /** What happens, why now, what a "no" means. 1-300. */
  why: string;
  /** ≤ 500, behind ⓘ. */
  detail?: string;
  /** Any path inside the project. */
  project?: string;
  /** The project heading's muted label, e.g. "Linear DOR". */
  projectLabel?: string;
  /** ISO time the condition began. */
  since?: string;
  /** How a person answers it. */
  actions: DecisionActions;
  /** In-app path the row's title opens. */
  link?: string;
}

/** One decision as core stored it (DorkOS `RaisedDecision`). */
export interface RaisedDecision {
  /** Core's id for the row. */
  readonly id: string;
  /** The extension's own key. */
  readonly key: string;
  /** A question or an outcome. */
  readonly title: string;
  /** The second line. */
  readonly why: string;
  /** Shown behind ⓘ, or null. */
  readonly detail: string | null;
  /** The project core resolved, or null. */
  readonly project: ProjectRef | null;
  /** The project heading's muted label, or null. */
  readonly projectLabel: string | null;
  /** When the condition began, or null. */
  readonly since: string | null;
  /** How a person answers it. */
  readonly actions: DecisionActions;
  /** In-app path the title opens, or null. */
  readonly link: string | null;
  /** When it was first raised. */
  readonly raisedAt: string;
  /** When it was last raised or changed. */
  readonly updatedAt: string;
}

/** `cleared` = resolved on its own; `cancelled` = no longer needed. */
export type DecisionOutcome = 'approved' | 'rejected' | 'answered' | 'cleared' | 'cancelled';

/** Who settled a decision, when it was not a person (DorkOS `DecisionActor`). */
export type DecisionActor = { kind: 'agent' | 'rule'; label: string } | { kind: 'deadline' };

/** What the `onAction` handler is told (DorkOS `DecisionActionEvent`). */
export interface DecisionActionEvent {
  /** The decision's key. */
  readonly key: string;
  /** 'offer' is the second call when a person said Yes to a follow-up offer. */
  readonly action: 'approve' | 'reject' | 'word' | 'choice' | 'offer';
  /** The chosen chip, for 'choice'. */
  readonly choiceId: string | null;
  /** 'person', or 'deadline' when core applied defaultChoice at decideBy. */
  readonly decidedBy: 'person' | 'deadline';
  /** The offer being accepted, for 'offer'. */
  readonly offerId: string | null;
  /** Set when a person answered in core's UI; pass back as `answering` after a keepOpen. */
  readonly pendingActionId: string | null;
  /** The "Send it back" note, when the reject asked for one. */
  readonly note: string | null;
  /** The typed answer. */
  readonly text: string | null;
  /** The decision's project, or null. */
  readonly project: ProjectRef | null;
}

/** A chat this extension started, drawn on the row ("Sorting 12 ideas… · Watch"). */
export interface DecisionWatch {
  /** The chat's session id. */
  sessionId: string;
  /** What it is doing, ≤ 40. */
  label: string;
}

/** A one-time "do this on its own next time" line under the answered row. */
export interface DecisionOffer {
  /** Plain text, ≤ 160. */
  text: string;
  /** ≤ 64; comes back as `offerId` when the person says Yes. */
  offerId: string;
  /** Applied by core on the person's Yes: a shallow merge into the project's settings. */
  settingsPatch?: { project: string; patch: Record<string, unknown> };
}

/** What the `onAction` handler answers (DorkOS `DecisionActionResult`). */
export type DecisionActionResult =
  | {
      resolve: 'approved' | 'rejected' | 'answered';
      navigate?: string;
      offer?: DecisionOffer;
      message?: string;
      watch?: DecisionWatch;
    }
  | { keepOpen: true; message?: string; navigate?: string; watch?: DecisionWatch }
  | { settled: true };

/** What `ctx.inbox.record` takes: a decision made without asking. */
export type RecordedDecisionInput = Omit<DecisionInput, 'actions' | 'since'> & {
  outcome: 'approved' | 'rejected' | 'answered';
  by: DecisionActor;
  /** true (Tell me after): unread in Activity. false (Just do it): quiet. */
  tell?: boolean;
  /** What was chosen, in words (≤ 40). */
  choiceLabel?: string;
};

/** Core's inbox, as one extension sees it (DorkOS `InboxApi`). */
export interface InboxApi {
  /** Raise, or update in place, the one open decision for `key`. */
  raise(input: DecisionInput): Promise<RaisedDecision>;
  /** Settle it. False when nothing was open. */
  resolve(
    key: string,
    opts: {
      outcome: DecisionOutcome;
      by?: DecisionActor;
      answering?: string;
      offer?: DecisionOffer;
      watch?: DecisionWatch;
    }
  ): Promise<boolean>;
  /** Write a history-only row for something decided without asking. */
  record(input: RecordedDecisionInput): Promise<void>;
  /** This extension's open decisions. */
  list(): Promise<RaisedDecision[]>;
  /** The one handler for a person's answer; bounded at 5s. */
  onAction(
    handler: (event: DecisionActionEvent) => DecisionActionResult | Promise<DecisionActionResult>
  ): () => void;
}

/** The server half's read-only view of flow's per-project settings. */
export interface ProjectSettingsReader {
  /** The stored value for a project, or null. */
  get<T = unknown>(projectRoot: string): Promise<T | null>;
  /** Called with the project root whenever a person changes that project's value. */
  onChange(listener: (projectRoot: string) => void): () => void;
}

/**
 * What starting work in a new chat takes (DorkOS `StartWorkInput`, contract
 * 1.3.0). The vendored fixture is 1.2.0, so this mirror is checked when the
 * fixture is refreshed; until then flow probes for the seam at run time.
 */
export interface StartWorkInput {
  /** Any path inside a known project. */
  project: string;
  /** Sent at once as the first message (≤ 20,000). Never shown as the headline. */
  prompt: string;
  /** The chat's title, plain words (1-80). */
  title: string;
  /** Why it was started (1-200), shown as the chat's first line. */
  reason: string;
}

/** Why a start was refused (DorkOS `StartWorkError.code`). */
export type StartWorkErrorCode = 'not_a_project' | 'account_not_allowed_here' | 'start_limit';

/** `ctx.sessions` (contract 1.3.0). */
export interface SessionsApi {
  /** Start work in a new chat in a project, without a person. */
  start(input: StartWorkInput): Promise<{ sessionId: string }>;
}

/** One tracker item a chat works on, newest first in lists (DorkOS `TrackerItemRef`). */
export interface TrackerItemRef {
  /** The tracker identifier. */
  readonly id: string;
  /** The flow stage, or null. */
  readonly stage: string | null;
  /** The run's own status, or null. */
  readonly runStatus: string | null;
  /** ISO-8601 time the run started. */
  readonly startedAt: string;
  /** How the chat relates to the item: it runs here, or in its own chat launched from here. */
  readonly via: 'this-chat' | 'own-chat';
  /** The chat the work runs in, or null. */
  readonly ownChatSessionId: string | null;
}

/** Props every extension page receives (DorkOS `ExtensionPageProps`). */
export interface ExtensionPageProps {
  /** Values of the page path's `:param` segments. */
  readonly params: Readonly<Record<string, string>>;
  /** The URL's query, flat. */
  readonly search: Readonly<Record<string, string>>;
  /** Replace query keys; null removes a key. Writes the URL. */
  setSearch(next: Record<string, string | null>): void;
}

/** How an extension page is named and listed (DorkOS `ExtensionPageOptions`). */
export interface ExtensionPageOptions {
  /** Title for the page bar, tab, palette and phone menu. */
  title: string;
  /** Icon, sized by the host with `className`. */
  icon?: ComponentType<{ className?: string }>;
  /** List it in the palette and the phone "Add-ons" menu. Default true. */
  menu?: boolean;
}

/** What a status-bar item is given, for the chat whose status bar it sits in (DorkOS `StatusBarSlotContext`). */
export interface StatusBarSlotContext {
  /** The chat's session id. */
  readonly sessionId: string;
  /** The chat's working folder, or null. */
  readonly cwd: string | null;
  /** The project of `cwd`, or null. */
  readonly project: ProjectRef | null;
  /** Every tracker item the chat works on, newest first. */
  readonly trackerItems: readonly TrackerItemRef[];
  /** True at phone width. */
  readonly compact: boolean;
}

/** How a status-bar item is named, ordered and shown (DorkOS `StatusBarItemOptions`). */
export interface StatusBarItemOptions {
  /** Accessible name of the item's region. */
  label: string;
  /** Order among extension items; lower first. Default 100. */
  priority?: number;
  /** Whether to show for this chat. Pure; reads only `ctx`. */
  when?(ctx: StatusBarSlotContext): boolean;
  /** Whether it needs attention. Pure; reads only `ctx`. */
  urgent?(ctx: StatusBarSlotContext): boolean;
}

/**
 * The part of DorkOS's client `ExtensionAPI` this extension uses. The methods
 * a DorkOS from before 0.88.0 may lack are optional, and each is probed
 * before use (spec `flow-multiproject` §10).
 */
export interface ClientApi {
  /** Go to a client route. */
  navigate(path: string): void;
  /** A snapshot of the host's state. */
  getState?(): ReadableState;
  /** Call `callback` when the selected part of the state changes; returns a function that stops. */
  subscribe?(
    selector: (state: ReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;
  /**
   * Add a tab to Settings.
   *
   * @returns A function that removes it.
   */
  registerSettingsTab(
    id: string,
    label: string,
    component: ComponentType,
    options?: { group?: string }
  ): () => void;
  /**
   * Add a component to a UI slot; for `right-panel`, a tab with `label` and `icon`.
   *
   * @returns A function that removes it.
   */
  registerComponent(
    slot: 'right-panel',
    id: string,
    component: ComponentType,
    options?: { label?: string; icon?: ComponentType<{ className?: string }> }
  ): () => void;
  /**
   * Add a command palette item.
   *
   * @returns A function that removes it.
   */
  registerCommand?(id: string, label: string, callback: () => void): () => void;
  /** Add a dialog; returns its controls. */
  registerDialog?(id: string, component: ComponentType): { open: () => void; close: () => void };
  /** Show a toast. */
  notify?(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;
  /**
   * Mount a full page at `/x/flow/<path>`. Missing on a DorkOS from before
   * extension pages: then flow has no home, lens page or settings page.
   *
   * @returns A function that removes it.
   */
  registerPage?(
    path: string,
    component: ComponentType<ExtensionPageProps>,
    options: ExtensionPageOptions
  ): () => void;
  /**
   * Add an item to the chat status bar. Missing on a DorkOS from before the
   * status-bar slot: then there is no run chip.
   *
   * @returns A function that removes it.
   */
  registerStatusBarItem?(
    id: string,
    component: ComponentType<StatusBarSlotContext>,
    options: StatusBarItemOptions
  ): () => void;
  /**
   * Mark one of this extension's right-panel tabs; null clears it. Missing on a
   * DorkOS from before tab markers: then the Flow tab gets no dot.
   */
  setTabMarker?(tabId: string, marker: 'attention' | null): void;
  /**
   * This extension's open decisions. Missing on a DorkOS without the inbox:
   * then flow's pages answer through flow's own route (§7.6).
   */
  listDecisions?(): Promise<ExtensionDecisionView[]>;
  /** Answer one of this extension's decisions from its own page. */
  answerDecision?(decisionId: string, answer: DecisionAnswer): Promise<DecisionAnswerResult>;
  /**
   * Start work in a NEW chat, as the person (contract 1.3.0). Missing on a
   * DorkOS from before it: then a button says what to type instead (§7.9).
   */
  startWork?(input: StartWorkInput): Promise<{ sessionId: string }>;
}

/** An answer given on the extension's own page (DorkOS `DecisionAnswer`). */
export type DecisionAnswer =
  | { action: 'approve' }
  | { action: 'reject'; note?: string }
  | { action: 'word'; text?: string }
  | { action: 'choice'; choiceId?: string; text?: string };

/** What `api.answerDecision` answers (DorkOS `DecisionAnswerResult`). */
export interface DecisionAnswerResult {
  /** Whether the answer settled it. */
  readonly resolved: boolean;
  /** Something to tell the person, or null. */
  readonly message: string | null;
  /** The checked in-app path the extension answered with, or null. */
  readonly navigate: string | null;
  /** "Sorting 12 ideas… · Watch", when the handler returned one. */
  readonly watch: { sessionId: string; label: string } | null;
}

/** One open decision as the client sees it (DorkOS `ExtensionDecisionView`). */
export interface ExtensionDecisionView {
  /** Core's id for the row: what `answerDecision` takes. */
  readonly id: string;
  /** The extension's own key. */
  readonly key: string;
  /** A question or an outcome. */
  readonly title: string;
  /** What happens, why now, what "no" means. */
  readonly why: string;
  /** Shown behind ⓘ, or null. */
  readonly detail: string | null;
  /** The project it belongs to, or null. */
  readonly project: ProjectRef | null;
  /** The project heading's muted label, or null. */
  readonly projectLabel: string | null;
  /** When the condition began, or null. */
  readonly since: string | null;
  /** How to answer it. */
  readonly actions: DecisionActions;
  /** In-app path the title opens, or null. */
  readonly link: string | null;
  /** When it was first raised. */
  readonly raisedAt: string;
}
