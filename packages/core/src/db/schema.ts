// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Drizzle ORM schema definitions for all database tables.
 *
 * Migrated from Python SQLAlchemy ORM models. All tables use UUID
 * primary keys and timestamp with timezone columns.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  doublePrecision,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// ── Helpers ──────────────────────────────────────────────────────────

/** Reusable timestamp columns (created_at + updated_at). */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

// ── 1. Users ─────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    // No business-identity columns here — a user's display name + URL
    // handle both live on their personal studio (studios.name /
    // studios.slug). `users` is the pure auth/account table (email
    // registration rewrite, 2026-06-06).
    avatarUrl: text("avatar_url"),
    hashedPassword: varchar("hashed_password", { length: 255 }),
    emailVerified: boolean("email_verified").default(false).notNull(),
    googleId: varchar("google_id", { length: 255 }),
    // Breatic is credits-only. No subscription tiers, no membership
    // levels - every user has the same feature set and pays per-use by
    // deducting credits. The old `membership_type` / `membership_expires_at`
    // columns were removed in the 0010_* migration.
    // Recovery code (GitHub backup-codes pattern, PR-a 2026-05-26):
    // bcrypt-hashed single-use code shown once at registration so users
    // can reset their password without an SMTP backend (self-host
    // friendly). After successful consumption, used_at is set and a
    // fresh code is generated + re-shown.
    recoveryCodeHash: text("recovery_code_hash"),
    recoveryCodeUsedAt: timestamp("recovery_code_used_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_google_id_idx").on(table.googleId),
  ],
);

// ── 2. Studios ───────────────────────────────────────────────────────
//
// V1 = personal Studio: every user has exactly one studio row, written
// at registration. The table exists in V1 only as a foreign-key target
// for `projects.studio_id`; it is otherwise an empty record. Asset
// management (`studio_assets`, `asset_models`) is deferred to V2.

export const studios = pgTable(
  "studios",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // The studio's URL handle. Globally unique across personal + team
    // (they share the /studio/{slug} namespace). For a personal studio the
    // slug is chosen at registration (2nd onboarding step); for a team
    // studio it is entered at creation. Slug-format validation is
    // application-level.
    slug: varchar("slug", { length: 40 }).notNull(),
    // 'personal' (one per user, auto-created at registration) | 'team'.
    type: varchar("type", { length: 16 }).notNull(),
    // Display name (editable). Initially equals the slug; for a personal
    // studio this is the user's display name (edited via studio settings).
    name: varchar("name", { length: 255 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Global-unique slug — personal + team studios share the /studio/{slug}
    // URL namespace. Partial unique lets a soft-deleted slug be reused.
    uniqueIndex("studios_slug_idx")
      .on(table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    // One personal studio per user (renamed from studios_owner_user_id_idx,
    // now scoped to type='personal' so a user may also own team studios).
    uniqueIndex("studios_owner_personal_idx")
      .on(table.createdByUserId)
      .where(sql`${table.type} = 'personal' AND ${table.deletedAt} IS NULL`),
  ],
);

// ── 3. Projects ──────────────────────────────────────────────────────
//
// v10 schema: project belongs to a studio (the studio that pays for /
// houses it). Owner / role information lives in `project_members`,
// not on the project row. `created_by_user_id` is an immutable audit
// field - used for "creator" UI labels, never for permission decisions.
//
// `canvas_data` (legacy JSONB snapshot) was dropped: live canvas state
// lives in Yjs documents (`project-{id}/canvas-{spaceId}`) and the
// `yjs_documents` table.

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    // URL slug for /project/{slug}-{uuid}. Format-validated app-side, NOT
    // unique (same-name projects disambiguate by uuid; URL design §5.7).
    slug: varchar("slug", { length: 120 }).notNull(),
    // 'studio' = visible to every studio member (open baseline); 'private'
    // = only users with an explicit project_members row (slice 2 §2.3).
    visibility: varchar("visibility", { length: 16 }).default("studio").notNull(),
    // Initial Space type seeded on first open (B.2). varchar with NO check
    // constraint — same pattern as studio_members.role, so adding 3d/plan
    // later is a zero-migration change. Canvas is the only editable type
    // today; document/timeline are stored + seeded but disabled in the
    // create picker until their editors ship.
    initialSpaceType: varchar("initial_space_type", { length: 16 })
      .default("canvas")
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("projects_studio_id_idx").on(table.studioId, table.deletedAt)],
);

