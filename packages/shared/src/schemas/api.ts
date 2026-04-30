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

export const chatMessageSchema = z.object({
  message: z.string().min(1),
  resource_list: z.array(z.string()).default([]),
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
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

export const taskCreateSchema = z.object({
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
  project_id: z.string().optional(),
  source: z.string().default("canvas"),
  /**
   * UUID v4 of the canvas node that will receive the task result.
   * Required when `node_ids` is present (single-node tasks).
   * The worker wraps this into `targetNodeIds: [target_node_id]` in the
   * BullMQ job payload.
   * Omit for tasks that do not bind to a canvas node.
   */
  target_node_id: z.string().uuid().optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const understandSchema = z.object({
  source_type: z.enum(["image", "video", "audio"]),
  source_url: z.string(),
  node_ids: z.array(z.string()).min(1).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  project_id: z.string().optional(),
});
export type UnderstandInput = z.infer<typeof understandSchema>;

// ── Projects ─────────────────────────────────────────────────────────

export const projectCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const canvasSaveSchema = z.object({
  canvas_data: z.record(z.string(), z.unknown()),
});
export type CanvasSaveInput = z.infer<typeof canvasSaveSchema>;

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
