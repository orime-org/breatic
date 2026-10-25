// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `@breatic/domain` — AIGC business kernel shared by server + worker.
 *
 * Holds the business logic both server and worker need but collab never
 * touches: the credit "spend" side (credit + `markCompletedAndBill`
 * atomic deduction) / tasks / node history / agent (model · tools) /
 * model-catalog.
 *
 * Dependency direction `shared ← core ← domain ← {server, worker}`:
 * domain may only import `@breatic/core` + `@breatic/shared`, never any
 * application package (`@server` / `@worker` / `@collab` / `@web`), and
 * collab never depends on domain. Both directions are enforced by CI
 * guards. See `AGENTS.md#backend-package-boundaries` + docs/ARCHITECTURE.md for the
 * package-placement decision tree and the three-layer boundary.
 */

// ── Credit (the "spend" side: deduction + balance + ledger) ──────
// The lot-based engine (#11): the only writer of a lot's lifecycle, its
// designation, and what is left on it.
export * as creditSourceRepo from "@domain/credit/creditSource.repo.js";
export * as creditLotService from "@domain/credit/creditLot.service.js";
export * as creditLotRepo from "@domain/credit/creditLot.repo.js";
export * as creditHoldService from "@domain/credit/creditHold.service.js";
export { SMALLEST_CREDIT, toChargeCredits } from "@domain/credit/credit-math.js";
export {
  containerCostUsd,
  type ContainerPrices,
  type ContainerSize,
} from "@domain/credit/container-cost.js";
export {
  createUsageRecorder,
  type RecordedOperation,
  type UsageRecorder,
  type UsageRow,
  type UsageFeature,
  type UsageSource,
} from "@domain/credit/usage-recorder.js";
export { usageContextFor } from "@domain/agent/tools/usage-context.js";
export { creditsForUsd, type ModelCallUsage } from "@domain/credit/usage-cost.js";
export { agentModelIds, assertModelsPriced } from "@domain/credit/priced-models.js";
export {
  USAGE_LOOKUP_QUEUE,
  handOffLookups,
  lookupGeneration,
  type GenerationAnswer,
  type UsageLookupJob,
} from "@domain/credit/generation-lookup.js";
export { isGenerationId, trackOpenGeneration, type OpenGeneration } from "@domain/credit/open-generation.js";
export type { LotContext, PayerLedgerRow } from "@domain/credit/creditLot.repo.js";

// ── Studio auth (loadStudioRole + studio_members repo; server+worker) ──
export * as studioAuthService from "@domain/auth/studioAuth.service.js";
export * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";

// ── Task (+ markCompletedAndBill: task·credit cross-table atomic) ─
export * as taskService from "@domain/task/task.service.js";
export * as taskRepo from "@domain/task/task.repo.js";
export * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
export * as upstreamCloneRepo from "@domain/task/upstreamClone.repo.js";

// ── Node history (per-node content timeline, append-only) ────────
export * as nodeHistoryService from "@domain/node-history/node-history.service.js";
export * as nodeHistoryRepo from "@domain/node-history/node-history.repo.js";

