// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation carrier routes, carrier geometry, encode estimates, chunk boundaries, container job ids and user-run
 * batching on the frame grid (inner#1306; frames-split design §4.1–§4.3, §5.4, §7.1, §7.1.1, §7.17, §8.2).
 *
 * Kept free of zod: the media container and the backend both compute these, and the container bundles this module.
 */

import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/mini-tools/types.js";
import type { FrameRate, SourceDecodeKey } from "@shared/upload/frame-grid-rate.js";

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
  | { kind: "run-stitch"; taskId: string; output: number; attempt: number }
  | { kind: "run-window"; taskId: string; output: number; chunk: number; attempt: number }
  | { kind: "prep"; taskId: string; input: number; attempt: number }
  | { kind: "prep-chunk"; taskId: string; input: number; chunk: number; attempt: number }
  | { kind: "prep-stitch"; taskId: string; input: number; attempt: number };

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
 * Estimate a job whose only encoding is one AAC track (§5.4): its start plus the audio seconds over the AAC rate. A lip-sync
 * stem and the lip-sync stitch (its video chunks joined by packet copy) are such jobs.
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
  for (const key of ["chunk", "batch", "output", "input"]) if (key in spec) indexInteger(Reflect.get(spec, key) as number, `The ${key} index`);
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
    case "run-window": return `${owner}:out:${spec.output}:win:${spec.chunk}:${a}`;
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

/** A grid-frame window `[start, end)`. */
export type FrameWindow = { start: number; end: number };
/** The §5.4 job layout of frames and split, frozen at admission: batches of output indices, and the outputs encoded in chunks. */
export type FramesExecutionLayout = { batches: number[][]; encodes: { outputIndex: number; chunks: FrameWindow[] }[] };
/** Remove-background: the model input's preparation chunks. */
export type RemovalExecutionLayout = { preparation: FrameWindow[] };
/** Erase: the preparation chunks, the mask (`bria_mask`) and the model composite chunks. */
export type CompositeExecutionLayout = { preparation: FrameWindow[]; composite: FrameWindow[] };
/** Expand: the preparation chunks, the windows (each its own stage) and the model composite chunks (execution design §10.5). */
export type ExpandExecutionLayout = { preparation: FrameWindow[]; composite: FrameWindow[]; windows: number };
/**
 * Lip-sync: the preparation chunks, the people it generates for, the composite chunks and the jobs preparing the tracking
 * clips (execution design §10.2): `forward` the one prepare:fwd job, none when the clip is the preparation itself or
 * absent; `reverse` each prepare:rev job's window (`clipJobWindows`), stitched when there are several.
 */
export type LipsyncExecutionLayout = { preparation: FrameWindow[]; persons: number; composite: FrameWindow[]; tracking: { forward: FrameWindow[]; reverse: FrameWindow[] } };
/** Transitions: the encode chunks and the overlap window chunks on the output grid. */
export type TransitionExecutionLayout = { encode: FrameWindow[]; window: FrameWindow[] };
/** The job layout an execution freezes at admission, by tool. */
export type MiniToolExecutionLayout =
  | FramesExecutionLayout | RemovalExecutionLayout | CompositeExecutionLayout | ExpandExecutionLayout | LipsyncExecutionLayout | TransitionExecutionLayout;
/** A stage of a planned execution and the container jobs it sends at once. */
export type MiniToolStageJobs = {
  stage: "prepare" | "prepare_stitch" | "track_prepare" | "track_prepare_stitch" | "track_join" | "encode" | "stitch" | "faces" | "clip_stem" |
    "mask" | "window" | "model_composite" | "composite";
  jobs: number;
};

/**
 * The container jobs each stage of a frozen layout sends, in execution order, stages with no job left out (§5.4 limit row):
 * frames and split encode every batch and chunk, then stitch each chunked output; a prepared model input stitches its
 * chunks only when there are several; lip-sync prepares its tracking clips side by side and stitches a chunked reversed
 * one, joins each person's track (`track_join`), runs each person's faces and its clip and stem, then the composite; erase
 * makes its mask; expand runs its windows one after another (window and window_mask, and frame_at from the second
 * window); transitions encode the encode and window chunks; every composited or transitioned result is stitched once.
 * @param layout - The frozen layout.
 * @returns Each stage and its job count.
 * @throws {never} Never.
 */
export function plannedStageJobs(layout: MiniToolExecutionLayout): MiniToolStageJobs[] {
  const stages: MiniToolStageJobs[] = [];
  /**
   * Record a stage when it has jobs.
   * @param stage - The stage.
   * @param jobs - Its job count.
   * @throws {never} Never.
   */
  const add = (stage: MiniToolStageJobs["stage"], jobs: number): void => { if (jobs > 0) stages.push({ stage, jobs }); };
  if ("batches" in layout) {
    add("encode", layout.batches.length + layout.encodes.reduce((total, encode) => total + encode.chunks.length, 0));
    add("stitch", layout.encodes.length);
    return stages;
  }
  if ("encode" in layout) {
    add("encode", layout.encode.length + layout.window.length);
    add("stitch", 1);
    return stages;
  }
  add("prepare", layout.preparation.length);
  add("prepare_stitch", layout.preparation.length > 1 ? 1 : 0);
  if ("persons" in layout) {
    add("track_prepare", layout.tracking.forward.length + layout.tracking.reverse.length);
    add("track_prepare_stitch", layout.tracking.reverse.length > 1 ? 1 : 0);
    add("track_join", layout.persons);
    add("faces", layout.persons);
    add("clip_stem", layout.persons * 2);
    add("composite", layout.composite.length);
    add("stitch", 1);
  } else if ("windows" in layout) {
    for (let window = 0; window < layout.windows; window += 1) add("window", window === 0 ? 2 : 3);
    add("model_composite", layout.composite.length);
    add("stitch", 1);
  } else if ("composite" in layout) {
    add("mask", 1);
    add("model_composite", layout.composite.length);
    add("stitch", 1);
  }
  return stages;
}

/** A cost budget for transition chunks: the seconds one chunk's frames may take, and what each output frame costs. */
export interface TransitionChunkBudget {
  targetSeconds: number;
  /** One output frame's work: each clip's decode it shows at that clip's own size, its encode, and a window frame's render. */
  frameSeconds: (frame: number, window: boolean) => number;
}

/** The two-clip timeline on the output grid that transition chunks are planned on (§97 D15-3). */
export interface TransitionChunkTimeline { frameCount: number; clips: readonly { startFrame: number; frameCount: number }[]; window: { startFrame: number; frameCount: number } | null }

/**
 * The transition chunks on the output grid (§97 D15-4; frames-split §5.4): the window chunks partition the
 * overlap window, the encode chunks partition each clip's frames outside it, and no chunk exceeds the target; a Cut has
 * no window chunks. Chunks are sized by each output frame's own cost against the share, so a chunk holds as many frames as
 * its own clips' work allows (§97, the per-clip cost the quote sums).
 * @param timeline - The frame-grid timeline.
 * @param budget - The share in seconds and each output frame's cost.
 * @returns The encode and window chunks.
 * @throws {RangeError} When the share is not a positive finite number.
 */
export function planTransitionChunks(timeline: TransitionChunkTimeline, budget: TransitionChunkBudget): { encode: FrameWindow[]; window: FrameWindow[] } {
  if (!(Number.isFinite(budget.targetSeconds) && budget.targetSeconds > 0)) throw new RangeError("targetSeconds must be a positive finite number");
  /**
   * Split one region into the fewest chunks that fit the share, as even in cost as whole frames allow: a chunk ends at the
   * last frame whose running cost stays within its even part; a split whose chunk would pass the share takes one chunk more.
   * Under a uniform cost this is an even split by frames.
   * @param from - The region's first frame.
   * @param to - Its end.
   * @param window - Whether it is the overlap window.
   * @returns The chunks; none for an empty region.
   * @throws {never} Never.
   */
  const chunk = (from: number, to: number, window: boolean): FrameWindow[] => {
    if (to <= from) return [];
    const costs = Array.from({ length: to - from }, (_, at) => budget.frameSeconds(from + at, window));
    const before = [0];
    for (const cost of costs) before.push(before.at(-1)! + cost);
    const total = before.at(-1)!;
    // A single frame costing more than the whole share still makes a chunk of one.
    for (let count = Math.max(1, Math.ceil(total / budget.targetSeconds - 1e-9)); ; count += 1) {
      const ends = Array.from({ length: count }, (_, at) => {
        if (at === count - 1) return costs.length;
        const part = (total * (at + 1)) / count;
        let end = 0;
        while (end < costs.length && before[end + 1]! <= part + 1e-9) end += 1;
        return end;
      });
      const chunks = ends.map((end, at) => ({ start: from + (at === 0 ? 0 : ends[at - 1]!), end: from + end })).filter((part) => part.end > part.start);
      if (count >= costs.length || chunks.every((part) => before[part.end - from]! - before[part.start - from]! <= budget.targetSeconds + 1e-9 || part.end - part.start === 1)) return chunks;
    }
  };
  const window = timeline.window;
  if (window === null) {
    const boundary = timeline.clips[1]?.startFrame ?? timeline.frameCount;
    return { encode: [...chunk(0, boundary, false), ...chunk(boundary, timeline.frameCount, false)], window: [] };
  }
  const end = window.startFrame + window.frameCount;
  return {
    encode: [...chunk(0, window.startFrame, false), ...chunk(end, timeline.frameCount, false)],
    window: chunk(window.startFrame, end, true),
  };
}

/**
 * Where a clip's picture sits on a transition's output frame (§7.17 transition output profile row; the preview's `contain`):
 * scaled by the smaller of the two side ratios, rounded to whole pixels, and centred. Every encode chunk and every window
 * chunk of the clip uses this one rectangle.
 * @param display - The clip's display size.
 * @param display.width - Its width.
 * @param display.height - Its height.
 * @param output - The output frame.
 * @param output.width - Its width.
 * @param output.height - Its height.
 * @returns The rectangle in output pixels.
 * @throws {never} Never.
 */
export function transitionFitRect(display: { width: number; height: number }, output: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(output.width / display.width, output.height / display.height);
  const width = Math.max(1, Math.min(output.width, Math.round(display.width * scale)));
  const height = Math.max(1, Math.min(output.height, Math.round(display.height * scale)));
  return { x: Math.floor((output.width - width) / 2), y: Math.floor((output.height - height) / 2), width, height };
}

/** The SDR BT.709 colour every transition output is written in. */
export interface TransitionOutputColor { matrix: "bt709"; range: "tv"; primaries: "bt709"; transfer: "bt709" }
/** The one output profile both clips of a transition are encoded to (frames-split §7.17 transition output profile row). */
export interface TransitionOutputProfile {
  width: number; height: number; fps: FrameRate; timeBase: FrameRate; pixFmt: "yuv420p" | "yuva420p";
  color: TransitionOutputColor; codec: "h264" | "vp9"; encode: { crf: number; preset: string }; alpha: boolean;
}
/** What a clip's selected P gives the profile: its display size, its grid fps and whether it is transparent. */
export interface TransitionClipPlan {
  display: { width: number; height: number; fps: FrameRate };
  alpha: boolean;
}

/**
 * The transition output profile from the two clips' selected P, in timeline order (§7.17 transition output profile row): the first
 * clip's display size, odd sides of an opaque output taken down to even (one up to two) and a transparent one kept; the
 * first clip's grid fps; alpha when either clip is transparent, then VP9 and yuva420p, else H.264 and yuv420p; time base
 * 1/fps; SDR BT.709 colour.
 * @param first - The first clip.
 * @param second - The second clip.
 * @param config - The presentation encode settings.
 * @param config.encode - Its crf and preset.
 * @param config.encode.crf - The crf.
 * @param config.encode.preset - The x264 preset.
 * @returns The profile.
 * @throws {never} Never.
 */
export function transitionOutputProfile(first: TransitionClipPlan, second: TransitionClipPlan, config: { encode: { crf: number; preset: string } }): TransitionOutputProfile {
  const alpha = first.alpha || second.alpha;
  const { fps } = first.display;
  /**
   * An opaque side taken down to even, one up to two; a transparent side kept.
   * @param side - The display side.
   * @returns The output side.
   * @throws {never} Never.
   */
  const even = (side: number): number => (alpha ? side : Math.max(2, side - (side % 2)));
  return {
    width: even(first.display.width), height: even(first.display.height), fps: { ...fps }, timeBase: { numerator: fps.denominator, denominator: fps.numerator },
    pixFmt: alpha ? "yuva420p" : "yuv420p", color: { matrix: "bt709", range: "tv", primaries: "bt709", transfer: "bt709" },
    codec: alpha ? "vp9" : "h264", encode: { crf: config.encode.crf, preset: config.encode.preset }, alpha,
  };
}
