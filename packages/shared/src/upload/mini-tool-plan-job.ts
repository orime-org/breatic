// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolAnalysisInputSchema } from "@shared/mini-tools/analysis-input.js";
import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { CONTAINER_FAILURES } from "@shared/mini-tools/types.js";
import { EDIT_FILE_TIERS } from "@shared/mini-tools/video-encode-plan.js";
import { ingestMeasurements } from "@shared/upload/ingest-client.js";
import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/upload/mini-tool-job.js";
import { x264PresetSchema } from "@shared/upload/video-presentation-policy.js";
import { packedGeometrySchema } from "@shared/upload/video-presentation.js";
import { positiveRationalSchema, rationalTimeSchema, sourceKeyframeStatsSchema } from "@shared/upload/video-presentation-version.js";
import { VIDEO_TOOL_SYNC_MODES } from "@shared/mini-tools/lipsync-timeline.js";
import { miniToolPlanRecipeInputs, type MiniToolPlanExact, type MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
export { miniToolPlanRecipeInputs } from "@shared/upload/mini-tool-plan-types.js";

export type {
  MiniToolPlanRecipe, MiniToolPlanPixelRect, MiniToolPlanFrameCrop, MiniToolPlanFrameTarget, MiniToolPlanExact, MiniToolPlanInterval, MiniToolPlanTarget,
  MiniToolPlanAnalysisTarget, MiniToolPlanDetectorProfile, MiniToolPlanGrid, MiniToolPlanToolSource, MiniToolPlanFrames, MiniToolPlanChunkRef,
  MiniToolPlanClipPlacement, MiniToolPlanColorInputs, MiniToolPlanEditEncode, MiniToolPlanEditStitch, MiniToolPlanStitchClip,
} from "@shared/upload/mini-tool-plan-types.js";

const inputId = z.uuid();
const storageKey = z.string().min(1).max(500);
const index = z.number().int().nonnegative();
const count = z.number().int().positive();
const profile = miniToolAnalysisInputSchema.options[0].shape.profile;
const pixelRect = z.strictObject({ x: index, y: index, width: z.number().int().positive(), height: z.number().int().positive() });
const frameCrop = z.strictObject({ sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(), rect: pixelRect })
  .refine((crop) => crop.rect.x + crop.rect.width <= crop.sourceWidth && crop.rect.y + crop.rect.height <= crop.sourceHeight);
const frames = z.strictObject({ start: index, end: index }).refine((value) => value.end > value.start);

/**
 * Sign of a − b for exact rationals with positive denominators.
 * @param a - One time.
 * @param b - The other.
 * @returns The signed cross-product difference.
 * @throws {never} Never.
 */
function compare(a: MiniToolPlanExact, b: MiniToolPlanExact): number {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}

const time = rationalTimeSchema.refine((value) => value.numerator >= 0, "Expected a non-negative time");
const positiveTime = positiveRationalSchema;
const interval = z.strictObject({ start: time, end: time }).refine((value) => compare(value.end, value.start) > 0);
// The grid a recipe reads (§4.1, §7.17): rate, grid start in source seconds, slots and the real video slots V.
const grid = z.strictObject({ fps: positiveRationalSchema, gridStart: rationalTimeSchema, frameCount: count, realFrameCount: count })
  .refine((value) => value.realFrameCount <= value.frameCount, "V is at most frameCount");
// The tool source (§7.16): the original with its keyframe statistics, or the all-intra edit file.
const toolSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("original"), keyframes: sourceKeyframeStatsSchema }),
  z.strictObject({ kind: z.literal("edit") }),
]);
const side = z.number().int().positive();
// An H.264 carrier or split output has even sides; a transparent VP9 split output keeps the display size (§4.3 odd-size row).
const target = z.strictObject({
  width: side, height: side, displayRect: pixelRect.nullable(), colorMatrix: z.string().min(1),
  toneMap: z.enum(["none", "sdr-bt709"]), alpha: z.enum(["none", "packed", "straight"]), crf: z.number().int().min(0).max(51), preset: x264PresetSchema,
  format: z.enum(["mp4-h264", "webm-vp9"]).optional(),
}).refine((value) => value.displayRect === null || (value.displayRect.x + value.displayRect.width <= value.width && value.displayRect.y + value.displayRect.height <= value.height))
  .refine((value) => value.format === "webm-vp9" || (value.width % 2 === 0 && value.height % 2 === 0), "An H.264 target has even sides")
  .refine((value) => value.alpha !== "straight" || value.format === "webm-vp9", "Straight alpha is a VP9 output's")
  .refine((value) => value.alpha !== "packed" || value.format === undefined, "A packed carrier is no split output");
