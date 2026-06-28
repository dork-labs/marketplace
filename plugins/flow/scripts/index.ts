/**
 * @dorkos/flow — the `/flow` engine's typed core.
 *
 * Home of the authoritative Zod config schema for `.agents/flow/config.json`
 * and the JSON Schema bridge that generates `.agents/flow/config.schema.json`.
 * Downstream engine code (calibration ladder, dispatch policy, gates,
 * ownership classification, recovery) imports the relevant sub-schemas and the
 * inferred {@link FlowConfig} type from here.
 *
 * @module @dorkos/flow
 */

export {
  FlowConfigSchema,
  TrackerSchema,
  IdentitySchema,
  OwnershipSchema,
  OwnershipScopeSchema,
  CommentsSchema,
  RespondWhenSchema,
  AmbiguousBiasSchema,
  StageSchema,
  StagesSchema,
  StateCategorySchema,
  AutonomySchema,
  AutonomyDefaultSchema,
  ConcurrencySchema,
  SeatSchema,
  WipCapSchema,
  InvolvementSchema,
  CommsSchema,
  CalibrationSchema,
  ProceedSilentlyWhenSchema,
  AlwaysAskSchema,
  StageBiasSchema,
  StageBiasValueSchema,
  AssumptionLogSchema,
  TicketCommentSchema,
  NudgeSchema,
  DispatchSchema,
  DispatchRankSchema,
  SizeOrderSchema,
  GatesSchema,
  ReviewGateSchema,
  OnConflictSchema,
  CircuitBreakerSchema,
  ContextSchema,
  PerIssueSchema,
  PerStageSchema,
  StageBudgetsSchema,
  WorkspaceSchema,
  IsolationSchema,
  WorkspaceFlowSchema,
  RecoverySchema,
  OnExhaustedSchema,
  DecompositionSchema,
  DecompositionModeSchema,
  SubIssueThresholdSchema,
  EvidenceSchema,
  EvidenceUiSchema,
  EvidenceTemporalSchema,
  EvidenceLogicSchema,
  EvidenceAttachToSchema,
  ReconcilerConfigSchema,
  LoopsSchema,
  ProducerSchema,
  IngestionSchema,
} from './config-schema.ts';
export type { FlowConfig, Stage } from './config-schema.ts';

export { CONFIG_SCHEMA_RELATIVE_PATH, buildConfigJsonSchema } from './config-schema-builder.ts';

export {
  TasksFileSchema,
  TaskSchema,
  TaskSizeSchema,
  TaskPrioritySchema,
  ProvenanceSchema,
  ProvenanceTrackerSchema,
  CANONICAL_SIZE_ORDER,
  normalizeSize,
  isPromotableToSubIssue,
} from './tasks-schema.ts';
export type { TasksFile, Task, TaskSize, CanonicalSize, Provenance } from './tasks-schema.ts';

// Work model — the normalized WorkItem the adapter produces and the engine consumes.
export type {
  WorkItem,
  WorkItemProject,
  WorkItemRelations,
  OwnershipClass,
  WorkItemType,
  WorkItemPriority,
  AgentDisposition,
  StateCategory,
} from './work-item.ts';

// Calibration ladder (§5) — uncertainty-gated involvement.
export { resolveInvolvement, CalibrationRow } from './calibration.ts';
export type {
  Calibration,
  FloorTrigger,
  Reversibility,
  Confidence,
  DecisionStage,
  InvolvementBehavior,
  DecisionDescriptor,
  InvolvementDecision,
} from './calibration.ts';

// Dispatch policy (§4) — eligibility filter + 7-tier ranking ladder.
export {
  selectDispatch,
  classifyDispatchOutcome,
  filterEligible,
  rankEligible,
  isClaimable,
} from './dispatch-policy.ts';
export type {
  DispatchOptions,
  DispatchOutcome,
  DispatchConfig,
  OwnershipConfig,
  WipCap,
  RankFactor,
} from './dispatch-policy.ts';

