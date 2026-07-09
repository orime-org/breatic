// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model catalog wire contract — the shape of the `GET /api/v1/models`
 * response, shared between the backend (which builds it from YAML) and the
 * web frontend (which renders the model picker + dynamic param form).
 *
 * These types live in `@breatic/shared`, not `@breatic/domain`: the catalog is
 * an API response contract consumed by BOTH the frontend and the backend, and
 * `ModelEntry`/`ParamDescriptor` were always meant as the "API response shape"
 * / "frontend form rendering" shape (their own doc comments) — they were
 * misplaced in the backend-only domain package. `@breatic/domain` imports them
 * from here and keeps the YAML-loading logic + the runtime `MODALITIES` list.
 *
 * The interfaces below are the CONTRACT (what a correct catalog looks like).
 * `sanitizeModelCatalog` at the bottom is the trust-boundary SANITIZER: the web
 * client runs every `GET /models` response through it so a malformed catalog
 * (wrong field types, a non-array bucket, a garbage entry) can never poison the
 * Generate panel. Downstream code consumes the sanitized value and can trust
 * the types — validation happens once, at the boundary, not field-by-field
 * everywhere the catalog flows.
 */

import { z } from "zod";

/**
 * AIGC model modalities — the `config/models/<modality>` directory names.
 * Distinct from the canvas node modalities (which include `text` / `3d` /
 * `web` and drive node rendering, not model selection).
 */
export type ModelModality =
  | 'image'
  | 'video'
  | 'audio'
  | 'tts'
  | 'three_d'
  | 'understand';

/** Model tier for frontend display filtering. */
export type ModelTier = 'recommended' | 'optional' | 'internal';

/** Single parameter descriptor — drives dynamic frontend form rendering. */
export interface ParamDescriptor {
  description: string;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  type?: string;
  max_items?: number;
  default: unknown;
}

/** One provider backing a model (with resolved availability). */
export interface ModelProvider {
  name: string;
  model_id: string;
  priority: number;
  available: boolean;
}

/** Single model definition — one entry in the catalog response. */
export interface ModelEntry {
  name: string;
  display_name: string;
  modality: ModelModality;
  mode: string | string[];
  description: string;
  guide: string;
  tier: ModelTier;
  cost_per_call: number;
  generation_time: number;
  params: Record<string, ParamDescriptor>;
  providers: ModelProvider[];
}

/** Full catalog grouped by modality — the `data` payload of `GET /models`. */
export interface ModelCatalog {
  image: ModelEntry[];
  video: ModelEntry[];
  audio: ModelEntry[];
  tts: ModelEntry[];
  three_d: ModelEntry[];
  understand: ModelEntry[];
  total: number;
}

// ── Image model classification ───────────────────────────────────────
//
// Single source of truth (web + backend) for which image `mode`s make a model
// GENERATABLE — i.e. it produces or edits an image from a prompt (optionally
// using an upstream reference as the source image), as opposed to a pure
// utility tool (`remove_bg` / `upscale`) that belongs in the mini-tool system.
// Both the Generate panel's model picker and the agent's image-plan skill
// filter through this so they always offer the same set.

/**
 * Image model `mode` values that make a model generatable: text-to-image and
 * image-to-image. A model qualifies when ANY of its modes is one of these, so
 * an edit model tagged `["i2i", "edit"]` qualifies via its `i2i` capability.
 * `edit` is NOT itself a generation mode: pure tools (`remove_bg` / `upscale`)
 * and any hypothetical edit-only model do not qualify — they belong in the
 * mini-tool system.
 */
export const IMAGE_GENERATION_MODES = ["t2i", "i2i"] as const;

/**
 * Whether an image model's `mode` makes it offerable for generation (Generate
 * picker + agent image plan) versus a pure utility tool. A model qualifies when
 * any single mode is a generation mode, so a multi-mode model (e.g.
 * `["i2i", "edit"]`) qualifies as long as it can do t2i or i2i.
 * @param mode - The model's `mode` (a single string or an array of modes).
 * @returns True when any of the model's modes is a generation mode.
 */
export function isImageGenerationMode(mode: string | string[]): boolean {
  const modes = Array.isArray(mode) ? mode : [mode];
  const generatable: readonly string[] = IMAGE_GENERATION_MODES;
  return modes.some((m) => generatable.includes(m));
}

