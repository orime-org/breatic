// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The standard-4 presentation recipes (frames-split design §4.3, §5.3, §5.4, §7.17; inner#1306 §91 D3): a chunk or model
 * input renders its window's entries on its own clock from 0, the stitch joins the chunks by stream copy for their plan
 * durations and adds the interval's audio, and the copy keeps every packet and tags the plan matrix. The recipe carries
 * what the worker wrote from the full ledger; nothing here reads the ledger.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rational } from "@shared/mini-tools/video-presentation-projection.js";
import type { MiniToolPlanAudio, MiniToolPlanEntry, MiniToolPlanExact, MiniToolPlanPixelRect, MiniToolPlanRecipe, MiniToolPlanStitch, MiniToolPlanTarget } from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { copyWithMatrixTag } from "@ingest/container/presentation-run.js";
import { probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import { pngSize } from "@ingest/png-size.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";
import { readSceneCutObservations, readYuNetFaces } from "@ingest/container/analysis-detection.js";

/** Caller-frozen process IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** The recipes this module runs. */
export type PresentationRecipe = Extract<MiniToolPlanRecipe, { kind: "copy_carrier" | "chunk_encode" | "prepare_model_input" }> | MiniToolPlanStitch
  | FrameRecipe | PeopleRecipe | SceneRecipe | SegmentRecipe;
/** A still frame on a full-ledger entry (§91 D4-3). */
type FrameRecipe = Extract<MiniToolPlanRecipe, { kind: "frame"; entry: MiniToolPlanEntry }>;
/** People detection on the anchor's entry (§91 D4-5). */
type PeopleRecipe = Extract<MiniToolPlanRecipe, { kind: "people"; entry: MiniToolPlanEntry }>;
/** Scene detection over a window's entries (§91 D4-5). */
type SceneRecipe = Extract<MiniToolPlanRecipe, { kind: "scene_cuts"; entries: unknown }>;
/** A split segment on a window's entries (§91 D4-4). */
type SegmentRecipe = Extract<MiniToolPlanRecipe, { kind: "segment"; entries: unknown }>;
/** The process lifetime and IO bounds of one command. */
type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** One recipe's local files and lifetime. */
export interface PresentationRecipeRequest {
  /** Any admitted recipe; the transition and composite recipes are refused until this module runs them. */
  recipe: MiniToolPlanRecipe;
  /** Downloaded files by bound input id: the recipe's input and, for a stitch, every chunk. */
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}

// §4.3 colour/HDR/bit-depth row: the D05 tone-map chain, then the BT.709 tags written on the frames.
const TONE_MAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
const BT709_TAGS = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
// The plan's matrix names (physical-video-probe.ts) as the scale filter spells them.
const SCALE_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", bt601: "bt601", bt2020nc: "bt2020" };

/**
 * Subtract two exact times.
 * @param left - The minuend.
 * @param right - The subtrahend.
 * @returns The exact difference.
 * @throws {RangeError} When a time is malformed.
 */
function minus(left: MiniToolPlanExact, right: MiniToolPlanExact): [bigint, bigint] {
  const [a, b] = rational(left);
  const [c, d] = rational(right);
  return [a * d - c * b, b * d];
}

/**
 * Round a non-negative exact value times a scale to the nearest integer.
 * @param value - The numerator and denominator.
 * @param scale - The multiplier.
 * @returns The rounded product.
 * @throws {RangeError} When the value is negative.
 */
function roundTimes([numerator, denominator]: [bigint, bigint], scale: bigint): bigint {
  if (numerator < 0n) throw new RangeError("Presentation entries run forward from the window start");
  return (2n * numerator * scale + denominator) / (2n * denominator);
}

/**
 * An exact time as FFmpeg seconds, rounded to the nanosecond.
 * @param value - The numerator and denominator.
 * @returns The decimal text.
 * @throws {RangeError} When the value is negative.
 */
function seconds(value: [bigint, bigint]): string {
  const nanos = roundTimes(value, 1_000_000_000n);
  return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, "0")}`;
}

/**
 * The presentation interval an entry covers.
 * @param entry - The entry.
 * @returns Its start and end.
 * @throws {never} Never.
 */
function span(entry: MiniToolPlanEntry): { start: MiniToolPlanExact; end: MiniToolPlanExact } {
  return entry.kind === "source" ? { start: entry.displayStart, end: entry.displayEnd } : entry.window;
}

/**
 * Where the picture sits in the coded frame: the display rectangle, or the whole frame (one plane when alpha is packed).
 * @param target - The carrier target.
 * @returns The picture rectangle and the plane width.
 * @throws {never} Never.
 */
function placement(target: MiniToolPlanTarget): { rect: MiniToolPlanPixelRect; planeWidth: number } {
  const planeWidth = target.alpha === "packed" ? target.width / 2 : target.width;
  return { rect: target.displayRect ?? { x: 0, y: 0, width: planeWidth, height: target.height }, planeWidth };
}

/**
 * The filters that turn decoded display frames into the target picture (§4.3 odd-size and colour/HDR/bit-depth rows, §3.5): HDR
 * tone mapped, decoded with the plan matrix, scaled to the picture rectangle and padded around it to the even coded size;
 * an alpha source is packed premultiplied colour left and alpha right as `alpha-presentation.ts` packs it.
 * @param target - The carrier target.
 * @param label - A label prefix unique within the graph.
 * @returns The filter chain text, ending on 8-bit BT.709 4:2:0 frames.
 * @throws {RangeError} When the plan matrix has no decode value.
 */
function picture(target: MiniToolPlanTarget, label: string): string {
  const matrix = SCALE_MATRICES[target.colorMatrix];
  if (matrix === undefined) throw new RangeError(`No decode matrix for ${target.colorMatrix}`);
  const { rect, planeWidth } = placement(target);
  const head = `${target.toneMap === "sdr-bt709" ? `${TONE_MAP},` : ""}scale=${rect.width}:${rect.height}:in_color_matrix=${matrix}`;
  const pad = `pad=${planeWidth}:${target.height}:${rect.x}:${rect.y}:color=black`;
  // The frames are already upright; a display matrix left on them would be written to the output and rotate it again.
  const unrotated = `${BT709_TAGS},sidedata=mode=delete:type=DISPLAYMATRIX`;
  // A VP9 split output keeps its display size, odd sides included, and its straight alpha (§4.3 odd-size row, §91 D4-4).
  if (target.format === "webm-vp9") return `${head}:out_color_matrix=bt709:out_range=tv,format=${target.alpha === "straight" ? "yuva420p" : "yuv420p"},setsar=1,${unrotated}`;
  const tail = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${unrotated}`;
  if (target.alpha === "none") return `${head}:out_color_matrix=bt709:out_range=tv,format=yuv444p,${pad},${tail}`;
  return `${head},format=gbrap,split=2[${label}r][${label}a];[${label}r]premultiply=inplace=1,format=rgb24,${pad}[${label}c];` +
    `[${label}a]alphaextract,format=rgb24,${pad}[${label}m];[${label}c][${label}m]hstack,${tail}`;
}