/**
 * Whether a recipe's frames lie inside its grid.
 * @param recipe - A structurally valid recipe with a grid and frames.
 * @param recipe.grid - Its grid.
 * @param recipe.grid.frameCount - The grid's slots.
 * @param recipe.frames - Its frames.
 * @param recipe.frames.end - The frame its window stops before.
 * @returns True inside.
 * @throws {never} Never.
 */
function framesOnGrid(recipe: { grid: { frameCount: number }; frames: { end: number } }): boolean {
  return recipe.frames.end <= recipe.grid.frameCount;
}
const windowRecipe = { inputId, grid, source: toolSource, frames, target };
const stillRecipe = { inputId, grid, source: toolSource, frameIndex: index };
// Audio of a single-source output: the original's audio over the frames (`audioInputId` names it beside an edit file).
const audioRef = { audio: z.boolean(), audioInputId: inputId.optional() };
// The transition output profile (§97 D15-5): alpha with VP9 and yuva420p, none with H.264 and yuv420p, even H.264 sides, timeBase 1/fps.
const transitionProfile = z.strictObject({
  width: side, height: side, fps: positiveTime, timeBase: positiveTime, pixFmt: z.enum(["yuv420p", "yuva420p"]),
  color: z.strictObject({ matrix: z.literal("bt709"), range: z.literal("tv"), primaries: z.literal("bt709"), transfer: z.literal("bt709") }),
  codec: z.enum(["h264", "vp9"]), encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), alpha: z.boolean(),
}).refine((value) => value.alpha === (value.codec === "vp9") && value.alpha === (value.pixFmt === "yuva420p"), "Alpha goes with VP9 and yuva420p")
  .refine((value) => value.codec === "vp9" || (value.width % 2 === 0 && value.height % 2 === 0), "An H.264 output has even sides")
  .refine((value) => value.fps.numerator * value.timeBase.numerator === value.fps.denominator * value.timeBase.denominator, "The time base is 1/fps");
const placement = z.strictObject({ startFrame: index, inFrame: index });
const chunkRef = z.strictObject({ inputId, frames });
// The lip-sync stitch's audio: every person's stem summed (§97 D22-3).
const stemMix = z.strictObject({ kind: z.literal("mix"), inputs: z.array(inputId).min(1) });
// The frozen lip-sync timeline (§97 D12-4); every lip-sync step maps through the prepared video's grid.
const positiveSeconds = z.number().finite().positive();
const lipsyncTimeline = z.strictObject({ duration: positiveSeconds, videoDuration: positiveSeconds, syncMode: z.enum(VIDEO_TOOL_SYNC_MODES) });
const cropSize = z.number().int().positive();
const windowRef = z.strictObject({ startFrame: index, frameCount: count });
// `fit`: where the clip sits on the output frame, the rectangle its encode chunks use too (`transitionFitRect`, §7.17).
const windowClip = z.strictObject({ inputId, grid, source: toolSource, placement, colorMatrix: z.string().min(1), toneMap: z.enum(["none", "sdr-bt709"]), fit: pixelRect });
// The erase model's grid and an expand window's grid (execution design §10.4, §10.5).
const modelGrid = z.strictObject({ mode: z.enum(["frames", "resample"]), rate: z.number().finite().positive(), frameCount: count });
const windowGrid = z.strictObject({ fps: z.number().int().positive(), frameCount: count });
const frameSize = z.strictObject({ width: side, height: side });
const editTier = z.enum(EDIT_FILE_TIERS);

/** Output and diagnostic byte ceilings frozen from the task's runtime configuration. */
export const miniToolPlanLimitsSchema = z.strictObject({
  probeStdoutBytes: z.number().int().positive(),
  analysisStdoutBytes: z.number().int().positive(),
  stderrTailBytes: z.number().int().positive(),
});

