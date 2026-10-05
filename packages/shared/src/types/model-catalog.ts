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
  | 'three_d';

/** Model tier for frontend display filtering. */
export type ModelTier = 'recommended' | 'optional' | 'internal';

/**
 * A catalog this param's value comes from, fetched at runtime rather than
 * declared in yaml. `voices` is served by `GET /models/:name/voices`, which
 * answers in the value domain of whichever provider this deployment resolved
 * to — so the value the picker writes is the one the vendor accepts.
 */
export type RemoteParamSource = "voices";

/** An endpoint's WaveSpeed pricing contract, as the catalog yaml writes it. */
export interface PricingContract {
  /** Price basis in millionths of a US dollar. */
  readonly base_price: number;
  /** JSONata formula WaveSpeed publishes; empty means `base_price` per call. */
  readonly formula: string;
  /** Percent of the formula's price actually charged. */
  readonly discount_rate: number;
}

/** An upstream call a run of this model makes besides the model's own. */
export interface ExtraStep {
  readonly endpoint: string;
  /** Whether the call runs before or after the model's own endpoint. */
  readonly at: "before" | "after";
  readonly pricing: PricingContract;
  /** The param whose value makes the run take this step; absent means every run does. */
  readonly for_param?: string;
  /** One call per item of `for_param`. */
  readonly per_item?: boolean;
  /** Skipped when the same source was sent through it before. */
  readonly reused?: boolean;
}

/** Params of which at least one has to carry material in one mode. */
export interface SourceGroup {
  readonly mode: string;
  readonly any_of: readonly string[];
}

/** One field of an entry in a list editor. */
export interface ItemField {
  readonly type?: "text";
  readonly values?: readonly (string | number | boolean)[];
  readonly default?: unknown;
  /** The most characters a text field takes, counted on the cleaned text. */
  readonly max_chars?: number;
}

/**
 * How a parameter's value reaches the run (#269). `storyboard` is filled from
 * the node's shots in the multi-shot mode (`storyboard.ts`).
 */
export type ParamFill = "canvas" | "pool" | "editor" | "panel" | "remote" | "storyboard" | "none";

/** What has to hold before a declared control counts for anything (#269). */
export interface ParamGate {
  /** That switch has to be on; the value is dropped while it is off. */
  flag_on?: string;
}

