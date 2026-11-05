// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation carrier routes, carrier geometry, encode estimates, chunk boundaries, container job ids and user-run
 * batching (inner#1306; frames-split design §4.1, §4.3, §5.1 step 2, §5.3, §5.4, §7.1, §8.2).
 *
 * Kept free of zod: the media container and the backend both compute these, and the container bundles this module.
 */

import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/mini-tools/types.js";

/** How a presentation candidate gets its carrier (§7.1). */
export type VideoCarrierRoute = "reuse" | "identity" | "copy" | "dispatch_copy" | "encode";
/** One stage of a carrier route. */
export type VideoCarrierStage = "plan" | "copy" | "dispatch_copy" | "encode" | "stitch" | "publish";
/** The identity a carrier is reused by. */
export interface VideoCarrierIdentity { planSha256: string; producerVersion: number; profileVersion: number }
/** Everything the route is chosen from. */
export interface VideoCarrierRouteInput {
  plan: VideoCarrierIdentity;
  /** The selected presentation version, or null when none is selected. */
  selected: VideoCarrierIdentity | null;
  hdr: boolean;
  alpha: "confirmed_alpha" | "confirmed_opaque";
  /** Every other identity condition of §4.1 holds. */
  identityQualified: boolean;
  /** The bitstream carries an explicit colour matrix tag. */
  colorMatrixTagged: boolean;
  /** The ffprobe codec name. */
  codec: string;
  /** A stream copy keeps the plan's timeline. */
  copyPreservesTimeline: boolean;
  /** The selected audio (or its absence) is in the MP4 audio codecs of the frozen identity table. */
  audioCopyable: boolean;
  sourceBytes: number;
  copyDiskMarginBytes: number;
  basicDiskBytes: number;
}
/** A picture rectangle inside a padded carrier. */
export interface VideoCarrierRect { x: number; y: number; width: number; height: number }
/** The encoded carrier's size and, when padded, where the picture lies. */
export interface VideoCarrierGeometry { width: number; height: number; displayRect: VideoCarrierRect | null }
/** The plan's source transfer and bit depth. */
export interface VideoPlanSource { transfer: string | null; bitDepth: number }
/** The conversion the plan's source decides for every output. */
export interface VideoPlanOutput { toneMap: "none" | "sdr-bt709"; framePngBitDepth: 8 | 16 }
/** The plan fields that decide whether the origin mapping is unaltered. */
export interface VideoPlanAlterations {
  originMapping: {
    entries: readonly { kind: "source" | "derived-empty" }[];
    firstSource: { lead: unknown };
    lastSource: { support: "declared" | "previous-max" | "single-frame"; hold: unknown };
  };
  videoSpans: readonly unknown[] | null;
}
/** The work of one encode job. */
export interface VideoJobWork {
  encodedFrames: number;
  prerollFrames: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  bitDepth: 8 | 10 | 12;
  hdr: boolean;
}
/** The encoder's configured rates. */
export interface VideoEncoderRates {
  startSeconds: number;
  encodePixelsPerSecond: number;
  decodeConvertPixelsPerSecond: { sdr_8bit: number; sdr_10bit: number; sdr_12bit: number; hdr_8bit: number; hdr_10bit: number; hdr_12bit: number };
}
/** A half-open range of presentation frame indices. */
export interface VideoEncodeChunk { start: number; end: number }
/** One container job's identity (§5.4). */
export type VideoContainerJobSpec =
  | { kind: "presentation-probe"; jobId: string }
  | { kind: "presentation-chunk"; jobId: string; chunk: number; attempt: number }
  | { kind: "presentation-stitch"; jobId: string; attempt: number }
  | { kind: "presentation-copy"; jobId: string; attempt: number }
  | { kind: "run-batch"; taskId: string; batch: number; attempt: number }
  | { kind: "run-chunk"; taskId: string; output: number; chunk: number; attempt: number }
  | { kind: "run-stitch"; taskId: string; output: number; attempt: number }
  | { kind: "prep"; taskId: string; input: number; attempt: number }
  | { kind: "prep-chunk"; taskId: string; input: number; chunk: number; attempt: number }
  | { kind: "prep-stitch"; taskId: string; input: number; attempt: number };

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const TAG_FILTERS: Readonly<Record<string, string>> = { h264: "h264_metadata", hevc: "hevc_metadata", vp9: "vp9_metadata", av1: "av1_metadata" };
const ROUTE_STAGES: Readonly<Record<VideoCarrierRoute, readonly VideoCarrierStage[]>> = {
  reuse: ["plan", "publish"],
  identity: ["plan", "publish"],
  copy: ["plan", "copy", "publish"],
  dispatch_copy: ["plan", "dispatch_copy", "publish"],
  encode: ["plan", "encode", "stitch", "publish"],
};

/**
 * Whether a transfer characteristic is HDR (PQ or HLG).
 * @param transfer - The ffprobe `color_transfer`, if any.
 * @returns True for `smpte2084` and `arib-std-b67`.
 * @throws {never} Never.
 */
export function isHdrTransfer(transfer: string | null | undefined): boolean {
  return transfer !== null && transfer !== undefined && HDR_TRANSFERS.has(transfer);
}

/**
 * The output conversion a plan's source decides (§3.2): HDR is tone mapped to 8-bit SDR, deeper SDR keeps 16-bit frame PNGs.
 * @param source - The source transfer and bit depth.
 * @returns The tone map and frame PNG bit depth.
 * @throws {never} Never.
 */
export function videoPlanOutput(source: VideoPlanSource): VideoPlanOutput {
  if (isHdrTransfer(source.transfer)) return { toneMap: "sdr-bt709", framePngBitDepth: 8 };
  return { toneMap: "none", framePngBitDepth: source.bitDepth > 8 ? 16 : 8 };
}

/**
 * The bitstream filter a stream copy writes the colour matrix tag with.
 * @param codec - The ffprobe codec name.
 * @returns The `*_metadata` filter, or null when the codec has none.
 * @throws {never} Never.
 */
export function videoCarrierTagFilter(codec: string): string | null {
  return Object.hasOwn(TAG_FILTERS, codec) ? TAG_FILTERS[codec]! : null;
}

/**
 * Choose the carrier route (§7.1, §5.1 step 2): reuse an identical selected version; HDR and confirmed alpha encode;
 * a qualified, matrix-tagged source plays as identity; a timeline-preserving copy that can carry the matrix tag runs
 * in basic when twice the source plus the margin fits its disk and its audio may be packet-copied, and is dispatched
 * otherwise (the dispatched copy encodes audio outside the table to AAC); everything else encodes.
 * @param input - The plan, the selected version and the source facts.
 * @returns The route.
 * @throws {never} Never.
 */
export function chooseVideoCarrierRoute(input: VideoCarrierRouteInput): VideoCarrierRoute {
  const { plan, selected } = input;
  if (selected !== null && selected.planSha256 === plan.planSha256 && selected.producerVersion === plan.producerVersion && selected.profileVersion === plan.profileVersion) return "reuse";
  if (input.hdr || input.alpha === "confirmed_alpha") return "encode";
  if (input.identityQualified && input.colorMatrixTagged) return "identity";
  if (input.copyPreservesTimeline && (input.colorMatrixTagged || videoCarrierTagFilter(input.codec) !== null)) {
    const fits = 2 * input.sourceBytes + input.copyDiskMarginBytes <= input.basicDiskBytes;
    return fits && input.audioCopyable ? "copy" : "dispatch_copy";
  }
  return "encode";
}

/**
 * The fixed stage sequence of a route (§7.1).
 * @param route - The route.
 * @returns Its stages in order.
 * @throws {never} Never.
 */
export function videoCarrierRouteStages(route: VideoCarrierRoute): VideoCarrierStage[] {
  return [...ROUTE_STAGES[route]];
}

/**
 * Check a positive safe integer.
 * @param value - The value.
 * @param name - What it is, for the message.
 * @throws {RangeError} When it is not a positive safe integer.
 */
function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Check a non-negative safe integer.
 * @param value - The value.
 * @param name - What it is, for the message.
 * @throws {RangeError} When it is not a non-negative safe integer.
 */
function indexInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * Check a positive finite number.
 * @param value - The value.
 * @param name - What it is, for the message.
 * @throws {RangeError} When it is not positive and finite.
 */
function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
}