const frameTarget = z.strictObject({
  width: z.number().int().positive(), height: z.number().int().positive(), colorMatrix: z.string().min(1), toneMap: z.enum(["none", "sdr-bt709"]),
  pngBitDepth: z.union([z.literal(8), z.literal(16)]), alpha: z.enum(["none", "straight"]),
});
// §7.17 frame row: one grid frame of the tool source and its PNG target; a crop names the target's display geometry (§5.5).
const gridFrame = z.strictObject({ kind: z.literal("frame"), ...stillRecipe, target: frameTarget, crop: frameCrop.optional() })
  .refine((recipe) => recipe.frameIndex < recipe.grid.frameCount, "The frame lies on the grid")
  .refine((recipe) => recipe.crop === undefined || (recipe.crop.sourceWidth === recipe.target.width && recipe.crop.sourceHeight === recipe.target.height));
const analysisTarget = z.strictObject({ width: side, height: side, colorMatrix: z.string().min(1), toneMap: z.enum(["none", "sdr-bt709"]) });
const colorInputs = z.strictObject({
  matrix: z.string().min(1), transfer: z.string().min(1).nullable(), primaries: z.string().min(1).nullable(), range: z.enum(["tv", "pc"]), chromaLocation: z.string().min(1),
});
const recipeUnion = z.discriminatedUnion("kind", [
  gridFrame,
  // §7.17 segment row: grid frames [k0, k1) re-encoded from the tool source, the original's audio over them.
  z.strictObject({ kind: z.literal("segment"), ...windowRecipe, ...audioRef }).refine(framesOnGrid),
  z.strictObject({ kind: z.literal("people"), ...stillRecipe, target: frameTarget, profile }).refine((recipe) => recipe.frameIndex < recipe.grid.frameCount),
  z.strictObject({ kind: z.literal("scene_cuts"), inputId, grid, source: toolSource, frames, profile, target: analysisTarget }).refine(framesOnGrid),
  // §7.17 grid_count: decode every video frame to null; no object is written.
  z.strictObject({ kind: z.literal("grid_count"), inputId, gridStart: rationalTimeSchema, fps: positiveRationalSchema, gridEnd: rationalTimeSchema.nullable() }),
  // §7.17 edit_encode: one edit-file chunk at its tier, the plan's explicit colour inputs, tone mapped once for HDR.
  z.strictObject({
    kind: z.literal("edit_encode"), inputId, grid, source: toolSource, frames,
    edit: z.strictObject({ profile: editTier, crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), color: colorInputs, toneMap: z.enum(["none", "sdr-bt709"]),
  }).refine(framesOnGrid),
  // A transition chunk names its profile and where its clip sits on the output grid, both or neither; its frames are output frames.
  z.strictObject({ kind: z.literal("chunk_encode"), ...windowRecipe, profile: transitionProfile.optional(), placement: placement.optional() })
    .refine((recipe) => (recipe.profile === undefined) === (recipe.placement === undefined))
    .refine((recipe) => recipe.profile !== undefined || framesOnGrid(recipe), "A chunk's frames lie on its grid"),
  // Each chunk is a bound job input with its grid frames. A single-source stitch names the original its audio comes from, the
  // grid and the target; an edit stitch names the grid and the tier only; a transition stitch names both clips, the
  // crossfade window and the profile (§97 D15-7). One object holds the forms so the union keeps one option per kind.
  z.strictObject({
    kind: z.literal("stitch"), chunks: z.array(chunkRef).min(1),
    inputId: inputId.optional(), grid: grid.optional(), audio: z.union([z.boolean(), stemMix]).optional(), target: target.optional(),
    edit: z.strictObject({ profile: editTier }).optional(),
    clips: z.tuple([
      z.strictObject({ inputId, grid, placement, frameCount: count, audio: z.boolean() }),
      z.strictObject({ inputId, grid, placement, frameCount: count, audio: z.boolean() }),
    ]).optional(),
    crossfade: windowRef.nullable().optional(), profile: transitionProfile.optional(),
  }).superRefine((recipe, ctx) => {
    /**
     * Whether the recipe names a field.
     * @param key - The field.
     * @returns True when present.
     * @throws {never} Never.
     */
    const has = (key: string): boolean => Object.hasOwn(recipe, key);
    const single = ["inputId", "grid", "audio", "target"].every(has) && !["edit", "clips", "crossfade", "profile"].some(has);
    const edit = ["grid", "edit"].every(has) && !["inputId", "audio", "target", "clips", "crossfade", "profile"].some(has);
    const transition = ["clips", "crossfade", "profile"].every(has) && !["inputId", "grid", "audio", "target", "edit"].some(has);
    if (!(single || edit || transition)) ctx.addIssue({ code: "custom", message: "A stitch is single-source, an edit file or a transition, completely" });
    const sources = [recipe.inputId, ...(recipe.clips ?? []).map((clip) => clip.inputId), ...(typeof recipe.audio === "object" ? recipe.audio.inputs : [])];
    if (recipe.chunks.some((chunk) => sources.includes(chunk.inputId))) ctx.addIssue({ code: "custom", path: ["chunks"], message: "A chunk is never a source input" });
    if (recipe.chunks.some((chunk, at) => chunk.frames.start !== (at === 0 ? recipe.chunks[0]!.frames.start : recipe.chunks[at - 1]!.frames.end))) {
      ctx.addIssue({ code: "custom", path: ["chunks"], message: "Chunks follow one another on the grid" });
    }
  }),
  // A model's input over its grid frames (§5.3), written as an intermediate object.
  z.strictObject({ kind: z.literal("prepare_model_input"), ...windowRecipe, ...audioRef, order: z.enum(["forward", "reverse"]).optional(), model: modelGrid.optional() }).refine(framesOnGrid),
  // The tracking join, the erase mask and the expand window steps (execution design §10.2, §10.4, §10.5).
  z.strictObject({ kind: z.literal("rle_join"), inputs: z.array(z.strictObject({ inputId, order: z.enum(["forward", "reverse"]), frameCount: count })).min(1).max(2), width: side, height: side }),
  z.strictObject({ kind: z.literal("bria_mask"), inputId, fps: positiveRationalSchema, range: windowRef, model: modelGrid, target: frameSize }),
  z.strictObject({ kind: z.literal("model_window"), ...windowRecipe, model: windowGrid, frame: frameSize, sourceRoi: pixelRect, fill: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]), span: interval }),
  z.strictObject({ kind: z.literal("model_window_mask"), model: windowGrid, frame: frameSize, sourceRoi: pixelRect, span: interval }),
  z.strictObject({ kind: z.literal("frame_at"), ...stillRecipe, target: frameSize }).refine((recipe) => recipe.frameIndex < recipe.grid.frameCount),
  // One chunk of a transition's overlap window (§97 D15-6): both clips on their grids, the chunk's output frames inside the window.
  z.strictObject({
    kind: z.literal("transition_window"),
    // Each clip is converted with its own plan's matrix and tone mapping before the blend (§97 D23-4).
    clips: z.tuple([windowClip, windowClip]),
    frames, window: windowRef, transition: z.enum(["fade", "wipeLeft", "wipeRight"]), profile: transitionProfile,
  }).refine((recipe) => recipe.frames.start >= recipe.window.startFrame && recipe.frames.end <= recipe.window.startFrame + recipe.window.frameCount,
    "The chunk's frames lie inside the window"),
  // The erase or expand composite over grid frames (§97 D15-8, execution design §8.1); one object holds both modes.
  z.strictObject({
    kind: z.literal("model_composite"), mode: z.enum(["erase", "expand"]), ...windowRecipe,
    result: inputId.optional(), rle: inputId.optional(), range: windowRef.optional(), model: modelGrid.optional(),
    matte: z.strictObject({ dilate: z.number().int().nonnegative(), feather: z.number().int().nonnegative() }).optional(), rleSize: frameSize.optional(),
    backgrounds: z.array(z.strictObject({ inputId, window: interval, crop: pixelRect.optional() })).optional(),
  }).superRefine((recipe, ctx) => {
    const eraseValues = [recipe.result, recipe.rle, recipe.range, recipe.model, recipe.matte, recipe.rleSize];
    if (recipe.mode === "erase") {
      if (eraseValues.some((value) => value === undefined) || recipe.backgrounds !== undefined) {
        ctx.addIssue({ code: "custom", message: "An erase composite names its result, mask, range, model grid and matte only" });
      }
      return;
    }
    const { backgrounds } = recipe;
    if (backgrounds === undefined || eraseValues.some((value) => value !== undefined) || backgrounds.length === 0) {
      ctx.addIssue({ code: "custom", message: "An expand composite names its background windows only" });
      return;
    }
    backgrounds.forEach((background, at) => {
      const previous = backgrounds[at - 1];
      if (previous !== undefined && compare(background.window.start, previous.window.start) <= 0) ctx.addIssue({ code: "custom", path: ["backgrounds", at], message: "Windows run in order" });
    });
  }),
  // The lip-sync steps (§7.17 lipsync rows, §97 D20-1): every object is a bound input named by its inputId.
  z.strictObject({ kind: z.literal("lipsync_faces"), inputId, track: inputId, profile }),
  // The clip is encoded at the plan's frozen container encode, as the composite's target is.
  z.strictObject({ kind: z.literal("lipsync_clip"), inputId, faces: inputId, track: inputId, cropSize, timeline: lipsyncTimeline, grid,
    encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }) }),
  z.strictObject({ kind: z.literal("lipsync_stem"), rows: z.array(z.strictObject({ inputId, startTime: time })).min(1), duration: positiveTime }),
  z.strictObject({
    kind: z.literal("lipsync_composite"), ...windowRecipe, timeline: lipsyncTimeline,
    persons: z.array(z.strictObject({ result: inputId, faces: inputId, track: inputId, cropSize })).min(1),
    // The prepared video's geometry (§5.3 model-input row): every track and face table is in its pixels, and its picture
    // rectangle is what the output's picture shows.
    prepared: z.strictObject({ width: side, height: side, displayRect: pixelRect.nullable() })
      .refine((value) => value.displayRect === null || (value.displayRect.x + value.displayRect.width <= value.width && value.displayRect.y + value.displayRect.height <= value.height)),
    // The plan's frozen raw disk budget: a chunk whose source goes back decodes its source window to a raw file within it
    // (execution design paragraph before §9.4).
    rawDiskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    // The plan's frozen face feather: each face's edge is feathered over this fraction of its shorter side (DD §7.2 step 6).
    feather: z.number().min(0).max(1),
  }),
]);
/**
 * The versioned per-output media recipes admitted by the planned job lane, every one on the frame grid and its tool source
 * (§7.17: the worker writes them from the frozen plan; the container reads no P).
 * Typed as the exact recipe union: the stitch and composite objects hold several forms, and their refinements admit only
 * complete forms, so every parsed value is one member of it.
 */