export interface ParamDescriptor {
  description: string;
  /**
   * How this parameter gets filled (#269).
   *
   * The catalog refuses to load without it, so a deployed frontend only ever
   * sees it missing while it is a version behind the catalog it is talking
   * to. Read as `none` then: a panel that draws nothing is a panel showing
   * less than it could, and one that guesses is a panel showing a control
   * whose value goes nowhere.
   */
  fill?: ParamFill;
  /** Which kind of node this parameter carries, when it carries one. */
  accepts?: "image" | "video" | "audio";
  /**
   * How a chip picked from this pool is written into the prompt (#2156,
   * design §13.2): `{n}` is its place in the sent list of this kind counted
   * from 1, `{i}` counted from 0. Absent, the chip adds nothing to the text.
   */
  mention?: string;
  /**
   * The key each entry of this list travels under upstream, when the upstream
   * takes objects rather than bare URLs (Krea's `reference: [{ image }]`).
   */
  item_key?: string;
  /**
   * The pool this slot's files are appended to on their way upstream, for a
   * model with no field of its own for them (inner#826).
   */
  joins?: string;
  /** The sentence appended to the prompt for a joining slot; `{list}` names its files. */
  prompt_note?: string;
  /** Whether a run can go out with this slot empty. */
  optional?: boolean;
  /** What has to hold before this control counts. */
  when?: ParamGate;
  /** The modes this parameter applies to; absent means all of the model's. */
  modes?: readonly string[];
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  /**
   * The increment a continuous control moves this value by (#1960).
   *
   * Bounds alone do not say how finely a value may be set — ElevenLabs states
   * 0 to 1 in steps of 0.05, Fish states -20 to 20 dB in steps of 1 — and that
   * is the model's statement about its own parameter, not a decision for
   * whichever control happens to render it. Only params meant to be set
   * continuously carry one; a param stating `values` is a list of choices and
   * has nothing to step through.
   */
  step?: number;
  /**
   * The shape of the value when it is not a single scalar: `list` carries
   * several sources (the reference pool), `items` is a list editor whose
   * entries carry `fields`, `text` is a free text control. Readers compare
   * against these exact strings, and the loader refuses any other value.
   */
  type?: "list" | "items" | "text";
  max_items?: number;
  /** The fewest entries a run takes; the panel keeps rows up to it. */
  min_items?: number;
  /** Another param this one stands in for: when this one is sent, that one is not. */
  replaces?: string;
  /** The fields of one entry of an `items` list. */
  fields?: Readonly<Record<string, ItemField>>;
  /** The upstream field this param is sent as, when the names differ. */
  upstream?: string;
  /**
   * What a value is sent as upstream, keyed by the value's string form, when
   * the panel's value is not the endpoint's (Kling's switch sends
   * `shot_type: "intelligence"`). A value not listed goes as it is.
   */
  upstream_values?: Readonly<Record<string, string>>;
  /**
   * For an `items` list the endpoint has no field for: each entry is written
   * into the prompt with this template instead (`{n}` its place from 1,
   * `{start}`/`{end}` its running seconds, `{prompt}` its text), one per line.
   */
  into_prompt?: string;
  /** Marks a control only this model has; its name on screen comes from the locales. */
  label?: string;
  /** How a value of `values` reads on screen, when its spelling is not that; English. */
  value_labels?: Readonly<Record<string, string>>;
  /** The BCP-47 tag each value of `values` is, by position, so the panel names it in the reader's language. */
  value_locales?: readonly string[];
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

/** One provider backing a model (with resolved availability). */
export interface ModelProvider {
  name: string;
  model_id: string;
  priority: number;
  available: boolean;
}

/** A kind of node a source slot takes. */
export type SourceType = "image" | "video" | "audio";

/** One camera command a model reads out of its prompt. */
export interface CameraCommandEntry {
  /** The command as it is written inside the brackets. */
  name: string;
  /** Where the clip showing this command plays from. */
  preview_url: string;
}

/** Single model definition — one entry in the catalog response. */
export interface ModelEntry {
  name: string;
  /** The vendor's name for the model; `modelLabel` builds what a list shows. */
  display_name: string;
  /** What tells this model apart from another one sharing its name in some mode. */
  variant?: string;
  modality: ModelModality;
  mode: string | string[];
  description: string;
  guide: string;
  tier: ModelTier;
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
   * The WaveSpeed pricing contract of the model's endpoint, which the panel,
   * the proposal card, the agent and the balance gate all estimate a run by.
   * Absent only on a version-skewed or corrupted wire: the panel then states
   * no price.
   */
  pricing?: PricingContract;
  /** The upstream field the prompt is sent as, when it is not `prompt`. */
  prompt_upstream?: string;
  /** Upstream calls a run makes besides the model's own. */
  extra_steps?: readonly ExtraStep[];
  /** The param whose source, once sent, lets later runs skip the model's own call. */
  reused_by?: string;
  /** Per mode, params of which at least one has to carry material. */
  source_groups?: readonly SourceGroup[];
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
   * The bracketed camera commands this model reads out of its prompt
   * (inner#1241), each with the clip that previews it. Absent on a model that
   * reads none.
   */
  camera_commands?: readonly CameraCommandEntry[];
  /**
   * Brand icon name for the Generate picker (mapped to an inline SVG on the
   * frontend, e.g. `nano-banana` / `openai` / `seedream`). Optional only so
   * a malformed entry still parses: the picker draws nothing for a missing or
   * unmapped name, and every model a picker offers declares one.
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
  total: number;
  /** Credits per US cent charged upstream; the estimate converts by it. */
  credit_multiplier: number;
}

// ── Image model classification ───────────────────────────────────────
//
// Which image `mode`s make a model GENERATABLE — i.e. it produces or edits an
// image from a prompt (optionally using an upstream reference as the source
// image), as opposed to a pure utility tool (`remove_bg` / `upscale`) that
// belongs in the mini-tool system.
//
// Two consumers: the agent's image-plan skill
// (`domain/agent/skills-loader.ts`), and `GENERATION_NODE_MODES` below, out
// of which the agent's capability tools answer which modes an image node
// can be set to.
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
 * model gaining a mode gains it in `config/models/modes.yaml` too, where what
 * that mode needs is declared: the catalog refuses to load a model naming a
 * mode with no row there.
 *
 * Which modes belong here is the user's decision (2026-08-08), not a formula:
 * these seven go in the Generate panel and `extend` / `edit` / `motion` /
 * `upscale` / `interpolate` go to the mini-tool system. Four of those five do
 * work on a video that already exists, which is the shape of the decision —
 * but `motion` does not: `kling-v3-pro-motion` takes a character image, and it
 * is out because the user put it out. Do not re-derive the list from a rule;
 * the list IS the rule.
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
  "multi_shot",
  "talking_head",
] as const;

/**
 * Audio model `mode` values the audio Generate panel offers (#261).
 *
 * The third of these lists, and it reads the same way: a product decision
 * written down, not a rule to re-derive. `separate` has models and is not
 * here, the same way `upscale` is absent from the image list.
 *
 * Here rather than only in the panel's own option table because the backend
 * needs the codes too -- the agent is told which modes a node can be set to,
 * and an answer assembled from a second copy is an answer that can disagree
 * with the picker. The panel's table keeps what belongs to the panel: each
 * entry's label, the slots its toolbar collects, and whether it asks for
 * lyrics. That table's own test reads its values off this list, so a mode
 * added to one and not the other turns red in the file the picker's author
 * is already editing.
 */
export const AUDIO_GENERATION_MODES = [
  'tts',
  'voice_clone',
  'sfx',
  't2m',
  'a2m',
] as const;

/** A node type that anchors a Generate panel. */
export type GenerationNodeType = 'image' | 'video' | 'audio';

/**
 * The catalog buckets each generation node draws its models from.
 *
 * Two of the three collide with the node's own name; audio does not. Text to
 * speech and voice cloning are catalogued under `tts`, sound effects and music
 * under `audio`, and one node offers all of them -- so `catalog[nodeType]`
 * compiles for audio and silently reads half the models the node can use.
 */
export const GENERATION_NODE_BUCKETS: Readonly<
  Record<GenerationNodeType, ReadonlyArray<ModelModality>>
> = {
  image: ['image'],
  video: ['video'],
  audio: ['tts', 'audio'],
};

/** The modes each generation node's picker offers, keyed by node type. */
export const GENERATION_NODE_MODES: Readonly<
  Record<GenerationNodeType, ReadonlyArray<string>>
> = {
  image: IMAGE_GENERATION_MODES,
  video: VIDEO_GENERATION_MODES,
  audio: AUDIO_GENERATION_MODES,
};

/**
 * Whether a node type anchors a Generate panel.
 * @param type - A node type.
 * @returns True for image, video and audio.
 */
export function isGenerationNodeType(type: string): type is GenerationNodeType {
  return Object.hasOwn(GENERATION_NODE_MODES, type);
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
const itemFieldSchema = z.object({
  type: z.literal("text").optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  default: z.unknown().optional(),
  max_chars: z.number().optional(),
});

const pricingContractSchema = z.object({
  base_price: z.number(),
  formula: z.string(),
  discount_rate: z.number(),
});

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
    type: z.enum(["list", "items", "text"]).optional().catch(undefined),
    max_items: z.number().optional().catch(undefined),
    min_items: z.number().optional().catch(undefined),
    replaces: z.string().optional().catch(undefined),
    fields: z.record(z.string(), itemFieldSchema).optional().catch(undefined),
    upstream: z.string().optional().catch(undefined),
    upstream_values: z.record(z.string(), z.string()).optional().catch(undefined),
    into_prompt: z.string().optional().catch(undefined),
    label: z.string().optional().catch(undefined),
    value_labels: z.record(z.string(), z.string()).optional().catch(undefined),
    value_locales: z.array(z.string()).optional().catch(undefined),
    // An unrecognised name would send the panel looking for a picker that does
    // not exist, so it degrades to an ordinary param rather than to a guess.
    remote_source: z.enum(["voices"]).optional().catch(undefined),
    // An unrecognised fill degrades to "no control" rather than to a guess:
    // the panel then draws nothing for it, which is less than it could do
    // rather than a control whose value reaches nobody.
    fill: z
      .enum(["canvas", "pool", "editor", "panel", "remote", "storyboard", "none"])
      .optional()
      .catch(undefined),
    accepts: z.enum(["image", "video", "audio"]).optional().catch(undefined),
    mention: z.string().optional().catch(undefined),
    item_key: z.string().optional().catch(undefined),
    joins: z.string().optional().catch(undefined),
    prompt_note: z.string().optional().catch(undefined),
    optional: z.boolean().optional().catch(undefined),
    when: z
      .object({
        flag_on: z.string().optional(),
      })
      .optional()
      .catch(undefined),
    modes: z.array(z.string()).optional().catch(undefined),
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
  variant: z.string().optional().catch(undefined),
  modality: z
    .enum(["image", "video", "audio", "tts", "three_d"])
    .catch("image"),
  mode: z.union([z.string(), z.array(z.string())]).catch("generate"),
  description: z.string().catch(""),
  guide: z.string().catch(""),
  tier: z.enum(["recommended", "optional", "internal"]).catch("optional"),
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
  // Whether the model consumes the user's text (#1966). The backend refuses to
  // load a catalog where a model omits it, so this `.catch` only fires on a
  // corrupted or version-skewed wire — and there it degrades OPEN.
  //
  // `true` mounts the editor and makes `canExecuteGenerate` demand a non-empty
  // prompt, which at worst reproduces the pre-#1966 behaviour of a prompt the
  // model ignores — the user types something that goes nowhere.
  //
  // `false` is the expensive direction, and not for the reason it looks: the
  // execute gate reads `!promptRequired || extractPromptText(promptText)`, so
  // a false here does not block anything — it REMOVES the demand. The panel would hide the
  // editor and then happily submit a paid generation with an empty prompt from
  // a model that actually wanted one.
  takes_prompt: z.boolean().catch(true),
  // A malformed contract degrades to absent: the panel then states no price,
  // where a half-parsed one would state a wrong one.
  pricing: pricingContractSchema.optional().catch(undefined),
  prompt_upstream: z.string().optional().catch(undefined),
  extra_steps: z
    .array(
      z.object({
        endpoint: z.string(),
        at: z.enum(["before", "after"]),
        pricing: pricingContractSchema,
        for_param: z.string().optional(),
        per_item: z.boolean().optional(),
        reused: z.boolean().optional(),
      }),
    )
    .optional()
    .catch(undefined),
  reused_by: z.string().optional().catch(undefined),
  source_groups: z
    .array(z.object({ mode: z.string(), any_of: z.array(z.string()) }))
    .optional()
    .catch(undefined),
  // How much text the model takes (#1960). Absent reads as uncapped, and a
  // malformed one degrades to absent for the same reason a bad rate does: a
  // number this side invented would refuse text the vendor accepts.
  max_input_chars: z.number().optional().catch(undefined),
  // A malformed list degrades to absent: the panel then offers no picker,
  // where a half-parsed one would offer commands with no clip.
  camera_commands: z
    .array(z.object({ name: z.string(), preview_url: z.string() }))
    .optional()
    .catch(undefined),
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
  total: 0,
  credit_multiplier: 1,
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
    total: z.number().catch(0),
    credit_multiplier: z.number().positive().catch(1),
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