/**
 * Scale the long side as FFmpeg `scale=-2` does: `av_rescale` to half the size, nearest with halves away from zero, times two.
 * @param long - The long side.
 * @param short - The short side.
 * @param cap - The new short side.
 * @returns The new long side.
 * @throws {never} Never.
 */
function scaledLongSide(long: number, short: number, cap: number): number {
  return Math.floor((2 * cap * long + 2 * short) / (4 * short)) * 2;
}

/**
 * The encoded carrier's geometry (§8.2, §4.3): a short side over the cap scales to the cap with the long side rounded as
 * FFmpeg `scale=-2`; otherwise odd sides pad to even and the picture rectangle is recorded.
 * @param display - The display size.
 * @param display.width - Display width in pixels.
 * @param display.height - Display height in pixels.
 * @param maxShortSide - The configured short-side cap.
 * @returns The carrier size and padded picture rectangle.
 * @throws {RangeError} When a side or the cap is not a positive integer.
 */
export function videoCarrierGeometry(display: { width: number; height: number }, maxShortSide: number): VideoCarrierGeometry {
  const { width, height } = display;
  positiveInteger(width, "Display width");
  positiveInteger(height, "Display height");
  positiveInteger(maxShortSide, "The carrier short-side cap");
  if (Math.min(width, height) > maxShortSide) {
    return width >= height
      ? { width: scaledLongSide(width, height, maxShortSide), height: maxShortSide, displayRect: null }
      : { width: maxShortSide, height: scaledLongSide(height, width, maxShortSide), displayRect: null };
  }
  const padded = width % 2 === 1 || height % 2 === 1;
  return { width: width + (width % 2), height: height + (height % 2), displayRect: padded ? { x: 0, y: 0, width, height } : null };
}