// ── Asset (physical asset registry: within-studio dedup + attribution + usage) ──
export * as assetService from "@domain/asset/asset.service.js";
export * as assetRepo from "@domain/asset/asset.repo.js";
export * as uploadGrantRepo from "@domain/asset/upload-grant.repo.js";
export * as uploadGrantService from "@domain/asset/upload-grant.service.js";
export * as uploadStatusService from "@domain/asset/upload-status.service.js";
export * as uploadFinishService from "@domain/asset/upload-finish.service.js";
export {
  UPLOAD_FINISH_QUEUE,
  type UploadFinishJob,
  type UploadFinishResult,
} from "@domain/asset/upload-finish.service.js";
export * as uploadTicketService from "@domain/asset/upload-ticket.service.js";
export * as backendUploadService from "@domain/asset/backend-upload.service.js";
export { openContainerOutputs } from "@domain/asset/container-outputs.service.js";
export * as mediaReadService from "@domain/asset/media-read.service.js";
export { extFromUrl, labelForUrl, readerUrlSchema, safeExt } from "@domain/asset/source-url.js";
export { isReaderLinkFault, storedTypeOf, TYPE_UNKNOWN, urlIngestFailureLevel } from "@domain/asset/reader-source.js";
export {
  MEDIA_READ_QUEUE,
  type MediaReadJob,
  type MediaReadResult,
} from "@domain/asset/media-read.service.js";
export * as audioPeaksService from "@domain/asset/audio-peaks.service.js";
export {
  AUDIO_PEAKS_QUEUE,
  AudioPeaksReadFailed,
  type AudioPeaksJob,
  type AudioPeaksResult,
} from "@domain/asset/audio-peaks.service.js";
export type {
  BackendUploadContext,
  StoredAsset,
} from "@domain/asset/backend-upload.service.js";
export type {
  UploadGrant,
  FinalizeClaim,
  FinalizeRefusal,
} from "@domain/asset/upload-grant.repo.js";

// ── Agent (AIGC execution kernel: model / tools / prompt extraction) ──
export { getModel, resolveProvider, callOptionsFor, systemFor } from "@domain/agent/llm.js";
export type { CallWants } from "@domain/agent/llm.js";
export { generateTextRetry, streamTextRetry } from "@domain/agent/model-call.js";
export {
  buildToolSet,
  BASELINE_TOOLS,
  TOOL_MAP,
  ASK_USER,
  PROPOSE_CANVAS_ACTION,
  PROPOSE_DOCUMENT_EDIT,
  SAVE_IMAGE,
  RECORD_TOOL_NAMES,
} from "@domain/agent/tools/index.js";
export type { OpenDocument } from "@domain/agent/tools/propose-document-edit.js";
export { STOPPED_BY_USER } from "@domain/agent/tools/failure.js";
export { SaveRefused, type SavedMaterial, type SaveToStorage } from "@domain/agent/tools/save-image.js";
export { MAX_TURN_INDEX, RecordsRefused } from "@domain/agent/tools/project-records.js";
export type {
  ProjectRecords,
  RecordsRefusalKind,
  ConversationSummary,
  ConversationListPage,
  MessageHit,
  MessageHitPage,
  StoredMessage,
  ConversationTurns,
  NodeTaskRecord,
  NodeRecords,
  ActivityPage,
} from "@domain/agent/tools/project-records.js";
export { buildAgentConfig, instructionsForAgentMemory } from "@domain/agent/agent-config.js";
export {
  createAgentPicturePreparer,
  type AgentPictureSource,
  type AgentPictureSourceAsset,
  type AgentPictureFacts,
  type AgentPictureUnavailable,
  type PreparedAgentPicture,
  type PrepareAgentPictures,
  type ToolPictureContext,
  type AgentPicturePreparation,
} from "@domain/agent/prepare-agent-pictures.js";
export { resolveModelPictureCapability } from "@domain/agent/model-picture-capability.js";
export { pictureMiddleware } from "@domain/agent/picture-middleware.js";
export {
  projectAgentRequest,
  expandAgentPictures,
  agentPictureOutputOf,
  AGENT_PICTURE_PROJECTION_VERSION,
  AGENT_TOOL_PICTURE_MARKER,
  agentPictureLabelFor,
  type AgentPicture,
  type AgentPicturePolicy,
  type AgentGenerationStep,
  type AgentPictureOutput,
  type AgentRequestProjection,
  type ProjectedAgentRequest,
} from "@domain/agent/project-agent-request.js";
export { instructionsText } from "@domain/agent/instructions.js";
export { finalizeTurn } from "@domain/agent/turn-finalizer.js";
export type { TurnSteps, TurnStepFailure } from "@domain/agent/turn-finalizer.js";
export type { AgentConfigRequest, ResolvedAgentConfig } from "@domain/agent/agent-config.js";
export type { Instructions } from "@domain/agent/instructions.js";