export const miniToolPlanRecipeSchema = recipeUnion as unknown as z.ZodType<MiniToolPlanRecipe> & { options: typeof recipeUnion.options };

/** The request holding a complete chunk's input and output identities. */
export const miniToolPlanJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  jobId: z.string().min(1).max(200),
  containerClass: z.string().min(1).max(100),
  deadlineAt: z.number().int().positive(),
  limits: miniToolPlanLimitsSchema,
  // A generated mask (model_window_mask) reads no input, so a job may bind none.
  inputs: z.array(z.strictObject({ inputId, storageKey })),
  outputs: z.array(z.strictObject({
    outputIndex: index,
    storageKey,
    contentType: z.string().min(1).max(100),
    coverKey: storageKey.optional(),
    recipe: miniToolPlanRecipeSchema,
  })).min(1).max(MINI_TOOL_JOB_MAX_OUTPUTS),
}).superRefine((request, ctx) => {
  const ids = new Set<string>();
  for (const input of request.inputs) {
    if (ids.has(input.inputId)) ctx.addIssue({ code: "custom", message: "Duplicate input identity" });
    ids.add(input.inputId);
  }
  const keys = new Set(request.inputs.map((input) => input.storageKey));
  const indices = new Set<number>();
  for (const output of request.outputs) {
    if (miniToolPlanRecipeInputs(output.recipe).some((id) => !ids.has(id))) ctx.addIssue({ code: "custom", message: "Recipe references an unbound input" });
    if (indices.has(output.outputIndex)) ctx.addIssue({ code: "custom", message: "Duplicate output index" });
    indices.add(output.outputIndex);
    for (const key of [output.storageKey, ...(output.coverKey === undefined ? [] : [output.coverKey])]) {
      if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Output key collides with another capability" });
      keys.add(key);
    }
  }
});