// FFmpeg's sample rates are C ints.
const MAX_SAMPLE_RATE = 2147483647n;

/**
 * Relabel 48 kHz samples to play at a reduced rate a/b (§4.2 rational relabel: no atempo, no pitch preservation; design line
 * 858): resample to b·m Hz, declare those samples a·m Hz, and resample back to 48 kHz, so every sample's time is divided by
 * a/b exactly. m = ceil(48000 / b) keeps the intermediate rate at or above 48 kHz, so no bandwidth is lost and the rate stays
 * below 48000 + b.
 * @param rate - The reduced rate.
 * @returns The filter chain, empty at rate 1.
 * @throws {RangeError} When the relabelled rate exceeds FFmpeg's sample-rate range.
 */
function relabel([numerator, denominator]: [bigint, bigint]): string {
  if (numerator === denominator) return "";
  const scale = (48000n + denominator - 1n) / denominator;
  if (numerator * scale > MAX_SAMPLE_RATE) throw new RangeError("The audio rate is beyond FFmpeg's sample-rate range");
  return `,aresample=${denominator * scale},asetrate=${numerator * scale},aresample=48000`;
}

/**
 * The audio of a presentation interval as AAC at 48 kHz from output time 0 (§4.2, §91 D3b-11, D4-2). With the plan's audio
 * spans the source is read on its media timeline (edit list ignored); each span's media samples, its bounds rounded to the
 * 48 kHz grid as FFmpeg `av_rescale` rounds (nearest, halves away from 0), are relabelled to its rate and placed at their
 * presentation sample. Without spans the edit list is applied and presentation time is movie time less the origin.
 * Silence before the first sample is kept.
 * @param input - The FFmpeg input index the source's audio is opened at.
 * @param audio - The recipe's audio.
 * @returns The input arguments and the filter chain ending at `[a]`, or null when no span meets the interval.
 * @throws {RangeError} When a time is malformed.
 */
