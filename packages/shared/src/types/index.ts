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
  ProjectVisibility,
  ProjectDetail,
  ProjectSummary,
  RecentItem,
  MemoryContext,
  SkillMeta,
} from "@shared/types/entities.js";

export { HANDLING_TIMEOUT_MS } from "@shared/types/canvas-node.js";
export type {
  NodeState,
  NodeType,
  HandlingActor,
  HandlingPhase,
  OperationLock,
  AttachRef,
  CanvasNodeFields,
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
  StudioMemberSummary,
  StudioInvitationStatus,
  PendingInvitationSummary,
  StudioMembersView,
  InvitationLandingView,
  PersonalStudioRef,
} from "@shared/types/studio.js";

export type {
  InvitableProjectRole,
  ProjectInvitationStatus,
  PendingProjectInvitationSummary,
  ProjectInvitationLandingView,
} from "@shared/types/project-invite.js";

export type { SpaceType, Space } from "@shared/types/space.js";
export { SpaceTypeSchema } from "@shared/types/space.js";

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
} from "@shared/types/project-activity.js";
export type {
  ProjectActivityType,
  ProjectActivityEntry,
  ProjectActivityPage,
  ActivityNewSignal,
} from "@shared/types/project-activity.js";

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
