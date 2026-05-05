export {
  Environment,
  LoginMode,
  TaskStatus,
  StorageProvider,
  DEV_USER_ID,
} from "./constants/index.js";

export type {
  Environment as EnvironmentType,
  LoginMode as LoginModeType,
  TaskStatus as TaskStatusType,
  StorageProvider as StorageProviderType,
} from "./constants/index.js";

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
  ProjectEntity,
  ProjectDetail,
  MemoryContext,
  SkillMeta,
  NodeState,
  HandlingActor,
  AttachRef,
  CanvasNodeFields,
  NodeStateUpdateEvent,
  NodeEvent,
  ProjectRole,
  ProjectMember,
  Studio,
} from "./types/index.js";

export { ROLE_RANK } from "./types/index.js";

export type {
  ApiResponse,
  PaginatedResponse,
  ApiError,
} from "./types/api.js";

// ── API Schemas ─────────────────────────────────────────────────────
export {
  registerSchema,
  loginSchema,
  chatMessageSchema,
  skillCommandSchema,
  taskCreateSchema,
  understandSchema,
  projectCreateSchema,
  checkoutSchema,
  paginationSchema,
} from "./schemas/index.js";

export type {
  RegisterInput,
  LoginInput,
  ChatMessageInput,
  SkillCommandInput,
  TaskCreateInput,
  UnderstandInput,
  ProjectCreateInput,
  CheckoutInput,
  PaginationInput,
} from "./schemas/index.js";

export { t, setLocale, getLocale, getAvailableLocales, loadLocales, resetLocales } from "./i18n/index.js";
export type { Locale } from "./i18n/index.js";

export {
  projectMetaDocName,
  canvasSpaceDocName,
  documentSpaceDocName,
  timelineSpaceDocName,
  parseDocName,
  isProjectScopedDocName,
  // Deprecated pre-v10 single-doc helpers; PR-C deletes these.
  projectDocName,
  parseProjectDocName,
} from "./yjs-doc-names.js";
export type { DocKind, ParsedDocName } from "./yjs-doc-names.js";

export {
  defaultAdjustValue,
  isAdjustValueNeutral,
  parseAdjustValue,
  buildAdjustVideoFilter,
} from "./adjust-value.js";
export type { AdjustValue } from "./adjust-value.js";