function audioOf(input: number, audio: MiniToolPlanAudio): { args: string[]; graph: string } | null {
  const start = rational(audio.start);
  const end = rational(audio.end);
  const pad = "aresample=48000:async=1:first_pts=0";
  if (audio.spans === null) {
    const movieStart = plus(start, rational(audio.origin));
    const movieEnd = plus(end, rational(audio.origin));
    return { args: ["-i"], graph: `[${input}:a:0]atrim=start=${seconds(movieStart)}:end=${seconds(movieEnd)},asetpts=PTS-(${seconds(movieStart)})/TB,${pad}[a]` };
  }
  const branches: string[] = [];
  for (const edit of audio.spans) {
    const rate = rational(edit.rate);
    const shownFrom = rational(edit.presentationStart);
    // Media [sourceStart, sourceEnd) is shown for its length / rate.
    const shownTo = plus(shownFrom, times(minusQ(rational(edit.sourceEnd), rational(edit.sourceStart)), [rate[1], rate[0]]));
    const from = later(shownFrom, start);
    const to = earlier(shownTo, end);
    if (!before(from, to)) continue;
    const mediaFrom = plus(rational(edit.sourceStart), times(minusQ(from, shownFrom), rate));
    const mediaTo = plus(mediaFrom, times(minusQ(to, from), rate));
    branches.push(`aresample=48000,atrim=start_pts=${roundTimes(mediaFrom, 48000n)}:end_pts=${roundTimes(mediaTo, 48000n)},asetpts=PTS-STARTPTS${relabel(rate)},` +
      `asetpts=PTS+${roundTimes(minusQ(from, start), 48000n)},${pad}`);
  }
  if (branches.length === 0) return null;
  const labels = branches.map((_branch, at) => `[s${at}]`);
  const split = branches.length === 1 ? `[${input}:a:0]${branches[0]}[a]`
    : `[${input}:a:0]asplit=${branches.length}${labels.join("")};${branches.map((branch, at) => `${labels[at]}${branch}[m${at}]`).join(";")};` +
      `${branches.map((_branch, at) => `[m${at}]`).join("")}amix=inputs=${branches.length}:normalize=0:duration=longest[a]`;
  return { args: ["-ignore_editlist", "1", "-i"], graph: split };
}

/**
 * Add two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The sum.
 * @throws {never} Never.
 */
function plus(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[1] + right[0] * left[1], left[1] * right[1]];
}

/**
 * Multiply two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The product.
 * @throws {never} Never.
 */
function times(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[0], left[1] * right[1]];
}

/**
 * Subtract two exact values.
 * @param left - The minuend.
 * @param right - The subtrahend.
 * @returns The difference.
 * @throws {never} Never.
 */
function minusQ(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[1] - right[0] * left[1], left[1] * right[1]];
}

/**
 * Whether one exact value is below another.
 * @param left - One.
 * @param right - The other.
 * @returns Whether left is below right.
 * @throws {never} Never.
 */
function before(left: [bigint, bigint], right: [bigint, bigint]): boolean {
  return left[0] * right[1] < right[0] * left[1];
}

/**
 * The later of two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The larger.
 * @throws {never} Never.
 */
function later(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return before(left, right) ? right : left;
}

/**
 * The earlier of two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The smaller.
 * @throws {never} Never.
 */
function earlier(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return before(left, right) ? left : right;
}

const AAC = ["-map", "[a]", "-c:a", "aac", "-ar", "48000"];

/** What the recipes need to know of a source before reading it. */
interface SourceFacts { iso: boolean; audio: boolean }

/**
 * Whether the source is ISO BMFF (its edit lists are ignored so packet times are media time, the recipe's timeline;
 * design §7.17 timeline row) and whether it has audio: the plan does not record it, so a recipe always names its interval
 * and the output carries audio only when there is some (§91 D3b-2; §7.17 the first audio stream in ffprobe order).
 * @param source - The downloaded source.
 * @param run - The lifetime and IO bounds.
 * @returns The facts.
 * @throws {Error} When ffprobe fails.
 */
async function sourceFacts(source: string, run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<SourceFacts> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=format_name:stream=codec_type", "-of", "json", source], run))
    .toString("utf8")) as { format?: { format_name?: string }; streams?: { codec_type?: string }[] };
  const names = (answer.format?.format_name ?? "").split(",");
  return { iso: names.includes("mov") || names.includes("mp4"), audio: (answer.streams ?? []).some((stream) => stream.codec_type === "audio") };
}

