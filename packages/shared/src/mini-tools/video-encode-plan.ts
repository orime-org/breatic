// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation carrier routes, carrier geometry, encode estimates, chunk boundaries, container job ids and user-run
 * batching (inner#1306; frames-split design §4.1, §4.3, §5.1 step 2, §5.3, §5.4, §7.1, §8.2).
 *
 * Kept free of zod: the media container and the backend both compute these, and the container bundles this module.
 */

import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/mini-tools/types.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

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
  | { kind: "run-window"; taskId: string; output: number; chunk: number; attempt: number }
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
 * Estimate a job whose only encoding is one AAC track (§5.4; §97 D7-1, D24-3): its start plus the audio seconds over the
 * AAC rate. The dispatched copy, a lip-sync stem and the lip-sync stitch (its video chunks joined by packet copy) are such jobs.
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

/** A presentation-frame window `[start, end)`. */
export type FrameWindow = { start: number; end: number };
/** The §5.4 job layout of frames and split, frozen at admission: batches of output indices, and the outputs encoded in chunks. */
export type FramesExecutionLayout = { batches: number[][]; encodes: { outputIndex: number; chunks: FrameWindow[] }[] };
/** Remove-background: the model input's preparation chunks. */
export type RemovalExecutionLayout = { preparation: FrameWindow[] };
/** Erase and expand: the preparation chunks and the model composite chunks. */
export type CompositeExecutionLayout = { preparation: FrameWindow[]; composite: FrameWindow[] };
/**
 * Lip-sync: the preparation chunks, the people it generates for, the composite chunks and the jobs preparing the tracking
 * clips (execution design §10.2): `forward` the one prepare:fwd job, none when the clip is the preparation itself or
 * absent; `reverse` each prepare:rev job's window (`clipJobWindows`), stitched when there are several.
 */
export type LipsyncExecutionLayout = { preparation: FrameWindow[]; persons: number; composite: FrameWindow[]; tracking: { forward: FrameWindow[]; reverse: FrameWindow[] } };
/** Transitions: the encode chunks and the overlap window chunks on the output grid. */
export type TransitionExecutionLayout = { encode: FrameWindow[]; window: FrameWindow[] };
/** The job layout an execution freezes at admission, by tool (§97 D12-1). */
export type MiniToolExecutionLayout = FramesExecutionLayout | RemovalExecutionLayout | CompositeExecutionLayout | LipsyncExecutionLayout | TransitionExecutionLayout;
/** A stage of a planned execution and the container jobs it sends at once. */
export type MiniToolStageJobs = {
  stage: "prepare" | "prepare_stitch" | "track_prepare" | "track_prepare_stitch" | "encode" | "stitch" | "faces" | "clip_stem" | "model_composite" | "composite"; jobs: number;
};

/**
 * The container jobs each stage of a frozen layout sends, in execution order, stages with no job left out (§97 D12-1;
 * frames-split §5.4): frames and split encode every batch and chunk, then stitch each chunked output; a prepared model
 * input stitches its chunks only when there are several; erase and expand composite each chunk, lip-sync prepares its
 * tracking clips side by side and stitches a chunked reversed one, runs each person's faces and its clip and stem, then the
 * composite; transitions encode the encode and window chunks; every
 * composited or transitioned result is stitched once.
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
  } else if ("encode" in layout) {
    add("encode", layout.encode.length + layout.window.length);
    add("stitch", 1);
  } else {
    add("prepare", layout.preparation.length);
    add("prepare_stitch", layout.preparation.length > 1 ? 1 : 0);
    if ("persons" in layout) {
      add("track_prepare", layout.tracking.forward.length + layout.tracking.reverse.length);
      add("track_prepare_stitch", layout.tracking.reverse.length > 1 ? 1 : 0);
      add("faces", layout.persons);
      add("clip_stem", layout.persons * 2);
      add("composite", layout.composite.length);
      add("stitch", 1);
    } else if ("composite" in layout) {
      add("model_composite", layout.composite.length);
      add("stitch", 1);
    }
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

/** An exact reduced rational. */
interface ExactRational { numerator: string; denominator: string }
/** The SDR BT.709 colour every transition output is written in (§97 D15-5). */
export interface TransitionOutputColor { matrix: "bt709"; range: "tv"; primaries: "bt709"; transfer: "bt709" }
/** The one output profile both clips of a transition are encoded to (frames-split §7.17). */
export interface TransitionOutputProfile {
  width: number; height: number; fps: ExactRational; timeBase: ExactRational; pixFmt: "yuv420p" | "yuva420p";
  color: TransitionOutputColor; codec: "h264" | "vp9"; encode: { crf: number; preset: string }; alpha: boolean;
}
/** What a clip's selected plan gives the profile: its display, its presentation table and its empty fill. */
export interface TransitionClipPlan {
  display: { width: number; height: number };
  presentation: VideoPresentationTable;
  policy: { emptyFill: "black" | "transparent" };
}

/**
 * A positive rational in lowest terms.
 * @param numerator - Its numerator.
 * @param denominator - Its denominator.
 * @returns The reduced rational.
 * @throws {never} Never.
 */
function reduced(numerator: bigint, denominator: bigint): ExactRational {
  let [a, b] = [numerator < 0n ? -numerator : numerator, denominator];
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
}

// The standard frame rates a VFR clip is conformed to, as editors conform one to the project's constant rate; each is a
// frame rate FFmpeg's int rationals carry with room for any clip's time base.
const STANDARD_FRAME_RATES: readonly (readonly [bigint, bigint])[] = [
  [12n, 1n], [15n, 1n], [24000n, 1001n], [24n, 1n], [25n, 1n], [30000n, 1001n], [30n, 1n], [48n, 1n], [50n, 1n], [60000n, 1001n], [60n, 1n], [120n, 1n],
];

/**
 * The standard frame rate nearest a rate, the lower one on a tie.
 * @param numerator - The rate's numerator.
 * @param denominator - The rate's positive denominator.
 * @returns The standard rate.
 * @throws {never} Never.
 */
function nearestStandardRate(numerator: bigint, denominator: bigint): ExactRational {
  // |n/d − a/b| = |n·b − a·d| / (d·b); d is shared, so candidates compare by |n·b − a·d| / b.
  /**
   * The distance to a candidate, times the shared denominator and the candidate's.
   * @param rate - The candidate as a numerator and denominator.
   * @returns |n·b − a·d|.
   * @throws {never} Never.
   */
  const gap = (rate: readonly [bigint, bigint]): bigint => {
    const [a, b] = rate;
    return numerator * b > a * denominator ? numerator * b - a * denominator : a * denominator - numerator * b;
  };
  let best = STANDARD_FRAME_RATES[0]!;
  for (const rate of STANDARD_FRAME_RATES) if (gap(rate) * best[1] < gap(best) * rate[1]) best = rate;
  return { numerator: String(best[0]), denominator: String(best[1]) };
}

/**
 * Each frame spacing of a table with how many frame pairs it separates, the first pair (frame 0 to frame 1) left out: the
 * first frame is held from 0 when the picture starts after the audio (§7.17 timeline row).
 * @param runs - The table's runs.
 * @returns The spacings.
 * @throws {never} Never.
 */
function frameSpacings(runs: VideoPresentationTable["runs"]): Map<number, number> {
  const spacings = new Map<number, number>();
  /**
   * Count a spacing for some frame pairs.
   * @param spacing - The ticks between two frame starts.
   * @param pairs - How many consecutive pairs it separates.
   * @throws {never} Never.
   */
  const add = (spacing: number, pairs: number): void => { if (pairs > 0) spacings.set(spacing, (spacings.get(spacing) ?? 0) + pairs); };
  runs.forEach((run, index) => {
    add(run.step, index === 0 ? run.count - 2 : run.count - 1);
    const next = runs[index + 1];
    if (next !== undefined) add(next.start - (run.start + (run.count - 1) * run.step), index === 0 && run.count === 1 ? 0 : 1);
  });
  return spacings;
}

/**
 * The exact frame grid of a constant-rate source whose clock rounded its frame times (§7.17 rounding clock row): a 30 fps
 * WebM on its 1 ms clock, a 29.97 fps iPhone clip on 1/600 s (or that clock times 32 after a remux). Every frame from the
 * second on truly starts on `origin + j · period`, the grid point its stored start rounds to; the first frame keeps the
 * presentation's start and the last frame its end.
 */
export interface PresentationConform { origin: ExactRational; period: ExactRational }

const conforms = new WeakMap<VideoPresentationTable, { conform: PresentationConform | null; rate: ExactRational | null }>();

/**
 * The greatest common divisor of two non-negative integers.
 * @param left - One.
 * @param right - The other.
 * @returns The divisor.
 * @throws {never} Never.
 */
function divisor(left: bigint, right: bigint): bigint {
  let [a, b] = [left, right];
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * The integer nearest a quotient, halves up.
 * @param numerator - The dividend.
 * @param denominator - The positive divisor.
 * @returns The integer.
 * @throws {never} Never.
 */
function nearestInteger(numerator: bigint, denominator: bigint): bigint {
  const twice = 2n * numerator + denominator;
  const bottom = 2n * denominator;
  return twice >= 0n ? twice / bottom : -((-twice + bottom - 1n) / bottom);
}

/**
 * The rounded constant rate of a table and its grid, computed once per table: the standard rate whose exact grid every
 * frame start from the second on matches within the clock's rounding granularity g (the greatest common divisor of those
 * starts' distances from the second start), with g under half a frame so each start rounds to one grid point. The starts'
 * offsets from the grid then spread over at most g; the rate with the least spread wins. The grid passes through the first
 * frame's start when that start fits it too (a start of 0 is stored exactly), else through the middle of the offsets, on a
 * half-tick of the table clock. Null for a table with fewer than three frames or one frame spacing (exact already) and for
 * one no standard grid fits (VFR).
 * @param table - The presentation table.
 * @returns The grid and its rate, or nulls.
 * @throws {never} Never.
 */
function roundedConstant(table: VideoPresentationTable): { conform: PresentationConform | null; rate: ExactRational | null } {
  const cached = conforms.get(table);
  if (cached !== undefined) return cached;
  let found: { conform: PresentationConform | null; rate: ExactRational | null } = { conform: null, rate: null };
  const frames = table.runs.reduce((total, run) => total + run.count, 0);
  if (frames >= 3 && frameSpacings(table.runs).size > 1) {
    const timescale = BigInt(table.timescale);
    const later: bigint[] = [];
    table.runs.forEach((run, index) => { for (let k = index === 0 ? 1 : 0; k < run.count; k += 1) later.push(BigInt(run.start + k * run.step)); });
    const granularity = later.reduce((g, start) => divisor(g, start - later[0]!), 0n);
    const first = BigInt(table.runs[0]!.start);
    let best: { rate: readonly [bigint, bigint]; spread: bigint; low: bigint; high: bigint } | null = null;
    for (const rate of STANDARD_FRAME_RATES) {
      const [numerator, denominator] = rate;
      // Offsets from the grid in ticks times n: s_k · n − k · timescale · d.
      let [low, high] = [0n, 0n];
      later.forEach((start, k) => {
        const offset = (start - later[0]!) * numerator - BigInt(k) * timescale * denominator;
        if (offset < low) low = offset;
        if (offset > high) high = offset;
      });
      const spread = high - low;
      // Within the granularity, which is under half a frame (2 · g · n < timescale · d); spreads compare per tick: spread / n.
      if (spread <= granularity * numerator && 2n * granularity * numerator < timescale * denominator
        && (best === null || spread * best.rate[0] < best.spread * numerator)) best = { rate, spread, low, high };
    }
    if (best !== null) {
      const [numerator, denominator] = best.rate;
      const limit = granularity * numerator;
      // The first frame's offset, one frame before the second: (s_0 − s_1) · n + timescale · d.
      const lead = (first - later[0]!) * numerator + timescale * denominator;
      // The grid point of the second frame in table ticks: through the first frame, or the offsets' middle on a half tick.
      const origin = lead >= best.high - limit && lead <= best.low + limit
        ? reduced((first * numerator + timescale * denominator), timescale * numerator)
        : reduced(2n * later[0]! + nearestInteger(best.low + best.high, numerator), 2n * timescale);
      found = { rate: reduced(numerator, denominator), conform: { origin, period: reduced(denominator, numerator) } };
    }
  }
  conforms.set(table, found);
  return found;
}

/**
 * The exact frame grid of a table whose clock rounded a constant rate's frame times (`roundedConstant`), or null.
 * @param table - The presentation table.
 * @returns The grid.
 * @throws {never} Never.
 */
export function presentationConform(table: VideoPresentationTable): PresentationConform | null {
  return roundedConstant(table).conform;
}

/**
 * A stored time on a conform grid: the grid point it rounds to, origin + round((t − origin) / period) · period, exact.
 * @param conform - The grid.
 * @param at - The time in seconds as a numerator and a positive denominator.
 * @returns The grid time as a numerator and denominator.
 * @throws {never} Never.
 */
export function conformedTime(conform: PresentationConform, at: readonly [bigint, bigint]): [bigint, bigint] {
  const [an, ad] = [BigInt(conform.origin.numerator), BigInt(conform.origin.denominator)];
  const [pn, pd] = [BigInt(conform.period.numerator), BigInt(conform.period.denominator)];
  // j = floor((t − a) / p + 1/2) = floor((2 · (t − a) + p) / (2p)), with t − a = (tn · ad − an · td) / (td · ad).
  const [tn, td] = at;
  const top = 2n * (tn * ad - an * td) * pd + pn * td * ad;
  const bottom = 2n * pn * td * ad;
  const j = top >= 0n ? top / bottom : -((-top + bottom - 1n) / bottom);
  return [an * pd + j * pn * ad, ad * pd];
}

/**
 * A presentation table's output frame rate (frames-split §7.17 transition output profile row), the one rule the profile,
 * the panel and the timeline Dialog read: timescale over the frame spacing when consecutive frames start the same number of
 * ticks apart, or the standard rate whose grid every start matches within the clock's rounding, otherwise the standard rate
 * nearest the average spacing. Neither the first frame's nor the last frame's own
 * length counts: the average runs from the second frame's start to the last frame's start, since the first frame is held
 * from 0 when the picture starts after the audio (§7.17 timeline row) and the last is held to the end when the audio runs
 * longer, or is cut short at the end of its stream. Two frames take their one spacing; one frame its duration.
 * @param table - The compact presentation table.
 * @returns The rate, exact and reduced.
 * @throws {RangeError} When the table presents no frame.
 */
export function presentationOutputFps(table: VideoPresentationTable): ExactRational {
  const { runs, timescale } = table;
  const frames = runs.reduce((total, run) => total + run.count, 0);
  if (frames === 0) throw new RangeError("A presentation table presents at least one frame");
  const first = runs[0]!;
  const second = first.count > 1 ? first.start + first.step : runs[1]?.start;
  if (second === undefined) return nearestStandardRate(BigInt(timescale), BigInt(first.duration));
  // Two frames have only the one spacing between them.
  if (frames === 2) return reduced(BigInt(timescale), BigInt(second - first.start));
  const spacings = frameSpacings(runs);
  if (spacings.size === 1) return reduced(BigInt(timescale), BigInt([...spacings.keys()][0]!));
  const rounded = roundedConstant(table).rate;
  if (rounded !== null) return rounded;
  const last = runs.at(-1)!;
  return nearestStandardRate(BigInt(frames - 2) * BigInt(timescale), BigInt(last.start + (last.count - 1) * last.step - second));
}

/**
 * The transition output profile from the two clips' selected plans, in timeline order (§97 D13-1, D15-5): the first
 * clip's display size, odd sides of an opaque output taken down to even (one up to two) and a transparent one kept; the
 * first clip's frame rate, `presentationOutputFps` of its table; alpha when
 * either clip is transparent, then VP9 and yuva420p, else H.264 and yuv420p; time base 1/fps; SDR BT.709 colour.
 * @param first - The first clip's plan.
 * @param second - The second clip's plan.
 * @param config - The presentation encode settings.
 * @param config.encode - Its crf and preset.
 * @param config.encode.crf - The crf.
 * @param config.encode.preset - The x264 preset.
 * @returns The profile.
 * @throws {RangeError} When the first plan has no frame.
 */
export function transitionOutputProfile(first: TransitionClipPlan, second: TransitionClipPlan, config: { encode: { crf: number; preset: string } }): TransitionOutputProfile {
  const alpha = first.policy.emptyFill === "transparent" || second.policy.emptyFill === "transparent";
  const fps = presentationOutputFps(first.presentation);
  /**
   * An opaque side taken down to even, one up to two; a transparent side kept.
   * @param side - The display side.
   * @returns The output side.
   * @throws {never} Never.
   */
  const even = (side: number): number => (alpha ? side : Math.max(2, side - (side % 2)));
  return {
    width: even(first.display.width), height: even(first.display.height), fps, timeBase: { numerator: fps.denominator, denominator: fps.numerator },
    pixFmt: alpha ? "yuva420p" : "yuv420p", color: { matrix: "bt709", range: "tv", primaries: "bt709", transfer: "bt709" },
    codec: alpha ? "vp9" : "h264", encode: { crf: config.encode.crf, preset: config.encode.preset }, alpha,
  };
}
