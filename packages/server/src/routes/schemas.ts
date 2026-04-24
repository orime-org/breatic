/**
 * API request schemas — re-exported from @breatic/shared.
 *
 * Server-only schemas (mini-tool discriminated unions, skill market)
 * remain defined here. Shared schemas are the single source of truth.
 */

// ── Re-export shared schemas ────────────────────────────────────────
export {
  registerSchema,
  loginSchema,
  chatMessageSchema,
  skillCommandSchema,
  taskCreateSchema,
  understandSchema,
  projectCreateSchema,
  canvasSaveSchema,
  checkoutSchema,
  paginationSchema,
} from "@breatic/shared";

// ── Server-only schemas (complex discriminated unions) ───────────────

import { z } from "zod";

// Mini-Tools: Image
const imageToolBase = z.object({
  image: z.string(),
  node_id: z.string().optional(),
  project_id: z.string().optional(),
});

export const imageToolSchema = z.discriminatedUnion("tool", [
  imageToolBase.extend({ tool: z.literal("remove-bg") }),
  imageToolBase.extend({ tool: z.literal("upscale"), output_resolution: z.string().optional(), source_width: z.number().optional(), source_height: z.number().optional() }),
  imageToolBase.extend({ tool: z.literal("upscale-creative"), output_resolution: z.string().optional(), source_width: z.number().optional(), source_height: z.number().optional(), prompt: z.string().optional(), creativity: z.number().default(3) }),
  imageToolBase.extend({ tool: z.literal("sharpen"), sharpen_model: z.string().default("Standard"), sharpen_strength: z.number().default(0), denoise_strength: z.number().default(0) }),
  imageToolBase.extend({ tool: z.literal("denoise"), denoise_model: z.string().default("Normal"), denoise: z.number().default(0), detail: z.number().default(0), face_enhancement: z.boolean().default(true) }),
  imageToolBase.extend({ tool: z.literal("restore"), restore_model: z.string().default("Dust-Scratch") }),
  imageToolBase.extend({ tool: z.literal("adjust"), adjust_mode: z.string().default("Adjust"), saturation: z.number().default(0.2) }),
  imageToolBase.extend({ tool: z.literal("relight"), light_source: z.string().default("none"), brightness: z.number().default(50), light_temperature: z.number().default(5600), rim_light: z.boolean().default(false), prompt: z.string().optional() }),
  imageToolBase.extend({ tool: z.literal("multi-angle"), horizontal_angle: z.number().default(0), vertical_angle: z.number().default(0), distance: z.number().default(1) }),
  imageToolBase.extend({ tool: z.literal("edit"), prompt: z.string() }),
]);

// Mini-Tools: Video
export const videoToolSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("upscale"), video: z.string(), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("interpolate"), video: z.string(), multiplier: z.number().default(2), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("extend"), video: z.string(), prompt: z.string().default(""), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("edit"), video: z.string(), prompt: z.string(), images: z.array(z.string()).optional(), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("motion"), image: z.string(), video: z.string().optional(), prompt: z.string().default(""), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("animate"), video: z.string(), image: z.string().optional(), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("talking-head"), image: z.string(), audio: z.string(), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  // Local (Worker-side FFmpeg) mini-tool — first non-vendor video op.
  // `host_node_id` identifies the mixed-editor container when the
  // request originates from a node-editor doc (Worker reads it out of
  // params to build NodeEvent.docName as `project-{id}/node/{host_node_id}`).
  // Omit for main-canvas invocations.
  z.object({
    tool: z.literal("crop"),
    sourceUrl: z.string().url(),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
]);

// Mini-Tools: Audio
export const audioToolSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("sfx"), prompt: z.string(), duration_seconds: z.number().optional(), prompt_influence: z.number().default(0.3), loop: z.boolean().default(false), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("tts"), text: z.string(), voice_id: z.string().default("Alice"), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("voice-clone"), text: z.string(), audio: z.string(), reference_text: z.string().optional(), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("separate"), audio: z.string(), mode: z.string().default("vocals"), node_id: z.string().optional(), project_id: z.string().optional() }),
  z.object({ tool: z.literal("extend"), audio: z.string(), prompt: z.string().default(""), model: z.string().optional(), node_id: z.string().optional(), project_id: z.string().optional() }),
]);

// Mini-Tools: Text
const textToolBase = z.object({
  document: z.string().optional(),
  selection: z.string().optional(),
  instructions: z.string().optional(),
  node_id: z.string().optional(),
  project_id: z.string().optional(),
});

export const textToolSchema = z.discriminatedUnion("tool", [
  textToolBase.extend({ tool: z.literal("polish"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("expand"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("summarize"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("translate"), document: z.string(), selection: z.string(), language: z.string() }),
  textToolBase.extend({ tool: z.literal("rewrite"), document: z.string(), selection: z.string(), style: z.string().optional() }),
  textToolBase.extend({ tool: z.literal("continue"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("generate"), instructions: z.string() }),
  textToolBase.extend({ tool: z.literal("character"), name: z.string(), traits: z.string().optional(), context: z.string().optional() }),
  textToolBase.extend({ tool: z.literal("storyboard"), instructions: z.string(), scene_count: z.number().int().optional() }),
  textToolBase.extend({ tool: z.literal("script"), scene_description: z.string(), characters: z.array(z.string()).optional() }),
]);

// Skill Market
export const skillMarketQuerySchema = z.object({
  tags: z.string().transform((s) => s.split(",").filter(Boolean)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
