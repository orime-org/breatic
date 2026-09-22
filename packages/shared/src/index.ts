// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

export {
  Environment,
  TaskStatus,
  DEFAULT_API_PORT,
  DEFAULT_COLLAB_PORT,
  AVATAR_OUTPUT_PX,
  USER_LOOKUP_MAX_IDS,
} from "@shared/constants/index.js";

export type {
  Environment as EnvironmentType,
  TaskStatus as TaskStatusType,
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
  StoredMessageMetadata,
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
  NodeType,
  AttachRef,
  FocusImage,
  AnnotationReply,
  CanvasNodeFields,
  NodeTaskCounts,
  NodeTaskResult,
  NodeTaskCountsEvent,
  NodeEvent,
  ModelModality,
  ModelTier,
  ParamDescriptor,
  RemoteParamSource,
  ModelRate,
  ModelProvider,
  ModelEntry,
  ModelCatalog,
  SourceType,
  SourceRule,
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
  Voice,
  VoicePage,
} from "@shared/types/index.js";

export {
  ROLE_RANK,
  STUDIO_ROLE_RANK,
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
  canGenerate,
  CANVAS_NODES_KEY,
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
  GENERATION_SOURCES,
  GenerationActivityPayloadSchema,
  SpaceActivityPayloadSchema,
  MemberActivityPayloadSchema,
  ProjectActivityEntrySchema,
  ProjectActivityPageSchema,
  ActivityNewSignalSchema,
} from "@shared/types/index.js";
export type { ControlGate } from "@shared/types/index.js";
export type { GenerationSource } from "@shared/types/project-activity.js";
export type { GenerationNodeType } from "@shared/types/index.js";
export type {
  PromptSegment,
  ProposalNode,
  CanvasProposal,
  ProposalRefused,
  ProposalAnswer,
} from "@shared/types/index.js";
export type { ParamOptionValue } from "@shared/types/index.js";

export type {
  ProjectActivityType,
  ProjectActivityEntry,
  ProjectActivityPage,
  ActivityNewSignal,
} from "@shared/types/index.js";

export {
  SOURCE_RULES,
  modelCatalogSchema,
  sanitizeModelCatalog,
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
  AUDIO_GENERATION_MODES,
  GENERATION_NODE_BUCKETS,
  GENERATION_NODE_MODES,
  paramValues,
  REFERENCE_POOL_PARAM,
  PANEL_EDITOR_PARAM,
  markText,
  promptTextOf,
  sanitizeVoicePage,
} from "@shared/types/index.js";

export type {
  CreditPage,
  CreditSourceKind,
  PurchaseRow,
  CreditLotView,
  StudioLotView,
  CreditLedgerKind,
  CreditLedgerView,
  StudioLedgerView,
  StudioCreditsView,
  StudioCreditSummary,
  CreditOverview,
} from "@shared/types/index.js";

export {
  accountTotal,
  CREDIT_SOURCE_KINDS,
  isPurchased,
  GRANTED_SOURCE_KINDS,
  HELD_LIFECYCLES,
  IN_FLIGHT_REFUND_LIFECYCLES,
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
  nodeHistorySnapshotSchema,
  projectCreateSchema,
  checkoutSchema,
  paymentConfirmSchema,
  paymentCancelSchema,
  paymentHistoryQuerySchema,
  subscriptionPlanSchema,
  subscriptionChangeSchema,
  paginationSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
  chatEarlierMessagesQuerySchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
  CHAT_MESSAGE_MAX_CHARS,
  CONVERSATION_TITLE_MAX_CHARS,
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
  PaymentConfirmInput,
  PaymentCancelInput,
  PaymentHistoryQuery,
  PaginationInput,
  ChatConversationsQueryInput,
  ChatCreateConversationInput,
  ChatRenameConversationInput,
} from "@shared/schemas/index.js";