export type MiniToolPlanJobRequest = z.infer<typeof miniToolPlanJobRequestSchema>;


const usage = z.strictObject({ wallMs: z.number().nonnegative(), cpuUsec: z.number().nonnegative().nullable() });
const measuredOutput = ingestMeasurements.extend({
  outputIndex: index,
  storageKey,
  // An alpha-packed output's planes as the container reported them (§91 D3-3).
  packing: packedGeometrySchema.optional(),
  cover: z.strictObject({
    storageKey,
    sha256: ingestMeasurements.shape.sha256,
    sizeBytes: z.number().int().positive(),
    contentType: z.string().min(1).max(100),
    width: ingestMeasurements.shape.width,
    height: ingestMeasurements.shape.height,
  }).nullish().transform((value) => value ?? null),
});

/** The indexed report of a planned job's actual written objects. */
export const miniToolPlanJobReportSchema = z.discriminatedUnion("state", [
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("starting") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("running") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("done"), outputs: z.array(measuredOutput), usage }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("failed"), outputs: z.array(measuredOutput), reason: z.enum(CONTAINER_FAILURES), usage: usage.nullable() }),
]);

export type MiniToolPlanJobReport = z.infer<typeof miniToolPlanJobReportSchema>;

/** A job's exact read and write capabilities. */
export interface MiniToolPlanAccess {
  reads: string[];
  writes: Record<string, string>;
}

