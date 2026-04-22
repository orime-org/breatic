/**
 * Drizzle ORM schema definitions for all database tables.
 *
 * Migrated from Python SQLAlchemy ORM models. All tables use UUID
 * primary keys and timestamp with timezone columns.
 */

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
    credits: doublePrecision("credits").default(0).notNull(),
    // Breatic is credits-only (see docs/PRODUCT.md § 8.4). No subscription
    // tiers, no membership levels — every user has the same feature set
    // and pays per-use by deducting credits. The old `membership_type` /
    // `membership_expires_at` columns were removed in 0010_* migration.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_google_id_idx").on(table.googleId),
  ],
);

// ── 2. Projects ──────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    canvasData: jsonb("canvas_data").$type<Record<string, unknown>>().default({}),
    thumbnailUrl: text("thumbnail_url"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("projects_user_id_idx").on(table.userId)],
);

// ── 3. Conversations ─────────────────────────────────────────────────

/** Shape of a single message stored inline in the JSONB array. */
export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: string;
  turnIndex: number;
  thinking?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
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

// ── 4. Tasks ─────────────────────────────────────────────────────────

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
    taskType: varchar("task_type", { length: 50 }).notNull(),
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
     * storage. Set as the "point of no return" — once this column is not
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
 * cascade — history is preserved until the project is deleted.
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
 * sending). Soft-deleted via deletedAt — records stay in DB, files
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

// ── 5. Payments ──────────────────────────────────────────────────────

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

// ── 6. Credit Transactions ───────────────────────────────────────────

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

// ── 7. Conversation Memories ─────────────────────────────────────────

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

// ── 8. Memory History Entries ────────────────────────────────────────

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

// ── 9. User Memories ─────────────────────────────────────────────────

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

// ── 10. User Memory Entries ──────────────────────────────────────────

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

// ── 11. Project Memories ─────────────────────────────────────────────

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

// ── 12. Project Memory Entries ───────────────────────────────────────

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

// ── 13. Custom Skills ────────────────────────────────────────────────

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

// ── 14. Skill Installs ───────────────────────────────────────────────

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
    installedAt: timestamp("installed_at", { withTimezone: true })
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

// ── 15. Yjs Documents ────────────────────────────────────────────────

export const yjsDocuments = pgTable("yjs_documents", {
  name: text("name").primaryKey(),
  data: bytea("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Soft-delete support — aligns with the project-wide "soft delete only"
  // rule (CLAUDE.md). Set by deleteProject() cascade when the owning
  // project is deleted. Collab's persistence layer filters this out on
  // fetch so deleted docs are invisible even if a stale client reconnects.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
