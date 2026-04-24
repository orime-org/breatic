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
  // ── Local (Worker-side Sharp) mini-tools ──
  // Source URL arrives on the base-inherited `image` field; Worker
  // builds NodeEvent.docName as `project-{id}/node/{host_node_id}`
  // for mixed-editor requests, else falls back to the canvas doc.
  imageToolBase.extend({
    tool: z.literal("crop"),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    host_node_id: z.string().optional(),
  }),
  imageToolBase.extend({
    tool: z.literal("flipRotate"),
    op: z.enum(["rotate90", "rotateMinus90", "flipHorizontal", "flipVertical"]),
    host_node_id: z.string().optional(),
  }),
  // `manual-adjust` carries the shared AdjustValue (15 sliders).
  // Named distinctly from `adjust: topaz-adjust` above (AI
  // auto-enhance) to prevent dispatch-table collision.
  imageToolBase.extend({
    tool: z.literal("manual-adjust"),
    value: z.record(z.string(), z.number()).optional(),
    host_node_id: z.string().optional(),
  }),
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
    // Source URL field name mirrors the rest of the video family
    // (`upscale` / `interpolate` / etc. all use `video`). The image
    // family's `crop` uses `image` for the same reason — local and
    // provider handlers inside one modality share field names.
    video: z.string().url(),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("speed"),
    video: z.string().url(),
    rate: z.number().positive(),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("cut"),
    video: z.string().url(),
    segments: z
      .array(
        z.object({
          start: z.number().min(0),
          end: z.number().positive(),
        }),
      )
      .min(1),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("adjust"),
    video: z.string().url(),
    value: z.record(z.string(), z.number()).optional(),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("audio-denoise"),
    video: z.string().url(),
    intensity: z.number().min(0).max(100),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  // Visual-parity local handlers (not real AIGC). Match the legacy
  // ffmpeg.wasm surface one-to-one so migrating the front-end is a
  // field-for-field swap.
  z.object({
    tool: z.literal("stabilization"),
    video: z.string().url(),
    // Symmetric crop percentage per edge. Front-end clamps to [0, 14]
    // in both the UI slider and the ffmpeg util — same bounds here.
    cropPct: z.number().min(0).max(14),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("scene-extension"),
    video: z.string().url(),
    // Outer frame the source should fit into; ox/oy non-positive (the
    // worker re-clamps to mirror the front-end normalisation).
    frame: z.object({
      w: z.number(),
      h: z.number(),
      ox: z.number(),
      oy: z.number(),
    }),
    container: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    node_id: z.string().optional(),
    project_id: z.string().optional(),
    host_node_id: z.string().optional(),
  }),
  z.object({
    tool: z.literal("hdr-conversion"),
    video: z.string().url(),
    preset: z.enum(["hdr10", "hlg", "dolby-vision"]),
    intensity: z.number().min(0).max(100),
    aiEnhance: z.boolean(),
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
