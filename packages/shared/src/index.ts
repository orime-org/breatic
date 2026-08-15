// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

export {
  Environment,
  TaskStatus,
  StorageProvider,
  DEFAULT_API_PORT,
  DEFAULT_COLLAB_PORT,
  AVATAR_OUTPUT_PX,
} from "@shared/constants/index.js";

export type {
  Environment as EnvironmentType,
  TaskStatus as TaskStatusType,
  StorageProvider as StorageProviderType,
} from "@shared/constants/index.js";

export type {
  DecisionKind,
  DecisionState,
  DecisionView,
  DecisionAction,
  DecisionResult,
} from "@shared/types/decision.js";

export type {
  UserEntity,
  ConversationEntity,
  MessageData,
  MessageInput,
  MessagePart,
  TaskEntity,
  NodeHistoryEntity,
  StudioAssetEntity,
  ConversationAttachmentEntity,
  AssetKind,
  PaymentEntity,
  CreditTransactionEntity,
  NotificationEntity,
  NotificationRef,
  NotificationListView,
  ProjectEntity,
  ProjectVisibility,
  ProjectDetail,
  ProjectSummary,
  RecentItem,
  MemoryContext,
  SkillMeta,
  NodeState,
  NodeType,
  HandlingActor,
  HandlingPhase,
  AttachRef,
  FocusImage,
  CanvasNodeFields,
  NodeStateUpdateEvent,
  NodeEvent,
  ModelModality,
  ModelTier,
  ParamDescriptor,
  ModelProvider,
  ModelEntry,
  ModelCatalog,
  SourceType,
  ProjectRole,
  ProjectMember,
  Studio,
  StudioType,
  StudioRole,
  StudioMember,
  StudioSummary,
  StudioDetail,
  StudioMemberSummary,
  StudioInvitationStatus,
  PendingInvitationSummary,
  StudioMembersView,
  PersonalStudioRef,
  MembershipTier,
  InvitableProjectRole,
  ProjectInvitationStatus,
  PendingProjectInvitationSummary,
  SpaceType,
  Space,
  MembersChangedEvent,
  ActivityNewControlEvent,
  ProjectDeletedLifecycleEvent,
  ProjectDuplicatedLifecycleEvent,
  ProjectLifecycleEvent,
} from "@shared/types/index.js";

export {
  ROLE_RANK,
  STUDIO_ROLE_RANK,
  MEMBERSHIP_TIERS,
  HANDLING_TIMEOUT_MS,
  canGenerate,
  membersChangedChannel,
  activityNewChannel,
  allProjectChannelsPattern,
  SpaceTypeSchema,
  SPACE_NAME_MAX_LEN,
  SpaceRpcRequestSchema,
  SpaceRpcResponseSchema,
  SpaceRpcErrorCodeSchema,
  SpaceCreatePayloadSchema,
  SpaceDeletePayloadSchema,
  SpaceLockPayloadSchema,
  SpaceRenamePayloadSchema,
  SpaceRestorePayloadSchema,
} from "@shared/types/index.js";

export type {
  SpaceRpcRequest,
  SpaceRpcResponse,
  SpaceRpcErrorCode,
  SpaceCreatePayload,
  SpaceDeletePayload,
  SpaceLockPayload,
  SpaceRenamePayload,
  SpaceRestorePayload,
} from "@shared/types/index.js";

export {
  PROJECT_ACTIVITY_TYPES,
  ACTIVITY_NEW_SIGNAL,
  AssetActivityPayloadSchema,
  GenerationActivityPayloadSchema,
  SpaceActivityPayloadSchema,
  MemberActivityPayloadSchema,
  ProjectActivityEntrySchema,
  ProjectActivityPageSchema,
  ActivityNewSignalSchema,
} from "@shared/types/index.js";
export type {
  ProjectActivityType,
  ProjectActivityEntry,
  ProjectActivityPage,
  ActivityNewSignal,
} from "@shared/types/index.js";

export {
  modelCatalogSchema,
  sanitizeModelCatalog,
  IMAGE_GENERATION_MODES,
  isImageGenerationMode,
  VIDEO_GENERATION_MODES,
} from "@shared/types/index.js";

export type {
  ApiResponse,
  PaginatedResponse,
  ApiError,
} from "@shared/types/api.js";

// ── API Schemas ─────────────────────────────────────────────────────
export {
  registerSchema,
  setupStudioSchema,
  createTeamStudioSchema,
  updateStudioSchema,
  SLUG_REGEX,
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
  loginSchema,
  chatMessageSchema,
  chatAttachedChipSchema,
  skillCommandSchema,
  taskCreateSchema,
  understandSchema,
  projectCreateSchema,
  checkoutSchema,
  paginationSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
  chatEarlierMessagesQuerySchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
} from "@shared/schemas/index.js";

export type {
  RegisterInput,
  SetupStudioInput,
  CreateTeamStudioInput,
  UpdateStudioInput,
  LoginInput,
  ChatMessageInput,
  ChatAttachedChip,
  SkillCommandInput,
  TaskCreateInput,
  UnderstandInput,
  ProjectCreateInput,
  CheckoutInput,
  PaginationInput,
  ChatConversationsQueryInput,
  ChatCreateConversationInput,
  ChatRenameConversationInput,
} from "@shared/schemas/index.js";

