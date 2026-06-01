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
  customType,
  uniqueIndex,
  index,
  primaryKey,
  check,
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
    username: varchar("username", { length: 100 }),
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
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // One personal studio per active user (V1 invariant). Partial unique
    // index lets a previously-soft-deleted studio coexist with a fresh
    // one if we ever recreate; not relevant for V1 but principled.
    uniqueIndex("studios_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.deletedAt} IS NULL`),
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("projects_studio_id_idx").on(table.studioId, table.deletedAt)],
);

// ── 4. Project Members ───────────────────────────────────────────────
//
// Three roles: `owner` (unique per project, partial unique index) /
// `edit` / `view`. The owner row is written in the same transaction as
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

// ── Custom Types ─────────────────────────────────────────────────────

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ── 17. Yjs Documents ────────────────────────────────────────────────

export const yjsDocuments = pgTable("yjs_documents", {
  name: text("name").primaryKey(),
  data: bytea("data").notNull(),
  // `createdAt` aligns with the project-wide rule: every PG table has
  // a createdAt timestamp (see CLAUDE.md "key conventions"). For existing rows
  // backfilled from `updated_at` - the earliest update is the create
  // time (Hocuspocus's persistence extension upserts on store).
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Soft-delete support - aligns with the project-wide "soft delete only"
  // rule (CLAUDE.md). Set by deleteProject() cascade when the owning
  // project is deleted. Collab's persistence layer filters this out on
  // fetch so deleted docs are invisible even if a stale client reconnects.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── 18. Share Links ──────────────────────────────────────────────────
//
// Project invite/share links generated by owner/admin from ShareDialog.
// Two modes discriminated by an explicit `kind` column (NOT by the
// nullness of `boundEmail` - that was the original PR-d design and
// later got refactored, since one column carrying both data and type
// is the classic "boolean as enum" smell):
//
//   - `kind = 'email'`: single-use, bound to a specific recipient.
//     `boundEmail` MUST be set; `expiresAt` = now() + 7 days.
//   - `kind = 'link'`: multi-use, no expiry, no recipient binding.
//     `boundEmail` MUST be NULL.
//
// Two DB CHECK constraints enforce the invariant so a corrupt
// insert/update cannot leave the table in a contradictory state.
//
// Three paths a non-member uses to request access (see PR-d spec):
//   path 1: visit the project URL directly with no permission → NOT_MEMBER
//   path 2: click an email invite (ShareDialog email input sends mail)
//   path 3: receive a forwarded invite link from another user

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    token: varchar("token", { length: 64 }).notNull().unique(),
    role: varchar("role", { length: 16 }).default("view").notNull(),
    /**
     * Link mode discriminator. 'email' = single-use bound invite,
     * 'link' = multi-use shareable URL. The DB enforces this together
     * with `boundEmail` via the `share_links_kind_bound_email_check`
     * CHECK constraint below - kind is the single source of truth for
     * application code branching.
     */
    kind: varchar("kind", { length: 16 }).notNull(),
    /**
     * Set only when `kind = 'email'`. The recipient address the
     * invite was sent to; only the user logged in with this email
     * can consume the link.
     */
    boundEmail: varchar("bound_email", { length: 255 }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("share_links_project_idx").on(table.projectId, table.deletedAt),
    check(
      "share_links_kind_enum_check",
      sql`${table.kind} IN ('email', 'link')`,
    ),
    check(
      "share_links_kind_bound_email_check",
      sql`(${table.kind} = 'email' AND ${table.boundEmail} IS NOT NULL) OR (${table.kind} = 'link' AND ${table.boundEmail} IS NULL)`,
    ),
  ],
);

// ── Notifications ──────────────────────────────────────────────────
//
// Per-user inbox for role-upgrade requests / approvals / member-joined
// events. PG is the source of truth; collab broadcasts a stateless
// invalidate signal to attached clients so the React Query cache
// refetches via REST.
//
// Design: see `breatic-inner/engineering/specs/2026-05-28-access-permission-design.md` § 7.
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
     * - 'access.member_joined' - someone consumed a link and joined
     */
    type: varchar("type", { length: 64 }).notNull(),
    /**
     * Type-specific payload. Examples:
     * - role_upgrade_request: { requesterUserId, projectName, requestedRole, message? }
     * - role_upgrade_approved/rejected: { projectName, newRole?, reason? }
     * - member_joined: { newMemberUserId, projectName, role }
     */
    payload: jsonb("payload").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
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

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
