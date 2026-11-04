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
/**
 * The versioned per-output media recipes admitted by the planned job lane, every one on full-ledger entries or a stored
 * carrier (§7.17: the worker's recipe construction is the one place that reads the ledger; the container reads no frame table).
 */
export const miniToolPlanRecipeSchema = z.discriminatedUnion("kind", [
  entryFrame,
  // §91 D4-4, D4-5: the split segment, the people anchor and the scanned scene window.
  z.strictObject({ kind: z.literal("segment"), ...windowRecipe, audio: audio.nullable() }),
  z.strictObject({ kind: z.literal("people"), inputId, entry, target: frameTarget, profile }),
  z.strictObject({ kind: z.literal("scene_cuts"), inputId, window: ordinals, timescale: z.number().int().positive(), profile, entries: placedEntries, target: analysisTarget })
    .refine((recipe) => recipe.entries[0]!.ordinalOffset === recipe.window.start && recipe.entries.every((value) => value.ordinalOffset < recipe.window.end)),
  // Presentation carrier jobs (§7.17, §5.4): the worker writes the window's entries and the target from the plan.
  z.strictObject({ kind: z.literal("copy_carrier"), inputId, colorMatrix: z.string().min(1) }),
  z.strictObject({ kind: z.literal("chunk_encode"), ...windowRecipe }),
  // Each chunk is a bound job input carrying its plan duration; the recipe's own input is the source the audio comes from.
  z.strictObject({ kind: z.literal("stitch"), inputId, chunks: z.array(z.strictObject({ inputId, duration: positiveTime })).min(1),
    audio: audio.nullable(), target }).refine((recipe) => recipe.chunks.every((chunk) => chunk.inputId !== recipe.inputId)),
  // A model's input over its presentation window (§5.3), written as an intermediate object.
  z.strictObject({ kind: z.literal("prepare_model_input"), ...windowRecipe, audio: audio.nullable() }),
]) satisfies z.ZodType<MiniToolPlanRecipe>;

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
    const named = output.recipe.kind === "stitch" ? [output.recipe.inputId, ...output.recipe.chunks.map((chunk) => chunk.inputId)] : [output.recipe.inputId];
    if (named.some((id) => !ids.has(id))) ctx.addIssue({ code: "custom", message: "Recipe references an unbound input" });
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