// ── 4. Project Members ───────────────────────────────────────────────
//
// Three roles: `owner` (unique per project, partial unique index) /
// `editor` / `viewer`. The owner row is written in the same transaction as
// the project insert - `addedBy` is null for that row (creator has no
// inviter). `transfer-owner` is intentionally not implemented in V1
// (v10 spec §7.2.5) - the partial unique index would have to be dance-
// stepped through; deferring saves complexity for the team-Studio phase.

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: varchar("role", { length: 16 }).notNull(),
    /** Null for the creator's row; set to inviter's id for invited members. */
    addedBy: uuid("added_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_members_user_id_idx").on(table.userId),
    index("project_members_project_id_idx").on(
      table.projectId,
      table.deletedAt,
    ),
    // Drizzle does not (as of 0.30) emit partial unique indexes via the
    // table builder; see migrations/<NNNN>_studios_and_project_members.sql
    // for the `project_members_one_owner_per_project` partial unique
    // index that backs the "one active owner per project" invariant.
  ],
);

// ── 4c. Project Last Opened ──────────────────────────────────────────
//
// Per-user "when did I last open this project" tracker, backing the
// cross-studio "Recent" landing feed (`GET /studios/recent`). One row per
// (user, project): opening a project again UPSERTs `last_opened_at = now()`
// in place (composite PK), so re-opening floats the project to the top of the
// viewer's own recent list. Ordering is per-user — another user's opens never
// touch this user's rows (spec §2.1, 2026-06-05).
//
// A project-specific table (not a generic polymorphic "recently viewed"),
// so both FKs are real `onDelete: restrict` references and integrity holds.
// No `deleted_at`: it carries no soft-delete semantics — a row for a deleted
// or now-inaccessible project is simply filtered out by the recent query's
// JOIN (`projects.deleted_at IS NULL`) + access predicate, so a leftover row
// is harmless. `created_at` (first-open time) is kept per the "every table has
// created_at" rule; there is no `updated_at` (the mutable timestamp IS
// `last_opened_at`). Recent-landing design §3.

export const projectLastOpened = pgTable(
  "project_last_opened",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /** The viewer's most-recent open time (UPSERTed to now() on each open). */
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    // Hot index for the recent feed: a user's opens, newest first.
    index("project_last_opened_user_idx").on(
      table.userId,
      table.lastOpenedAt,
    ),
  ],
);

// ── 4b. Studio Members ───────────────────────────────────────────────
//
// Studio-level membership + role (Admin / Member). The admin role lives
// HERE (not on the studios row) so a team studio can have members beyond
// its creator. One active admin per studio is enforced by a partial
// unique index in the migration. `addedBy` is null for the creator's own
// admin row (no inviter). All FKs are `onDelete: restrict` — the project
// is soft-delete only (rows never physically vanish, so a reference can
// never dangle; hard delete goes through a dedicated GDPR flow). See
// the "soft delete" rule in CLAUDE.md.

export const studioMembers = pgTable(
  "studio_members",
  {
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: varchar("role", { length: 16 }).notNull(),
    /** Null for the creator's admin row (no inviter); inviter's id otherwise. */
    addedBy: uuid("added_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.studioId, table.userId] }),
    index("studio_members_user_id_idx").on(table.userId),
    index("studio_members_studio_id_idx").on(table.studioId, table.deletedAt),
    // One active admin per studio is enforced by a partial unique index
    // (`studio_members_one_admin_per_studio`) in the migration — Drizzle's
    // table builder does not emit partial unique indexes.
  ],
);

// ── 5. Conversations ─────────────────────────────────────────────────

/** Shape of a single message stored inline in the JSONB array. */
export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: string;
  turnIndex: number;
  thinking?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
  tool_call_id?: string;
  name?: string;
}

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 200 }).default("New conversation").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    lastConsolidatedTurn: integer("last_consolidated_turn").default(0).notNull(),
    messages: jsonb("messages").$type<ConversationMessage[]>().default([]),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("conversations_user_id_idx").on(table.userId),
    index("conversations_project_id_idx").on(table.projectId),
  ],
);

