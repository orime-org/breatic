// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drizzle ORM schema definitions for all database tables.
 *
 * Migrated from Python SQLAlchemy ORM models. All tables use UUID
 * primary keys and timestamp with timezone columns.
 */

import { desc, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  doublePrecision,
  numeric,
  integer,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
// A self-referencing FK needs its column type spelled out, since the table is
// still being defined at the point the reference is written.
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { MessagePart } from "@breatic/shared";

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
    // No business-identity columns here — a user's display name, URL handle,
    // and avatar all live on their personal studio (studios.name /
    // studios.slug / studios.avatar_url). `users` is the pure auth/account
    // table (email registration rewrite 2026-06-06; avatar moved 2026-07-22,
    // #1808).
    hashedPassword: varchar("hashed_password", { length: 255 }),
    emailVerified: boolean("email_verified").default(false).notNull(),
    googleId: varchar("google_id", { length: 255 }),
    // Membership tier (0052). One of the five in `MEMBERSHIP_TIERS`, and a
    // CHECK constraint in the database lists exactly those five — added by
    // hand in migration 0053, when the column gained a writer. It is not
    // declared here: this repo hand-writes its migrations, so a drizzle
    // `check()` beside the column would be a second copy that no tool
    // compares against the first. What keeps the two in step is the
    // integration case that stores every tier in `MEMBERSHIP_TIERS` and fails
    // on one the migration does not allow.
    //
    // Four of the five carry ceilings, and they live in
    // `config/membership.yaml`, never here. `enterprise` is the fifth: legal
    // to store, and impossible to price until its negotiated numbers are read
    // from the database. Asking for its ceilings throws, naming the account.
    // A tier added to the enum without a migration widening the constraint
    // would be storable in TypeScript and rejected by the database.
    //
    // It sits on the account because the tier follows the person. Which tier
    // governs a studio's ceilings is a separate question with a settled
    // answer — the tier of that studio's current admin — so transferring a
    // studio moves it onto the new admin's tier without touching this column.
    //
    // The old `membership_type` / `membership_expires_at` pair, dropped in
    // 0010 back when the product carried no tiers at all, is NOT what this
    // is. There is no expiry column here: an expiry is a billing fact, and
    // billing is a separate leg — this column is a value that can be read and
    // enforced, and what makes it change is the Stripe work that comes later.
    //
    // Credits are yet another leg and live in `credit_lots`, one row per
    // purchase, never on the
    // account row.
    membershipTier: varchar("membership_tier", { length: 16 })
      .default("base")
      .notNull(),
    // Recovery code (GitHub backup-codes pattern, PR-a 2026-05-26):
    // bcrypt-hashed single-use code shown once at registration so users
    // can reset their password without an SMTP backend (self-host
    // friendly). After successful consumption, used_at is set and a
    // fresh code is generated + re-shown.
    recoveryCodeHash: text("recovery_code_hash"),
    recoveryCodeUsedAt: timestamp("recovery_code_used_at", { withTimezone: true }),
    // The Stripe customer this account pays through (0055, #106).
    //
    // Written before the first Checkout Session is created, never after an
    // event arrives — which is the whole point of it. Subscription events
    // carry no identifier of ours (`client_reference_id` reaches the Session
    // object only), so the customer on the event is what names the account.
    // Letting Stripe create the customer at checkout would mean first seeing
    // that id inside an event with nothing to match it against.
    //
    // Nullable: an account that has never tried to pay us has no customer,
    // and creating one per registration would make a Stripe object per signup.
    // One customer per account, reused across every subscription it ever has.
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_google_id_idx").on(table.googleId),
  ],
);

// ── 1b. Membership Tier Changes ──────────────────────────────────────

/**
 * Every move of an account from one membership tier to another (0053).
 *
 * The column on `users` answers "what is this account on"; this table answers
 * "how did it get there", which the column cannot. A tier is what somebody
 * paid for, so months later "why am I on base" and "when did my team plan
 * start" have to be answerable from stored fact rather than from a Stripe
 * dashboard that may have been reconciled since.
 *
 * Same shape as `credit_ledger` and for the same reason: the current
 * value is a scalar somewhere else, and every change to it is appended here.
 *
 * Append-only, so `created_at` alone rather than the `timestamps` pair — a row
 * is written once and never edited. Nothing has to be declared for that:
 * `schema-timestamps` requires `created_at` and `deleted_at`, never
 * `updated_at`. The missing `deleted_at` does need declaring, and its reason
 * sits in that rule's allowlist: deleting a row would leave a history that no
 * longer adds up to the value on the account.
 *
 * `reference_id` holds whatever the trigger was identified by upstream — a
 * Stripe subscription or event id once subscriptions land. It is deliberately
 * NOT what makes a redelivered webhook safe: comparing tiers converges on the
 * last call and cannot tell a replay from a new event, so the subscription
 * work keys idempotency on event identity the way `updatePaymentStatusCAS`
 * and `chargeOnceForGeneration` already do.
 */