// Gates (§5) + auto-merge recovery ladder (§6) — config-driven loop control.
export { planApprovalRequired, tripsCircuitBreaker, evaluateAutoMerge } from './gates-policy.ts';
export type {
  GatesConfig,
  ReviewGateConfig,
  CircuitBreakerConfig,
  MergeableState,
  CiState,
  MergeState,
  MergeDispositionKind,
  MergeDisposition,
  UnitUsage,
  CircuitBreakerTrip,
} from './gates-policy.ts';

// Comms routing (§5) — infer the human-contact channel from the trigger.
export { resolveCommsChannel } from './comms.ts';
export type {
  InvolvementConfig,
  NudgeConfig,
  CommsChannel,
  CommsTrigger,
  CommsRoute,
} from './comms.ts';

// Comment-response rules (§5) — reading the comms channel back.
export { shouldRespondToComment } from './comment-response.ts';
export type {
  CommentsConfig,
  InboxComment,
  CommentIdentity,
  CommentDecisionContext,
  CommentAction,
  CommentDecision,
} from './comment-response.ts';

// Identity & ownership model (§7) — the one primitive, two consumers.
export { classifyOwnership, resolveIdentityMode, SHARED_MODE_CLAIM_LABEL } from './identity.ts';
export type { Identity, IdentityMode, IdentityConfig, OwnershipScope } from './identity.ts';

// Crash & stall recovery (§12) — the durable FlowRun record + next-tick recovery ladder.
export { recoverOrphan, RECOVERY_BLOCKED_LABEL } from './flow-run.ts';
export type {
  FlowRun,
  FlowRunStatus,
  FlowStage,
  RecoveryConfig,
  RecoveryContext,
  OrphanSignal,
  RecoveryAction,
  RecoveryActionKind,
} from './flow-run.ts';

// FlowRun writer/reader (§6) — the typed flow-state.json store (pure core + injected seam).
export {
  FlowRunSchema,
  FlowStateSchema,
  parseFlowState,
  serializeFlowState,
  pruneClosedRuns,
  readFlowState,
  writeFlowRun,
  updateFlowRunStatus,
  gcFlowState,
} from './flow-state.ts';
export type { FlowStateStore } from './flow-state.ts';

// Evidence selection (§13) — config-driven proof-of-completion plan for VERIFY.
export { selectEvidence } from './evidence.ts';
export type {
  EvidenceConfig,
  EvidenceTarget,
  EvidenceKind,
  EvidenceCapture,
  EvidenceTrigger,
  EvidencePlan,
} from './evidence.ts';

// Normalized inbound event seam (§4) — the typed TrackerEvent union (G9).
export { trackerEventDedupeKey } from './events.ts';
export type {
  TrackerEvent,
  TrackerEventKind,
  TrackerEventBase,
  ReceivedVia,
  CommentAddedEvent,
  ItemReadiedEvent,
  ItemAssignedEvent,
  ItemStateChangedEvent,
  MentionEvent,
  ItemCreatedEvent,
} from './events.ts';

// Inbound transport seam (§4) — the InboundTransport interface + PollingTransport.
export { PollingTransport } from './transport.ts';
export type {
  InboundTransport,
  PollResult,
  Watermark,
  InboxEntry,
  InboxReader,
} from './transport.ts';

// Reconciler contract (§3) — the typed registry/scheduler promotion surface.
export type {
  ReconcilerId,
  ReconcilerConfig,
  ReconcileContext,
  ReconcileResult,
  Reconciler,
} from './reconciler.ts';

// Reconciler registry + generic priority-ordered scheduler (§3).
export { createReconcilerRegistry, runTick, isCadenceDue } from './scheduler.ts';
export type { ReconcilerRegistry, LoopConfigOverrides } from './scheduler.ts';

// Baseline reconcilers wrapping the existing oracles + the default registry (§3).
export {
  recoveryReconciler,
  inboxReconciler,
  reviewReconciler,
  dispatchReconciler,
  triageReconciler,
  hygieneReconciler,
  defaultRegistry,
} from './reconcilers.ts';
export type {
  FlowReconcileInput,
  DispatchCandidates,
  ReviewReconcileInput,
  TriageReconcileInput,
  RecoveryCandidate,
  RecoveryReconcileInput,
  InboxCandidate,
  InboxReconcileInput,
} from './reconcilers.ts';