// ── 6. Tasks ─────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    /**
     * Space within the project that the task targets. v10 multi-doc:
     * worker writes results back into `project-{projectId}/canvas-{spaceId}`,
     * so the worker MUST know which Space's doc to open.
     *
     * No FK - Spaces live in the Yjs `meta` doc (not in PG), so there
     * is no FK target. Stored as plain UUID for round-tripping through
     * the BullMQ payload + worker handler. v10 spec impl §1.2.1.
     */
    spaceId: uuid("space_id").notNull(),
    taskType: varchar("task_type", { length: 50 }).notNull(),
    /**
     * Execution mode (spec §10.13 + §10.15).
     *
     * - `append`: produces a new sibling node. No lock - the new nodeId
     *   is freshly generated, no contention possible.
     * - `overwrite`: replaces an existing node's data. Server SETNX-locks
     *   the target node; concurrent overwrites get 409 ConflictLocked.
     *
     * Required (no default) - every task creator must declare intent
     * explicitly. Mini-tools and AIGC direct flows pass `'append'`.
     */
    mode: varchar("mode", { length: 16 }).notNull(),
    model: varchar("model", { length: 100 }),
    skillName: varchar("skill_name", { length: 100 }),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    arqJobId: varchar("arq_job_id", { length: 255 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    creditsUsed: doublePrecision("credits_used").default(0).notNull(),
    durationMs: integer("duration_ms"),
    resolvedSkills: jsonb("resolved_skills").$type<string[]>().default([]),
    source: varchar("source", { length: 20 }).default("canvas").notNull(),
    /**
     * URL returned by the AIGC provider, before persistence to permanent
     * storage. Set as the "point of no return" - once this column is not
     * null, the Worker must NOT re-invoke the provider (business policy:
     * only one successful provider call per task).
     */
    providerResultUrl: text("provider_result_url"),
    /**
     * Idempotency guard for credit deduction. Set via CAS when the task
     * is marked completed AND the file is persisted to storage. If set,
     * `chargeOnce()` is a no-op. Prevents double-charge on BullMQ retries,
     * stalled-job redelivery, or duplicate Worker instances.
     */
    billedAt: timestamp("billed_at", { withTimezone: true }),
    /** How many credits were charged (for audit / reconciliation). */
    billedCredits: doublePrecision("billed_credits"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("tasks_user_id_idx").on(table.userId),
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_project_space_idx").on(table.projectId, table.spaceId),
    index("tasks_task_type_idx").on(table.taskType),
    index("tasks_status_idx").on(table.status),
  ],
);

// ── Node History ─────────────────────────────────────────────────────

/**
 * Per-node content timeline.
 *
 * Records every content change on a canvas node: successful/failed
 * AIGC generations + user uploads. Queried by frontend to show
 * version history and support restore. Node soft-deletes don't
 * cascade - history is preserved until the project is deleted.
 */
export const nodeHistory = pgTable(
  "node_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    nodeId: varchar("node_id", { length: 255 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    entryType: varchar("entry_type", { length: 20 }).notNull(), // 'generation' | 'upload'
    status: varchar("status", { length: 20 }).notNull(),         // 'success' | 'failed'
    content: text("content"),                                    // URL or text (null if failed)
    thumbnailUrl: text("thumbnail_url"),                         // cover for video, self for image
    errorMessage: text("error_message"),                         // if failed

    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete, stamped by deleteProject() cascade when the owning
    // project is deleted. Required for the project-wide "soft delete
    // only" rule (CLAUDE.md) now that deleteProject actually cascades.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("node_history_node_idx").on(
      table.projectId,
      table.nodeId,
      table.createdAt,
    ),
  ],
);