export const membershipTierChanges = pgTable(
  "membership_tier_changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Both carry a tier name, and both have the same CHECK constraint the
    // account column does — in migration 0053, not declared here; see the
    // note on `users.membershipTier`.
    fromTier: varchar("from_tier", { length: 16 }).notNull(),
    toTier: varchar("to_tier", { length: 16 }).notNull(),
    // What caused the move: `subscription_activated`, `subscription_ended`,
    // `registration`, or `manual`. The last two have no writer yet — see the
    // block seven design for why registration does not append a row.
    reason: varchar("reason", { length: 32 }).notNull(),
    referenceId: varchar("reference_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("membership_tier_changes_user_id_idx").on(table.userId)],
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
    // Avatar URL (nullable). For a personal studio this is the user's avatar;
    // for a team studio, the team logo. Moved off `users` 2026-07-22 (#1808),
    // same pointer model as `name`. Set via UI upload (#1809); Google OAuth
    // never imports it.
    avatarUrl: text("avatar_url"),
    // Self-description shown on the studio's front door (nullable = unset).
    // The API stores NULL for a cleared bio, so "no bio" has one representation.
    bio: varchar("bio", { length: 500 }),
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

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Null while the conversation has no name of its own. What the reader
    // sees in that case is decided where their language is known, which is
    // not here.
    title: varchar("title", { length: 200 }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    lastConsolidatedTurn: integer("last_consolidated_turn").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("conversations_user_id_idx").on(table.userId),
    index("conversations_project_id_idx").on(table.projectId),
  ],
);

/**
 * One row per message. Replaces the `conversations.messages` JSONB array,
 * where every append rewrote and re-compressed the whole document and took a
 * lock on the conversation row — cost that grows with the square of the
 * conversation length.
 *
 * `parts` holds the pieces of a single message (prose, reasoning, tool calls),
 * which is the granularity Postgres asks for: a JSON document should be an
 * atomic datum, and a message is exactly that — a conversation is not.
 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    /**
     * Denormalised owner, so cross-tenant reads and audits do not have to
     * join back through `conversations` on every query.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: varchar("role", { length: 16 }).notNull(),
    /** Increments on each user message; half of the billing idempotency key. */
    turnIndex: integer("turn_index").notNull(),
    /** Position within its turn. */
    seq: integer("seq").notNull(),
    parts: jsonb("parts").$type<MessagePart[]>().default([]).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversation_messages_turn_seq_key").on(
      table.conversationId,
      table.turnIndex,
      table.seq,
    ),
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
     * Vendor task id for async (submit → poll) generation. Persisted right
     * after submit; on a BullMQ retry the Worker resumes by polling this id
     * instead of re-submitting (prevents duplicate vendor generation, #1628).
     */
    providerTaskId: text("provider_task_id"),
    /**
     * Idempotency guard for credit deduction. Set via CAS when the task
     * is marked completed AND the file is persisted to storage. If set,
     * `chargeOnce()` is a no-op. Prevents double-charge on BullMQ retries,
     * stalled-job redelivery, or duplicate Worker instances.
     */
    billedAt: timestamp("billed_at", { withTimezone: true }),
    /**
     * What the run consumed, for audit and reconciliation.
     *
     * The whole bill, whether or not the studio's lots covered it: the ledger
     * rows sharing this task's reference id add up to exactly this, with the
     * uncovered part written as debt.
     */
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
    nodeId: uuid("node_id").notNull(),
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
    // Generation idempotency (#1618): a partial UNIQUE (task_id, node_id)
    // WHERE entry_type='generation' AND status='success' AND deleted_at IS
    // NULL lives in migration 0036 (Drizzle's builder does not emit partial
    // unique indexes — same note as project_activities / project_invitations).
    // createGenerationSuccessIfAbsent relies on it for ON CONFLICT DO NOTHING,
    // so a billed generation lands in history exactly once (double-live +
    // billed-redelivery re-record both collapse to one row).
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
    // What Stripe worked out this purchase comes to, tax included, read back
    // off the Checkout Session (0066, #13). Filled the first time we read a
    // session Stripe has already priced: for a delayed payment method that is
    // when its session completes, days before the money moves; for every
    // other purchase it is settlement itself, written alongside the CAS. So a
    // value here says nothing about whether the money moved — `status`
    // answers that. NULL until then: Stripe cannot work out the tax without
    // knowing where the buyer is, and `amount_cents` beside them is the
    // pre-tax face value from our own price table, which is why a refund of a
    // landed purchase pays back `total_cents` instead.
    taxCents: integer("tax_cents"),
    totalCents: integer("total_cents"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    ...timestamps,
  },
  (table) => [
    index("payments_user_id_idx").on(table.userId),
    uniqueIndex("payments_stripe_session_id_idx").on(table.stripeSessionId),
    // `expired` (0066, #13) is how an abandoned checkout leaves "processing":
    // the buyer clicking back expires the session on the spot, and the two
    // slower paths (the session's own expiry, and reconciling) land here too.
    // Without it the purchase record would show a payment as in flight for as
    // long as the session lives, with nothing in flight.
    check(
      "payments_status_check",
      sql`${table.status} IN ('pending', 'completed', 'failed', 'expired')`,
    ),
  ],
);

// ── 7b. Purchase consent and confirmation mail ───────────────────────

/**
 * The consent a buyer gave when they paid (0066, #13).
 *
 * Legal evidence. The row is written from inside the fulfillment transaction,
 * so the consent and the credits it paid for commit together. All four
 * callers of `fulfillPayment` reach this write, and `payment_id` being UNIQUE
 * is what makes the later ones no-ops rather than a second, contradicting
 * record.
 *
 * `consented_at` is the instant the checkout request arrived carrying the
 * tick, stamped on our own clock and kept on the payment row until this one
 * is written. The buyer ticks on our own confirm dialog, one request earlier;
 * settling can arrive days later by way of reconciliation, so the moment this
 * row is written is not the moment they agreed.
 *
 * Append-only: `created_at` and no `deleted_at`. A consent record outlives
 * the statutory retention period and deleting one would destroy the evidence
 * it exists to be — the written reason this table is waived from the
 * soft-delete mandate.
 */
