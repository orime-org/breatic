// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The standard-4 presentation recipes (frames-split design §4.3, §5.3, §5.4, §7.17; inner#1306 §91 D3): a chunk or model
 * input renders its window's entries on its own clock from 0, the stitch joins the chunks by stream copy for their plan
 * durations and adds the interval's audio, and the copy keeps every packet and tags the plan matrix. The recipe carries
 * what the worker wrote from the full ledger; nothing here reads the ledger.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gcd, rational } from "@shared/mini-tools/video-presentation-projection.js";
import type { MiniToolPlanAudio, MiniToolPlanEntry, MiniToolPlanExact, MiniToolPlanPixelRect, MiniToolPlanRecipe, MiniToolPlanTarget } from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { copyWithMatrixTag } from "@ingest/container/presentation-run.js";
import type { PlanLimits } from "@ingest/container/plan-recipes.js";
import { probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";

/** The recipes this module runs. */
export type PresentationRecipe = Extract<MiniToolPlanRecipe, { kind: "copy_carrier" | "chunk_encode" | "stitch" | "prepare_model_input" }>;
/** One recipe's local files and lifetime. */
export interface PresentationRecipeRequest {
  recipe: PresentationRecipe;
  /** Downloaded files by bound input id: the recipe's input and, for a stitch, every chunk. */
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}

const KINDS: ReadonlySet<string> = new Set(["copy_carrier", "chunk_encode", "stitch", "prepare_model_input"]);
// §4.3 colour/HDR/bit-depth row: the D05 tone-map chain, then the BT.709 tags written on the frames.
const TONE_MAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
const BT709_TAGS = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
// The plan's matrix names (physical-video-probe.ts) as the scale filter spells them.
const SCALE_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", bt601: "bt601", bt2020nc: "bt2020" };

/**
 * Whether a recipe is one of the presentation recipes.
 * @param recipe - A validated recipe.
 * @returns True for copy, chunk, stitch and model input.
 * @throws {never} Never.
 */
export function isPresentationRecipe(recipe: MiniToolPlanRecipe): recipe is PresentationRecipe {
  return KINDS.has(recipe.kind);
}

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
  const tail = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${BT709_TAGS},sidedata=mode=delete:type=DISPLAYMATRIX`;
  if (target.alpha === "none") return `${head}:out_color_matrix=bt709:out_range=tv,format=yuv444p,${pad},${tail}`;
  return `${head},format=gbrap,split=2[${label}r][${label}a];[${label}r]premultiply=inplace=1,format=rgb24,${pad}[${label}c];` +
    `[${label}a]alphaextract,format=rgb24,${pad}[${label}m];[${label}c][${label}m]hstack,${tail}`;
}

// The highest intermediate rate the exact relabel resamples to; above it the relabelled rate is rounded to the hertz.
const MAX_RELABEL_RATE = 384000n;

/**
 * Relabel 48 kHz samples to play at a rate (§4.2 rational relabel: no atempo, no pitch preservation): resample to a rate R
 * whose R·rate is whole, declare the samples R·rate, and resample back to 48 kHz, so the duration becomes duration / rate.
 * @param rate - The reduced rate.
 * @returns The filter chain, empty at rate 1.
 * @throws {never} Never.
 */
function relabel([numerator, denominator]: [bigint, bigint]): string {
  if (numerator === denominator) return "";
  const base = 48000n * denominator / gcd(48000n, denominator);
  // ponytail: a rate whose exact intermediate rate exceeds the cap (a 16.16 rate such as 65535/65536) is relabelled at the
  // rounded hertz, drifting at most 0.5 Hz in 384 kHz; an exact path would need a resampler that takes a rational ratio.
  if (base > MAX_RELABEL_RATE) return `,aresample=48000,asetrate=${(2n * 48000n * numerator + denominator) / (2n * denominator)},aresample=48000`;
  return `,aresample=${base},asetrate=${base * numerator / denominator},aresample=48000`;
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

/**
 * Render a window (§5.4 chunking and chunk time; §7.17 entries): each source span decodes from its keyframe and shows from its clip
 * start, each derived-empty entry is one black frame, all on a `1/timescale` clock from 0 that opens with a keyframe; the
 * next frame's start ends each frame and the window end ends the last, so a held frame keeps its span. A model input adds
 * its interval's audio (§5.3, §91 D3-4); a chunk has none.
 * @param recipe - The chunk or model-input recipe.
 * @param source - The downloaded source.
 * @param output - The MP4 to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When FFmpeg fails.
 */
async function renderWindow(recipe: Extract<PresentationRecipe, { kind: "chunk_encode" | "prepare_model_input" }>, source: string, output: string,
  run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<void> {
  const { entries, target } = recipe;
  const clock = BigInt(recipe.timescale);
  const origin = span(entries[0]!).start;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts"];
  const graph: string[] = [];
  const facts = await sourceFacts(source, run);
  let inputs = 0;
  for (const [at, entry] of entries.entries()) {
    const offset = roundTimes(minus(span(entry).start, origin), clock);
    if (entry.kind === "empty") {
      // Black: a transparent fill packs to black colour and black alpha.
      graph.push(`color=c=black:s=${target.width}x${target.height}:r=1:d=1,format=yuv420p,setsar=1,${BT709_TAGS},settb=1/${clock},setpts=${offset}[e${at}]`);
      continue;
    }
    // At rate a/b the span shows media [clipStart, clipStart + length·a/b), each frame for its media duration·b/a (§7.17).
    const [rateNumerator, rateDenominator] = rational(entry.rate);
    const [clipNumerator, clipDenominator] = rational(entry.clipStart);
    const clipEnd = plus([clipNumerator, clipDenominator], times(minus(entry.displayEnd, entry.displayStart), [rateNumerator, rateDenominator]));
    // An edit can start inside a source frame (§7.17 timeline row): that frame is kept and shown from clipStart.
    const first = await frameStartAt(source, facts, entry, run);
    args.push(...mediaTimeline(facts), "-noaccurate_seek", "-ss", seconds(rational(entry.decodeStart)), "-i", source);
    graph.push(`[${inputs}:v:0]trim=start=${seconds(first)}:end=${seconds(clipEnd)},settb=1/${clock},` +
      `setpts=max(round((PTS-${roundTimes([clipNumerator, clipDenominator], clock)})*${rateDenominator}/${rateNumerator})\\,0)+${offset},${picture(target, `p${at}`)}[e${at}]`);
    inputs += 1;
  }
  graph.push(`${entries.map((_entry, at) => `[e${at}]`).join("")}interleave=nb_inputs=${entries.length},settb=1/${clock}[v]`);
  const audio = recipe.kind === "prepare_model_input" && recipe.audio !== null && facts.audio ? audioOf(inputs, recipe.audio) : null;
  if (audio !== null) {
    args.push(...audio.args, source);
    graph.push(audio.graph);
  }
  const end = roundTimes(minus(span(entries[entries.length - 1]!).end, origin), clock);
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", "-c:v", "libx264", "-preset", target.preset, "-crf", String(target.crf), "-bf", "0", "-pix_fmt", "yuv420p",
    "-fps_mode", "passthrough", "-enc_time_base:v", `1/${clock}`, "-bsf:v", `setts=duration=if(eq(NEXT_PTS\\,NOPTS)\\,${end}-PTS\\,NEXT_PTS-PTS)`,
    "-video_track_timescale", String(clock), ...(audio === null ? ["-an"] : AAC), "-movflags", "+faststart", "-f", "mp4", output);
  await runPlanCommand("ffmpeg", args, run);
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
  const list = join(directory, "stitch.txt");
  await writeFile(list, recipe.chunks.map((chunk) => `file '${local(files, chunk.inputId)}'\nduration ${seconds(rational(chunk.duration))}\n`).join(""));
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts", "-f", "concat", "-safe", "0", "-i", list];
  const source = local(files, recipe.inputId);
  const audio = recipe.audio !== null && (await sourceFacts(source, run)).audio ? audioOf(1, recipe.audio) : null;
  if (audio !== null) args.push(...audio.args, source, "-filter_complex", audio.graph);
  args.push("-map", "0:v:0", "-c:v", "copy", ...(audio === null ? ["-an"] : AAC), "-movflags", "+faststart", "-f", "mp4", output);
  await runPlanCommand("ffmpeg", args, run);
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
 * Run one presentation recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers, and for a packed stitch its packing geometry (§91 D3-3; the DO writes the manifest).
 * @throws {Error} When a process fails or the output has no complete video metadata.
 */
export async function executePresentationRecipe(request: PresentationRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { recipe, inputs, output, directory, signal, limits } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  if (recipe.kind === "copy_carrier") await copyWithMatrixTag(local(inputs, recipe.inputId), output, recipe.colorMatrix, { signal, limits });
  else if (recipe.kind === "stitch") await stitch(recipe, inputs, directory, output, run);
  else await renderWindow(recipe, local(inputs, recipe.inputId), output, run);
  const metadata = pickMediaMetadata(readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output, "own-file"),
    { signal, stdoutBytes: limits.probeStdoutBytes, stderrTailBytes: limits.stderrTailBytes })).toString("utf8")));
  if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null) throw new Error(`The ${recipe.kind} recipe produced no complete video metadata`);
  if (recipe.kind !== "stitch" || recipe.target.alpha !== "packed") return { ...metadata, cover: null };
  const { rect, planeWidth } = placement(recipe.target);
  return { ...metadata, cover: null, packing: { packedWidth: recipe.target.width, packedHeight: recipe.target.height, colorRect: rect, alphaRect: { ...rect, x: rect.x + planeWidth } } };
}