// ── Model catalog (incl. per-call credit cost: cost_per_call) ────
export * as modelCatalog from "@domain/model-catalog/model-catalog.js";
export { estimateTaskCredits, violatesSourceRequirementForModel, violatesReferenceCountForModel, MIN_TASK_CREDIT_COST, getFullModelConfig } from "@domain/model-catalog/model-catalog.js";
export type { ReferenceCountViolation } from "@domain/model-catalog/reference-count.js";
export type { FullModalityConfig, FullModelEntry, FullProviderEndpoint, FullParamSpec, ProviderConnectionConfig } from "@domain/model-catalog/model-catalog.js";
// Which upstream a model runs on in this deployment. One rule, two callers:
// the worker sends the generation, the voice endpoint lists voices in that
// same upstream's value domain.
export { resolveActiveProvider } from "@domain/model-catalog/resolve-active-provider.js";
export type { ActiveProvider } from "@domain/model-catalog/resolve-active-provider.js";

// The voices a tts model offers, in one shape whichever vendor answers.
export { listVoices, getVoice } from "@domain/model-catalog/voice-catalog.js";
export { getVoiceSampleConfig, voiceSampleUrl } from "@domain/model-catalog/voice-sample-config.js";
export type { VoiceSampleConfig } from "@domain/model-catalog/voice-sample-config.js";
export type { Voice, VoicePage, VoiceQuery } from "@domain/model-catalog/voice-catalog.js";

// ── Node tasks (one row per task on a node; the four counts the node shows) ──
export * as nodeTaskService from "@domain/node-task/node-task.service.js";
export { settleTaskForNode } from "@domain/node-task/settle-for-node.js";
export { failureOutcome } from "@domain/node-task/failure-outcome.js";
export type {
  NodeTaskCounts,
  NodeTaskListRow,
  NodeTaskRow,
  NodeTaskStatus,
  SettleResult,
  DismissResult,
} from "@domain/node-task/node-task.service.js";

// ── Canvas node state write-back (worker finishes a generation, server
//    finishes an upload — one shape, one place) ──
export { emitNodeTaskCounts } from "@domain/canvas-node/node-state-events.js";

// ── The project activity feed's write side (asset registration appends a row,
//    and registration runs in both our server and our worker) ──
export {
  appendProjectActivity,
  type ActivityAppend,
} from "@domain/activity/project-activity.service.js";

// ── Registering what the edge measured (our server finishes the browser's
//    upload, our worker finishes its own — one function, one place) ──
export * as ingestReportService from "@domain/asset/ingest-report.service.js";
export { uploadDeadlineByKey } from "@domain/asset/upload-deadline.js";
export type {
  IngestReport,
  IngestReportOutcome,
  IngestSideEffects,
} from "@domain/asset/ingest-report.service.js";
export { INGEST_SIDE_EFFECT_EVENTS } from "@domain/asset/ingest-report.service.js";

// ── Reading a piece of media into text (the agent's tool and the canvas's
//    task call the same capability — one order of steps, one classification
//    of failures) ──
export {
  MediaUnavailable,
  UNDERSTAND_PINS,
  UnderstandRefused,
  understandMediaAt,
  readingLimitsUntil,
} from "@domain/understand/index.js";
export {
  openUnderstandOperation,
  getUnderstandOperation,
  listDueUnderstandDispatches,
  applyUnderstandOperationEvent,
  applyUnderstandDispatchEvent,
  claimUnderstandOperationLease,
  renewUnderstandOperationLease,
  releaseUnderstandOperationLease,
} from "@domain/understand/operation.repo.js";
export type {
  DueUnderstandDispatch,
  OpenUnderstandOperationInput,
  UnderstandOperationLease,
  UnderstandOperationLeaseMutation,
} from "@domain/understand/operation.repo.js";
export type {
  MediaKind,
  RefusalKind,
  UnavailableKind,
  UnderstandAnswer,
  UnderstandAt,
} from "@domain/understand/index.js";

// ── Mail (notification mail sent by the worker) ──
export { MAIL_QUEUE, enqueueMail, type MailJob } from "@domain/mail/mail-queue.js";