export const purchaseConsents = pgTable("purchase_consents", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id")
    .notNull()
    .unique()
    .references(() => payments.id, { onDelete: "restrict" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  locale: varchar("locale", { length: 10 }).notNull(),
  consentTextVersion: varchar("consent_text_version", { length: 20 }).notNull(),
  refundTextVersion: varchar("refund_text_version", { length: 20 }),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * One purchase-confirmation email per payment (0066, #13).
 *
 * The row is born `pending` inside the fulfillment transaction, so a purchase
 * that landed always has one. A purchase that has not landed has none, and
 * the purchase history reaches this table through a left join. A resend is
 * offered from every state but `sent`, and from `sending` only once that send
 * has gone stale.
 *
 * `updated_at` carries `$onUpdate`, which the `sending` timeout depends on:
 * a process replaced between claiming `sending` and writing the result would
 * otherwise strand that row forever, with no background sweep to free it.
 *
 * Append-only in the sense that matters here: it lives as long as the payment
 * it records, and there is nothing a user could delete — the written reason
 * for its soft-delete waiver.
 */
export const purchaseMailOutbox = pgTable("purchase_mail_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id")
    .notNull()
    .unique()
    .references(() => payments.id, { onDelete: "restrict" }),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  ...timestamps,
});

// ── 7b. Subscriptions ────────────────────────────────────────────────

/**
 * Every subscription an account has ever held (0055, #106 §5.2).
 *
 * Not one row per account. A subscription that ends stays here as a ledger
 * entry and a new one is inserted alongside it, so "does this account
 * subscribe" is a question about `status`, never about whether a row exists.
 * The unique constraint is therefore on the Stripe id and NOT on `user_id`:
 * one there would refuse the second subscription of anybody who cancelled and
 * came back, and the refusal would land on somebody who had already paid.
 *
 * The same reasoning rules out a partial one over the live statuses, which
 * 0057 added and 0059 removed. This table mirrors Stripe, so the only
 * constraints it can carry are the ones Stripe guarantees — and Stripe will
 * hold two live subscriptions for one customer. A constraint cannot prevent
 * that; it can only decide what happens when it reaches us, and its only
 * available answer is to fail the write. "One account, at most one live
 * subscription" is a business rule, enforced where checkouts start and by
 * Stripe's own setting for it, and the reading in `subscription-state.ts`
 * decides which row governs when two arrive anyway.
 *
 * `status` holds Stripe's own word, unchanged. Which tier that word earns has
 * already been reworked once during design; storing the conclusion instead
 * would have made every historical row wrong the moment it changed.
 *
 * `has_pending_update` cannot be inferred from `payable_invoice_url`: an
 * account behind on payment carries a payable invoice too, and an unpaid
 * upgrade and an unpaid renewal are different situations offering different
 * actions (`subscription-state.ts`).
 *
 * `payments` next door is the other leg of the product and unrelated: credit
 * packs are bought once, in `mode: payment`, and grant a balance.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    stripeSubscriptionId: varchar("stripe_subscription_id", {
      length: 255,
    }).notNull(),
    // The tier this subscription was bought for. Same CHECK constraint as
    // `users.membership_tier`, added by hand in 0055 for the same reason the
    // one there is not declared in drizzle: migrations here are hand-written,
    // so a `check()` beside the column would be a second copy nothing compares
    // against the first.
    tier: varchar("tier", { length: 16 }).notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    // From `items.data[0].current_period_end`. Stripe moved it off the
    // subscription object in the 2025-03-31 release; nullable because a
    // subscription whose first invoice never settled has no period.
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end")
      .default(false)
      .notNull(),
    // Changing which tier a subscription sells means replacing the price on
    // its item, and that requires naming the item: omitting the id ADDS a
    // price instead, leaving the account holding two memberships.
    stripeItemId: varchar("stripe_item_id", { length: 255 }),
    hasPendingUpdate: boolean("has_pending_update").default(false).notNull(),
    pendingTier: varchar("pending_tier", { length: 16 }),
    payableInvoiceUrl: text("payable_invoice_url"),
    // When the snapshot this row was written from was taken (0058).
    //
    // Two paths write here — the webhook and the panel's reconciliation — and
    // both ask Stripe first and write second, so the one that asked first can
    // still commit last while holding the older answer. Comparing this decides
    // which view is newer, which is what lets both of them fetch outside any
    // lock: whoever saw Stripe more recently wins, whatever the commit order.
    observedAt: timestamp("observed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("subscriptions_user_id_idx").on(table.userId),
    uniqueIndex("subscriptions_stripe_subscription_id_idx").on(
      table.stripeSubscriptionId,
    ),
  ],
);

// ── 7c. Stripe Webhook Events ────────────────────────────────────────

/**
 * Which Stripe events have been processed (0055, #106 §5.3).
 *
 * The primary key IS the idempotency: the insert goes in the same transaction
 * as the tier change it guards, and a redelivery collides. `changeMembership
 * Tier` compares tiers rather than event identity, so it converges on the last
 * call and cannot tell a replay from a new event — which is exactly why this
 * table exists rather than a check inside it.
 *
 * Append-only, so `created_at` alone and no `deleted_at`: deleting a row would
 * make the event it names replayable, which is the one thing this table is for.
 */
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  eventId: varchar("event_id", { length: 255 }).primaryKey(),
  type: varchar("type", { length: 80 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── 8c. Credit Lots & Ledger ─────────────────────────────────────────

/**
 * One top-up (0061, task #11).
 *
 * A row is one payment that succeeded, and it tracks that purchase for the
 * rest of its life: how much of it is left, which studio may spend it, and
 * whether it is on its way back to the buyer. Credits are spent lot by lot,
 * oldest first, which is why the remainder lives per purchase rather than as
 * one number per account — a refund returns a purchase, so a purchase has to
 * be a thing that can still be pointed at.
 *
 * `payment_id` is NOT NULL and unique, and that is the whole of "a payment
 * grants credits exactly once". The `payments` table cannot carry that rule:
 * `stripe_payment_intent_id` has no unique index, and the one on
 * `stripe_session_id` sits on a nullable column, where Postgres admits any
 * number of NULLs. A redelivered webhook reaches the same `payments` row and
 * is refused here, at the insert.
 *
 * `payments` and this table hold different facts about the same event and
 * both keep their own status: `payments.status` says whether the money
 * arrived, `lifecycle` says whether the credits still exist. Putting them in
 * one row would give one row two state machines written by two paths, and
 * every state in the design has a single writer.
 *
 * `designated_studio_id` NULL means unassigned, which means unspendable — a
 * lot has to be pointed at a studio before anything can be charged to it. A
 * lot pointing at a soft-deleted studio reads as unassigned too, so both
 * conditions travel together in one shared predicate rather than being
 * spelled out per query.
 *
 * `user_id` is the buyer and never changes: it is where the money came from,
 * not where it goes. It is copied from `payments.user_id` so that taking the
 * next lot to spend, and paging the account overview, need no join.
 *
 * `refund_attempts` is the only trace of a refund that was refused — the
 * lifecycle returns to `active` afterwards, so that column plus a
 * `refund_rejected` ledger row is what keeps the history visible.
 *
 * The lifecycle CHECK is added by hand in the migration, as the tier ones
 * are, because migrations here are hand-written and a drizzle `check()`
 * beside the column would be a second copy nothing compares against the
 * first.
 */
export const creditLots = pgTable(
  "credit_lots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // A charge is a fraction of a cent and is summed across lots, so binary
    // floating point would strand a residue that cannot be spent or refunded.
    purchasedCredits: numeric("purchased_credits", {
      precision: 20,
      scale: 6,
    }).notNull(),
    // A materialised projection of the ledger, not a second source of truth:
    // it must always equal sum(credit_ledger.amount) over this lot. It is
    // stored because spending takes lots in order and locks them, which a
    // sum-on-read cannot do.
    remainingCredits: numeric("remaining_credits", {
      precision: 20,
      scale: 6,
    }).notNull(),
    designatedStudioId: uuid("designated_studio_id").references(
      () => studios.id,
      { onDelete: "restrict" },
    ),
    // One of `active` / `depleted` / `refund_pending` / `refunding` /
    // `refunded`. CHECK in 0061.
    lifecycle: varchar("lifecycle", { length: 16 }).notNull(),
    refundAttempts: integer("refund_attempts").default(0).notNull(),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credit_lots_payment_id_idx").on(table.paymentId),
    index("credit_lots_user_id_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("credit_lots_studio_lifecycle_idx").on(
      table.designatedStudioId,
      table.lifecycle,
      table.createdAt,
    ),
  ],
);

/**
 * Append-only credit ledger (0061, task #11) — what actually happened.
 *
 * Every top-up, charge and refund is one row, and a lot's remaining balance
 * is this table summed over that lot. It replaces `credit_transactions`,
 * which had no notion of which purchase a charge came out of.
 *
 * Two people, two columns. `payer_user_id` is whose credits moved;
 * `actor_user_id` is who did the spending, and in a team they are routinely
 * different — a studio's guest can be an editor on a project and spends the
 * admin's credits there. One column could serve only one of the two views
 * that have to work: the buyer seeing where their money went, and the
 * spender seeing what they used.
 *
 * `lot_id` is nullable for the three situations where usage is recorded but
 * no purchase is drawn down: payments disabled, a route that carries no
 * project to pick a pool from, and a studio with nothing spendable left.
 * `payer_user_id` is absent on `debt_incurred` alone (0064, with a CHECK
 * requiring it everywhere else): a debt is what a studio owes, recorded
 * before anyone has paid it. The account ledger reads by payer and reports
 * what left this account's purchases, so a debt is not one of its rows —
 * the studio's own page reports it.
 *
 * `created_at` only. No `updated_at`, because nothing here is ever edited,
 * and no `deleted_at`, which is the repository's soft-delete mandate being
 * waived with its reason stated: a row says something already happened, and
 * removing it would make that thing repeatable — which is the single reason
 * this table exists.
 *
 * `balance_after` from the old table is deliberately not carried over: the
 * balance is derived now, and freezing an account-wide total into a row would
 * be storing the scalar this model just removed.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Whose money this row moved. Null on `debt_incurred`: a debt is what a
    // studio owes, recorded before anyone has paid for it — the payment comes
    // later, as the `debt_repayment` row of whoever assigns a purchase. A
    // CHECK in 0064 requires it on every other type.
    payerUserId: uuid("payer_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    lotId: uuid("lot_id").references(() => creditLots.id, {
      onDelete: "restrict",
    }),
    studioId: uuid("studio_id").references(() => studios.id, {
      onDelete: "restrict",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    // One of `topup` / `spend` / `refund` / `refund_rejected` (0061) or
    // `debt_incurred` / `debt_repayment` (0063). CHECK in 0063.
    entryType: varchar("entry_type", { length: 24 }).notNull(),
    // Positive in, negative out.
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    model: varchar("model", { length: 100 }),
    provider: varchar("provider", { length: 50 }),
    tokensUsed: integer("tokens_used"),
    description: text("description"),
    referenceId: varchar("reference_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Newest-first is the only order any of these are read in, and the two
    // studio indexes are partial because a row with no studio belongs to no
    // studio's page. Declared exactly as 0061 creates them: this file is what
    // a reader consults to know what the table has.
    index("credit_ledger_payer_created_idx").on(
      table.payerUserId,
      desc(table.createdAt),
    ),
    index("credit_ledger_studio_created_idx")
      .on(table.studioId, desc(table.createdAt))
      .where(sql`${table.studioId} IS NOT NULL`),
    index("credit_ledger_lot_idx").on(table.lotId),
    // The one read that asks by actor: which studios this account has run up
    // debt in. Partial, because only `debt_incurred` rows can answer it, and
    // 0064 cleared the payer on exactly those rows so the payer index cannot
    // serve it. Declared as 0065 creates it.
    index("credit_ledger_actor_debt_idx")
      .on(table.actorUserId, table.studioId)
      .where(sql`${table.entryType} = 'debt_incurred'`),
    index("credit_ledger_payer_studio_created_idx")
      .on(table.payerUserId, table.studioId, desc(table.createdAt))
      .where(sql`${table.studioId} IS NOT NULL`),
  ],
);

/**
 * What a studio owes (0063, task #11) — one row per studio, at most.
 *
 * The precheck reads what is spendable and freezes nothing, and what it asks
 * for is a floor rather than the bill: every mini-tool asks for
 * `MIN_TASK_CREDIT_COST`, and a model with no `cost_per_call` falls back to
 * the same number. The worker then charges what the run actually used. So a
 * studio near the bottom of its balance finishes a generation owing credits,
 * with no concurrency involved at all. That shortfall is this row.
 *
 * A mutable current value, not a sum over the ledger. Two paths write it —
 * a charge that could not be covered, and a designation paying it down — and
 * they have to be serialised against each other, which a sum cannot be. It is
 * the same trade `credit_lots.remaining_credits` makes, and it reconciles
 * against the ledger the same way: `amount` equals
 * `sum(debt_repayment) - sum(debt_incurred)`.
 *
 * Its own table rather than a column on `studios`, because both writers lock
 * it and `studios` is read on the way into every project — locking there would
 * queue a charge behind a rename.
 *
 * No `deleted_at`, which is the repository's soft-delete mandate waived with
 * its reason stated: hiding a debt row is the debt vanishing, and preventing
 * exactly that is why the table exists. What becomes of a debt when its studio
 * is deleted is a business decision, not a hidden row.
 *
 * The CHECK is added by hand in the migration, as `credit_lots`' are, because
 * a drizzle `check()` beside the column would be a second copy nothing
 * compares against the first.
 */
export const studioCreditDebts = pgTable(
  "studio_credit_debts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    // What is owed right now, never negative. CHECK in 0063.
    amount: numeric("amount", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("studio_credit_debts_studio_id_idx").on(table.studioId),
  ],
);

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
     * - 'studio.invite_request' - admin invites the user to a studio (TTL; answered on the decision page)
     * - 'studio.invite_accepted' - invitee accepted; the inviting admin is notified
     * - 'project.invite_request' - owner invites the user to a project (TTL; answered on the decision page)
     * - 'project.invite_accepted' - invitee accepted; the inviting owner is notified
     * - 'project.transfer_request' - owner asks the user to take the project (TTL) (0039)
     * - 'project.transfer_approved' - user accepted; the old owner is notified (0039)
     * - 'membership.ended' - the account fell back to the free tier (0056)
     * - 'membership.upgrade_incomplete' - an upgrade's invoice went unpaid (0056)
     * - 'storage.quota_exceeded' - a write was refused because the admin's
     *   account is out of storage (0060)
     */
    type: varchar("type", { length: 64 }).notNull(),
    /**
     * Type-specific payload. Examples:
     * - role_upgrade_request: { requesterUserId, projectName, requestedRole, message? }
     * - role_upgrade_approved/rejected: { projectName, newRole? }
     */
    payload: jsonb("payload").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /**
     * Actionable-notification deadline — the decision window from
     * `config/limits.yaml`, stamped when the row is created. null means no
     * deadline: informational notices never carry one, and neither do
     * actionable rows created before the window covered their flow (nothing
     * migrates those, so they stay decidable for good). Expired actionable
     * rows are filtered out of the unread list / count.
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
// real member (the rejected-by-design rationale, DD §2). `status` flows pending
// → accepted | declined | expired | revoked (append-only lifecycle; rows are
// soft-deleted only). A pending invite that times out keeps `status = 'pending'`
// until it is reaped to `expired`: the `one_pending` partial index ignores
// `expires_at`, so re-invite (`expireStalePending`) flips the stale row before
// taking the slot (#1769). All FKs are `onDelete: restrict` except
// `notification_id` (`set null` — the bell row may be GC'd). One LIVE pending
// invite per (studio, invitee) is enforced by a partial unique index in the
// migration. See the studio invite-confirmation DD (2026-06-14).

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
     * The bell notification that surfaces this invite, so settling it can mark
     * that row read in the same transaction — whether the recipient answered
     * on the decision page or the sender revoked the invite. Nothing is
     * answered in the bell itself any more, so without this the row would
     * linger after the fact. Null when no notification was created, and
     * `set null` if the notice is GC'd.
     */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Invite times out after this; expired pendings self-void in queries. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Names this request in the `/decision?token=` link. Minted when the
     * request is filed and never rotated, so the LINK stays valid for as long
     * as the row exists — what expires is the request, not the URL. Shared by
     * all three channels that can reach the request: the email, the bell entry
     * and (for a project invite) the owner's copyable share link.
     */
    shareToken: varchar("share_token", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("studio_invitations_share_token_key").on(table.shareToken),
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
// revoked | expired (append-only lifecycle; rows are soft-deleted only). A
// pending invite that times out keeps `status = 'pending'` until it is reaped to
// `expired`: the `one_pending` partial index ignores `expires_at`, so re-invite
// (`expireStalePending`) flips the stale row before taking the slot (#1769). All
// FKs are `onDelete: restrict` except `notification_id` (`set null` — the bell
// row may be GC'd). The granted `role` is `editor` | `viewer` only (never
// `owner` — owner is granted at project creation / transfer, never invited). One
// LIVE pending invite per (project, invitee) is enforced by a partial unique
// index in the migration. See the project-invite parity spec (2026-06-18).

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
    /** Lifecycle: 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked'. */
    status: varchar("status", { length: 16 }).notNull(),
    /**
     * The bell notification that surfaces this invite, so settling it can mark
     * that row read in the same transaction — whether the recipient answered
     * on the decision page or the sender revoked the invite. Nothing is
     * answered in the bell itself any more, so without this the row would
     * linger after the fact. Null when no notification was created, and
     * `set null` if the notice is GC'd.
     */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Invite times out after this; expired pendings self-void in queries. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Names this request in the `/decision?token=` link. Minted when the
     * request is filed and never rotated, so the LINK stays valid for as long
     * as the row exists — what expires is the request, not the URL. Shared by
     * all three channels that can reach the request: the email, the bell entry
     * and (for a project invite) the owner's copyable share link.
     */
    shareToken: varchar("share_token", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("project_invitations_share_token_key").on(table.shareToken),
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

// ── Deferred-decision requests (2026-07-31) ──────────────────────────
//
// Role upgrades, project transfers and studio transfers: three flows where
// someone asks and someone else answers later. They used to live as rows in
// `notifications`, a table built to ANNOUNCE things — it has `read_at` and
// nothing else: no status, no uniqueness, no expiry. So all three inherited
// the same three defects: a request could never time out, the same person
// could file it any number of times, and "already decided" was indistinguishable
// from "already read". The two invite flows above own tables and consequently
// have all three; these three owned nothing and kept breaking.
//
// They are modelled on `studio_invitations` / `project_invitations` on purpose —
// same lifecycle shape, same partial-unique-index trick, same reaping rule:
//
//   - `status` is append-only through the lifecycle; rows are soft-deleted only.
//   - A timed-out row KEEPS `status = 'pending'` and holds its uniqueness slot
//     until something flips it. A partial index predicate must be immutable, so
//     it cannot reference `now()` — the create path reaps stale pendings to
//     `expired` before inserting, exactly as `expireStalePending` does (#1769).
//   - All FKs are `onDelete: restrict` except `notification_id` (`set null` —
//     the bell row may be GC'd).
//
// Uniqueness GRAIN differs by table and is deliberate: a role upgrade is one
// live request per (project, requester), so two viewers may each ask; a
// transfer is one live request per CONTAINER, since a project has exactly one
// owner and can never be offered to two people at once. All three partial
// unique indexes live in the migration.

export const roleUpgradeRequests = pgTable(
  "role_upgrade_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Role being asked for — 'editor' (a viewer asking to edit). */
    requestedRole: varchar("requested_role", { length: 16 }).notNull(),
    /** Optional note the requester wrote for the decider. */
    message: text("message"),
    /**
     * Lifecycle: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'.
     * 'approved' / 'rejected' rather than the transfers' 'accepted' /
     * 'declined': an upgrade is decided FOR you, a transfer is one you accept.
     */
    status: varchar("status", { length: 16 }).notNull(),
    /** Who decided. Null while pending, and stays null on expiry / cancel. */
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /**
     * The bell notification that surfaces this request, so deciding / cancelling
     * / reaping can mark it read in the same transaction — the bell entry then
     * disappears with the request instead of outliving it.
     */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Request times out after this; the decision path refuses expired rows. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Names this request in the `/decision?token=` link. Minted when the
     * request is filed and never rotated, so the LINK stays valid for as long
     * as the row exists — what expires is the request, not the URL. Shared by
     * all three channels that can reach the request: the email, the bell entry
     * and (for a project invite) the owner's copyable share link.
     */
    shareToken: varchar("share_token", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("role_upgrade_requests_share_token_key").on(table.shareToken),
    index("role_upgrade_requests_project_id_idx").on(
      table.projectId,
      table.deletedAt,
    ),
    index("role_upgrade_requests_requester_user_id_idx").on(
      table.requesterUserId,
    ),
    // One LIVE pending request per (project, requester) is enforced by a partial
    // unique index (`role_upgrade_requests_one_pending`) in the migration.
  ],
);

export const projectTransfers = pgTable(
  "project_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /** The current owner, offering the project away. */
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The member being offered ownership. */
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Lifecycle: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'. */
    status: varchar("status", { length: 16 }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Bell row for the recipient; marked read in the deciding transaction. */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Offer times out after this; the decision path refuses expired rows. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Names this request in the `/decision?token=` link. Minted when the
     * request is filed and never rotated, so the LINK stays valid for as long
     * as the row exists — what expires is the request, not the URL. Shared by
     * all three channels that can reach the request: the email, the bell entry
     * and (for a project invite) the owner's copyable share link.
     */
    shareToken: varchar("share_token", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("project_transfers_share_token_key").on(table.shareToken),
    index("project_transfers_project_id_idx").on(
      table.projectId,
      table.deletedAt,
    ),
    index("project_transfers_to_user_id_idx").on(table.toUserId),
    // One LIVE pending transfer per PROJECT (not per recipient) is enforced by a
    // partial unique index (`project_transfers_one_pending`) in the migration.
  ],
);

export const studioTransfers = pgTable(
  "studio_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    /** The current admin, offering the studio away. */
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The member being offered adminship. */
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Lifecycle: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'. */
    status: varchar("status", { length: 16 }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Bell row for the recipient; marked read in the deciding transaction. */
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Offer times out after this; the decision path refuses expired rows. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Names this request in the `/decision?token=` link. Minted when the
     * request is filed and never rotated, so the LINK stays valid for as long
     * as the row exists — what expires is the request, not the URL. Shared by
     * all three channels that can reach the request: the email, the bell entry
     * and (for a project invite) the owner's copyable share link.
     */
    shareToken: varchar("share_token", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("studio_transfers_share_token_key").on(table.shareToken),
    index("studio_transfers_studio_id_idx").on(table.studioId, table.deletedAt),
    index("studio_transfers_to_user_id_idx").on(table.toUserId),
    // One LIVE pending transfer per STUDIO (not per recipient) is enforced by a
    // partial unique index (`studio_transfers_one_pending`) in the migration.
  ],
);

// ── Project Activities ───────────────────────────────────────────────
//
// Unified project activity feed (ADR 2026-07-04 project-activity-feed):
// asset uploads/deletes, generation outcomes, space lifecycle, member
// changes - one append-only table replacing the meta-doc
// `projectMessages` Y.Array (retired; a CRDT array never shrinks, so a
// high-frequency feed there would bloat the meta doc irreversibly).
//
// APPEND-ONLY: no deleted_at / updated_at (same exemption as
// project_lifecycle_outbox - immutable audit log, not a business
// entity). The single mutable column is `restored`, consumed by
// space:restore to mark a space:deleted row's snapshot as used.
// Written by server (assets, members), worker (generation) and collab
// (space lifecycle) through the core-owned repo.

export const projectActivities = pgTable(
  "project_activities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /**
     * Pointer to the acting user (display name resolved by a users join
     * at read time so renames propagate retroactively). Null for
     * system-originated rows (e.g. lazy-seed bootstrap entries).
     */
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    /**
     * Event type. Allowed values (CHECK enforced at SQL level, 0034):
     * asset:uploaded | asset:deleted | generation:succeeded |
     * generation:failed | space:created | space:deleted |
     * space:restored | space:locked | space:unlocked | space:renamed |
     * member:joined | member:removed | member:role-changed |
     * member:ownership-transferred
     */
    type: varchar("type", { length: 64 }).notNull(),
    spaceId: uuid("space_id"),
    nodeId: uuid("node_id"),
    /**
     * Generation idempotency key - one activity row per task even when
     * BullMQ redelivers a billed job and worker Stage 4 re-runs
     * (partial UNIQUE in migration 0034; INSERT .. ON CONFLICT DO
     * NOTHING). Null for non-generation rows and frontend-executed
     * mini-tools (which have no task).
     */
    taskId: uuid("task_id"),
    /**
     * Type-specific payload. Shapes (zod-validated in the shared package):
     * - asset:uploaded/deleted: { fileUrl, kind }
     * - generation:*: { source, toolName?, model?, outputCount?,
     *   executedOn?, errorMessage? }
     * - space:deleted: { spaceName, spaceSnapshot } (snapshot rebuilds
     *   the meta directory entry on restore)
     * - space:renamed: { spaceName, oldSpaceName }
     * - member:*: { role?, previousRole? }
     */
    payload: jsonb("payload").notNull(),
    /**
     * Restore-consumption marker, meaningful only on space:deleted rows
     * (space:restore flips it so the same snapshot is never consumed
     * twice). Always false on every other type.
     */
    restored: boolean("restored").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete: individual rows are never user-deleted, but the whole
    // table is project-scoped and cascade-soft-deleted by deleteProject
    // (same as node_history). Feed queries filter deleted_at IS NULL.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Hot feed index for keyset pagination (partial on live rows):
    // WHERE project_id = ? AND deleted_at IS NULL AND (created_at, id) < (?, ?)
    // ORDER BY created_at DESC, id DESC.
    index("project_activities_feed_idx")
      .on(table.projectId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    // The task_id partial UNIQUE lives in migration 0034 (Drizzle's
    // builder does not emit partial unique indexes - same note as
    // project_invitations).
  ],
);

// ── Studio assets ────────────────────────────────────────────────────
//
// Physical asset registry (spec 2026-07-04-asset-layer-v1). One row per
// unique stored object PER STUDIO: the same bytes uploaded twice inside
// one studio dedup to one row (within-studio dedup); across studios they
// are independent rows (each studio owns its own physical copy). The
// content hash is a DEDUP COLUMN ONLY - it never enters the storage key
// or URL (those stay random + unguessable; a content-hash URL would be a
// content-existence oracle). Registration happens off the canvas hot
// path (server /assets/uploaded handshake + worker generation Stage 4),
// never on Yjs node edits.
//
// V1 has no delete flow (assets accumulate); `deleted_at` is reserved
// for a future GDPR / studio-deletion cascade. It does NOT cascade with
// deleteProject (studio-scoped, not project-scoped).

export const studioAssets = pgTable(
  "studio_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Owner studio (storage usage + dedup scope). */
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    /** sha256 hex of the content - the dedup key (never in the URL). */
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    /** Random storage key (unchanged format; NOT the hash). */
    storageKey: text("storage_key").notNull(),
    /** Public URL (adapter.publicUrl(key)) - the value embedded in Yjs. */
    fileUrl: text("file_url").notNull(),
    /** Cached byte size; source of truth is the storage layer head(). */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    /** image | video | audio | document | file (detectKind). */
    kind: varchar("kind", { length: 20 }).notNull(),
    /**
     * 'ai' (worker-generated) | 'upload' (user upload) | 'cover' (#1826 §4.5:
     * a video's first-class cover asset — a normal row that counts toward
     * storage, kind judged from the cover itself). varchar, no schema change.
     */
    source: varchar("source", { length: 20 }).notNull(),
    /**
     * Who FIRST brought this content into the studio (#1839). Distinct from
     * `studioId`, which says who OWNS it: attribution follows the project's
     * studio for personal and team studios alike, so the producer is no
     * longer recoverable from the owner studio the way it was while a
     * personal-studio project attributed to the acting user's own studio.
     *
     * On a dedup HIT the existing row wins and keeps its original producer —
     * "who first brought it in" is the meaningful answer for storage
     * accounting, abuse triage and GDPR erasure. A later uploader of the same
     * bytes is not recorded here (their upload deduped away).
     */
    producedByUserId: uuid("produced_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * The generation task that produced an AI asset - links to cost via
     * tasks.billed_credits + credit_ledger.reference_id. Null for
     * uploads (user-supplied, no generation cost).
     */
    generationTaskId: uuid("generation_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    /**
     * A video's cover, backfilled once the worker has extracted and registered
     * it (#173). Only video rows ever carry one.
     *
     * Without this column the relationship exists nowhere: the cover used to
     * ride along in the upload report and was resolved on the spot, which
     * worked only because the browser sent a cover with every video. Once the
     * cover is produced server-side, a dedup hit against an existing video row
     * has nothing to read it from — the node comes back showing a video that
     * already has a cover, without it.
     *
     * A backfill rather than part of the insert: the video row is written by
     * the server at report time, and the cover does not exist until the worker
     * finishes. Between those two the column is null, which reads as "no
     * cover" — the same thing an extraction failure leaves behind, and the
     * same Film icon.
     */
    coverAssetId: uuid("cover_asset_id").references(
      (): AnyPgColumn => studioAssets.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Reserved for future GDPR / studio-deletion cascade; no V1 flow
    // writes it (assets are non-deletable in V1). No updated_at: a row is
    // immutable once created (content_hash defines it).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Usage sum + management listing scoped to one studio (partial on
    // live rows).
    index("studio_assets_studio_idx")
      .on(table.studioId)
      .where(sql`${table.deletedAt} IS NULL`),
    // Reverse lookup by key (#1826, Gate-2 R9). `queueForReclaim` refuses to
    // enqueue a key that still has a live row, checking it inside the INSERT
    // (atomically); without this index that guard was a sequential scan on
    // every dedup-hit registration. NOT unique — dedup is keyed on content,
    // not on key, and one key may appear on a soft-deleted row plus its
    // replacement. Partial to match the guard's predicate exactly.
    index("studio_assets_storage_key_idx")
      .on(table.storageKey)
      .where(sql`${table.deletedAt} IS NULL`),
    // The (studio_id, content_hash) partial UNIQUE (within-studio dedup
    // key, WHERE deleted_at IS NULL) lives in the migration - Drizzle's
    // builder does not emit partial unique indexes (same note as
    // project_activities / project_invitations).
  ],
);

// The anti-spoof authority (#1826, design §2.2 / §3.2) that REPLACES the
// prefix-based isOwnedKey once storage keys drop their {userId}/{projectId}/
// prefix. /presign writes one grant row per issued storage key K (user +
// owner studio + declared content_hash + K); the upload endpoints re-check
// it — /local-upload finds a LIVE (not-consumed) grant to gate the disk
// write WITHOUT consuming (a local upload is a two-hop PUT-then-report on
// ONE grant), /uploaded finds + INSERTs studio_assets + marks consumed
// exactly once (anti-replay).
//
// No expires_at (design v11): the check is ownership + not-consumed only, no
// upload time limit (local uploads take as long as they take; cloud presigned
// PUT-URL expiry is the provider's own PUT window, unrelated to this table).
// No deleted_at: a short-lived anti-spoof credential, not a project-scoped
// audit row — bound to (user, studio), never to a project, physically
// reclaimed by an OFFLINE GC sweep (design §7), like an outbox. No
// updated_at: append-only; consumed_at is a single-shot business marker.
export const uploadGrants = pgTable(
  "upload_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The user who requested the presign. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The owner studio resolved server-side at presign (resolveOwnerStudioId). */
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    /** The tenant-neutral storage key K the server minted (issued at most once). */
    storageKey: text("storage_key").notNull(),
    /**
     * Client-declared byte size — a presign-time UX pre-check + downstream
     * quota-reservation hint ONLY; the authoritative upload-cap gate reads the
     * stored object's real size at /uploaded (design §4.2), never this.
     */
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    /**
     * Anti-replay marker — set exactly once by /uploaded AFTER its
     * studio_assets INSERT. Null while unconsumed. /local-upload never sets it
     * (write-time gate only). A consumed grant no longer resolves as live.
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /**
     * Set when this grant died without its bytes ever becoming an asset — the
     * report said `aborted`, the size came back over the cap, or the sweep
     * found it past its deadline. Kept apart from `consumed_at` because the
     * two terminal states demand opposite handling: a consumed grant produced
     * an asset row, a voided one produced an object nobody owns.
     */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /**
     * How long the ticket itself stays usable. Checked once, when the browser
     * asks the ingest Worker to start; an upload already running is never cut
     * off by it. Judged lazily on read, the way `studioInvite.service.ts:133`
     * clears stale invites — no background scan.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * The node's fencing gen at the moment handling opened. It is also signed
     * into the ticket and echoed back by the Worker; keeping it here means the
     * report handler reads the gen off a row we wrote rather than off anything
     * the caller supplies. An event published without the right gen is dropped
     * by collab's CAS and the node hangs in handling until the lease sweeper
     * reclaims it an hour later.
     */
    leaseGen: integer("lease_gen").notNull(),
    /** Node these bytes land on. Absent for a focus crop, which has no node. */
    nodeId: uuid("node_id"),
    /** Project the node belongs to, checked against the user's access at ticket time. */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    /** Canvas space holding the node — part of the doc name the event addresses. */
    spaceId: uuid("space_id"),
    /** What started this upload. node_history and the activity feed both read it. */
    source: text("source"),
    /** Mini-tool that produced these bytes, when one did. */
    toolName: text("tool_name"),
    /** True when the bytes came out of another asset rather than the user's disk. */
    derived: boolean("derived"),
    /** Original file name, shown in history. */
    filename: text("filename"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // A storage key is issued at most once; this plain UNIQUE both enforces
    // that and serves the ownership lookup (storage_key alone locates the row,
    // then user_id + consumed_at IS NULL are checked). The studio is READ from
    // the row, NEVER a query condition — that is the anti-spoof invariant, and
    // what lets /local-upload (which holds no studio) authorize. Not partial,
    // so Drizzle emits it fine — but the migration is still hand-written.
    uniqueIndex("upload_grants_storage_key_unique").on(table.storageKey),
  ],
);

// ── Storage reclaim queue (#1826 §2.3, v15 2026-07-26) ───────────────
//
// The list the OFFLINE reclaim job works from. When an upload or a generated
// output turns out to be a within-studio duplicate, the copy we just stored is
// redundant — but runtime NEVER deletes physical objects (§0 rule 1, which
// keeps the delete attack surface at zero). So runtime does the only thing it
// is allowed to do: it INSERTs one more row, here, saying "this object is a
// known duplicate and is safe to reclaim". The offline job then works from an
// explicit list instead of scanning the whole bucket guessing what is an
// orphan.
//
// Nothing live ever references these keys: every consumer URL comes from the
// surviving row's canonical (§0 rule 2), so reclaiming them cannot affect
// production. No deleted_at — this is an internal work queue (like the
// lifecycle outbox), not a project-scoped audit row: the physical object still
// needs reclaiming even after its project is gone.
export const storageReclaimQueue = pgTable(
  "storage_reclaim_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The redundant object to reclaim (the copy this request just stored). */
    storageKey: text("storage_key").notNull(),
    /** Its content fingerprint — identical to the surviving row's. */
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    /** Owning studio (quota / reconciliation audits). */
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    /**
     * The key that WON dedup and stays live. A safety rail: the offline job can
     * confirm the winner still exists before deleting this one, so it can never
     * reclaim the last copy of a content.
     */
    keptStorageKey: text("kept_storage_key").notNull(),
    /**
     * Mirrors `studio_assets.source` exactly: 'upload' (browser) | 'ai'
     * (worker) | 'cover' (a video's cover, from EITHER path). No other value
     * is possible — the column is written straight from the registered
     * asset's own source.
     */
    source: varchar("source", { length: 16 }).notNull(),
    /**
     * Null while pending; set once the offline job has reclaimed the object.
     * The row is MARKED, never deleted (same shape as upload_grants.consumed_at
     * — the project never destroys records).
     */
    reclaimedAt: timestamp("reclaimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One row per redundant object — a retry of the same report must not queue
    // it twice (the INSERT is ON CONFLICT DO NOTHING against this).
    uniqueIndex("storage_reclaim_queue_storage_key_unique").on(table.storageKey),
    // The offline job's driving query: the pending backlog, oldest first.
    index("storage_reclaim_queue_pending_idx").on(
      table.reclaimedAt,
      table.createdAt,
    ),
  ],
);