// ── Conversation Attachments ─────────────────────────────────────────

/**
 * Per-conversation attachment pool.
 *
 * Users upload files once and reference them across multiple messages
 * in the same conversation via @ syntax (resolved client-side before
 * sending). Soft-deleted via deletedAt - records stay in DB, files
 * stay in storage.
 */
export const conversationAttachments = pgTable(
  "conversation_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),

    url: text("url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    name: varchar("name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    size: integer("size").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // image | video | audio | 3d | document

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("conv_attachments_conv_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

// ── 7. Payments ──────────────────────────────────────────────────────

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    stripeSessionId: varchar("stripe_session_id", { length: 255 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 10 }).default("usd").notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    creditsGranted: doublePrecision("credits_granted").default(0).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    ...timestamps,
  },
  (table) => [
    index("payments_user_id_idx").on(table.userId),
    uniqueIndex("payments_stripe_session_id_idx").on(table.stripeSessionId),
  ],
);

// ── 8. Credit Transactions ───────────────────────────────────────────

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    txType: varchar("tx_type", { length: 20 }).notNull(),
    amount: doublePrecision("amount").notNull(),
    balanceAfter: doublePrecision("balance_after").notNull(),
    tokensUsed: integer("tokens_used").default(0),
    model: varchar("model", { length: 100 }),
    provider: varchar("provider", { length: 50 }),
    description: text("description"),
    referenceId: varchar("reference_id", { length: 255 }),
    ...timestamps,
  },
  (table) => [index("credit_tx_user_id_idx").on(table.userId)],
);

// ── 8b. Credit Balances ──────────────────────────────────────────────

/**
 * Per-user credit balance - one row per user, the single source of
 * truth for "how many credits a user has left". Migrated out of the
 * `users.credits` column (PR3, migration 0020) so the credit domain is
 * self-contained and no longer coupled to the user identity table.
 */
export const creditBalances = pgTable("credit_balances", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  balance: doublePrecision("balance").default(0).notNull(),
  ...timestamps,
});

// ── 9. Conversation Memories ─────────────────────────────────────────

export const conversationMemories = pgTable(
  "conversation_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    content: text("content").default("").notNull(),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("conv_memories_conv_id_idx").on(table.conversationId),
  ],
);

// ── 10. Memory History Entries ───────────────────────────────────────

export const memoryHistoryEntries = pgTable(
  "memory_history_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    entry: text("entry").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("mem_history_conv_id_idx").on(table.conversationId),
  ],
);

// ── 11. User Memories ────────────────────────────────────────────────

export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    content: text("content").default("").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("user_memories_user_id_idx").on(table.userId)],
);

// ── 12. User Memory Entries ──────────────────────────────────────────

export const userMemoryEntries = pgTable(
  "user_memory_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    content: text("content").notNull(),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("user_mem_entries_user_id_idx").on(table.userId)],
);

// ── 13. Project Memories ─────────────────────────────────────────────

export const projectMemories = pgTable(
  "project_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    content: text("content").default("").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("project_memories_project_id_idx").on(table.projectId),
  ],
);

// ── 14. Project Memory Entries ───────────────────────────────────────

export const projectMemoryEntries = pgTable(
  "project_memory_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    content: text("content").notNull(),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("project_mem_entries_project_id_idx").on(table.projectId),
  ],
);

// ── 15. Custom Skills ────────────────────────────────────────────────

export const customSkills = pgTable(
  "custom_skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description").default("").notNull(),
    version: varchar("version", { length: 32 }).default("1.0.0").notNull(),
    tags: text("tags").array(),
    files: jsonb("files").$type<Record<string, { type: string; data: string }>>(),
    isPublished: boolean("is_published").default(false).notNull(),
    installCount: integer("install_count").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("custom_skills_owner_name_idx").on(
      table.ownerUserId,
      table.name,
    ),
    index("custom_skills_owner_id_idx").on(table.ownerUserId),
  ],
);

// ── 16. Skill Installs ───────────────────────────────────────────────