/**
 * The input options that put an ISO source on its media timeline.
 * @param facts - The source facts.
 * @returns `-ignore_editlist 1` for ISO, nothing otherwise.
 * @throws {never} Never.
 */
function mediaTimeline(facts: SourceFacts): string[] {
  return facts.iso ? ["-ignore_editlist", "1"] : [];
}

/**
 * The start of the source frame shown at a span's clip start: the last video packet at or before it, read from the span's
 * keyframe on. A span starting on its keyframe starts on a frame.
 * @param source - The downloaded source.
 * @param facts - Its facts.
 * @param entry - The source span.
 * @param run - The lifetime and IO bounds.
 * @returns The frame start, exact; the clip start when no frame starts before it.
 * @throws {Error} When ffprobe fails or answers without the stream's time base.
 */
async function frameStartAt(source: string, facts: SourceFacts, entry: Extract<MiniToolPlanEntry, { kind: "source" }>, run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<[bigint, bigint]> {
  const clip = rational(entry.clipStart);
  const decode = rational(entry.decodeStart);
  if (decode[0] * clip[1] === clip[0] * decode[1]) return clip;
  // One second past the clip start covers packets that B-frame reordering delivers after a later one.
  const until: [bigint, bigint] = [clip[0] + clip[1], clip[1]];
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", ...mediaTimeline(facts), "-select_streams", "v:0",
    "-read_intervals", `${seconds(decode)}%${seconds(until)}`, "-show_entries", "stream=time_base:packet=pts", "-of", "json", source], run)).toString("utf8")) as
    { streams?: { time_base?: string }[]; packets?: { pts?: number }[] };
  const base = /^(\d+)\/(\d+)$/u.exec(answer.streams?.[0]?.time_base ?? "");
  if (base === null) throw new Error("Source span probe has no video time base");
  const [tickNumerator, tickDenominator] = [BigInt(base[1]!), BigInt(base[2]!)];
  let best: bigint | null = null;
  for (const packet of answer.packets ?? []) {
    if (packet.pts === undefined) continue;
    const pts = BigInt(packet.pts);
    if (pts * tickNumerator * clip[1] <= clip[0] * tickDenominator && (best === null || pts > best)) best = pts;
  }
  return best === null ? clip : [best * tickNumerator, tickDenominator];
}

/** The inputs and filter graph presenting a window's frames, ending at `[v]`. */
interface WindowGraph { args: string[]; graph: string[]; inputs: number; facts: SourceFacts }

/**
 * Present a window's entries as frames (§5.4 chunking and chunk time; §7.17 entries): each source span decodes from its
 * keyframe on the media timeline and shows from its clip start at its rate, each derived-empty entry is one composed frame,
 * all on a `1/timescale` clock from 0, one output frame per presented frame.
 * @param entries - The window's entries.
 * @param clock - The timescale.
 * @param source - The downloaded source.
 * @param run - The lifetime and IO bounds.
 * @param frame - The chain after a source span's timing, given a unique label prefix.
 * @param empty - The source of one composed frame for a derived-empty entry.
 * @returns The inputs and graph.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When ffprobe fails.
 */
async function windowGraph(entries: readonly MiniToolPlanEntry[], clock: bigint, source: string, run: Run,
  frame: (label: string) => string, empty: (entry: Extract<MiniToolPlanEntry, { kind: "empty" }>) => string): Promise<WindowGraph> {
  const origin = span(entries[0]!).start;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts"];
  const graph: string[] = [];
  const facts = await sourceFacts(source, run);
  let inputs = 0;
  for (const [at, entry] of entries.entries()) {
    const offset = roundTimes(minus(span(entry).start, origin), clock);
    if (entry.kind === "empty") {
      graph.push(`${empty(entry)},settb=1/${clock},setpts=${offset}[e${at}]`);
      continue;
    }
    // At rate a/b the span shows media [clipStart, clipStart + length·a/b), each frame for its media duration·b/a (§7.17).
    const [rateNumerator, rateDenominator] = rational(entry.rate);
    const [clipNumerator, clipDenominator] = rational(entry.clipStart);
    const clipEnd = plus([clipNumerator, clipDenominator], times(minus(entry.displayEnd, entry.displayStart), [rateNumerator, rateDenominator]));
    // An edit can start inside a source frame (§7.17 timeline row): that frame is kept and shown from clipStart.
    const first = await frameStartAt(source, facts, entry, run);
    args.push(...mediaTimeline(facts), "-seek_timestamp", "1", "-noaccurate_seek", "-ss", seconds(rational(entry.decodeStart)), "-i", source);
    graph.push(`[${inputs}:v:0]trim=start=${seconds(first)}:end=${seconds(clipEnd)},settb=1/${clock},` +
      `setpts=max(round((PTS-${roundTimes([clipNumerator, clipDenominator], clock)})*${rateDenominator}/${rateNumerator})\\,0)+${offset},${frame(`p${at}`)}[e${at}]`);
    inputs += 1;
  }
  graph.push(`${entries.map((_entry, at) => `[e${at}]`).join("")}interleave=nb_inputs=${entries.length},settb=1/${clock}[v]`);
  return { args, graph, inputs, facts };
}

