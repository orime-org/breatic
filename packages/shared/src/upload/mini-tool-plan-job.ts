// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolAnalysisInputSchema } from "@shared/mini-tools/analysis-input.js";
import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { CONTAINER_FAILURES } from "@shared/mini-tools/types.js";
import { ingestMeasurements } from "@shared/upload/ingest-client.js";
import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/upload/mini-tool-job.js";
import { x264PresetSchema } from "@shared/upload/video-presentation-policy.js";
import { packedGeometrySchema } from "@shared/upload/video-presentation.js";
import { compare, exactTime } from "@shared/upload/video-source-ledger.js";
import type { MiniToolPlanEntry, MiniToolPlanExact, MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";

export type {
  MiniToolPlanRecipe, MiniToolPlanPixelRect, MiniToolPlanFrameCrop, MiniToolPlanFrameTarget, MiniToolPlanEntry, MiniToolPlanExact, MiniToolPlanInterval, MiniToolPlanTarget, MiniToolPlanAudio, MiniToolPlanEditSpan, MiniToolPlanPlacedEntry, MiniToolPlanAnalysisTarget, MiniToolPlanDetectorProfile,
} from "@shared/upload/mini-tool-plan-types.js";

const inputId = z.uuid();
const storageKey = z.string().min(1).max(500);
const index = z.number().int().nonnegative();
const profile = miniToolAnalysisInputSchema.options[0].shape.profile;
const pixelRect = z.strictObject({ x: index, y: index, width: z.number().int().positive(), height: z.number().int().positive() });
const frameCrop = z.strictObject({ sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(), rect: pixelRect })
  .refine((crop) => crop.rect.x + crop.rect.width <= crop.sourceWidth && crop.rect.y + crop.rect.height <= crop.sourceHeight);
const ordinals = z.strictObject({ start: index, end: index }).refine((value) => value.end > value.start);
const ZERO = { numerator: "0", denominator: "1" };
const time = exactTime.refine((value) => compare(value, ZERO) >= 0n, "Expected a non-negative time");
const positiveTime = exactTime.refine((value) => compare(value, ZERO) > 0n, "Expected a positive time");
const interval = z.strictObject({ start: time, end: time }).refine((value) => compare(value.end, value.start) > 0n);
const editSpan = z.strictObject({ sourceStart: time, sourceEnd: time, presentationStart: exactTime, rate: positiveTime })
  .refine((span) => compare(span.sourceEnd, span.sourceStart) > 0n);
// §91 D3b-11: the interval in presentation time with the plan's origin and audio spans (null when the track has no edit).
const audio = z.strictObject({ start: time, end: time, origin: time, spans: z.array(editSpan).min(1).nullable() }).refine((value) => compare(value.end, value.start) > 0n);
const sourceShape = { kind: z.literal("source"), decodeStart: time, clipStart: time, displayStart: time, displayEnd: time, rate: positiveTime };
const emptyShape = { kind: z.literal("empty"), fill: z.enum(["black", "transparent"]), window: interval };

/**
 * Whether a source span decodes no later than it is shown from and covers a positive interval.
 * @param span - A structurally valid span.
 * @param span.decodeStart - Its decode start.
 * @param span.clipStart - Its clip start.
 * @param span.displayStart - Its presentation start.
 * @param span.displayEnd - Its presentation end.
 * @returns Whether it is well formed.
 * @throws {never} Never.
 */
function spanValid(span: { decodeStart: MiniToolPlanExact; clipStart: MiniToolPlanExact; displayStart: MiniToolPlanExact; displayEnd: MiniToolPlanExact }): boolean {
  return compare(span.decodeStart, span.clipStart) <= 0n && compare(span.displayEnd, span.displayStart) > 0n;
}

const entry = z.discriminatedUnion("kind", [z.strictObject(sourceShape).refine(spanValid), z.strictObject(emptyShape)]);
// §91 D4-5: a scene-cut entry names the presentation ordinal of its first frame.
const placedEntry = z.discriminatedUnion("kind", [
  z.strictObject({ ...sourceShape, ordinalOffset: index }).refine(spanValid), z.strictObject({ ...emptyShape, ordinalOffset: index }),
]);

/**
 * The presentation interval an entry covers.
 * @param value - A validated entry.
 * @returns Its start and end.
 * @throws {never} Never.
 */
function entryInterval(value: MiniToolPlanEntry): { start: { numerator: string; denominator: string }; end: { numerator: string; denominator: string } } {
  return value.kind === "source" ? { start: value.displayStart, end: value.displayEnd } : value.window;
}

/**
 * Whether entries run in presentation order end to end with no two derived-empty frames side by side (§7.17).
 * @param list - Structurally valid entries.
 * @returns Whether they are contiguous.
 * @throws {never} Never.
 */
function contiguous(list: readonly MiniToolPlanEntry[]): boolean {
  return list.every((value, at) => at === 0 ||
    (compare(entryInterval(list[at - 1]!).end, entryInterval(value).start) === 0n && !(value.kind === "empty" && list[at - 1]!.kind === "empty")));
}

const entries = z.array(entry).min(1).refine(contiguous);
const placedEntries = z.array(placedEntry).min(1).refine(contiguous)
  .refine((list) => list.every((value, at) => at === 0 || value.ordinalOffset > list[at - 1]!.ordinalOffset), "Ordinal offsets increase");
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
const windowRecipe = { inputId, window: ordinals, timescale: z.number().int().positive(), entries, target };
// The transition output profile (§97 D15-5): alpha with VP9 and yuva420p, none with H.264 and yuv420p, even H.264 sides, timeBase 1/fps.
const transitionProfile = z.strictObject({
  width: side, height: side, fps: positiveTime, timeBase: positiveTime, pixFmt: z.enum(["yuv420p", "yuva420p"]),
  color: z.strictObject({ matrix: z.literal("bt709"), range: z.literal("tv"), primaries: z.literal("bt709"), transfer: z.literal("bt709") }),
  codec: z.enum(["h264", "vp9"]), encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), alpha: z.boolean(),
}).refine((value) => value.alpha === (value.codec === "vp9") && value.alpha === (value.pixFmt === "yuva420p"), "Alpha goes with VP9 and yuva420p")
  .refine((value) => value.codec === "vp9" || (value.width % 2 === 0 && value.height % 2 === 0), "An H.264 output has even sides")
  .refine((value) => BigInt(value.fps.numerator) * BigInt(value.timeBase.numerator) === BigInt(value.fps.denominator) * BigInt(value.timeBase.denominator), "The time base is 1/fps");