export const skillInstalls = pgTable(
  "skill_installs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => customSkills.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("skill_installs_user_skill_idx").on(
      table.userId,
      table.skillId,
    ),
  ],
);

// ── 17. Yjs Documents ────────────────────────────────────────────────
//
// MOVED: the `yjs_documents` table now lives in its own database +
// schema file `@core/db/yjs-schema.ts` (see `yjsDb` in client.ts). It is
// migrated by the independent `migrations-yjs/` set, not the business
// migrations here. The business DB drops its abandoned copy (migration
// 0022). The query repository lives in `@breatic/collab`.

// ── 17.1 Project Lifecycle Outbox ────────────────────────────────────
//
// Transactional outbox bridging the business DB to the separate yjs DB.
// Since the two databases cannot share a transaction, a project delete /
// duplicate writes one command row HERE inside the same business tx (so
// the command's existence is atomic with the business write). A relay
// loop forwards unsent rows to the `project-lifecycle` Redis Stream;
// collab consumes them and performs the yjs-DB side idempotently. Rows
// are retained (sent_at stamped) as an audit trail, never deleted —
// hence no deleted_at (this is an internal command queue, not a business
// entity); append + mark-sent only.
export const projectLifecycleOutbox = pgTable(
  "project_lifecycle_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Discriminator: "project:deleted" | "project:duplicated"
    // (see @breatic/shared ProjectLifecycleEvent).
    kind: text("kind").notNull(),
    // Full ProjectLifecycleEvent payload (projectId / sourceId+newId / ts).
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // NULL until the relay has forwarded the row to the stream.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Relay attempt counter (incremented on each forward attempt).
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    // Rows are retained after send, so the relay's "unsent" scan must
    // stay cheap as the table grows — a partial index over just the
    // unsent rows keeps it index-only.
    index("project_lifecycle_outbox_unsent_idx")
      .on(table.createdAt)
      .where(sql`${table.sentAt} IS NULL`),
  ],
);

// ── Notifications ──────────────────────────────────────────────────
//
// Per-user inbox for role-upgrade requests / approvals + studio / project
// invite-confirm events. PG is the source of truth; collab broadcasts a
// stateless invalidate signal to attached clients so the React Query cache
// refetches via REST.
//
// Design: see `access-permission design (2026-05-28)` § 7.
// per-user private + cross-project + offline catchup → PG, not Yjs.

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * Notification type. Allowed values (CHECK enforced at SQL level):
     * - 'access.role_upgrade_request' - viewer asks owner for editor role
     * - 'access.role_upgrade_approved' - owner approved viewer's request
     * - 'access.role_upgrade_rejected' - owner rejected viewer's request
     * - 'studio.transfer_request' - admin asks the user to take admin (TTL)
     * - 'studio.transfer_approved' - user accepted; old admin is notified
     * - 'studio.invite_request' - admin invites the user to a studio (TTL; confirm/decline)
     * - 'studio.invite_accepted' - invitee accepted; the inviting admin is notified
     * - 'project.invite_request' - owner invites the user to a project (TTL; confirm/decline)
     * - 'project.invite_accepted' - invitee accepted; the inviting owner is notified
     */
    type: varchar("type", { length: 64 }).notNull(),
    /**
     * Type-specific payload. Examples:
     * - role_upgrade_request: { requesterUserId, projectName, requestedRole, message? }
     * - role_upgrade_approved/rejected: { projectName, newRole?, reason? }
     */
    payload: jsonb("payload").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /**
     * Actionable-notification TTL (slice 3) — e.g. the 7-day transfer-admin
     * confirmation window. null = no expiry (informational notices). Expired
     * actionable rows are filtered out of the unread list / count.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Hot index for BellMenu (unread list per user, newest first).
    index("notifications_user_unread_idx").on(
      table.userId,
      table.createdAt,
      table.readAt,
      table.deletedAt,
    ),
  ],
);

// ── Studio Invitations (invite-confirm handshake, 2026-06-14) ─────────
//
// Pending studio-member invitations. A studio invite no longer takes effect
// immediately: the admin creates a `pending` row here, the invitee confirms
// via the bell notification or an email link, and ONLY THEN is a
// `studio_members` row written. Keeping pending invites in their OWN table
// (not a `status` column on `studio_members`) means `studio_members` stays
// "active members only" — studio auth / member-list / member-count queries
// need zero status filter, and a pending invitee can never be mistaken for a
// real member (the rejected rejected-by-design rationale, DD §2). `status`
// flows pending → accepted | declined | expired | revoked (append-only
// lifecycle; rows are soft-deleted only). All FKs are `onDelete: restrict`
// except `notification_id` (`set null` — the bell row may be GC'd). One LIVE
// pending invite per (studio, invitee) is enforced by a partial unique index
// in the migration. See the studio invite-confirmation DD (2026-06-14).

export const studioInvitations = pgTable(
  "studio_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    invitedUserId: uuid("invited_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Granted studio role — 'maintainer' | 'guest' (admin is never invited). */
    role: varchar("role", { length: 16 }).notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Lifecycle: 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked'. */
    status: varchar("status", { length: 16 }).notNull(),
    /**
     * The bell notification that surfaces this invite, so confirm / decline /
     * revoke can mark it read in the same transaction — the bell entry then
     * disappears even when the invite was acted on via the email link. Null
     * when no notification was created, and `set null` if the notice is GC'd.
     */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Invite times out after this; expired pendings self-void in queries. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("studio_invitations_studio_id_idx").on(
      table.studioId,
      table.deletedAt,
    ),
    index("studio_invitations_invited_user_id_idx").on(table.invitedUserId),
    // One LIVE pending invite per (studio, invitee) is enforced by a partial
    // unique index (`studio_invitations_one_pending`) in the migration —
    // Drizzle's table builder does not emit partial unique indexes.
  ],
);