/**
 * The video encoder, frame timing and muxer of a target: H.264 MP4 on the presentation track clock, or a VP9 WebM split
 * output with its alpha (§91 D4-4); the next frame's start ends each frame and the window end ends the last.
 * @param target - The target.
 * @param clock - The timescale.
 * @param end - The window end in ticks.
 * @returns The encoder and timing arguments, and the muxer arguments.
 * @throws {never} Never.
 */
function videoOutput(target: MiniToolPlanTarget, clock: bigint, end: bigint): { video: string[]; muxer: string[] } {
  const timing = ["-fps_mode", "passthrough", "-enc_time_base:v", `1/${clock}`, "-bsf:v", `setts=duration=if(eq(NEXT_PTS\\,NOPTS)\\,${end}-PTS\\,NEXT_PTS-PTS)`];
  if (target.format === "webm-vp9") {
    const alpha = target.alpha === "straight";
    return { video: ["-c:v", "libvpx-vp9", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "-crf", String(target.crf), "-b:v", "0", "-deadline", "good", "-row-mt", "1",
      ...(alpha ? ["-auto-alt-ref", "0"] : []), ...timing], muxer: ["-f", "webm"] };
  }
  return { video: ["-c:v", "libx264", "-preset", target.preset, "-crf", String(target.crf), "-bf", "0", "-pix_fmt", "yuv420p", ...timing, "-video_track_timescale", String(clock)],
    muxer: ["-movflags", "+faststart", "-f", "mp4"] };
}

/**
 * The audio encoder of a target: AAC in MP4, Opus in a VP9 WebM split output (§7.17 segment row).
 * @param target - The target.
 * @returns The audio mapping and encoder arguments.
 * @throws {never} Never.
 */
function audioOutput(target: MiniToolPlanTarget): string[] {
  return target.format === "webm-vp9" ? ["-map", "[a]", "-c:a", "libopus", "-ar", "48000"] : AAC;
}

/**
 * Render a window into its target (§5.4; §7.17 segment row): the window's frames with the target picture, opening with a
 * keyframe; a model input or a segment adds its interval's audio (§5.3, §91 D3-4, D4-4), a chunk has none.
 * @param recipe - The chunk, model-input or segment recipe.
 * @param source - The downloaded source.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When FFmpeg fails.
 */
