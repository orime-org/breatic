// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
} from "@shared/types/entities.js";

export type {
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
} from "@shared/types/canvas-node.js";

export { ROLE_RANK } from "@shared/types/role.js";
export type { ProjectRole, ProjectMember } from "@shared/types/role.js";

export type {
  Studio,
  StudioType,
  StudioRole,
  StudioMember,
  StudioSummary,
  StudioDetail,
  PersonalStudioRef,
} from "@shared/types/studio.js";

export type { SpaceType, Space } from "@shared/types/space.js";
export { SpaceTypeSchema } from "@shared/types/space.js";

export {
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
} from "@shared/types/space-rpc.js";
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
} from "@shared/types/space-rpc.js";

export {
  membersChangedChannel,
  ALL_PROJECT_CHANNELS_PATTERN,
} from "@shared/types/redis-events.js";
export type {
  MembersChangedEvent,
  ProjectDeletedLifecycleEvent,
  ProjectDuplicatedLifecycleEvent,
  ProjectLifecycleEvent,
} from "@shared/types/redis-events.js";
