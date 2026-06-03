// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared API request schemas.
 *
 * These Zod schemas define the contract between frontend and backend.
 * Both sides import from here to ensure type consistency.
 *
 * Convention: schema name = `{resource}{Action}Schema`
 * Inferred type: `{Resource}{Action}Input`
 */

import { z } from "zod";

// ── Auth ─────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  // Display name collected by RegisterPage as a required field. The
  // server stores it on `users.username`; absence falls back to the
  // email local-part (`email.split("@")[0]`) for back-compat with
  // older clients that still POST a 2-field body.
  name: z.string().trim().min(1).max(100).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const googleAuthSchema = z.object({
  credential: z.string().min(1),
});
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;

// ── Chat ─────────────────────────────────────────────────────────────

/**
 * Chat-attached chip — a snapshot of a canvas node the user picked
 * from a Space and attached to this message (spec/07-chat-agent.md
 * §10.18.2 v13). The `dataSnapshot` is a deep copy taken at attach
 * time; subsequent Space-side edits / deletions of the source node
 * do NOT mutate the chip (C1 full-snapshot model — same philosophy as
 * spec §6.2 Studio→Space copies).
 */
export const chatAttachedChipSchema = z.object({
  /** Source node id (audit only — not a live reference). */
  id: z.string(),
  type: z.enum(["image", "video", "audio", "text", "generative", "annotation"]),
  /** Display name for the chip; LLM context renders this as the section title. */
  name: z.string(),
  /** Deep copy of the source node's `data` at attach time. */
  data_snapshot: z.record(z.string(), z.unknown()),
});
export type ChatAttachedChip = z.infer<typeof chatAttachedChipSchema>;

export const chatMessageSchema = z.object({
  message: z.string().min(1),
  resource_list: z.array(z.string()).default([]),
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
  /**
   * V13 (spec §10.18.2): canvas-node snapshots the user attached to
   * this message via the chips bar. Required field but defaults to
   * `[]` so legacy callers (skills / SDK that don't surface a chips
   * bar) keep working. The chat handler injects each chip's
   * `data_snapshot` into the LLM prompt as a structured context section.
   */
  attached_chips: z.array(chatAttachedChipSchema).default([]),
  /**
   * V13 (spec §10.18.5): user-picked Skill name (resolved against the
   * registered skills/ directory). Optional — bare chat works without
   * a skill.
   */
  skill: z.string().optional(),
  /**
   * V13: model override. Spec §10.18.5 v13 dropped the in-composer
   * model picker (model is now decided by the Skill or global
   * settings), but we keep the wire field so SDK callers and test
   * cases can override explicitly. Normal chat omits this.
   */
  model: z.string().optional(),
});
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

export const skillCommandSchema = z.object({
  skill_name: z.string().min(1),
  input: z.string().min(1),
  resource_list: z.array(z.string()).default([]),
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
});
export type SkillCommandInput = z.infer<typeof skillCommandSchema>;

// ── Canvas ───────────────────────────────────────────────────────────

export const taskCreateSchema = z
  .object({
    task_type: z.string(),
    model: z.string().optional(),
    skill_name: z.string().optional(),
    params: z.record(z.string(), z.unknown()),
    /**
     * Result nodes this task will update on completion (1..N).
     * Mini-tools / AIGC tasks always bind to at least one node; other
     * task types (some internal audits) may omit and pass through.
     */
    node_ids: z.array(z.string()).min(1).optional(),
    project_id: z.string().uuid(),
    /**
     * Space within the project the task targets (v10 multi-doc).
     * Worker writes results to `project-{project_id}/canvas-{space_id}`,
     * so this is required. Plain UUID — no FK on the server side.
     */
    space_id: z.string().uuid(),
    source: z.string().default("canvas"),
    /**
     * UUID v4 of the canvas node that will receive the task result.
     * Required when `node_ids` is present (single-node tasks).
     * The worker wraps this into `targetNodeIds: [target_node_id]` in the
     * BullMQ job payload.
     * Omit for tasks that do not bind to a canvas node.
     */
    target_node_id: z.string().uuid().optional(),
    /**
     * Execution mode (spec §10.13 generative dual-button + §10.15 lock).
     * Required — every caller must declare intent explicitly.
     *
     *   - `append`: create a new sibling result node. No lock contention
     *     because the new node has its own UUID. Mini-tools / AIGC direct
     *     flows always use this.
     *   - `overwrite`: replace the existing `target_node_id` node's data.
     *     Requires `target_node_id`. The server SETNX-locks the node so
     *     concurrent overwrites are rejected with `ConflictLocked` 409
     *     (spec §10.15.3 two-tier check).
     */
    mode: z.enum(["append", "overwrite"]),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "overwrite" && !val.target_node_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "target_node_id is required when mode is 'overwrite' (spec §10.15.3)",
        path: ["target_node_id"],
      });
    }
  });
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const understandSchema = z.object({
  source_type: z.enum(["image", "video", "audio"]),
  source_url: z.string(),
  node_ids: z.array(z.string()).min(1).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  project_id: z.string().uuid(),
  /** Same as taskCreateSchema.space_id (v10 multi-doc). Required. */
  space_id: z.string().uuid(),
});
export type UnderstandInput = z.infer<typeof understandSchema>;

// ── Projects ─────────────────────────────────────────────────────────

export const projectCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

// ── Payment ──────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
  tier: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ── Pagination ───────────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

/**
 * `GET /chat/conversations` query — pagination plus an optional
 * `project_id` filter. Without the filter, ChatPanel had to pull a
 * page and client-side `find` for a matching project, which dropped
 * silently when the target conversation sat past the page boundary.
 */
export const chatConversationsQuerySchema = paginationSchema.extend({
  project_id: z.string().uuid().optional(),
});
export type ChatConversationsQueryInput = z.infer<typeof chatConversationsQuerySchema>;