export {
  t,
  setLocale,
  getLocale,
  getAvailableLocales,
  setLocaleMessages,
  setLocaleResolver,
  onLocaleChange,
  resetLocales,
} from "@shared/i18n/index.js";
export type { Locale } from "@shared/i18n/index.js";

export {
  projectMetaDocName,
  canvasSpaceDocName,
  documentSpaceDocName,
  timelineSpaceDocName,
  spaceContentDocName,
  parseDocName,
  isProjectScopedDocName,
} from "@shared/yjs-doc-names.js";
export type { DocKind, ParsedDocName } from "@shared/yjs-doc-names.js";

export {
  DOCUMENT_TITLE_NODE,
  documentBodyFragment,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

export {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaDiffers,
  documentSchemaMatches,
  documentSchemaVersion,
  publishedSchemaVersion,
} from "@shared/document-schema.js";

export type { DocumentSchema } from "@shared/document-schema.js";

export {
  defaultAdjustValue,
  isAdjustValueNeutral,
  parseAdjustValue,
  buildAdjustVideoFilter,
} from "@shared/adjust-value.js";
export type { AdjustValue } from "@shared/adjust-value.js";

export { newId, deriveId } from "@shared/ids.js";

// The agent chat stream's wire contract — the one place its event names and
// envelope are written, for the server that sends them and the browser that
// reads them. Sentinels are not here on purpose; see the file's own note.
export {
  SSE_EVENT_NAMES,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_HEARTBEAT_TIMEOUT_MS,
} from "@shared/agent/sse-events.js";
export { toolCallHasOutcome } from "@shared/agent/tool-outcome.js";
export type { ToolOutcomeFields } from "@shared/agent/tool-outcome.js";
export type { SSEEventName, SSEEventEnvelope } from "@shared/agent/sse-events.js";

// The one HTTP transport with retries — backend services and browser alike.
// Anything aimed at OUR OWN backend keeps using the browser's axios singleton;
// anything aimed outward (cloud storage, vendor APIs, arbitrary URLs) comes
// through here, on both sides of the wire (decided 2026-08-02).
//
// Two symbols for what it does, plus one for what it demands of a caller (see
// below). It does seven things — send, judge, wait, cap at three deliveries,
// hand over or throw, hold nothing, stop when the caller says so — and no
// eighth, so there is nothing else worth naming here. Everything the loop needs internally (the judgement, its
// vocabulary, the sleep) stays inside: an export is a promise to somebody, and
// nobody outside this package needs those. Not even the options type: a caller
// writes the object inline and TypeScript's structural typing does the rest,
// so exporting a name nobody spells is surface for nothing.
//
// `exponentialJitterDelay` used to be on that list, on the same reasoning. It
// came off when the reasoning expired rather than because the rule bent:
// core's BullMQ retry strategy now calls it, so "nobody outside this package
// needs it" simply stopped being true. `fullJitter`, which it is built on,
// stays unexported — nobody outside calls that one. See below.
//
// It hands back the platform's own `Response` and holds nothing afterwards.
// Reading it — how long a read may stall, how large it may be, how to parse
// it — belongs to the caller: the HTTP client underneath already times a
// stalled read, and a second timer on top would be a duplicate with worse
// information (decided 2026-08-02). The one thing the transport does still
// answer for after handing over is the seventh item above: a caller who says
// it no longer wants the answer stops that read too, because the signal
// composed into the request stays attached to the body.
//
// The delivery count rides with the failure and never with the response: a
// caller holding a 200 has no use for "and it took two tries", while a caller
// holding a failure has a log line to write.
export { httpRequest, HttpRetryError } from "@shared/http/request.js";

// The ceiling on `timeoutMs`, exported because asking callers to compute their
// own deadline while keeping the range they must land in inside an error
// message is only half a contract. A caller whose deadline comes from config
// (`size / rate`) has to be able to refuse an unusable pair where the operator
// can still read the complaint, rather than at the moment someone uploads.
// This is not an eighth thing the transport does — it is the bound the second
// parameter already had, said out loud.
export { MAX_TIMER_MS } from "@shared/http/constants.js";

// The one backoff function with a consumer outside this package.
// `packages/core/src/infra/retry.ts` held a byte-identical copy of the backoff
// maths, because the transport lives here and `shared` cannot import `core` —
// the dependency runs the other way, so during the migration a second copy was
// the only option. Every caller of core's copy has since moved onto the
// transport except its BullMQ job-retry strategy, which is backend-only
// plumbing and stays where it is; it now calls this instead of a twin.
//
// `fullJitter` is deliberately NOT exported alongside it. It is what this one
// is built on, so the pull to export the pair is real — but the criterion is
// whether something outside the package calls it, and nothing does. Exporting
// a symbol because its neighbour earned it is how a barrel stops meaning
// anything.
//
// Deleting the twin is the point. Two copies of one formula are two things to
// change and one of them will be forgotten — the copy carried a comment
// saying exactly that, and now neither has to.
export { exponentialJitterDelay } from "@shared/backoff.js";
