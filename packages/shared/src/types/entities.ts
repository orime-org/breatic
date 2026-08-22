// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared entity interfaces for cross-layer data transfer.
 *
 * These are the "clean" types that cross layer boundaries — routes,
 * services, and the frontend all use these. ORM/Drizzle types stay
 * inside the server package.
 */

import type { ToolFailure } from "@shared/agent/tool-failure.js";
import type { MembershipTier } from "@shared/types/membership.js";
import type { ProjectRole } from "@shared/types/role.js";

/** User entity (excludes hashed_password for safety). */
export interface UserEntity {
  id: string;
  email: string;
  emailVerified: boolean;
  googleId: string | null;
  /**
   * Which membership tier this account is on.
   *
   * It travels with the session payload because the avatar menu names the
   * tier and that menu renders in every studio's top bar. Answering from the
   * membership endpoint instead would sum every controlled studio's assets
   * just to light up a label. The tier is a fixed property of the account,
   * the same kind of thing as its email — the ceilings it grants are not,
   * and those stay behind the endpoint that reads them.
   */
  membershipTier: MembershipTier;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Conversation entity (without inline messages). */
export interface ConversationEntity {
  id: string;
  userId: string;
  /** Null until the conversation has been named, by its first message or by its owner. */
  title: string | null;
  projectId: string | null;
  /** Turn index up to which messages have been consolidated into memory. */
  lastConsolidatedTurn: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * One piece of a stored message.
 *
 * A message is not a single string: an assistant turn can carry reasoning,
 * visible prose and a tool call at once, and later work adds execution steps
 * and interactive cards to the same list. Storing the pieces as a list is the
 * shape the AI SDK itself uses for UI messages, and the shape every chat
 * product renders from — a tool call is a foldable block inside the reply,
 * not a reply of its own.
 *
 * These go out as they are. A reader that wants the pieces gets the pieces;
 * the flat fields on {@link MessageData} sit beside them for readers that
 * only want the prose. What does not happen is a reader receiving the flat
 * form and having to guess the pieces back out of it.
 */
/**
 * What a stored message carries besides its parts, on its way to the browser.
 *
 * The turn is what the client pages back with; the timestamp is what it shows.
 * Both are ours rather than the streaming protocol's, which is what the SDK's
 * `metadata` slot is for.
 *
 * Here rather than beside either side of the wire because both sides declare
 * the same message type and neither imports the other: two hand-written
 * copies both type-check, and a field renamed on one side would surface only
 * as an undefined at runtime. The message type itself stays on each side --
 * it is `UIMessage<StoredMessageMetadata>`, and `UIMessage` comes from `ai`,
 * which this package does not depend on.
 */
export type StoredMessageMetadata = {
  /** The turn this message belongs to. Increments on each user message. */
  turnIndex: number;
  /** When the row was written, ISO-formatted. */
  ts: string;
};

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /**
   * One use of one tool, from the call to whatever came back.
   *
   * A call and its result are one thing that happened, so they are one part
   * with a status rather than two parts to pair up by id. That pairing is
   * what every reader would otherwise have to redo, and a reader that meets
   * the call without the result — a turn stopped mid-tool — has to invent an
   * answer for a state the store could have just told it.
   */
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      /**
       * What the model sent, as it sent it.
       *
       * A string when the arguments would not parse as JSON: the model's own
       * text is then the only record of what it tried, and it is what the
       * model needs to see to correct itself.
       */
      input: Record<string, unknown> | string;
      /** How far this use of the tool got. */
      status: "pending" | "success" | "error";
      /**
       * What the tool returned, as the tool returned it.
       *
       * Whatever the tool's own return type is: the search tools answer with
       * prose, the four interaction tools answer with the object the panel
       * needs to draw their question. Narrowing this to a string would be a
       * type that disagrees with the rows already in the table -- and the
       * disagreement shows up two turns later, when the history goes back to
       * the model in the wrong arm of its output union.
       *
       * Absent while the status is still `pending`.
       */
      output?: unknown;
      /**
       * Why it ended with nothing to show. Only set when the status is
       * `error`, and set for every stored part that is.
       *
       * Optional in the type because a part is built up as the call runs and
       * is `pending` until it is not. A stored `error` part without one is a
       * record that cannot say what happened, which is what this replaced.
       */
      failure?: ToolFailure;
      /**
       * The arguments never finished arriving.
       *
       * A turn cut off while the model was still emitting a call leaves the
       * arguments half-parsed -- the SDK fills `input` from a partial JSON
       * parse on every delta. The panel still shows the call, because the
       * reader watched it start; the model is not shown it, because it would
       * read as a call it made with arguments it never sent.
       */
      argumentsIncomplete?: boolean;
    }
  /**
   * The turn this message belongs to was stopped before it finished.
   *
   * A part rather than a column because the row has nowhere else to put it:
   * `conversation_messages` stores role, turn index, sequence and this list,
   * and a message-level flag would otherwise need a migration to say something
   * the list can already carry. It is also the only piece a stopped turn is
   * guaranteed to have — a turn cut off before it wrote a word produces no
   * text, no reasoning and no tool call, and a row with an empty list is
   * indistinguishable from nothing having happened.
   */
  | { type: "interrupted" }
  /**
   * The turn could not be finished: the provider refused, or something in the
   * loop threw. Whatever had been written stands, and this says it stopped
   * there for a reason rather than because the model had said everything.
   *
   * A part for the same reason `interrupted` is one, and the same guarantee
   * follows: a turn that fails before the model says a word produces nothing
   * else, and a row with an empty list cannot be told apart from a turn that
   * never happened. Being stopped and failing are the two ways a turn ends
   * without finishing, and a reader has to tell them apart — one is something
   * the user did, the other is something that went wrong.
   */
  | { type: "failed" };

/**
 * Single message within a conversation, as the rest of the app handles it.
 *
 * The store keeps the pieces in {@link MessagePart} form; the repository maps
 * between the two so callers keep working with one flat shape.
 */
export interface MessageData {
  /**
   * The row's own id. What a client keys its rendered list on — deriving a key
   * from position or turn index would be making up something the store already
   * knows.
   *
   * Absent only on a message that has not been written yet, which is how a
   * caller assembling one for the store passes it in.
   */
  id?: string;
  role: "user" | "assistant";
  /**
   * The pieces of this message, in the order they happened.
   *
   * This is the message. Everything below is a flat view derived from it, kept
   * for readers that only need the prose.
   */
  parts: MessagePart[];
  /** Every `text` part joined — what this message says, without the rest. */
  content: string;
  /** Creation time, ISO-formatted. Assigned by the store, never by callers. */
  ts: string;
  /** Turn index — increments on each user message. Assigned by the store. */
  turnIndex: number;
  /** The `reasoning` parts joined. Never sent back to the model. */
  thinking?: string;
  /**
   * The turn was stopped before it finished, so `content` is as far as it got.
   *
   * Only ever `true`: its absence is the ordinary case, and a `false` would
   * have to be written on every message that ever completed normally.
   */
  interrupted?: true;
  /**
   * The turn could not be finished, so `content` is as far as it got.
   *
   * Only ever `true`, for the same reason as {@link MessageData.interrupted}.
   */
  failed?: true;
}

/**
 * A message as a caller hands it to the store.
 *
 * Only what the caller knows: who is speaking, what happened, and — for a
 * reply — which turn it answers. The id, the timestamp, the sequence within
 * the turn are the store's to assign, and `content` / `thinking` are read
 * back off the parts rather than written twice.
 *
 * The two roles differ on the turn index because they genuinely differ: a
 * question opens a turn, so its number is the store's to hand out, while a
 * reply joins one that already exists. Saying so here is what makes a reply
 * with no turn to answer impossible to write down, rather than something a
 * rule has to catch.
 */
export type MessageInput =
  | (Pick<MessageData, "parts"> & { role: "user" })
  | (Pick<MessageData, "parts" | "turnIndex"> & { role: "assistant" });

/** Task entity. */
export interface TaskEntity {
  id: string;
  userId: string;
  projectId: string | null;
  /**
   * Space within the project the task targets (v10 multi-doc).
   * Worker writes results to `project-{projectId}/canvas-{spaceId}`,
   * so the column is non-null. No FK — Spaces live in Yjs.
   */
  spaceId: string;
  taskType: string;
  /**
   * Execution mode — `'append'` (new sibling) or `'overwrite'` (replace
   * existing target). Required at task creation; the worker uses this to
   * decide whether to verify + release the canvas-node Redis lock
   * (spec §10.13 / §10.15).
   */
  mode: "append" | "overwrite";
  model: string | null;
  skillName: string | null;
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  arqJobId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  creditsUsed: number;
  durationMs: number | null;
  resolvedSkills: string[];
  source: string;
  /** URL returned by the AIGC provider (pre-persistence). Set as the "no-retry" point of no return. */
  providerResultUrl: string | null;
  /** Vendor task id for async generation; on retry the Worker resumes by polling it (#1628). */
  providerTaskId: string | null;
  /** Idempotency guard for credit deduction — set when charge has been applied. */
  billedAt: Date | null;
  /** Actual credits charged (audit trail). */
  billedCredits: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Kinds of uploadable assets. */
export type AssetKind = "image" | "video" | "audio" | "3d" | "document";

/** Conversation attachment — per-conversation reference pool. */
export interface ConversationAttachmentEntity {
  id: string;
  conversationId: string;
  userId: string;
  url: string;
  thumbnailUrl: string | null;
  name: string;
  mimeType: string;
  size: number;
  kind: AssetKind;
  deletedAt: Date | null;
  createdAt: Date;
}

/** Node history entry — per-node content timeline (generation + upload). */
export interface NodeHistoryEntity {
  id: string;
  projectId: string;
  nodeId: string;
  userId: string;
  /**
   * Display name of the operator (`userId`), joined server-side from their
   * personal studio — the app-wide display-name source (pointer model, so
   * renames propagate; mirrors `ProjectActivityEntry.actorName`). `null` when
   * unresolved (studio deleted) and on the write paths, which do not join —
   * only `listByNode` populates it for the browse UI (#1619).
   */
  operatorName: string | null;
  entryType: "generation" | "upload";
  status: "success" | "failed";
  content: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  taskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Physical asset entity (spec 2026-07-04-asset-layer-v1). One row per
 * unique stored object per studio (within-studio dedup). `contentHash`
 * is a dedup column only — it is never part of `fileUrl` (URLs stay
 * random + unguessable). `generationTaskId` links an AI asset to its
 * cost; null for uploads.
 */
export interface StudioAssetEntity {
  id: string;
  studioId: string;
  contentHash: string;
  storageKey: string;
  fileUrl: string;
  sizeBytes: number;
  mimeType: string;
  kind: "image" | "video" | "audio" | "document" | "file";
  /**
   * 'ai' (worker-generated) | 'upload' (user upload) | 'cover' (a video's
   * first-class cover asset — #1826 §4.5: the cover is a normal studio_assets
   * row that counts toward storage, kind judged from the cover itself = image).
   */
  source: "ai" | "upload" | "cover";
  /**
   * Who FIRST brought this content into the studio (#1839). Distinct from
   * `studioId` (who OWNS it): attribution follows the project's studio for
   * personal and team studios alike, so the producer can no longer be
   * recovered from the owner studio. On a dedup hit the existing row keeps
   * its original producer — a later uploader of the same bytes is not
   * recorded (their upload deduped away).
   */
  producedByUserId: string;
  generationTaskId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Payment entity. */
export interface PaymentEntity {
  id: string;
  userId: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  creditsGranted: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Credit transaction entity. */
export interface CreditTransactionEntity {
  id: string;
  userId: string;
  txType: string;
  amount: number;
  balanceAfter: number;
  tokensUsed: number | null;
  model: string | null;
  provider: string | null;
  description: string | null;
  referenceId: string | null;
  createdAt: Date;
}

/**
 * Notification entity (per-user inbox row). Hand-written domain shape so
 * the `notifications` Drizzle row type never leaks out of the repo layer
 * into service / route signatures (prohibition #3 — the repo maps the
 * Drizzle row to this via `toEntity`). `payload` is opaque jsonb;
 * consumers narrow it by the `type` discriminator.
 */
export interface NotificationEntity {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  projectId: string | null;
  readAt: Date | null;
  /** Actionable-notification TTL (slice 3); null = no expiry. */
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The current display identity of something a notification points at.
 *
 * Resolved server-side at read time from an immutable id, never stored in the
 * notification itself. That is the whole point: a stored slug is a snapshot of
 * a name that can change hands, and for a personal studio the slug IS the
 * user's `@handle` — once someone else claims a released handle, a stored copy
 * silently points at a stranger.
 */
export interface NotificationRef {
  /** Current URL slug, for building the link. */
  slug: string;
  /** Current display name, for the link text. */
  name: string;
  /**
   * The target has been soft-deleted: name it, but do not link to it.
   *
   * Soft delete is deactivation, not erasure — the same split GitHub draws
   * with its ghost user and Slack draws between deactivating an account and
   * deleting its profile. At this level the name stays visible, because a
   * notification is a record of something that happened and "someone invited
   * you to something" is not a usable record. Actual erasure (the GDPR path)
   * anonymises the ROW; resolution then returns the anonymised value and this
   * layer needs no special case.
   */
  deleted: boolean;
}

/**
 * A page of notifications plus the identities its ids resolve to right now.
 *
 * `resolved` lives INSIDE `data` rather than beside it because the frontend's
 * request helper unwraps the envelope and discards everything else — a sibling
 * field would arrive as `undefined` with no type error to warn anyone.
 *
 * An id missing from its map means the target is gone (deleted, or never
 * resolvable); the frontend renders that reference as plain text instead of a
 * dead link. Lookups are batched per kind, so one page costs a constant number
 * of queries no matter how many notifications it holds.
 */
export interface NotificationListView {
  items: NotificationEntity[];
  resolved: {
    /** Keyed by user id → that user's personal studio (their `@handle`). */
    users: Record<string, NotificationRef>;
    /** Keyed by studio id. */
    studios: Record<string, NotificationRef>;
    /** Keyed by project id. */
    projects: Record<string, NotificationRef>;
  };
}

/**
 * Project visibility (slice 2). 'studio' = open baseline, visible to every
 * studio member; 'private' = only users with an explicit project_members row.
 */
export type ProjectVisibility = "studio" | "private";

/** Project entity (v10 schema). */
export interface ProjectEntity {
  id: string;
  /**
   * The Studio this project belongs to. In V1 (personal Studio) this
   * is always the creator's personal studio; in team Studio (V2+) it
   * may be the team's studio.
   */
  studioId: string;
  /**
   * The user who created the project. Immutable — used only for audit
   * and "creator" UI labels. Does NOT participate in permission
   * decisions; permission goes through `project_members.role`.
   */
  createdByUserId: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  /** URL slug for /project/{slug}-{uuid}; format-validated, not unique. */
  slug: string;
  /** 'studio' (open baseline) | 'private' (explicit members only). */
  visibility: ProjectVisibility;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Project read DTO returned by `GET /api/v1/projects/:id` (v10 §7.2.6).
 *
 * Shape that the frontend consumes — joins ProjectEntity with the
 * caller's role on this project. The frontend uses `myRole` to gate
 * UI (e.g. hide chat for viewer, hide member-management for non-owner).
 */
export interface ProjectDetail {
  id: string;
  studioId: string;
  createdByUserId: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  /**
   * The requesting user's role on this project.
   *
   * Derived from `project_members` at request time; never persisted on
   * the project row itself.
   */
  myRole: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Project list-row DTO returned by `GET /api/v1/studio/:slug/projects`
 * (slice 2 — the studio container's "projects" tab).
 *
 * Visibility-filtered server-side (private projects the viewer has no role
 * on are never returned, unless the viewer is a studio admin). `myRole` is
 * nullable: a studio-visible project the viewer has not opened yet has no
 * `project_members` row, so `myRole` is `null` until they enter (which
 * materializes a viewer row — see `loadForViewer`). `isOwner` is NOT a
 * separate field: it is `myRole === 'owner'`, derived by the frontend.
 */
export interface ProjectSummary {
  id: string;
  studioId: string;
  name: string;
  /** URL slug for /project/{slug}-{uuid}; format-validated, not unique. */
  slug: string;
  /** 'studio' (open baseline) | 'private' (explicit members only). */
  visibility: ProjectVisibility;
  thumbnailUrl: string | null;
  /**
   * The viewer's role on this project, or `null` when they have no
   * `project_members` row yet (a studio-visible project not yet entered, or
   * a studio admin viewing a project they are not a member of).
   */
  myRole: ProjectRole | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A row in the cross-studio "Recent" landing feed, returned by
 * `GET /api/v1/studios/recent`.
 *
 * One entry per project the viewer has opened, ordered by the viewer's own
 * last-open time (per-user — another user's opens never affect this list).
 * Access-filtered server-side: a project the viewer can no longer reach
 * (kicked from the studio, turned private with no membership, soft-deleted) is
 * never returned, and another user's private project is never leaked. The
 * studio identity (`studioId` / `studioName`) backs the "from X studio" label
 * on the landing card. Recent-landing design §4.2.
 */
export interface RecentItem {
  /** The opened project's id (URL is `/project/{slug}-{projectId}`). */
  projectId: string;
  name: string;
  /** URL slug for /project/{slug}-{projectId}; format-validated, not unique. */
  slug: string;
  thumbnailUrl: string | null;
  /** The studio that houses the project. */
  studioId: string;
  /** The studio's display name (the "from X studio" label on the card). */
  studioName: string;
  /**
   * The viewer's role on this project (the card's role badge), or `null` for a
   * studio-visible project admitted via open baseline with no membership row.
   */
  myRole: ProjectRole | null;
  /** The viewer's own last-open time for this project (the sort key). */
  lastOpenedAt: Date;
}

/** Three-layer memory context for LLM prompts. */
export interface MemoryContext {
  userMemory: string;
  projectMemory: string;
  conversationMemory: string;
}

/** Skill metadata (from built-in SkillRegistry). */
export interface SkillMeta {
  name: string;
  description: string;
  category: string;
  tools: string[];
  outputType: string;
  keywords: string[];
}
