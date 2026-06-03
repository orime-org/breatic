// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

export {
  Environment,
  TaskStatus,
  StorageProvider,
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
  ConversationAttachmentEntity,
  AssetKind,
  PaymentEntity,
  CreditTransactionEntity,
  NotificationEntity,
  ProjectEntity,
  ProjectDetail,
  MemoryContext,
  SkillMeta,
  NodeState,
  HandlingActor,
  OperationLock,
  AttachRef,
  CanvasNodeFields,
  CanvasEdgeData,
  GenerativeRefSourceType,
  ReferenceItem,
  ChipSnapshot,
  PromptInline,
  PromptDoc,
  NodeStateUpdateEvent,
  NodeEvent,
  ProjectRole,
  ProjectMember,
  Studio,
  SpaceType,
  Space,
  MembersChangedEvent,
  ProjectDeletedLifecycleEvent,
  ProjectDuplicatedLifecycleEvent,
  ProjectLifecycleEvent,
} from "@shared/types/index.js";

export {
  ROLE_RANK,
  membersChangedChannel,
  ALL_PROJECT_CHANNELS_PATTERN,
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
  MessagesClearPayloadSchema,
  ProjectMessageKindSchema,
  ProjectMessageEntrySchema,
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
  MessagesClearPayload,
  ProjectMessageKind,
  ProjectMessageEntry,
} from "@shared/types/index.js";

export type {
  ApiResponse,
  PaginatedResponse,
  ApiError,
} from "@shared/types/api.js";

// ── API Schemas ─────────────────────────────────────────────────────
export {
  registerSchema,
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