/**
 * Whether a plan presents the original unaltered (§5.3): no derived frame, lead or hold, declared last support and no edit
 * (the assembler already records a whole-media rate-1 edit as none).
 * @param plan - The plan.
 * @returns Whether the origin mapping is unaltered.
 * @throws {never} Never.
 */
export function videoPlanIsUnaltered(plan: VideoPlanAlterations): boolean {
  const { entries, firstSource, lastSource } = plan.originMapping;
  return plan.videoSpans === null && firstSource.lead === null && lastSource.hold === null && lastSource.support === "declared" &&
    entries.every((entry) => entry.kind === "source");
}

/**
 * Estimate a job's seconds (§5.4): start seconds + (encoded + pre-roll frames) × (source pixels ÷ the decode-convert rate
 * for the source's bit depth and range + output pixels ÷ the encode rate); downloads are not estimated.
 * @param work - The job's frames and geometry.
 * @param rates - The encoder's configured rates.
 * @returns The estimated seconds.
 * @throws {RangeError} When a count, size or rate is out of range or the bit depth is not 8, 10 or 12.
 */
export function estimateVideoJobSeconds(work: VideoJobWork, rates: VideoEncoderRates): number {
  positiveInteger(work.encodedFrames, "Encoded frames");
  indexInteger(work.prerollFrames, "Pre-roll frames");
  for (const [name, value] of [["Source width", work.sourceWidth], ["Source height", work.sourceHeight], ["Output width", work.outputWidth], ["Output height", work.outputHeight]] as const) positiveInteger(value, name);
  if (work.bitDepth !== 8 && work.bitDepth !== 10 && work.bitDepth !== 12) throw new RangeError("The source bit depth must be 8, 10 or 12");
  if (!Number.isFinite(rates.startSeconds) || rates.startSeconds < 0) throw new RangeError("Start seconds must be non-negative");
  positiveFinite(rates.encodePixelsPerSecond, "The encode rate");
  const decodeRate = rates.decodeConvertPixelsPerSecond[`${work.hdr ? "hdr" : "sdr"}_${work.bitDepth}bit`];
  positiveFinite(decodeRate, "The decode-convert rate");
  const perFrame = (work.sourceWidth * work.sourceHeight) / decodeRate + (work.outputWidth * work.outputHeight) / rates.encodePixelsPerSecond;
  return rates.startSeconds + (work.encodedFrames + work.prerollFrames) * perFrame;
}

/**
 * Split presentation frames into encode chunks (§5.4): from each chunk start, the boundary is the later keyframe or the
 * end nearest to start + target work, the earlier of two equally near; the first chunk starts at 0.
 * @param input - Keyframe flag per presentation frame, the work per frame and the target work per chunk, in seconds.
 * @param input.keyframes - Whether each presentation frame is a source keyframe.
 * @param input.frameSeconds - Estimated seconds per frame.
 * @param input.targetSeconds - Target seconds per chunk.
 * @returns Half-open chunks that tile every frame.
 * @throws {RangeError} When there are no frames or the work or target is not positive.
 */
export function planVideoEncodeChunks(input: { keyframes: readonly boolean[]; frameSeconds: number; targetSeconds: number }): VideoEncodeChunk[] {
  const { keyframes, frameSeconds, targetSeconds } = input;
  if (keyframes.length === 0) throw new RangeError("Expected at least one frame");
  positiveFinite(frameSeconds, "Per-frame work");
  positiveFinite(targetSeconds, "The chunk target");
  const end = keyframes.length;
  const candidates: number[] = [];
  keyframes.forEach((keyframe, index) => { if (keyframe && index > 0) candidates.push(index); });
  candidates.push(end);
  const chunks: VideoEncodeChunk[] = [];
  let start = 0;
  let next = 0;
  while (start < end) {
    while (candidates[next]! <= start) next += 1;
    /**
     * How far a boundary's chunk work is from the target.
     * @param boundary - A candidate end frame.
     * @returns The absolute difference in seconds.
     * @throws {never} Never.
     */
    const distance = (boundary: number): number => Math.abs((boundary - start) * frameSeconds - targetSeconds);
    let pick = next;
    // Distances fall until the target and rise after it, so stop at the first candidate no nearer than the one before.
    while (pick + 1 < candidates.length && distance(candidates[pick + 1]!) < distance(candidates[pick]!)) pick += 1;
    chunks.push({ start, end: candidates[pick]! });
    start = candidates[pick]!;
  }
  return chunks;
}

