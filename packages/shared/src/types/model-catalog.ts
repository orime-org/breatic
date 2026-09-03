// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * A catalog this param's value comes from, fetched at runtime rather than
 * declared in yaml. `voices` is served by `GET /models/:name/voices`, which
 * answers in the value domain of whichever provider this deployment resolved
 * to — so the value the picker writes is the one the vendor accepts.
 */
export type RemoteParamSource = "voices";

/** Single parameter descriptor — drives dynamic frontend form rendering. */
export interface ParamDescriptor {
  description: string;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  /**
   * The increment a continuous control moves this value by (#1960).
   *
   * Bounds alone do not say how finely a value may be set — 0 to 1 is three
   * stops for ElevenLabs' stability and twenty for its similarity — and that
   * is the model's statement about its own parameter, not a decision for
   * whichever control happens to render it. Only params meant to be set
   * continuously carry one; a param stating `values` is a list of choices and
   * has nothing to step through.
   */
  step?: number;
  type?: string;
  max_items?: number;
  /**
   * Names the picker that fills this param, for params whose value domain
   * lives upstream instead of in `values` (#1960). Two models spell the same
   * choice differently — ElevenLabs takes `voice_id`, Fish takes
   * `reference_id` — so the panel finds its voice param by this rather than
   * by name.
   */
  remote_source?: RemoteParamSource;
  default: unknown;
}

/**
 * What a model charges, in the unit its vendor bills by (#1960).
 *
 * The unit travels with the number because vendors do not share one: Fish
 * bills per UTF-8 byte, ElevenLabs per character, and a Chinese character is
 * three bytes — one shared "per 1000 characters" wording would understate
 * Fish threefold. This states a rate, not a total: charging happens after
 * generation, on actual usage.
 */
export interface ModelRate {
  /** Credits charged per `per` units. 1 credit = 1 US cent. */
  credits: number;
  /** How many units that many credits buy. */
  per: number;
  unit: "characters" | "utf8_bytes";
}

/** One provider backing a model (with resolved availability). */
export interface ModelProvider {
  name: string;
  model_id: string;
  priority: number;
  available: boolean;
}

/**
 * A kind of source input a generation mode may require (#1675 cross-modality
 * execute gate). i2i/edit/i2v/… need an `image`; video edit/upscale need a
 * `video`; a2m/voice_clone need an `audio`. A mode may need several (e.g.
 * `talking_head` needs image + audio).
 */
