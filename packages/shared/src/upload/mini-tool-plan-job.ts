// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import { miniToolPlanRecipeInputs, type MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
export { miniToolPlanRecipeInputs } from "@shared/upload/mini-tool-plan-types.js";

export type {
  MiniToolPlanRecipe, MiniToolPlanPixelRect, MiniToolPlanFrameCrop, MiniToolPlanFrameTarget, MiniToolPlanExact, MiniToolPlanTarget,
  MiniToolPlanAnalysisTarget, MiniToolPlanDetectorProfile, MiniToolPlanGrid, MiniToolPlanToolSource, MiniToolPlanFrames, MiniToolPlanChunkRef,
  MiniToolPlanColorInputs, MiniToolPlanEditEncode, MiniToolPlanEditStitch,
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
const chunkRef = z.strictObject({ inputId, frames });
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
/** The explicit colour inputs the probe read (§4.3 colour/HDR row), which an edit chunk decodes with. */
export const miniToolPlanColorInputsSchema = z.strictObject({
  matrix: z.string().min(1), transfer: z.string().min(1).nullable(), primaries: z.string().min(1).nullable(), range: z.enum(["tv", "pc"]), chromaLocation: z.string().min(1),
});
const colorInputs = miniToolPlanColorInputsSchema;
// §7.17 grid_count: decode every video frame to null; the request declares no output and the job report carries the count.
const gridCount = z.strictObject({ kind: z.literal("grid_count"), inputId, gridStart: rationalTimeSchema, fps: positiveRationalSchema, gridEnd: rationalTimeSchema.nullable() });
const recipeUnion = z.discriminatedUnion("kind", [
  gridFrame,
  // §7.17 segment row: grid frames [k0, k1) re-encoded from the tool source, the original's audio over them.
  z.strictObject({ kind: z.literal("segment"), ...windowRecipe, ...audioRef }).refine(framesOnGrid),
  z.strictObject({ kind: z.literal("scene_cuts"), inputId, grid, source: toolSource, frames, profile, target: analysisTarget }).refine(framesOnGrid),
  gridCount,
  // §7.17 edit_encode: one edit-file chunk at its tier, the plan's explicit colour inputs, tone mapped once for HDR.
  z.strictObject({
    kind: z.literal("edit_encode"), inputId, grid, source: toolSource, frames,
    edit: z.strictObject({ profile: editTier, crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), color: colorInputs, toneMap: z.enum(["none", "sdr-bt709"]),
  }).refine(framesOnGrid),
  // One encode chunk of an output over its grid frames.
  z.strictObject({ kind: z.literal("chunk_encode"), ...windowRecipe }).refine(framesOnGrid, "A chunk's frames lie on its grid"),
  // Each chunk is a bound job input with its grid frames. A single-source stitch names the original its audio comes from, the
  // grid and the target; an edit stitch names the grid and the tier only. One object holds both forms so the union keeps one
  // option per kind.
  z.strictObject({
    kind: z.literal("stitch"), chunks: z.array(chunkRef).min(1),
    inputId: inputId.optional(), grid: grid.optional(), audio: z.boolean().optional(), target: target.optional(),
    edit: z.strictObject({ profile: editTier }).optional(),
  }).superRefine((recipe, ctx) => {
    /**
     * Whether the recipe names a field.
     * @param key - The field.
     * @returns True when present.
     * @throws {never} Never.
     */
    const has = (key: string): boolean => Object.hasOwn(recipe, key);
    const single = ["inputId", "grid", "audio", "target"].every(has) && !has("edit");
    const edit = ["grid", "edit"].every(has) && !["inputId", "audio", "target"].some(has);
    if (!(single || edit)) ctx.addIssue({ code: "custom", message: "A stitch is single-source or an edit file, completely" });
    if (recipe.chunks.some((chunk) => chunk.inputId === recipe.inputId)) ctx.addIssue({ code: "custom", path: ["chunks"], message: "A chunk is never a source input" });
    if (recipe.chunks.some((chunk, at) => chunk.frames.start !== (at === 0 ? recipe.chunks[0]!.frames.start : recipe.chunks[at - 1]!.frames.end))) {
      ctx.addIssue({ code: "custom", path: ["chunks"], message: "Chunks follow one another on the grid" });
    }
  }),
]);
/**
 * The versioned per-output media recipes admitted by the planned job lane, every one on the frame grid and its tool source
 * (§7.17: the worker writes them from the frozen plan; the container reads no P).
 * Typed as the exact recipe union: the stitch object holds two forms, and its refinement admits only complete forms, so
 * every parsed value is one member of it.
 */
export const miniToolPlanRecipeSchema = recipeUnion as unknown as z.ZodType<MiniToolPlanRecipe> & { options: typeof recipeUnion.options };

/**
 * The request holding a complete chunk's input and output identities. A grid count (§7.17 grid_count) declares no output and
 * names its recipe as `count`; every other job declares at least one output and no count.
 */
export const miniToolPlanJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  jobId: z.string().min(1).max(200),
  containerClass: z.string().min(1).max(100),
  deadlineAt: z.number().int().positive(),
  limits: miniToolPlanLimitsSchema,
  inputs: z.array(z.strictObject({ inputId, storageKey })),
  outputs: z.array(z.strictObject({
    outputIndex: index,
    storageKey,
    contentType: z.string().min(1).max(100),
    coverKey: storageKey.optional(),
    recipe: miniToolPlanRecipeSchema,
  })).max(MINI_TOOL_JOB_MAX_OUTPUTS),
  count: gridCount.optional(),
}).superRefine((request, ctx) => {
  if ((request.count === undefined) === (request.outputs.length === 0)) ctx.addIssue({ code: "custom", message: "A job declares outputs, or is a grid count with none" });
  if (request.outputs.some((output) => output.recipe.kind === "grid_count")) ctx.addIssue({ code: "custom", message: "A grid count writes no output" });
  const ids = new Set<string>();
  for (const input of request.inputs) {
    if (ids.has(input.inputId)) ctx.addIssue({ code: "custom", message: "Duplicate input identity" });
    ids.add(input.inputId);
  }
  const keys = new Set(request.inputs.map((input) => input.storageKey));
  const indices = new Set<number>();
  if (request.count !== undefined && !ids.has(request.count.inputId)) ctx.addIssue({ code: "custom", message: "Recipe references an unbound input" });
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

/** What a done grid count measured (§4.1 frame count row): the last decoded frame's display time and the decoded frames. */
export const miniToolPlanGridCountSchema = z.strictObject({ lastVideoTime: rationalTimeSchema, sourceFrames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** The indexed report of a planned job's actual written objects; a done grid count carries its count instead. */
export const miniToolPlanJobReportSchema = z.discriminatedUnion("state", [
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("starting") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("running") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("done"), outputs: z.array(measuredOutput), usage, count: miniToolPlanGridCountSchema.optional() }),
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
 * @throws {Error} When the measured report conflicts with the declared capabilities, or a count is missing or undeclared.
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
  if (read.state === "done" && (read.count !== undefined) !== (parsed.count !== undefined)) throw new Error("Planned job report has a count exactly when the job is a grid count");
  return read;
}