/**
 * The presentation failure for a chunk count (§5.4): more chunks than the parallel cap is `too_long`.
 * @param chunkCount - The planned chunks.
 * @param maxParallelChunks - The configured cap.
 * @returns `too_long` over the cap, otherwise null.
 * @throws {never} Never.
 */
export function presentationEncodeFailure(chunkCount: number, maxParallelChunks: number): "too_long" | null {
  return chunkCount > maxParallelChunks ? "too_long" : null;
}

/**
 * A container job id in the §5.4 format; indices count from 0 and attempts from 1.
 * @param spec - The job's kind and identity.
 * @returns The job id.
 * @throws {RangeError} When an id is empty, an index is not a non-negative integer or an attempt not a positive integer.
 */
export function videoContainerJobId(spec: VideoContainerJobSpec): string {
  const owner = "jobId" in spec ? spec.jobId : spec.taskId;
  if (owner.length === 0) throw new RangeError("A job or task id must not be empty");
  if ("attempt" in spec) positiveInteger(spec.attempt, "An attempt");
  for (const key of ["chunk", "batch", "output", "input"]) if (key in spec) indexInteger(Reflect.get(spec, key) as number, `The ${key} index`);
  const a = "attempt" in spec ? `a${spec.attempt}` : "";
  switch (spec.kind) {
    case "presentation-probe": return `video-presentation:${owner}`;
    case "presentation-chunk": return `video-presentation:${owner}:chunk:${spec.chunk}:${a}`;
    case "presentation-stitch": return `video-presentation:${owner}:stitch:${a}`;
    case "presentation-copy": return `video-presentation:${owner}:copy:${a}`;
    case "run-batch": return `${owner}:batch:${spec.batch}:${a}`;
    case "run-chunk": return `${owner}:out:${spec.output}:enc:${spec.chunk}:${a}`;
    case "run-stitch": return `${owner}:out:${spec.output}:stitch:${a}`;
    case "prep": return `${owner}:prep:${spec.input}:${a}`;
    case "prep-chunk": return `${owner}:prep:${spec.input}:enc:${spec.chunk}:${a}`;
    case "prep-stitch": return `${owner}:prep:${spec.input}:stitch:${a}`;
  }
}

/**
 * Batch a user run's outputs (§5.4) in stable order: each batch holds at most `maxOutputsPerJob` outputs and its fixed
 * seconds plus their work stay within the share; an output that alone exceeds the share is set aside for chunk encoding.
 * @param works - Each output's estimated seconds, in output order.
 * @param limits - The per-job output cap, the chunk share and the fixed seconds per job.
 * @param limits.maxOutputsPerJob - At most this many outputs per batch, within the job contract.
 * @param limits.shareSeconds - The seconds one job may take.
 * @param limits.fixedSeconds - Seconds every job costs before its outputs.
 * @returns The batches of output indices and the oversized outputs.
 * @throws {RangeError} When the per-job cap is not an integer from 1 to the job contract's maximum or a time is invalid.
 */
export function batchVideoRunOutputs(
  works: readonly number[],
  limits: { maxOutputsPerJob: number; shareSeconds: number; fixedSeconds: number },
): { batches: number[][]; oversized: number[] } {
  const { maxOutputsPerJob, shareSeconds, fixedSeconds } = limits;
  positiveInteger(maxOutputsPerJob, "Outputs per job");
  if (maxOutputsPerJob > MINI_TOOL_JOB_MAX_OUTPUTS) throw new RangeError(`Outputs per job must not exceed ${MINI_TOOL_JOB_MAX_OUTPUTS}`);
  positiveFinite(shareSeconds, "The chunk share");
  if (!Number.isFinite(fixedSeconds) || fixedSeconds < 0) throw new RangeError("Fixed seconds must be non-negative");
  const batches: number[][] = [];
  const oversized: number[] = [];
  let used = 0;
  works.forEach((work, index) => {
    if (!Number.isFinite(work) || work < 0) throw new RangeError("Output work must be non-negative");
    if (fixedSeconds + work > shareSeconds) { oversized.push(index); return; }
    const current = batches.at(-1);
    if (current !== undefined && current.length < maxOutputsPerJob && used + work <= shareSeconds) {
      current.push(index);
      used += work;
    } else {
      batches.push([index]);
      used = fixedSeconds + work;
    }
  });
  return { batches, oversized };
}