export {
  t,
  setLocale,
  getLocale,
  getActiveLocale,
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

// The confirmation email names the instant the window closes, in the buyer's
// zone and in UTC; the eligibility rule beside it asks whether that instant
// has passed. Both the server and the refunds screen read that rule, and they
// read this one copy of it.
export {
  refundWindowCloses,
  withinRefundWindow,
} from "@shared/refund-window.js";
export {
  REFUND_LIFECYCLES,
  refundRefusal,
} from "@shared/refund-eligibility.js";
export type {
  RefundCandidate,
  RefundRefusal,
} from "@shared/refund-eligibility.js";

export { newId, deriveId } from "@shared/ids.js";

// The three gates on a capped list param — the panel while picking, the server
// before enqueue, the worker before mapping to vendor names — read one number,
// so a submission the panel allowed is never the one the worker truncates.
export { effectiveItemCap, isPresent } from "@shared/item-cap.js";
export type { CappedParam } from "@shared/item-cap.js";

// The tab bar belongs to one browser; these are the pure ordering rules the
// reducer and the Space drawer call.
export {
  applyTabMove,
  initialOpenTabIds,
  sameTabOrder,
  spacesNewestFirst,
  type TabOrderEntry,
} from "@shared/tab-order.js";

// How many beats in a row may go missing before the agent chat stream is
// called dead. How often they arrive is `config/agent.yaml`'s, served to the
// browser at `GET /chat/stream-config`.
export { SSE_HEARTBEAT_MISSES_ALLOWED } from "@shared/agent/heartbeat.js";
export { extractPromptText } from "@shared/agent/extract-prompt.js";
export {
  carrying,
  FAILURE_LINES,
  isReaderLine,
  NOTHING_SAID_WHY,
  toolFailureOf,
} from "@shared/agent/tool-failure.js";
export type {
  FailureLine,
  StoppedLine,
  ToolFailure,
  ToolFailureKind,
} from "@shared/agent/tool-failure.js";

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
export { readWithin, readBytesWithin, BodyTooLarge, EmptyBody } from "@shared/http/read-within.js";

// Beside the transport because it undoes what the transport did: a request
// that was retried is reported as "failed after N attempts", and which
// failure it was sits underneath that sentence.
export { reasonOf } from "@shared/http/reason.js";

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

// The upload ticket (#173). Its two consumers sit on opposite sides of a
// runtime boundary: our server mints one, the ingest Worker verifies it, and
// Cloudflare Workers cannot load `@breatic/core` — every backend package below
// this one reaches for a `node:` module somewhere in its import graph. The
// package rule reads "does web use it? no → core", and web does not use this;
// it is here because it is the one package the Worker can load at all, and
// because a second copy of a signature format is how the two sides drift into
// rejecting each other's tickets.
export {
  MIN_PART_SIZE_BYTES,
  signUploadTicket,
  verifyUploadTicket,
  type UploadTicketPayload,
  type UploadTicketRejection,
  type UploadTicketVerification,
} from "@shared/upload/ticket.js";
// The credential a part carries, beside the ticket for the same reason: the
// Worker verifies one on every part, and our server verifies the last one when
// it drives the finish, reading the key out of the signature rather than off
// the request body.
export {
  signSessionToken,
  verifySessionToken,
  type PartLayout,
  type SessionTokenPayload,
} from "@shared/upload/session-token.js";
// Why a task failed, as a code rather than a sentence: the writer is a server
// and the reader is whoever opens the list, in their own language.
export {
  TASK_FAILURE_REASONS,
  encodeTaskFailure,
  readTaskFailure,
  type TaskFailureReason,
} from "@shared/types/task-failure.js";
// Which media the understanding endpoint takes. Both ends ask it: the browser
// before it builds anything, the backend before it sends bytes.
export {
  AUDIO_FORMAT_NAMES,
  IMAGE_TYPES,
  IMAGE_FORMAT_NAMES,
  VIDEO_FORMAT_NAMES,
  audioFormatOf,
  videoFormatOf,
  type AudioFormat,
  type VideoFormat,
} from "@shared/understand/media-formats.js";
// The one word each format goes by on screen, asked by both gates that name a
// format while refusing a file.
export {
  formatNameOf,
  formatPhrase,
} from "@shared/media/format-names.js";
// What a stored asset is called, which is the last segment of the address it
// is stored at — read by both ends that name a file while refusing it.
export { assetNameFromUrl } from "@shared/media/asset-name.js";
// Plain text in and out of a text node's body ships at
// `@breatic/shared/canvas/text-body` — that file says why it is not here.

// The arithmetic both sides of an upload read: the browser sizes each part's
// deadline with it, and the config refuses windows narrower than what they
// have to hold.
export {
  partDeadlineMs,
  partRetryBudgetMs,
  completeRetryBudgetMs,
  assertUploadWindows,
  type PartDeadlineConfig,
  type UploadWindows,
} from "@shared/upload/windows.js";
// Sending bytes to the ingest Worker. Whoever holds them sends them: the
// browser for a file a person picked, our own backend for what it produced
// itself -- one implementation, so "every asset reaches R2 through the ingest
// Worker" is not a rule each caller is trusted to follow.
export {
  sendBytesToIngest,
  finishUploadAtIngest,
  fetchUrlToIngest,
  computePutTimeoutMs,
  IngestAnswerError,
  UploadHttpError,
  type UploadClientConfig,
  type IngestTarget,
  type IngestOutcome,
  type HeldUpload,
  type PartReceipt,
  type IngestMeasurements,
  type MediaLimits,
} from "@shared/upload/ingest-client.js";
// The encoding those credentials use, exported for the session token the
// Worker signs with the same secret. `btoa` refuses anything outside latin1,
// and a storage key's extension comes from a filename we let be any Unicode.
export {
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Bytes,
  decodeBase64Bytes,
} from "@shared/upload/base64.js";
// The credential format both halves of an upload use: our server signs the
// ticket and the session token with one secret, and the Worker verifies both.
export {
  signPayload,
  readSignedPayload,
  type SignedPayloadReading,
  type SignedPayloadRejection,
} from "@shared/upload/signed-payload.js";
// The one judgement a declared media type gets, wherever it arrives from: the
// ticket endpoint reads what a browser declares, the ingest Worker reads what
// a source URL's response declares, and both cut the value the same way.
export {
  reduceMediaType,
  canonicalMediaType,
  isUploadableMediaType,
  uploadableSpellings,
  uploadableFormatList,
  hasCoverFrame,
} from "@shared/upload/media-type.js";
// The type read off the bytes themselves. It lives beside the lists above
// because they answer two halves of one question: what these bytes are, and
// whether we take it.
export {
  sniffMimeType,
  sniffMimeTypeOfStream,
  SNIFF_WINDOW,
} from "@shared/upload/sniff-mime.js";
// Why the Worker refused, named on the answer. Four separate failures share
// one status, and a caller that has to tell them apart cannot do it from the
// status alone.
export {
  INGEST_FAILURE_HEADER,
  INGEST_FAILURE_CODES,
  INGEST_REFUSED_UNNAMED,
  INGEST_NO_ANSWER,
  INGEST_TYPE_NOT_REPORTED,
  INGEST_NOT_STARTED,
  INGEST_SETTLEMENT_CODES,
  readIngestFailureCode,
  type IngestFailureCode,
} from "@shared/upload/ingest-failure.js";
// Whether a Generate panel may execute, and what to say when it may not.
// In shared rather than in the panel because the proposal tool has to answer
// the same question about a group it is about to offer: two implementations of
// "would the panel refuse this" is the split #269 removes.
export {
  evaluateExecute,
  isExecuteButtonDisabled,
  refusalToastKey,
  REFUSAL_TOAST_KEY,
  type ExecuteGateInput,
  type ExecuteRefusal,
  type ExecuteVerdict,
} from "@shared/generate-guards.js";
// How many references a model takes, read the same way by the panels that
// draw the pool, the gate that refuses a submit over it, and the tool.
export { positiveCap, referenceCapExceeded } from "@shared/reference-cap.js";