/**
 * Resolve the frozen inputs and outputs into the container's capabilities.
 * @param request - The planned job request.
 * @returns The exact registered read and output write keys.
 * @throws {z.ZodError} When the frozen request is invalid.
 */
export function miniToolPlanAccess(request: unknown): MiniToolPlanAccess {
  const parsed = miniToolPlanJobRequestSchema.parse(request);
  const writes: Record<string, string> = {};
  for (const output of parsed.outputs) {
    writes[output.storageKey] = output.contentType;
    if (output.coverKey !== undefined) writes[output.coverKey] = "image/png";
  }
  return { reads: [...new Set(parsed.inputs.map((input) => input.storageKey))], writes };
}

/**
 * Compare a repeated submission with the job's original frozen request.
 * @param accepted - The originally accepted request.
 * @param incoming - The repeated submission.
 * @returns Whether both complete parsed requests have the same frozen identity.
 * @throws {z.ZodError} When either request is invalid.
 */
export function sameMiniToolPlanJob(accepted: unknown, incoming: unknown): boolean {
  return canonicalMiniToolValue(miniToolPlanJobRequestSchema.parse(accepted)) === canonicalMiniToolValue(miniToolPlanJobRequestSchema.parse(incoming));
}

/**
 * Validate an indexed report against the job's original output identities.
 * @param request - The frozen job request.
 * @param report - The actual report received from the ingest Worker.
 * @returns The measured report bound to its declared output identities.
 * @throws {z.ZodError} When the request or report cannot be read.
 * @throws {Error} When the measured report conflicts with the declared capabilities.
 */
export function readMiniToolPlanJobReport(request: unknown, report: unknown): MiniToolPlanJobReport {
  const parsed = miniToolPlanJobRequestSchema.parse(request);
  const read = miniToolPlanJobReportSchema.parse(report);
  if (read.state === "starting" || read.state === "running") return read;
  const expected = new Map(parsed.outputs.map((output) => [output.outputIndex, output]));
  const observed = new Set<number>();
  for (const output of read.outputs) {
    const declared = expected.get(output.outputIndex);
    if (!declared || observed.has(output.outputIndex) || declared.storageKey !== output.storageKey || declared.contentType !== output.contentType) {
      throw new Error("Planned job report has an undeclared or duplicated output identity");
    }
    if (output.cover !== null && (output.cover.storageKey !== declared.coverKey || output.cover.contentType !== "image/png")) {
      throw new Error("Planned job report has an undeclared cover");
    }
    if (output.upright !== null) throw new Error("Planned job report has an undeclared upright copy");
    observed.add(output.outputIndex);
  }
  if (read.state === "done" && observed.size !== expected.size) throw new Error("Planned job report is missing declared outputs");
  return read;
}
