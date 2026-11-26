// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Presentation carrier routes, carrier geometry, encode estimates, chunk boundaries, container job ids and user-run
 * batching on the frame grid (inner#1306; frames-split design §4.1–§4.3, §5.4, §7.1, §7.1.1, §7.17, §8.2).
 *
 * Kept free of zod: the media container and the backend both compute these, and the container bundles this module.
 */

import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/mini-tools/types.js";
import type { SourceDecodeKey } from "@shared/upload/frame-grid-rate.js";

/** How a presentation candidate gets its carrier (§7.1 route table). */
export type VideoCarrierRoute = "encode" | "edit" | "reuse_edit" | "reuse";
/** One stage of a carrier route. */
export type VideoCarrierStage = "plan" | "count" | "edit" | "edit_stitch" | "encode" | "stitch" | "publish";
/**
 * The identity a carrier or an edit file is reused by (§7.1): the plan digest, the producer and playback profile versions
 * (sha256 hex digests), and the edit profile version, null without an edit file.
 */
export interface VideoCarrierIdentity { planSha256: string; producerVersion: string; profileVersion: string; editProfileVersion: string | null }
/** What the route is chosen from: the new job's identity and the latest published version V, ready or invalid(V). */
export interface VideoCarrierRouteInput {
  plan: VideoCarrierIdentity;
  reuseFrom: { identity: VideoCarrierIdentity; ready: boolean } | null;
}
/** The five edit-file tiers (§4.2): each has its own decode and encode rate (§5.4 estimate row). */
export const EDIT_FILE_TIERS = [
  "edit_h264_intra_8bit_420", "edit_h264_intra_10bit_420", "edit_h264_intra_8bit_444", "edit_h264_intra_10bit_444", "edit_prores",
] as const;
/** One edit-file tier. */
export type EditFileTier = (typeof EDIT_FILE_TIERS)[number];
/** A decode-rate key: the original's source key, or the edit file's tier. */
export type VideoDecodeKey = SourceDecodeKey | EditFileTier;
/** What a job encodes to: the playback carrier, an edit-file tier, or nothing (the decode-only count). */
export type VideoEncodeKey = "playback" | EditFileTier | null;
/** A picture rectangle inside a padded carrier. */
export interface VideoCarrierRect { x: number; y: number; width: number; height: number }
/** The encoded carrier's size and, when padded, where the picture lies. */
export interface VideoCarrierGeometry { width: number; height: number; displayRect: VideoCarrierRect | null }
/** The plan's source transfer and bit depth. */
export interface VideoPlanSource { transfer: string | null; bitDepth: number }
/** The conversion the plan's source decides for every output. */
export interface VideoPlanOutput { toneMap: "none" | "sdr-bt709"; framePngBitDepth: 8 | 16 }
/** The work of one container job (§5.4 estimate row). */
export interface VideoJobWork {
  encodedFrames: number;
  prerollFrames: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  /** The tool source's decode key: `sourceDecodeKey` for the original, the tier for the edit file. */
  decodeKey: VideoDecodeKey;
  encodeKey: VideoEncodeKey;
  /** Whether the job tone maps: only an HDR original's `edit_encode`. */
  toneMap: boolean;
}
/** The encoder's configured rates, frozen at admission. */
export interface VideoEncoderRates {
  startSeconds: number;
  encodePixelsPerSecond: number;
  tonemapPixelsPerSecond: number;
  decodeConvertPixelsPerSecond: Readonly<Record<VideoDecodeKey, number>>;
  editEncodePixelsPerSecond: Readonly<Record<EditFileTier, number>>;
}
/** The keys a presentation stage reads (§5.4 estimate row). */
export interface VideoStageKeys { decodeKey: VideoDecodeKey; encodeKey: VideoEncodeKey; toneMap: boolean }
/** The source facts the stage keys depend on. */
export interface VideoStageSource { sourceDecodeKey: SourceDecodeKey; hdr: boolean; editTier: EditFileTier | null }
/** One stage of a presentation route with each job's estimated seconds (§5.4 limit row). */
export interface PresentationRouteStage { stage: string; chunked: boolean; jobSeconds: readonly number[] }
/** A half-open range of grid frames. */
export interface VideoEncodeChunk { start: number; end: number }
/** One container job's identity (§5.4 job identity). */
export type VideoContainerJobSpec =
  | { kind: "presentation-probe"; jobId: string }
  | { kind: "presentation-count"; jobId: string; attempt: number }
  | { kind: "presentation-chunk"; jobId: string; chunk: number; attempt: number }
  | { kind: "presentation-stitch"; jobId: string; attempt: number }
  | { kind: "presentation-edit"; jobId: string; chunk: number; attempt: number }
  | { kind: "presentation-edit-stitch"; jobId: string; attempt: number }
  | { kind: "run-batch"; taskId: string; batch: number; attempt: number }
  | { kind: "run-chunk"; taskId: string; output: number; chunk: number; attempt: number }
  | { kind: "run-stitch"; taskId: string; output: number; attempt: number };

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const ROUTE_STAGES: Readonly<Record<VideoCarrierRoute, readonly VideoCarrierStage[]>> = {
  encode: ["plan", "count", "encode", "stitch", "publish"],
  edit: ["plan", "count", "edit", "edit_stitch", "encode", "stitch", "publish"],
  reuse_edit: ["plan", "encode", "stitch", "publish"],
  reuse: ["plan", "publish"],
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
 * The output conversion a plan's source decides (§3.2, §4.3): HDR is tone mapped to 8-bit SDR in the edit file, deeper SDR
 * keeps 16-bit frame PNGs.
 * @param source - The source transfer and bit depth.
 * @returns The tone map and frame PNG bit depth.
 * @throws {never} Never.
 */
export function videoPlanOutput(source: VideoPlanSource): VideoPlanOutput {
  if (isHdrTransfer(source.transfer)) return { toneMap: "sdr-bt709", framePngBitDepth: 8 };
  return { toneMap: "none", framePngBitDepth: source.bitDepth > 8 ? 16 : 8 };
}

/**
 * Whether two identities agree on every version.
 * @param a - One identity.
 * @param b - The other.
 * @returns True when plan, producer, playback profile and edit profile all match.
 * @throws {never} Never.
 */
function sameIdentity(a: VideoCarrierIdentity, b: VideoCarrierIdentity): boolean {
  return a.planSha256 === b.planSha256 && a.producerVersion === b.producerVersion && a.profileVersion === b.profileVersion &&
    a.editProfileVersion === b.editProfileVersion;
}

/**
 * Choose the carrier route (§7.1 route table): reuse the carrier only from a ready selected P with every version equal;
 * when the job needs an edit file, reuse V's when the plan and the edit profile are equal (also from an invalid V during the
 * automatic readmit), else encode a new edit file; without an edit file, encode the playback file.
 * @param input - The new job's identity and the latest published version.
 * @returns The route.
 * @throws {never} Never.
 */
export function chooseVideoCarrierRoute(input: VideoCarrierRouteInput): VideoCarrierRoute {
  const { plan, reuseFrom } = input;
  if (reuseFrom !== null && reuseFrom.ready && sameIdentity(plan, reuseFrom.identity)) return "reuse";
  if (plan.editProfileVersion === null) return "encode";
  const from = reuseFrom?.identity;
  return from !== undefined && from.planSha256 === plan.planSha256 && from.editProfileVersion === plan.editProfileVersion ? "reuse_edit" : "edit";
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
 * The edit-file tier of a source (§4.2 edit file): transparent sources are ProRes 4444; opaque ones all-intra H.264, 10-bit
 * for an SDR source above 8 bits (HDR is tone mapped to 8-bit), High 4:4:4 Intra when a side is odd.
 * @param source - The source facts.
 * @param source.alpha - Whether the source is confirmed transparent.
 * @param source.bitDepth - Its bit depth.
 * @param source.hdr - Whether its transfer is PQ or HLG.
 * @param source.width - The display width.
 * @param source.height - The display height.
 * @returns The tier.
 * @throws {never} Never.
 */
export function editFileTier(source: { alpha: boolean; bitDepth: number; hdr: boolean; width: number; height: number }): EditFileTier {
  if (source.alpha) return "edit_prores";
  const deep = !source.hdr && source.bitDepth > 8;
  const odd = source.width % 2 === 1 || source.height % 2 === 1;
  if (odd) return deep ? "edit_h264_intra_10bit_444" : "edit_h264_intra_8bit_444";
  return deep ? "edit_h264_intra_10bit_420" : "edit_h264_intra_8bit_420";
}

/**
 * The rate keys a presentation stage reads (§5.4 estimate row): the count decodes the original only; `edit_encode` decodes the
 * original, encodes the tier and tone maps an HDR source; a playback encode decodes the edit file when there is one,
 * else the original, and never tone maps.
 * @param stage - The stage.
 * @param source - The source decode key, HDR and the edit tier (null without an edit file).
 * @returns The keys.
 * @throws {RangeError} When the edit stage is asked for a source without an edit tier.
 */
export function presentationStageKeys(stage: "count" | "edit" | "encode", source: VideoStageSource): VideoStageKeys {
  switch (stage) {
    case "count": return { decodeKey: source.sourceDecodeKey, encodeKey: null, toneMap: false };
    case "edit":
      if (source.editTier === null) throw new RangeError("Only a source with an edit file has an edit stage");
      return { decodeKey: source.sourceDecodeKey, encodeKey: source.editTier, toneMap: source.hdr };
    case "encode": return { decodeKey: source.editTier ?? source.sourceDecodeKey, encodeKey: "playback", toneMap: false };
  }
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
 * Columns between the colour and alpha planes of a packed carrier (§3.5 alpha-packed): two repeat the colour plane's edge and
 * two are neutral black, so a browser upsampling 4:2:0 chroma from neighbouring samples reads each plane's own chroma at the
 * seam. Measured in Chrome 157 with the planes touching: up to 20% wrong alpha in the alpha plane's first column.
 */
export const PACKED_PLANE_GAP = 4;

/**
 * A packed carrier's width: the colour plane, the gap and the alpha plane.
 * @param planeWidth - One plane's even width.
 * @returns The carrier width.
 * @throws {never} Never.
 */
export function packedCarrierWidth(planeWidth: number): number {
  return planeWidth * 2 + PACKED_PLANE_GAP;
}

/**
 * One plane's width in a packed carrier.
 * @param packedWidth - The carrier width.
 * @returns The plane width.
 * @throws {never} Never.
 */
export function packedPlaneWidth(packedWidth: number): number {
  return (packedWidth - PACKED_PLANE_GAP) / 2;
}

/**
 * Estimate a job whose only encoding is one AAC track (§5.4): its start plus the audio seconds over the AAC rate. A
 * presentation stitch (its video chunks joined by packet copy) is such a job.
 * @param audioSeconds - The audio seconds encoded.
 * @param rates - The encoder's start seconds and AAC rate.
 * @param rates.startSeconds - A job's start seconds.
 * @param rates.aacEncodeSecondsPerSecond - Audio seconds encoded per second.
 * @returns The estimated seconds.
 * @throws {never} Never.
 */
export function estimateAudioEncodeSeconds(audioSeconds: number, rates: { startSeconds: number; aacEncodeSecondsPerSecond: number }): number {
  return rates.startSeconds + audioSeconds / rates.aacEncodeSecondsPerSecond;
}

/**
 * Estimate a job's seconds (§5.4 estimate row): start seconds + (encoded + pre-roll frames) × (source pixels ÷ the tool
 * source's decode rate + source pixels ÷ the tone-map rate when the job tone maps + output pixels ÷ the encode rate of its
 * encode key, none for the decode-only count); downloads are not estimated.
 * @param work - The job's frames, geometry and keys.
 * @param rates - The encoder's configured rates.
 * @returns The estimated seconds.
 * @throws {RangeError} When a count, size or rate is out of range.
 */
export function estimateVideoJobSeconds(work: VideoJobWork, rates: VideoEncoderRates): number {
  positiveInteger(work.encodedFrames, "Encoded frames");
  indexInteger(work.prerollFrames, "Pre-roll frames");
  for (const [name, value] of [["Source width", work.sourceWidth], ["Source height", work.sourceHeight], ["Output width", work.outputWidth], ["Output height", work.outputHeight]] as const) positiveInteger(value, name);
  if (!Number.isFinite(rates.startSeconds) || rates.startSeconds < 0) throw new RangeError("Start seconds must be non-negative");
  const source = work.sourceWidth * work.sourceHeight;
  const decodeRate = rates.decodeConvertPixelsPerSecond[work.decodeKey];
  positiveFinite(decodeRate, "The decode-convert rate");
  let perFrame = source / decodeRate;
  if (work.toneMap) {
    positiveFinite(rates.tonemapPixelsPerSecond, "The tone-map rate");
    perFrame += source / rates.tonemapPixelsPerSecond;
  }
  if (work.encodeKey !== null) {
    const encodeRate = work.encodeKey === "playback" ? rates.encodePixelsPerSecond : rates.editEncodePixelsPerSecond[work.encodeKey];
    positiveFinite(encodeRate, "The encode rate");
    perFrame += (work.outputWidth * work.outputHeight) / encodeRate;
  }
  return rates.startSeconds + (work.encodedFrames + work.prerollFrames) * perFrame;
}

/**
 * Split the grid's frames into encode chunks (§5.4 chunking row): boundaries divide the frame count evenly into the fewest
 * chunks whose frames plus pre-roll stay within the target; a pre-roll that alone fills the target gives one frame a chunk.
 * @param input - The frame count, the work per frame, each chunk's pre-roll frames and the target per chunk, in seconds.
 * @param input.frameCount - The grid's frame count (§4.1 frame count row).
 * @param input.frameSeconds - Estimated seconds per frame.
 * @param input.prerollFrames - Frames each chunk decodes before its first frame.
 * @param input.targetSeconds - Target seconds per chunk.
 * @returns Half-open chunks that tile [0, frameCount).
 * @throws {RangeError} When the count is not positive or the work or target is not positive.
 */
export function planVideoEncodeChunks(input: { frameCount: number; frameSeconds: number; prerollFrames: number; targetSeconds: number }): VideoEncodeChunk[] {
  const { frameCount, frameSeconds, prerollFrames, targetSeconds } = input;
  positiveInteger(frameCount, "The frame count");
  positiveFinite(frameSeconds, "Per-frame work");
  indexInteger(prerollFrames, "Pre-roll frames");
  positiveFinite(targetSeconds, "The chunk target");
  const room = targetSeconds / frameSeconds - prerollFrames;
  const count = room >= 1 ? Math.min(frameCount, Math.max(1, Math.ceil(frameCount / Math.floor(room)))) : frameCount;
  return Array.from({ length: count }, (_unused, at) => ({ start: Math.floor((at * frameCount) / count), end: Math.floor(((at + 1) * frameCount) / count) }));
}

/**
 * The presentation failure of a whole route (§5.4 limit row): `too_long` when a job that cannot be chunked exceeds one
 * share, a stage sends more jobs than the parallel cap, or the stages in sequence (each stage taking its slowest job) pass
 * the remaining budget.
 * @param input - The remaining seconds, the share, the cap and each stage's job estimates.
 * @param input.remainingSeconds - Seconds left before the deadline.
 * @param input.chunkShare - The share of the remaining seconds one job may take.
 * @param input.maxParallelChunks - The most jobs one stage sends at once.
 * @param input.stages - The route's stages in order.
 * @returns `too_long`, or null when the route fits.
 * @throws {never} Never.
 */
export function presentationRouteFailure(input: { remainingSeconds: number; chunkShare: number; maxParallelChunks: number; stages: readonly PresentationRouteStage[] }): "too_long" | null {
  const share = input.remainingSeconds * input.chunkShare;
  let total = 0;
  for (const stage of input.stages) {
    if (stage.jobSeconds.length > input.maxParallelChunks) return "too_long";
    if (!stage.chunked && stage.jobSeconds.some((seconds) => seconds > share)) return "too_long";
    total += Math.max(0, ...stage.jobSeconds);
  }
  return total > input.remainingSeconds ? "too_long" : null;
}

/**
 * The frame check of a chunk or stitch (§4.1 frame count row): its measured frames must equal its grid window's k1 − k0.
 * @param window - The grid frame window [start, end).
 * @param window.start - k0.
 * @param window.end - k1.
 * @param measuredFrames - The frames the written object holds.
 * @returns `grid_mismatch` when they differ, else null.
 * @throws {never} Never.
 */
export function checkGridFrames(window: { start: number; end: number }, measuredFrames: number): "grid_mismatch" | null {
  return measuredFrames === window.end - window.start ? null : "grid_mismatch";
}

/**
 * The edit file's size check (§4.2 size cap row): at plan time the estimate frames × output pixels × bytes per pixel, after
 * the write the measured size, against `presentation.max_edit_bytes`.
 * @param input - The grid frames, output size, the configured bytes per pixel, the cap and the measured size (null before the write).
 * @param input.frameCount - Grid frames.
 * @param input.width - Output width.
 * @param input.height - Output height.
 * @param input.bytesPerPixel - `presentation.edit.bytes_per_pixel`.
 * @param input.maxEditBytes - `presentation.max_edit_bytes`.
 * @param input.measuredBytes - The written file's size, or null at plan time.
 * @returns `edit_over_cap` over the cap, else null.
 * @throws {never} Never.
 */
export function editFileSizeFailure(input: { frameCount: number; width: number; height: number; bytesPerPixel: number; maxEditBytes: number; measuredBytes: number | null }): "edit_over_cap" | null {
  const bytes = input.measuredBytes ?? input.frameCount * input.width * input.height * input.bytesPerPixel;
  return bytes > input.maxEditBytes ? "edit_over_cap" : null;
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
  for (const key of ["chunk", "batch", "output"]) if (key in spec) indexInteger(Reflect.get(spec, key) as number, `The ${key} index`);
  const a = "attempt" in spec ? `a${spec.attempt}` : "";
  switch (spec.kind) {
    case "presentation-probe": return `video-presentation:${owner}`;
    case "presentation-chunk": return `video-presentation:${owner}:chunk:${spec.chunk}:${a}`;
    case "presentation-stitch": return `video-presentation:${owner}:stitch:${a}`;
    case "presentation-count": return `video-presentation:${owner}:count:${a}`;
    case "presentation-edit": return `video-presentation:${owner}:edit:${spec.chunk}:${a}`;
    case "presentation-edit-stitch": return `video-presentation:${owner}:edit-stitch:${a}`;
    case "run-batch": return `${owner}:batch:${spec.batch}:${a}`;
    case "run-chunk": return `${owner}:out:${spec.output}:enc:${spec.chunk}:${a}`;
    case "run-stitch": return `${owner}:out:${spec.output}:stitch:${a}`;
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

/** A grid-frame window `[start, end)`. */
export type FrameWindow = { start: number; end: number };
/** The §5.4 job layout of frames and split, frozen at admission: batches of output indices, and the outputs encoded in chunks. */
export type FramesExecutionLayout = { batches: number[][]; encodes: { outputIndex: number; chunks: FrameWindow[] }[] };
/** The job layout an execution freezes at admission. */
export type MiniToolExecutionLayout = FramesExecutionLayout;
/** A stage of a planned execution and the container jobs it sends at once. */
export type MiniToolStageJobs = { stage: "encode" | "stitch"; jobs: number };

/**
 * The container jobs each stage of a frozen layout sends, in execution order, stages with no job left out (§5.4 limit row):
 * frames and split encode every batch and chunk, then stitch each chunked output.
 * @param layout - The frozen layout.
 * @returns Each stage and its job count.
 * @throws {never} Never.
 */
export function plannedStageJobs(layout: MiniToolExecutionLayout): MiniToolStageJobs[] {
  const stages: MiniToolStageJobs[] = [];
  const encode = layout.batches.length + layout.encodes.reduce((total, item) => total + item.chunks.length, 0);
  if (encode > 0) stages.push({ stage: "encode", jobs: encode });
  if (layout.encodes.length > 0) stages.push({ stage: "stitch", jobs: layout.encodes.length });
  return stages;
}
