// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  CreditLotEntity,
  CreditLotLifecycle,
  CreditLedgerEntryEntity,
  CreditLedgerEntryType,
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
  StoredMessageMetadata,
} from "@shared/types/entities.js";

export type {
  CreditPage,
  CreditLotView,
  StudioLotView,
  CreditLedgerKind,
  CreditLedgerView,
  StudioLedgerView,
  StudioCreditsView,
  StudioCreditSummary,
  CreditOverview,
} from "@shared/types/credit.js";

export {
  HANDLING_TIMEOUT_MS,
  canGenerate,
} from "@shared/types/canvas-node.js";
export type {
  NodeState,
  NodeType,
  HandlingActor,
  HandlingPhase,
  AttachRef,
  FocusImage,
  CanvasNodeFields,
  NodeStateUpdateEvent,
  NodeEvent,
} from "@shared/types/canvas-node.js";

export type {
  ModelModality,
  ModelTier,
  ParamDescriptor,
  ModelProvider,
  ModelEntry,
  ModelCatalog,
  SourceType,
} from "@shared/types/model-catalog.js";
export {
  modelCatalogSchema,
  sanitizeModelCatalog,
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
} from "@shared/types/model-catalog.js";

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
  PersonalStudioRef,
} from "@shared/types/studio.js";

export { STUDIO_ROLE_RANK } from "@shared/types/studio.js";

export type {
  MembershipTier,
  ConfiguredMembershipTier,
  MembershipLimits,
  ComparableMembershipTier,
  SubscribableMembershipTier,
  SubscriptionSituation,
  SubscriptionActionAvailability,
  UpgradeOffer,
  SubscriptionSummary,
  TierOffer,
  AccountUsage,
  AccountMembership,
} from "@shared/types/membership.js";

export {
  MEMBERSHIP_TIERS,
  CONFIGURED_MEMBERSHIP_TIERS,
  tierLimitsSchema,
  COMPARABLE_MEMBERSHIP_TIERS,
  SUBSCRIBABLE_MEMBERSHIP_TIERS,
  SUBSCRIPTION_SITUATIONS,
  ACTIONABLE_SUBSCRIPTION_SITUATIONS,
  holdsActionableSubscription,
  subscriptionActions,
  isComparableMembershipTier,
} from "@shared/types/membership.js";

export type {
  InvitableProjectRole,
  ProjectInvitationStatus,
  PendingProjectInvitationSummary,
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
} from "@shared/types/space-rpc.js";

export {
  membersChangedChannel,
  activityNewChannel,
  allProjectChannelsPattern,
} from "@shared/types/redis-events.js";
export type {
  MembersChangedEvent,
  ActivityNewControlEvent,
  ProjectDeletedLifecycleEvent,
  ProjectDuplicatedLifecycleEvent,
  ProjectLifecycleEvent,
} from "@shared/types/redis-events.js";