export type SourceType = "image" | "video" | "audio";

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
  /**
   * Whether this model consumes the text the user writes (#1966). Declared
   * per model in yaml, never derived: it used to be read off a `prompt` entry
   * under `params`, which is a per-catalog writing habit rather than a rule —
   * no image model ever wrote one, so that derivation answered "no prompt"
   * for the whole image catalog. Both Generate panels mount (or refuse to
   * mount) their prompt editor on this, and the reference rail freezes a
   * row's insert and ✕ on it.
   *
   * Not optional: a model that omits it fails to load. Defaulting to `false`
   * would let a forgotten line silently unmount the editor.
   */
  takes_prompt: boolean;
  /**
   * What this model charges per unit of input (#1960), for the panel to state
   * before the user generates. Absent on models that bill per call — those
   * state `cost_per_call` instead.
   */
  rate?: ModelRate;
  /**
   * How much input text this model accepts in one request (#1960), so the
   * panel can refuse before sending text the upstream would reject.
   *
   * The vendor of the model states it, and a gateway reselling that model
   * cannot raise it — it forwards the same request to the same API. Absent
   * when the vendor publishes no cap, and absent means uncapped: a number
   * invented here would refuse text the vendor accepts.
   */
  max_input_chars?: number;
  /**
   * Per-mode source requirements (#1675 cross-modality execute gate),
   * computed backend-side (the rule lives in domain). Maps each of the
   * model's modes to the source types that mode needs (`t2i` → `[]`,
   * `i2i` → `["image"]`, `talking_head` → `["image","audio"]`). The frontend
   * gate reads `sourcesByMode[activePanelMode]` to decide whether to block
   * execution — it never runs the rule itself. Empty when the catalog entry
   * carries no recognized mode.
   */
  sourcesByMode: Record<string, SourceType[]>;
  /**
   * Brand icon name for the Generate picker (mapped to an inline SVG on the
   * frontend, e.g. `nano-banana` / `midjourney` / `seedream`). Optional so a
   * catalog entry missing it degrades to a fallback icon rather than dropping.
   */
  icon?: string;
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
// Which image `mode`s make a model GENERATABLE — i.e. it produces or edits an
// image from a prompt (optionally using an upstream reference as the source
// image), as opposed to a pure utility tool (`remove_bg` / `upscale`) that
// belongs in the mini-tool system.
//
// One consumer: the agent's image-plan skill (`domain/agent/skills-loader.ts`).
// The Generate panel does NOT read this — its picker narrows the catalog to the
// mode the user is on (`filterModelsByMode`), and since #1951 it offers only the
// modes this deployment has a model for. It used to be a shared predicate; the
// web side of it lost its last caller when the picker started asking about
// availability instead of about classification.

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
 * Video model `mode` values that make a model offerable in the video Generate
 * panel (#1896). A model qualifies when ANY of its modes is one of these, so a
 * model tagged with several offerable modes qualifies through any of them.
 *
 * `first_last` is declared by the two image-to-video models whose vendor takes
 * an end frame — `kling-o3-pro-i2v` and `seedance-1.5-pro-i2v`, both
 * `mode: ["i2v", "first_last"]` (#1904); `veo-3.1-i2v` stays plain `i2v`. A
 * model gaining the mode must gain a row in the backend's per-mode source map
 * at the same time — a mode missing from that map is treated as needing no
 * source, which would switch the execute gate off for that model in every one
 * of its modes.
 *
 * Which modes belong here is the user's decision (2026-08-08), not a formula:
 * these six go in the Generate panel and `extend` / `edit` / `motion` /
 * `upscale` / `interpolate` go to the mini-tool system. Four of those five do
 * work on a video that already exists, which is the shape of the decision —
 * but `motion` does not: `kling-v3-pro-motion` takes a character image
 * (`config/models/video/kling.yaml:186`, and `MODE_REQUIRED_SOURCES.video`
 * lists it as `["image"]`), and it is out because the user put it out. Do not
 * re-derive the list from a rule; the list IS the rule.
 *
 * Offering a mini-tool mode here would put a model in the picker that needs a
 * source this panel does not collect, and the backend's cross-modality source
 * gate then rejects the submit with a 400.
 *
 * This is a separate list from `IMAGE_GENERATION_MODES` on purpose, not a
 * duplication to be merged: the two are independent product decisions that
 * happen to share a shape. Changing which image modes are generatable says
 * nothing about video, and the agent's image-plan skill reads the image list
 * without wanting a video decision attached to it.
 */
export const VIDEO_GENERATION_MODES = [
  "t2v",
  "i2v",
  "first_last",
  "animate",
  "ref",
  "talking_head",
] as const;

// The source-image predicates (SOURCE_IMAGE_MODES / requiresSourceImage /
// supportsTextToImage) were replaced by the cross-modality execute gate
// (#1675): the (modality, mode) → source-type rule now lives backend-side in
// domain/model-catalog/source-requirement.ts and reaches the frontend as the
// precomputed ModelEntry.sourcesByMode wire field.

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
    step: z.number().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    max_items: z.number().optional().catch(undefined),
    // An unrecognised name would send the panel looking for a picker that does
    // not exist, so it degrades to an ordinary param rather than to a guess.
    remote_source: z.enum(["voices"]).optional().catch(undefined),
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
  // Brand icon name; a non-string → undefined so the entry still survives.
  icon: z.string().optional().catch(undefined),
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
  // Per-mode source requirements (#1675); non-object / garbage → {} so the
  // entry still survives (a missing gate degrades open, matching the lenient
  // sanitizer contract — the server gate is the authoritative enforcement).
  sourcesByMode: z
    .record(z.string(), z.array(z.enum(["image", "video", "audio"])))
    .catch({}),
  // Whether the model consumes the user's text (#1966). The backend refuses to
  // load a catalog where a model omits it, so this `.catch` only fires on a
  // corrupted or version-skewed wire — and there it degrades OPEN, same as
  // `sourcesByMode` above.
  //
  // `true` mounts the editor and makes `canExecuteGenerate` demand a non-empty
  // prompt, which at worst reproduces the pre-#1966 behaviour of a prompt the
  // model ignores — the user types something that goes nowhere.
  //
  // `false` is the expensive direction, and not for the reason it looks: the
  // execute gate reads `!promptRequired || promptText.trim()`, so a false here
  // does not block anything — it REMOVES the demand. The panel would hide the
  // editor and then happily submit a paid generation with an empty prompt from
  // a model that actually wanted one.
  takes_prompt: z.boolean().catch(true),
  // What the model charges per unit of input (#1960). Absent on models that
  // bill per call, and a malformed one degrades to absent — a panel with no
  // rate says nothing, where a half-parsed one would state a wrong price.
  rate: z
    .object({
      credits: z.number(),
      per: z.number(),
      unit: z.enum(["characters", "utf8_bytes"]),
    })
    .optional()
    .catch(undefined),
  // How much text the model takes (#1960). Absent reads as uncapped, and a
  // malformed one degrades to absent for the same reason a bad rate does: a
  // number this side invented would refuse text the vendor accepts.
  max_input_chars: z.number().optional().catch(undefined),
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
