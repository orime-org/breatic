// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared entity interfaces for cross-layer data transfer.
 *
 * These are the "clean" types that cross layer boundaries — routes,
 * services, and the frontend all use these. ORM/Drizzle types stay
 * inside the server package.
 */

import type { ProjectRole } from "@shared/types/role.js";

/** User entity (excludes hashed_password for safety). */
export interface UserEntity {
  id: string;
  email: string;
  emailVerified: boolean;
  googleId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Conversation entity (without inline messages). */
export interface ConversationEntity {
  id: string;
  userId: string;
  title: string;
  projectId: string | null;
  /** Turn index up to which messages have been consolidated into memory. */
  lastConsolidatedTurn: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Structured tool call info within a message. */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Parsed tool output for tools whose result drives a frontend UI render
   * (e.g., v13 interaction tools `ask_user_choice` / `propose_canvas_action` /
   * `show_search_results`). For LLM-only tools, the result lives in the
   * paired `role: 'tool'` message and this field stays unset.
   */
  result?: Record<string, unknown>;
}

/** Single message within a conversation. */
export interface MessageData {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: string;
  /** Turn index — increments on each user message. */
  turnIndex: number;
  /** Model reasoning/thinking content (not sent back to LLM). */
  thinking?: string;
  tool_calls?: ToolCallInfo[];
  tool_call_id?: string;
  name?: string;
}

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
  source: "ai" | "upload";
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