async function renderWindow(recipe: Extract<PresentationRecipe, { kind: "chunk_encode" | "prepare_model_input" }> | SegmentRecipe, source: string, output: string, run: Run): Promise<void> {
  const { entries, target } = recipe;
  const clock = BigInt(recipe.timescale);
  const transparent = target.format === "webm-vp9" && target.alpha === "straight";
  // Black: a transparent fill packs to black colour and black alpha; a VP9 output with alpha keeps it transparent.
  const window = await windowGraph(entries, clock, source, run, (label) => picture(target, label),
    (entry) => `color=c=black${transparent && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,` +
      `format=${transparent ? "yuva420p" : "yuv420p"},setsar=1,${BT709_TAGS}`);
  const { args, graph } = window;
  const audio = recipe.kind !== "chunk_encode" && recipe.audio !== null && window.facts.audio ? audioOf(window.inputs, recipe.audio) : null;
  if (audio !== null) {
    args.push(...audio.args, source);
    graph.push(audio.graph);
  }
  const end = roundTimes(minus(span(entries[entries.length - 1]!).end, span(entries[0]!).start), clock);
  const { video, muxer } = videoOutput(target, clock, end);
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", ...video, ...(audio === null ? ["-an"] : audioOutput(target)), ...muxer, output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * Refuse chunks whose video codec headers differ (§5.4 拼接 row): a stream copy would join incompatible streams. The
 * headers are the codec, profile, size, pixel format and the codec's extradata (H.264 avcC with its SPS and PPS).
 * @param chunks - The downloaded chunk files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing when every chunk has the first one's headers.
 * @throws {Error} When a chunk's headers differ or ffprobe fails.
 */
async function sameCodecHeaders(chunks: readonly string[], run: Run): Promise<void> {
  let first: string | null = null;
  for (const chunk of chunks) {
    const headers = JSON.stringify(JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,width,height,pix_fmt,extradata", "-show_data", "-of", "json", chunk], run)).toString("utf8")).streams);
    if (first === null) first = headers;
    else if (headers !== first) throw new Error("Stitch chunks have different codec headers");
  }
}

/**
 * Join the chunks by stream copy (§5.4 stitching): each chunk is placed for its plan duration, and the source's interval audio,
 * when the recipe names one, is encoded once as AAC at 48 kHz.
 * @param recipe - The stitch recipe.
 * @param files - The downloaded inputs by id.
 * @param directory - The run's directory.
 * @param output - The MP4 to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When an input is missing or FFmpeg fails.
 */
async function stitch(recipe: Extract<PresentationRecipe, { kind: "stitch" }>, files: ReadonlyMap<string, string>, directory: string, output: string,
  run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<void> {
  await sameCodecHeaders(recipe.chunks.map((chunk) => local(files, chunk.inputId)), run);
  const list = join(directory, "stitch.txt");
  await writeFile(list, recipe.chunks.map((chunk) => `file '${local(files, chunk.inputId)}'\nduration ${seconds(rational(chunk.duration))}\n`).join(""));
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts", "-f", "concat", "-safe", "0", "-i", list];
  const source = local(files, recipe.inputId);
  const audio = recipe.audio !== null && (await sourceFacts(source, run)).audio ? audioOf(1, recipe.audio) : null;
  if (audio !== null) args.push(...audio.args, source, "-filter_complex", audio.graph);
  const webm = recipe.target.format === "webm-vp9";
  args.push("-map", "0:v:0", "-c:v", "copy", ...(audio === null ? ["-an"] : audioOutput(recipe.target)), ...(webm ? ["-f", "webm"] : ["-movflags", "+faststart", "-f", "mp4"]), output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * Copy the carrier (§7.17 copy_carrier row): the video packets as they are with the plan's matrix tag; the audio copied,
 * encoded to AAC 48 kHz over the stitch's audio entries (§4.2), or left out.
 * @param recipe - The copy recipe.
 * @param source - The downloaded source.
 * @param output - The MP4 to write.
 * @param bounds - The lifetime and frozen process IO bounds for the copy.
 * @param bounds.signal - The lifetime.
 * @param bounds.limits - The bounds.
 * @param run - The lifetime and IO bounds for reading the source facts.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function copyCarrier(recipe: Extract<PresentationRecipe, { kind: "copy_carrier" }>, source: string, output: string,
  bounds: { signal: AbortSignal; limits: { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number } }, run: Run): Promise<void> {
  const { audio } = recipe;
  if (audio === null || audio.kind === "copy") { await copyWithMatrixTag(source, output, recipe.colorMatrix, bounds, audio === null ? null : "copy"); return; }
  const { kind: _kind, ...entries } = audio;
  await copyWithMatrixTag(source, output, recipe.colorMatrix, bounds, (await sourceFacts(source, run)).audio ? audioOf(1, entries) : null);
}

/**
 * The recipe as one this module runs.
 * @param recipe - An admitted recipe.
 * @returns It, when this module runs it.
 * @throws {Error} For a transition window, a transition stitch or a model composite, which no container step runs yet.
 */
function presentationRecipe(recipe: MiniToolPlanRecipe): PresentationRecipe {
  if (recipe.kind === "transition_window" || recipe.kind === "model_composite" || (recipe.kind === "stitch" && "clips" in recipe)) {
    throw new Error(`The ${recipe.kind} recipe has no container step yet`);
  }
  return recipe;
}

/**
 * A bound input's downloaded file.
 * @param files - The downloaded inputs by id.
 * @param inputId - The input.
 * @returns Its path.
 * @throws {Error} When it was not downloaded.
 */
function local(files: ReadonlyMap<string, string>, inputId: string): string {
  const file = files.get(inputId);
  if (file === undefined) throw new Error("Presentation recipe names an input that was not downloaded");
  return file;
}

/**
 * Render a still frame (§7.17 frame row and orientation-and-geometry row; §4.3): a source entry decodes from its decodeStart and takes the
 * frame shown at its clip start, upright, tone mapped when the plan says so, decoded with the plan's matrix and scaled to the
 * display geometry; a derived-empty entry is composed in its fill. The PNG is 8 or 16 bits per channel, RGBA when alpha is
 * kept, and cropped to the display crop when there is one.
 * @param recipe - The frame recipe.
 * @param source - The downloaded source.
 * @param output - The PNG to write.
 * @param run - The lifetime and IO bounds.
 * @returns The PNG's size.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When FFmpeg fails or the PNG is incomplete.
 */
async function renderFrame(recipe: FrameRecipe, source: string, output: string,
  run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<{ width: number; height: number }> {
  const { entry, target, crop } = recipe;
  const keep = target.alpha === "straight";
  const pixel = keep ? (target.pngBitDepth === 16 ? "rgba64be" : "rgba") : (target.pngBitDepth === 16 ? "rgb48be" : "rgb24");
  const cropped = crop === undefined ? "" : `,crop=${crop.rect.width}:${crop.rect.height}:${crop.rect.x}:${crop.rect.y}:exact=1`;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts"];
  let graph: string;
  if (entry.kind === "empty") {
    graph = `color=c=black${keep && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,format=${pixel}${cropped}[v]`;
  } else {
    const matrix = SCALE_MATRICES[target.colorMatrix];
    if (matrix === undefined) throw new RangeError(`No decode matrix for ${target.colorMatrix}`);
    const facts = await sourceFacts(source, run);
    const first = await frameStartAt(source, facts, entry, run);
    args.push(...mediaTimeline(facts), "-seek_timestamp", "1", "-noaccurate_seek", "-ss", seconds(rational(entry.decodeStart)), "-i", source);
    graph = `[0:v:0]trim=start=${seconds(first)},${target.toneMap === "sdr-bt709" ? `${TONE_MAP},` : ""}` +
      `scale=${target.width}:${target.height}:in_color_matrix=${matrix},format=${pixel}${cropped}[v]`;
  }
  await runPlanCommand("ffmpeg", [...args, "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-c:v", "png", "-f", "image2", output], run);
  const size = pngSize(new Uint8Array(await readFile(output)));
  if (size === null) throw new Error("The frame recipe produced no complete PNG");
  return size;
}

/**
 * Run the pinned detector process on raw BGR frames (the separate Python process, as the source-facts analyses run it).
 * @param kind - The detector.
 * @param profile - Its frozen profile.
 * @param frames - The geometry and count of the frames, and the FFmpeg arguments that write them to stdout.
 * @param frames.width - Their width.
 * @param frames.height - Their height.
 * @param frames.count - How many there are.
 * @param frames.args - The FFmpeg arguments.
 * @param directory - The run's directory.
 * @param signal - The lifetime.
 * @param limits - The frozen IO bounds.
 * @returns The detector's JSON object.
 * @throws {Error} When the detector, its input or its JSON fails.
 */
async function detect(kind: "people" | "scene_cuts", profile: unknown, frames: { width: number; height: number; count: number; args: string[] }, directory: string,
  signal: AbortSignal, limits: PlanLimits): Promise<Record<string, unknown>> {
  const path = join(directory, "analysis-request.json");
  await writeJson(path, { kind, width: frames.width, height: frames.height, expectedFrameCount: frames.count, profile });
  const answer: unknown = JSON.parse(Buffer.from(await runAnalysisPipeline({
    decoder: { program: "ffmpeg", args: frames.args }, processor: { program: "python3", args: ["/app/analysis-runtime.py", path] },
    width: frames.width, height: frames.height, expectedFrameCount: frames.count, signal,
    limits: { stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes },
  })).toString("utf8"));
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new TypeError("Expected a complete detector object");
  return answer as Record<string, unknown>;
}

/**
 * Store JSON facts as text without allowing a string to mimic SVG bytes.
 * @param output - The file.
 * @param value - The value.
 * @returns Nothing once written.
 * @throws {Error} When writing fails.
 */
async function writeJson(output: string, value: unknown): Promise<void> {
  await writeFile(output, JSON.stringify(value).replace(/</g, "\\u003c"));
}

/**
 * Detect people on the anchor's frame (§7.17 people anchor row, §91 D4-5): the frame is rendered upright at the target size,
 * and the JSON gives the candidates in that display geometry, with no anchor (the accepted record holds it, §93 D5-8).
 * @param recipe - The people recipe.
 * @param source - The downloaded source.
 * @param output - The JSON to write.
 * @param request - The run's directory, lifetime and bounds.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {Error} When rendering, detection or writing fails.
 */
async function detectPeople(recipe: PeopleRecipe, source: string, output: string, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height } = recipe.target;
  const anchor = join(request.directory, "people-anchor.png");
  await renderFrame({ kind: "frame", inputId: recipe.inputId, entry: recipe.entry, target: recipe.target }, source, anchor, run);
  const result = await detect("people", recipe.profile, { width, height, count: 1,
    args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-i", anchor, "-map", "0:v:0", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  await writeJson(output, { schemaVersion: 1, kind: "people", coordinateSpace: "display", width, height, candidates: readYuNetFaces(result.faces, { width, height }, true) });
}

/**
 * Detect scene cuts over a window (§7.17 scene_cuts row, §91 D4-5): the window's frames are presented in display geometry,
 * one per presented frame, and each cut is recorded by its presentation ordinal (§93 D5-8).
 * @param recipe - The scene_cuts recipe.
 * @param source - The downloaded source.
 * @param output - The JSON to write.
 * @param request - The run's directory, lifetime and bounds.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When rendering, detection or writing fails.
 */
async function detectScenes(recipe: SceneRecipe, source: string, output: string, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height, colorMatrix, toneMap } = recipe.target;
  const matrix = SCALE_MATRICES[colorMatrix];
  if (matrix === undefined) throw new RangeError(`No decode matrix for ${colorMatrix}`);
  const window = await windowGraph(recipe.entries, BigInt(recipe.timescale), source, run,
    () => `${toneMap === "sdr-bt709" ? `${TONE_MAP},` : ""}scale=${width}:${height}:in_color_matrix=${matrix},format=bgr24,setsar=1,sidedata=mode=delete:type=DISPLAYMATRIX`,
    () => `color=c=black:s=${width}x${height}:r=1:d=1,format=bgr24,setsar=1`);
  const count = recipe.window.end - recipe.window.start;
  const result = await detect("scene_cuts", recipe.profile, { width, height, count,
    args: [...window.args, "-filter_complex", window.graph.join(";"), "-map", "[v]", "-fps_mode", "passthrough", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  const ordinals = Array.from({ length: count }, (_unused, at) => ({ frameIndex: recipe.window.start + at, pts: (recipe.window.start + at) / recipe.timescale }));
  await writeJson(output, { schemaVersion: 1, kind: "scene_cuts",
    cuts: readSceneCutObservations(result.cuts, ordinals).map((cut) => ({ ordinal: cut.frameIndex, detectionScore: cut.detectionScore })) });
}

/**
 * Run one presentation recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers, and for a packed stitch its packing geometry (§91 D3-3; the DO writes the manifest).
 * @throws {Error} When a process fails or the output has no complete video metadata.
 */
export async function executePresentationRecipe(request: PresentationRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { inputs, output, directory, signal, limits } = request;
  const recipe = presentationRecipe(request.recipe);
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  if (recipe.kind === "frame") return { ...await renderFrame(recipe, local(inputs, recipe.inputId), output, run), durationSeconds: null, cover: null };
  if (recipe.kind === "people" || recipe.kind === "scene_cuts") {
    if (recipe.kind === "people") await detectPeople(recipe, local(inputs, recipe.inputId), output, request, run);
    else await detectScenes(recipe, local(inputs, recipe.inputId), output, request, run);
    return { width: null, height: null, durationSeconds: null, cover: null };
  }
  if (recipe.kind === "copy_carrier") await copyCarrier(recipe, local(inputs, recipe.inputId), output, { signal, limits }, run);
  else if (recipe.kind === "stitch") await stitch(recipe, inputs, directory, output, run);
  else await renderWindow(recipe, local(inputs, recipe.inputId), output, run);
  const metadata = pickMediaMetadata(readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output, "own-file"),
    { signal, stdoutBytes: limits.probeStdoutBytes, stderrTailBytes: limits.stderrTailBytes })).toString("utf8")));
  if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null) throw new Error(`The ${recipe.kind} recipe produced no complete video metadata`);
  if (recipe.kind !== "stitch" || recipe.target.alpha !== "packed") return { ...metadata, cover: null };
  const { rect, planeWidth } = placement(recipe.target);
  return { ...metadata, cover: null, packing: { packedWidth: recipe.target.width, packedHeight: recipe.target.height, colorRect: rect, alphaRect: { ...rect, x: rect.x + planeWidth } } };
}