// ── Boundary sanitizer ───────────────────────────────────────────────
//
// Lenient by design: an entry is only DROPPED when it lacks a usable identity
// (a non-empty string `name`); every other malformed field is coerced to a safe
// default so one bad field never discards an otherwise usable model. This keeps
// the picker resilient to backend/catalog drift while guaranteeing the types
// downstream code relies on.

/**
 * One param descriptor. The trailing `transform` re-asserts `default` so the
 * inferred type carries it as a required property (a bare `z.unknown()` infers
 * it optional), keeping the output assignable to {@link ParamDescriptor}.
 */
const paramDescriptorSchema = z
  .object({
    description: z.string().catch(""),
    values: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .catch(undefined),
    min: z.number().optional().catch(undefined),
    max: z.number().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    max_items: z.number().optional().catch(undefined),
    default: z.unknown(),
  })
  .transform((d) => ({ ...d, default: d.default }));

/** A minimal, always-valid descriptor used when a param descriptor is garbage. */
const SAFE_DESCRIPTOR: z.infer<typeof paramDescriptorSchema> = {
  description: "",
  default: undefined,
};

const modelProviderSchema = z.object({
  name: z.string().catch(""),
  model_id: z.string().catch(""),
  priority: z.number().catch(0),
  available: z.boolean().catch(false),
});

const modelEntrySchema = z.object({
  // Identity: no `.catch`, so an entry with no usable name fails and is dropped.
  name: z.string().min(1),
  display_name: z.string().catch(""),
  modality: z
    .enum(["image", "video", "audio", "tts", "three_d", "understand"])
    .catch("image"),
  mode: z.union([z.string(), z.array(z.string())]).catch("generate"),
  description: z.string().catch(""),
  guide: z.string().catch(""),
  tier: z.enum(["recommended", "optional", "internal"]).catch("optional"),
  cost_per_call: z.number().catch(0),
  generation_time: z.number().catch(0),
  // Non-object params → {}; an individual garbage descriptor → SAFE_DESCRIPTOR,
  // so siblings survive. `z.record` keys are always strings here.
  params: z
    .record(z.string(), z.unknown())
    .catch({})
    .transform((rec) => {
      const out: Record<string, z.infer<typeof paramDescriptorSchema>> = {};
      for (const [key, value] of Object.entries(rec)) {
        const parsed = paramDescriptorSchema.safeParse(value);
        out[key] = parsed.success ? parsed.data : SAFE_DESCRIPTOR;
      }
      return out;
    }),
  providers: z.array(modelProviderSchema).catch([]),
});

/** One modality bucket: a non-array coerces to [], garbage entries drop out. */
const modelEntryBucketSchema = z
  .array(z.unknown())
  .catch([])
  .transform((arr) =>
    arr.flatMap((entry) => {
      const parsed = modelEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );

// The empty catalog returned when the whole response is not even an object.
// Left un-annotated so the empty buckets infer as `never[]` (assignable to the
// schema's mutable entry-array output); annotating it `ModelCatalog` would fail
// because `ParamDescriptor.values` is `readonly` and the `.catch` fallback must
// match the schema's mutable output type, not the read-only contract.
const EMPTY_CATALOG = {
  image: [],
  video: [],
  audio: [],
  tts: [],
  three_d: [],
  understand: [],
  total: 0,
};

/**
 * Zod schema for the full catalog. A non-object response falls back to the
 * empty catalog; individual buckets and `total` never throw (each self-heals),
 * so `.parse` is total — it always returns a valid {@link ModelCatalog}.
 */
export const modelCatalogSchema = z
  .object({
    image: modelEntryBucketSchema,
    video: modelEntryBucketSchema,
    audio: modelEntryBucketSchema,
    tts: modelEntryBucketSchema,
    three_d: modelEntryBucketSchema,
    understand: modelEntryBucketSchema,
    total: z.number().catch(0),
  })
  .catch(EMPTY_CATALOG);

/**
 * Sanitizes an untrusted `GET /models` response into a trusted
 * {@link ModelCatalog}. Never throws: malformed entries are dropped, malformed
 * fields are coerced to safe defaults, and total garbage yields an empty
 * catalog. Call this once at the API boundary so downstream code can trust the
 * types instead of re-guarding every field.
 * @param raw - The raw response payload (already unwrapped from the envelope).
 * @returns A structurally valid catalog.
 */
export function sanitizeModelCatalog(raw: unknown): ModelCatalog {
  return modelCatalogSchema.parse(raw);
}
