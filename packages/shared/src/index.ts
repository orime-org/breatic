// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

export {
  Environment,
  TaskStatus,
  StorageProvider,
  DEFAULT_API_PORT,
  DEFAULT_COLLAB_PORT,
} from "@shared/constants/index.js";

export type {
  Environment as EnvironmentType,
  TaskStatus as TaskStatusType,
  StorageProvider as StorageProviderType,
} from "@shared/constants/index.js";

export type {
  UserEntity,
  ConversationEntity,
  MessageData,
  ToolCallInfo,
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
  OperationLock,
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
  InvitationLandingView,
  PersonalStudioRef,
  InvitableProjectRole,
  ProjectInvitationStatus,
  PendingProjectInvitationSummary,
  ProjectInvitationLandingView,
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
  HANDLING_TIMEOUT_MS,
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
  defaultAdjustValue,
  isAdjustValueNeutral,
  parseAdjustValue,
  buildAdjustVideoFilter,
} from "@shared/adjust-value.js";
export type { AdjustValue } from "@shared/adjust-value.js";

export { newId, deriveId } from "@shared/ids.js";

export { fullJitter, exponentialJitterDelay } from "@shared/backoff.js";
export { sleep } from "@shared/sleep.js";

// The one HTTP transport with retries — backend services and browser alike.
// Callers state the `replaySafe` fact and the transport applies the judgement,
// so a verdict is reached in exactly one place. (`decideRetry` itself is
// exported further down, for the one caller whose retry subject is not a
// `fetch`; the point is one implementation of the judgement, not one exit.)
//
// It hands back the platform's own `Response` and holds nothing afterwards.
// Reading it — how long a read may stall, how large it may be, how to stop
// one — belongs to the caller: the HTTP client underneath already times a
// stalled read, and a second timer on top would be a duplicate with worse
// information (decided 2026-08-02).
export { httpRequest } from "@shared/http/request.js";
export type { HttpRequestOptions, HttpOutcome } from "@shared/http/request.js";
// No constants are exported. They are fixed rather than configurable on
// purpose — worker and browser each used to carry their own copy of the retry
// count and the two drifted into meaning different things — so putting them on
// the public surface invites exactly the second opinion the fixed values exist
// to prevent.
// The judgement is exposed on its own for callers whose retry subject is not
// a `fetch` — the browser's presign step retries an axios call, so it owns the
// loop but must not own a second opinion about what is worth retrying.
export { decideRetry } from "@shared/http/decide-retry.js";
export type {
  RetryDecision,
  RetryInput,
  RetryRefusal,
  RetryTrigger,
  TransportErrorKind,
} from "@shared/http/decide-retry.js";