const chunkRef = z.strictObject({ inputId, duration: positiveTime });
const windowRef = z.strictObject({ startFrame: index, frameCount: z.number().int().positive() });

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
// §91 D4-3: one full-ledger entry and its PNG target; a crop names the target's display geometry.
const entryFrame = z.strictObject({ kind: z.literal("frame"), inputId, entry, target: frameTarget, crop: frameCrop.optional() })
  .refine((recipe) => recipe.crop === undefined || (recipe.crop.sourceWidth === recipe.target.width && recipe.crop.sourceHeight === recipe.target.height));
const analysisTarget = z.strictObject({ width: side, height: side, colorMatrix: z.string().min(1), toneMap: z.enum(["none", "sdr-bt709"]) });
const recipeUnion = z.discriminatedUnion("kind", [
  entryFrame,
  // §91 D4-4, D4-5: the split segment, the people anchor and the scanned scene window.
  z.strictObject({ kind: z.literal("segment"), ...windowRecipe, audio: audio.nullable() }),
  z.strictObject({ kind: z.literal("people"), inputId, entry, target: frameTarget, profile }),
  z.strictObject({ kind: z.literal("scene_cuts"), inputId, window: ordinals, timescale: z.number().int().positive(), profile, entries: placedEntries, target: analysisTarget })
    .refine((recipe) => recipe.entries[0]!.ordinalOffset === recipe.window.start && recipe.entries.every((value) => value.ordinalOffset < recipe.window.end)),
  // Presentation carrier jobs (§7.17, §5.4): the worker writes the window's entries and the target from the plan.
  z.strictObject({ kind: z.literal("copy_carrier"), inputId, colorMatrix: z.string().min(1),
    audio: z.union([z.strictObject({ kind: z.literal("copy") }), z.strictObject({ kind: z.literal("encode"), start: time, end: time, origin: time, spans: z.array(editSpan).min(1).nullable() })
      .refine((value) => compare(value.end, value.start) > 0n)]).nullable() }),
  z.strictObject({ kind: z.literal("chunk_encode"), ...windowRecipe, profile: transitionProfile.optional() }),
  // Each chunk is a bound job input carrying its plan duration. A single-source stitch names the source its audio comes from
  // and the target; a transition stitch names both clips with their audio, the crossfade window and the profile (§97 D15-7).
  // One object holds both forms so the union keeps one option per kind; the refinement admits exactly one of them.
  z.strictObject({
    kind: z.literal("stitch"), chunks: z.array(chunkRef).min(1),
    inputId: inputId.optional(), audio: audio.nullable().optional(), target: target.optional(),
    clips: z.tuple([z.strictObject({ inputId, audio: audio.nullable() }), z.strictObject({ inputId, audio: audio.nullable() })]).optional(),
    crossfade: windowRef.nullable().optional(), profile: transitionProfile.optional(),
  }).superRefine((recipe, ctx) => {
    const single = recipe.inputId !== undefined && Object.hasOwn(recipe, "audio") && recipe.target !== undefined;
    const transition = recipe.clips !== undefined && Object.hasOwn(recipe, "crossfade") && recipe.profile !== undefined;
    const singleKeys = recipe.inputId !== undefined || Object.hasOwn(recipe, "audio") || recipe.target !== undefined;
    const transitionKeys = recipe.clips !== undefined || Object.hasOwn(recipe, "crossfade") || recipe.profile !== undefined;
    if (!((single && !transitionKeys) || (transition && !singleKeys))) ctx.addIssue({ code: "custom", message: "A stitch is single-source or a transition, completely" });
    const sources = [recipe.inputId, ...(recipe.clips ?? []).map((clip) => clip.inputId)];
    if (recipe.chunks.some((chunk) => sources.includes(chunk.inputId))) ctx.addIssue({ code: "custom", path: ["chunks"], message: "A chunk is never a source input" });
  }),
  // A model's input over its presentation window (§5.3), written as an intermediate object.
  z.strictObject({ kind: z.literal("prepare_model_input"), ...windowRecipe, audio: audio.nullable() }),
  // One chunk of a transition's overlap window (§97 D15-6): both clips' entries, the chunk's frames inside the window.
  z.strictObject({
    kind: z.literal("transition_window"),
    clips: z.tuple([z.strictObject({ inputId, entries }), z.strictObject({ inputId, entries })]),
    frames: ordinals, window: windowRef, transition: z.enum(["fade", "wipeLeft", "wipeRight"]), profile: transitionProfile,
  }).refine((recipe) => recipe.frames.start >= recipe.window.startFrame && recipe.frames.end <= recipe.window.startFrame + recipe.window.frameCount,
    "The chunk's frames lie inside the window"),
  // The erase or expand composite over a presentation window (§97 D15-8, execution design §8.1); one object holds both modes.
  z.strictObject({
    kind: z.literal("model_composite"), mode: z.enum(["erase", "expand"]), ...windowRecipe,
    result: inputId.optional(), range: interval.optional(),
    backgrounds: z.array(z.strictObject({ inputId, window: interval })).optional(),
    ledger: z.array(z.strictObject({ overlap: time, consumed: interval })).optional(),
  }).superRefine((recipe, ctx) => {
    if (recipe.mode === "erase") {
      if (recipe.result === undefined || recipe.range === undefined || recipe.backgrounds !== undefined || recipe.ledger !== undefined) {
        ctx.addIssue({ code: "custom", message: "An erase composite names its result and range only" });
      }
      return;
    }
    const { backgrounds, ledger } = recipe;
    if (backgrounds === undefined || ledger === undefined || recipe.result !== undefined || recipe.range !== undefined || backgrounds.length === 0 || ledger.length !== backgrounds.length) {
      ctx.addIssue({ code: "custom", message: "An expand composite names one ledger row per background window" });
      return;
    }
    backgrounds.forEach((background, at) => {
      const row = ledger[at]!;
      const previous = backgrounds[at - 1];
      const overlap = previous === undefined ? ZERO : { numerator: String(BigInt(previous.window.end.numerator) * BigInt(background.window.start.denominator) - BigInt(background.window.start.numerator) * BigInt(previous.window.end.denominator)),
        denominator: String(BigInt(previous.window.end.denominator) * BigInt(background.window.start.denominator)) };
      if (previous !== undefined && compare(background.window.start, previous.window.start) <= 0n) ctx.addIssue({ code: "custom", path: ["backgrounds", at], message: "Windows run in order" });
      if (compare(row.overlap, overlap) !== 0n) ctx.addIssue({ code: "custom", path: ["ledger", at, "overlap"], message: "The overlap is the previous window's tail" });
      if (compare(row.consumed.start, background.window.start) < 0n || compare(row.consumed.end, background.window.end) > 0n) {
        ctx.addIssue({ code: "custom", path: ["ledger", at, "consumed"], message: "The consumed interval lies in its window" });
      }
      if (at > 0 && compare(row.consumed.start, ledger[at - 1]!.consumed.end) !== 0n) ctx.addIssue({ code: "custom", path: ["ledger", at, "consumed"], message: "Consumed intervals run end to end" });
    });
  }),
]);
/**
 * The versioned per-output media recipes admitted by the planned job lane, every one on full-ledger entries or a stored
 * carrier (§7.17: the worker's recipe construction is the one place that reads the ledger; the container reads no frame table).
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
  inputs: z.array(z.strictObject({ inputId, storageKey })).min(1),
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

/**
 * Every job input a recipe reads: its source, a stitch's chunks and clips, a window's clips, a composite's results.
 * @param recipe - A validated recipe.
 * @returns The input ids it names.
 * @throws {never} Never.
 */
export function miniToolPlanRecipeInputs(recipe: MiniToolPlanRecipe): string[] {
  switch (recipe.kind) {
    case "stitch": return [...("clips" in recipe ? recipe.clips.map((clip) => clip.inputId) : [recipe.inputId]), ...recipe.chunks.map((chunk) => chunk.inputId)];
    case "transition_window": return recipe.clips.map((clip) => clip.inputId);
    case "model_composite": return [recipe.inputId, ...(recipe.mode === "erase" ? [recipe.result] : recipe.backgrounds.map((background) => background.inputId))];
    default: return [recipe.inputId];
  }
}

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