// ── Project Invitations (invite-confirm handshake, 2026-06-18) ────────
//
// Pending project-member invitations — the direct mirror of
// `studio_invitations` for the project membership layer (#1337). A project
// invite no longer takes effect immediately (the old `share_links` model let a
// link consumer join on click, with no decline state and no invitee-side
// handshake): the inviter creates a `pending` row here, the invitee confirms
// via the bell notification or an email link, and ONLY THEN is a
// `project_members` row written. Keeping pending invites in their OWN table
// (not a `status` column on `project_members`) means `project_members` stays
// "active members only" — project auth (`loadProjectRole`) / member-list /
// member-count queries need zero status filter, and a pending invitee can never
// be mistaken for a real member. `status` flows pending → accepted | declined |
// revoked (append-only lifecycle; rows are soft-deleted only). All FKs are
// `onDelete: restrict` except `notification_id` (`set null` — the bell row may
// be GC'd). The granted `role` is `editor` | `viewer` only (never `owner` —
// owner is granted at project creation / transfer, never invited). One LIVE
// pending invite per (project, invitee) is enforced by a partial unique index
// in the migration. See the project-invite parity spec (2026-06-18).

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    invitedUserId: uuid("invited_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Granted project role — 'editor' | 'viewer' (owner is never invited). */
    role: varchar("role", { length: 16 }).notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Lifecycle: 'pending' | 'accepted' | 'declined' | 'revoked'. */
    status: varchar("status", { length: 16 }).notNull(),
    /**
     * The bell notification that surfaces this invite, so confirm / decline /
     * revoke can mark it read in the same transaction — the bell entry then
     * disappears even when the invite was acted on via the email link. Null
     * when no notification was created, and `set null` if the notice is GC'd.
     */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Invite times out after this; expired pendings self-void in queries. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("project_invitations_project_id_idx").on(
      table.projectId,
      table.deletedAt,
    ),
    index("project_invitations_invited_user_id_idx").on(table.invitedUserId),
    // One LIVE pending invite per (project, invitee) is enforced by a partial
    // unique index (`project_invitations_one_pending`) in the migration —
    // Drizzle's table builder does not emit partial unique indexes.
  ],
);
