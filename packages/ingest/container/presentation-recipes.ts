// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The grid recipes (frames-split design §4.1, §4.2, §4.4, §5.4, §7.16, §7.17): every recipe reads its tool source by grid frame.
 * The original is opened with `-copyts -seek_timestamp 1 -noaccurate_seek` at the §7.16 seek position (none near its start);
 * every decoded frame goes through the §4.1 placement chain and the frame-number cut; the first frame decoded before the chain
 * is checked, and a late landing seeks again with a doubled back-off. The all-intra edit file starts at 0 and reads frame i
 * at i / fps. Audio is read from the original, shifted by the grid start and cut on the 48 kHz grid (§4.4). The recipe
 * carries what the worker wrote from the frozen plan; nothing here reads P.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKED_PLANE_GAP, checkGridFrames, transitionFitRect } from "@shared/mini-tools/video-encode-plan.js";
import { gridFilterChain, gridLandingLate, gridSeekPosition, type SourceKeyframeStats } from "@shared/upload/frame-grid.js";
import type { FrameRate } from "@shared/upload/frame-grid-rate.js";
import type {
  MiniToolPlanEditEncode, MiniToolPlanEditStitch, MiniToolPlanExpandComposite, MiniToolPlanFrames, MiniToolPlanGrid, MiniToolPlanRecipe, MiniToolPlanStitch,
  MiniToolPlanTarget, MiniToolPlanToolSource, MiniToolPlanTransitionProfile, MiniToolPlanTransitionStitch, MiniToolPlanTransitionWindow,
} from "@shared/upload/mini-tool-plan-types.js";
import type { ContainerFailure } from "@shared/mini-tools/types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { TAGGED_MATRICES } from "@ingest/container/physical-video-probe.js";
import { BT709_TAGS, audioOutput, decodedPicture, picture, placement, scaleMatrix, videoOutput } from "@ingest/container/playback-command.js";
import { editEncode, editMuxer, editPicture } from "@ingest/container/edit-command.js";
import { alphaDecoderArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import { pngSize } from "@ingest/png-size.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";
import { readSceneCutObservations, readYuNetFaces } from "@ingest/container/analysis-detection.js";

export { BT709_TAGS, picture, placement, videoOutput };

/** A recipe that ends on a property of its input, reported as the job's reason rather than `tool_failed`. */
export class RecipeFailure extends Error {
  /**
   * Name the reason.
   * @param reason - The report's reason.
   */
  constructor(readonly reason: ContainerFailure) { super(reason); this.name = "RecipeFailure"; }
}

/** Caller-frozen process IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** The recipes this module runs. */
export type PresentationRecipe = Extract<MiniToolPlanRecipe, { kind: "frame" | "segment" | "people" | "scene_cuts" | "grid_count" | "edit_encode" | "chunk_encode" | "stitch" | "prepare_model_input" | "transition_window" }>
  | MiniToolPlanExpandComposite;
/** The process lifetime and IO bounds of one command. */
export type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** One recipe's local files and lifetime. */
export interface PresentationRecipeRequest {
  /** Any admitted recipe but the lip-sync and model steps, which their own modules run. */
  recipe: PresentationRecipe;
  /** Downloaded files by bound input id. */
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}

const HEAD = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file"];
const ZERO: FrameRate = { numerator: 0, denominator: 1 };
// Paths a filter option names verbatim: mkdtemp and our own file names keep to these.
const PLAIN_PATH = /^[\w./-]+$/u;

/** What the recipes need to know of a source before reading it. */
export interface SourceFacts { audio: boolean; mono: boolean; decoder: string[]; range: "tv" | "pc"; oddSubsampled: boolean }

/**
 * Probe a source for its audio, the decoder options a VP9 or VP8 stream with alpha needs (only libvpx reads the alpha plane),
 * its range and whether its decoded frames are subsampled with an odd side.
 * @param source - The downloaded source.
 * @param run - The lifetime and IO bounds.
 * @returns The facts.
 * @throws {Error} When ffprobe fails.
 */
export async function sourceFacts(source: string, run: Run): Promise<SourceFacts> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries",
    "stream=codec_type,codec_name,channels,width,height,pix_fmt,color_range:stream_tags", "-of", "json", source], run)).toString("utf8")) as {
    streams?: { codec_type?: string; codec_name?: string; channels?: number; width?: number; height?: number; pix_fmt?: string; color_range?: string; tags?: Record<string, string> }[] };
  const video = (answer.streams ?? []).find((stream) => stream.codec_type === "video");
  const audio = (answer.streams ?? []).find((stream) => stream.codec_type === "audio");
  const alphaMode = Object.entries(video?.tags ?? {}).find(([key]) => key.toLowerCase() === "alpha_mode")?.[1];
  const format = video?.pix_fmt ?? "";
  const subsampled = /^yuv[aj]?(420|422|440)p/u.test(format);
  return {
    audio: audio !== undefined, mono: audio?.channels === 1, decoder: alphaDecoderArgs(video?.codec_name, alphaMode),
    range: video?.color_range === "pc" || format.startsWith("yuvj") ? "pc" : "tv",
    oddSubsampled: subsampled && ((video?.width ?? 0) % 2 === 1 || (video?.height ?? 0) % 2 === 1),
  };
}

/** A window of grid frames read from one tool source. */
export interface GridWindow { file: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames }

/**
 * Seconds of an exact rational.
 * @param value - The value.
 * @returns Its number.
 * @throws {never} Never.
 */
function valueOf(value: FrameRate): number {
  return value.numerator / value.denominator;
}

/**
 * The grid a tool source is read on (§7.16): the original on the plan's grid; the edit file from 0, every slot a real frame.
 * @param window - The window.
 * @returns The grid and the keyframe statistics a seek reads.
 * @throws {never} Never.
 */
function readGrid(window: Pick<GridWindow, "grid" | "source">): { grid: MiniToolPlanGrid; keyframes: SourceKeyframeStats } {
  if (window.source.kind === "original") return { grid: window.grid, keyframes: window.source.keyframes };
  return { grid: { ...window.grid, gridStart: ZERO, realFrameCount: window.grid.frameCount },
    keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: window.grid.fps.denominator / window.grid.fps.numerator, allKeyframes: true } };
}

/**
 * The first decoded frame's source time a landing file records, or null when nothing was decoded.
 * @param file - The `metadata=print` file.
 * @returns Seconds, or null.
 * @throws {never} Never.
 */
async function landingTime(file: string): Promise<number | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const match = /pts_time:(-?[\d.]+)/u.exec(text);
  return match === null ? null : Number(match[1]);
}

let landings = 0;

/**
 * Decode a window of grid frames from a tool source (§7.16, §4.1): the source is input 0, opened at the seek position; the
 * graph splits off the first decoded frame to record its time and places every frame on the grid, ending at `[g]` on the
 * window's frames (time base 1/fps, slot k0 first). A first frame past the seek frame, or none, means the seek landed late:
 * the command runs again with the back-off doubled, until it decodes from the start.
 * @param window - The tool source and its frames.
 * @param facts - The source's facts.
 * @param directory - Where the landing record goes.
 * @param run - The lifetime and IO bounds.
 * @param command - The whole FFmpeg argument list from the input arguments and the graph head ending at `[g]`.
 * @returns Nothing once a command landed in time.
 * @throws {RangeError} When the run directory is not a plain path.
 * @throws {Error} When FFmpeg fails.
 */
export async function decodeGridWindow(window: GridWindow, facts: Pick<SourceFacts, "decoder">, directory: string, run: Run,
  command: (input: string[], graph: string) => string[]): Promise<void> {
  const { grid, keyframes } = readGrid(window);
  const seekFrame = Math.min(window.frames.start, grid.realFrameCount - 1);
  for (let attempt = 0; ; attempt += 1) {
    const position = gridSeekPosition({ grid, keyframes, startFrame: window.frames.start }, attempt);
    landings += 1;
    const landing = join(directory, `landing-${landings}.txt`);
    if (!PLAIN_PATH.test(landing)) throw new RangeError("The run directory is not a plain path");
    const input = [...HEAD, "-copyts", "-seek_timestamp", "1", "-noaccurate_seek", ...(position === null ? [] : ["-ss", position.toFixed(6)]), ...facts.decoder, "-i", window.file];
    const graph = `[0:v:0]split=2[gd][gl];[gl]trim=end_frame=1,metadata=mode=add:key=landing:value=1,metadata=mode=print:file=${landing},nullsink;` +
      `[gd]${gridFilterChain({ gridStart: grid.gridStart, fps: grid.fps, startFrame: window.frames.start, endFrame: window.frames.end })},setpts=PTS-STARTPTS[g]`;
    await runPlanCommand("ffmpeg", command(input, graph), run);
    if (position === null || !gridLandingLate({ fps: grid.fps, gridStart: grid.gridStart, seekFrame }, await landingTime(landing))) return;
  }
}

/**
 * The input arguments and graph head of a grid window whose seek lands in time, for a caller that streams the decode (a
 * lip-sync composite): a one-frame run checks the landing first (`decodeGridWindow`), and the streamed decode then opens the
 * same position, so the frames it reads are the window's.
 * @param window - The tool source and its frames.
 * @param facts - The source's facts.
 * @param directory - Where the landing record goes.
 * @param run - The lifetime and IO bounds.
 * @returns The input arguments and the graph head ending at `[g]`.
 * @throws {Error} When FFmpeg fails.
 */
export async function landedGridInput(window: GridWindow, facts: Pick<SourceFacts, "decoder">, directory: string, run: Run): Promise<{ input: string[]; graph: string }> {
  const landed = { input: [] as string[], graph: "" };
  await decodeGridWindow(window, facts, directory, run, (input, graph) => {
    Object.assign(landed, { input, graph });
    return [...input, "-filter_complex", `${graph};[g]null[v]`, "-map", "[v]", "-frames:v", "1", "-f", "null", "-"];
  });
  return landed;
}

/**
 * A grid frame's first audio sample on the 48 kHz grid (§4.4): k / fps × 48000, rounded as FFmpeg `av_rescale` (nearest,
 * halves away from 0).
 * @param frame - The grid frame.
 * @param fps - The grid rate.
 * @returns The sample.
 * @throws {never} Never.
 */
export function gridSample(frame: number, fps: FrameRate): bigint {
  const [a, b] = [BigInt(frame) * 48000n * BigInt(fps.denominator), BigInt(fps.numerator)];
  return a >= 0n ? (2n * a + b) / (2n * b) : -((-2n * a + b) / (2n * b));
}

/**
 * The original's audio over samples [from, to) of the 48 kHz grid as samples from 0 (§4.4): grid time t is the original's
 * time grid start + t; silence before the first sample and after the last; exactly `to − from` samples.
 * @param input - The FFmpeg input index the original is opened at (with `-copyts`).
 * @param gridStart - The original's grid start.
 * @param from - The first sample.
 * @param to - The sample it stops before.
 * @param label - The label the chain ends at.
 * @returns The chain from `[input:a:0]`.
 * @throws {never} Never.
 */
function audioSamples(input: number, gridStart: FrameRate, from: bigint, to: bigint, label: string): string {
  const count = to - from;
  return `[${input}:a:0]asetpts=PTS-(${gridStart.numerator}/${gridStart.denominator})/TB,aresample=48000:async=1:first_pts=0,` +
    `atrim=start_pts=${from}:end_pts=${to},asetpts=PTS-STARTPTS,apad=whole_len=${count},atrim=end_sample=${count}[${label}]`;
}

/**
 * The original's audio over grid frames [k0, k1) (§4.4, `audioSamples`).
 * @param input - The FFmpeg input index the original is opened at (with `-copyts`).
 * @param grid - The original's grid.
 * @param frames - The frames.
 * @param label - The label the chain ends at.
 * @returns The chain from `[input:a:0]`.
 * @throws {never} Never.
 */
export function gridAudio(input: number, grid: Pick<MiniToolPlanGrid, "fps" | "gridStart">, frames: MiniToolPlanFrames, label = "a"): string {
  return audioSamples(input, grid.gridStart, gridSample(frames.start, grid.fps), gridSample(frames.end, grid.fps), label);
}

/**
 * Refuse a written video whose frames are not its grid window's (§4.1 frame count row; `checkGridFrames`).
 * @param file - The written file.
 * @param frames - The window.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing when they match.
 * @throws {Error} `grid_mismatch` when they differ, or when ffprobe fails.
 */
async function checkWritten(file: string, frames: MiniToolPlanFrames, run: Run): Promise<void> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "json", file], run)).toString("utf8")) as { streams?: { nb_read_packets?: string }[] };
  if (checkGridFrames(frames, Number(answer.streams?.[0]?.nb_read_packets)) !== null) throw new Error("grid_mismatch");
}

/**
 * A bound input's downloaded file.
 * @param files - The downloaded inputs by id.
 * @param inputId - The input.
 * @returns Its path.
 * @throws {Error} When it was not downloaded.
 */
export function local(files: ReadonlyMap<string, string>, inputId: string): string {
  const file = files.get(inputId);
  if (file === undefined) throw new Error("Presentation recipe names an input that was not downloaded");
  return file;
}

/**
 * Store JSON facts as text without allowing a string to mimic SVG bytes.
 * @param output - The file.
 * @param value - The value.
 * @returns Nothing once written.
 * @throws {Error} When writing fails.
 */
export async function writeJson(output: string, value: unknown): Promise<void> {
  await writeFile(output, JSON.stringify(value).replace(/</g, "\\u003c"));
}

/**
 * Render one grid frame as a PNG (§7.17 frame row, §5.5): the tool source's frame, decoded with the plan matrix at the display
 * geometry, 8 or 16 bits per channel, RGBA when alpha is kept, cut to the crop box when there is one.
 * @param recipe - The frame recipe.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @param output - The PNG to write.
 * @returns The PNG's size.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When FFmpeg fails or the PNG is incomplete.
 */
async function renderFrame(recipe: Extract<MiniToolPlanRecipe, { kind: "frame" | "people" }> & { crop?: Extract<MiniToolPlanRecipe, { kind: "frame" }>["crop"] },
  request: PresentationRecipeRequest, run: Run, output = request.output): Promise<{ width: number; height: number }> {
  const { target, crop } = recipe;
  const keep = target.alpha === "straight";
  const pixel = keep ? (target.pngBitDepth === 16 ? "rgba64be" : "rgba") : (target.pngBitDepth === 16 ? "rgb48be" : "rgb24");
  const cropped = crop === undefined ? "" : `,crop=${crop.rect.width}:${crop.rect.height}:${crop.rect.x}:${crop.rect.y}:exact=1`;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: { start: recipe.frameIndex, end: recipe.frameIndex + 1 } }, facts, request.directory, run,
    (input, graph) => [...input, "-filter_complex", `${graph};[g]${decodedPicture(target.colorMatrix, facts.range, target.width, target.height, { format: pixel })}${cropped}[v]`,
      "-map", "[v]", "-frames:v", "1", "-c:v", "png", "-f", "image2", output]);
  const size = pngSize(new Uint8Array(await readFile(output)));
  if (size === null) throw new Error("The frame recipe produced no complete PNG");
  return size;
}

/**
 * Render a window of grid frames into a target (§7.17 segment row, §5.4): the tool source's frames [k0, k1) from 0 at 1/fps,
 * opening with a keyframe; a segment or model input adds the original's audio over the same grid time, a chunk has none. A
 * model input may play backwards (a reversed tracking clip) or be resampled on its model grid (§10.2, §10.4).
 * @param recipe - The segment, chunk or model-input recipe.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When FFmpeg fails.
 */
async function renderWindow(recipe: Extract<PresentationRecipe, { kind: "segment" | "chunk_encode" | "prepare_model_input" }>, request: PresentationRecipeRequest, run: Run): Promise<void> {
  if (recipe.kind === "chunk_encode" && recipe.profile !== undefined) { await renderTransitionChunk(recipe as TransitionChunk, request, run); return; }
  const { target, grid, frames } = recipe;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const audioId = recipe.kind === "chunk_encode" || !recipe.audio ? null : recipe.audioInputId ?? recipe.inputId;
  const audioFile = audioId === null ? null : local(request.inputs, audioId);
  const heard = audioFile !== null && (audioFile === file ? facts.audio : (await sourceFacts(audioFile, run)).audio);
  const count = frames.end - frames.start;
  let chain = picture(target, facts.range, "p");
  let fps = grid.fps;
  if (recipe.kind === "prepare_model_input") {
    if (recipe.order === "reverse") chain = `reverse,setpts=N,${chain}`;
    if (recipe.model?.mode === "resample") {
      const slots = recipe.model.frameCount;
      chain = `${chain},fps=fps=${recipe.model.rate}:round=up,tpad=stop_mode=clone:stop=${slots},trim=end_frame=${slots}`;
      fps = { numerator: recipe.model.rate, denominator: 1 };
    }
  }
  const { video, muxer } = videoOutput(target, fps);
  await decodeGridWindow({ file, grid, source: recipe.source, frames }, facts, request.directory, run, (input, graph) => [
    ...input, ...(heard ? ["-i", audioFile] : []),
    "-filter_complex", `${graph};[g]${chain}[v]${heard ? `;${gridAudio(1, grid, frames)}` : ""}`,
    "-map", "[v]", ...video, ...(heard ? audioOutput(target) : ["-an"]), ...muxer, request.output,
  ]);
  if (recipe.kind !== "prepare_model_input" || recipe.model === undefined) await checkWritten(request.output, { start: 0, end: count }, run);
}

/**
 * Encode one edit-file chunk (§4.2, §7.17 edit_encode row): the original's grid frames [k0, k1) from 0, all-intra at the tier,
 * tone mapped once when the plan says so, no audio.
 * @param recipe - The edit chunk.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a matrix has no value.
 * @throws {Error} When FFmpeg fails.
 */
async function encodeEditChunk(recipe: MiniToolPlanEditEncode, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  // ponytail: the ProRes profile is the configured initial 4444; the recipe names the tier, crf and preset only.
  const { video, muxer } = editEncode(recipe.edit.profile, { crf: recipe.edit.crf, preset: recipe.edit.preset, proresProfile: "4444" }, recipe.grid.fps);
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: recipe.frames }, facts, request.directory, run, (input, graph) => [
    ...input, "-filter_complex", `${graph};[g]${editPicture(recipe.color, recipe.toneMap, recipe.edit.profile, facts.oddSubsampled)}[v]`,
    "-map", "[v]", ...video, "-an", ...muxer, request.output,
  ]);
  await checkWritten(request.output, { start: 0, end: recipe.frames.end - recipe.frames.start }, run);
}

/** A grid count's request: its recipe, the downloaded input, a scratch directory and the lifetime and IO bounds. */
export interface GridCountRequest {
  recipe: Extract<MiniToolPlanRecipe, { kind: "grid_count" }>;
  inputs: ReadonlyMap<string, string>;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}

/**
 * Count the original's decoded video frames (§4.1 frame count row, §7.17 grid_count): every frame decoded to null without the
 * grid chain; the last frame's display time and the count, which the job reports and never writes as an object.
 * @param request - The count recipe, its downloaded input and lifetime.
 * @returns The last decoded frame's display time and the decoded frames.
 * @throws {Error} When FFmpeg fails or no frame was decoded.
 */
export async function countPresentationGrid(request: GridCountRequest): Promise<{ lastVideoTime: FrameRate; sourceFrames: number }> {
  request.signal.throwIfAborted();
  const { limits, signal } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  const file = local(request.inputs, request.recipe.inputId);
  const facts = await sourceFacts(file, run);
  const base = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "stream=time_base",
    "-of", "json", file], run)).toString("utf8")) as { streams?: { time_base?: string }[] };
  const tick = /^(\d+)\/(\d+)$/u.exec(base.streams?.[0]?.time_base ?? "");
  if (tick === null) throw new Error("The counted video has no time base");
  const record = join(request.directory, "grid-count.txt");
  await runPlanCommand("ffmpeg", [...HEAD, "-copyts", ...facts.decoder, "-i", file, "-map", "0:v:0",
    "-vf", `metadata=mode=add:key=count:value=1,metadata=mode=print:file=${record}`, "-f", "null", "-"], run);
  let [frames, last] = [0, null as bigint | null];
  for (const match of (await readFile(record, "utf8")).matchAll(/pts:(-?\d+)/gu)) {
    frames += 1;
    const pts = BigInt(match[1]!);
    if (last === null || pts > last) last = pts;
  }
  if (last === null) throw new Error("The counted video decoded no frame");
  const [num, den] = [BigInt(tick[1]!), BigInt(tick[2]!)];
  return { lastVideoTime: { numerator: Number(last * num), denominator: Number(den) }, sourceFrames: frames };
}

/**
 * Refuse chunks whose video codec headers differ (§5.4 stitching row): the codec, profile, size, pixel format, alpha mode and
 * the codec's extradata (H.264 avcC with its SPS and PPS, VP9 codec private).
 * @param chunks - The downloaded chunk files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing when every chunk has the first one's headers.
 * @throws {Error} When a chunk's headers differ or ffprobe fails.
 */
async function sameCodecHeaders(chunks: readonly string[], run: Run): Promise<void> {
  let first: string | null = null;
  for (const chunk of chunks) {
    const headers = JSON.stringify(JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,width,height,pix_fmt,extradata:stream_tags=alpha_mode", "-show_data", "-of", "json", chunk], run)).toString("utf8")).streams);
    if (first === null) first = headers;
    else if (headers !== first) throw new Error("Stitch chunks have different codec headers");
  }
}

/**
 * The concat list of a stitch's chunks: each placed for its grid frames' duration.
 * @param chunks - The chunk files and frame counts.
 * @param fps - The grid rate.
 * @param list - The list file.
 * @returns Nothing once written.
 * @throws {Error} When writing fails.
 */
async function concatList(chunks: readonly { file: string; frames: number }[], fps: FrameRate, list: string): Promise<void> {
  await writeFile(list, chunks.map((chunk) => `file '${chunk.file}'\nduration ${((chunk.frames * fps.denominator) / fps.numerator).toFixed(9)}\n`).join(""));
}

/**
 * Join chunks by stream copy (§5.4 stitching row, §7.17 stitch row): a single-source stitch adds the original's audio over the
 * chunks' grid frames, or the lip-sync stems' sum; an edit stitch writes the edit file with no audio in its tier's container.
 * @param recipe - The stitch.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When the chunks' headers differ, an input is missing or FFmpeg fails.
 */
async function stitch(recipe: MiniToolPlanStitch | MiniToolPlanEditStitch, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const files = recipe.chunks.map((chunk) => local(request.inputs, chunk.inputId));
  await sameCodecHeaders(files, run);
  const list = join(request.directory, "stitch.txt");
  await concatList(recipe.chunks.map((chunk, at) => ({ file: files[at]!, frames: chunk.frames.end - chunk.frames.start })), recipe.grid.fps, list);
  const args = [...HEAD, "-f", "concat", "-safe", "0", "-i", list];
  const window = { start: recipe.chunks[0]!.frames.start, end: recipe.chunks.at(-1)!.frames.end };
  if ("edit" in recipe) {
    await runPlanCommand("ffmpeg", [...args, "-map", "0:v:0", "-c:v", "copy", "-an", ...editMuxer(recipe.edit.profile), request.output], run);
    await checkWritten(request.output, { start: 0, end: window.end - window.start }, run);
    return;
  }
  let graph: string | null = null;
  if (typeof recipe.audio === "object") {
    const samples = gridSample(window.end, recipe.grid.fps) - gridSample(window.start, recipe.grid.fps);
    const labels = recipe.audio.inputs.map((_stem, at) => `[s${at}]`);
    for (const stem of recipe.audio.inputs) args.push("-i", local(request.inputs, stem));
    const heads = recipe.audio.inputs.map((_stem, at) => `[${at + 1}:a:0]aresample=48000,asetpts=PTS-STARTPTS${labels[at]}`);
    const mix = labels.length === 1 ? "anull" : `amix=inputs=${labels.length}:normalize=0:duration=longest`;
    graph = [...heads, `${labels.join("")}${mix},apad=whole_len=${samples},atrim=end_sample=${samples}[a]`].join(";");
  } else if (recipe.audio) {
    const source = local(request.inputs, recipe.inputId);
    if ((await sourceFacts(source, run)).audio) {
      args.push("-copyts", "-i", source);
      graph = gridAudio(1, recipe.grid, window);
    }
  }
  args.push(...(graph === null ? [] : ["-filter_complex", graph]), "-map", "0:v:0", "-c:v", "copy", ...(graph === null ? ["-an"] : audioOutput(recipe.target)),
    ...(recipe.target.format === "webm-vp9" ? ["-f", "webm"] : ["-movflags", "+faststart", "-f", "mp4"]), request.output);
  await runPlanCommand("ffmpeg", args, run);
  await checkWritten(request.output, { start: 0, end: window.end - window.start }, run);
}

/** A transition chunk: a chunk encoded to the transition's output profile at its clip's placement. */
type TransitionChunk = Extract<PresentationRecipe, { kind: "chunk_encode" }> & { profile: MiniToolPlanTransitionProfile; placement: { startFrame: number; inFrame: number } };

/**
 * A transition output profile as an encode target (§7.17 transition output profile row).
 * @param profile - The profile.
 * @returns The target.
 * @throws {never} Never.
 */
function profileTarget(profile: MiniToolPlanTransitionProfile): MiniToolPlanTarget {
  return { width: profile.width, height: profile.height, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: profile.alpha ? "straight" : "none",
    crf: profile.encode.crf, preset: profile.encode.preset, format: profile.codec === "vp9" ? "webm-vp9" : "mp4-h264" };
}

/**
 * The clip frames output frames [s, e) show (§7.17 transition output profile row): output frame k shows the clip's grid frame
 * covering (k − startFrame) / output fps after its in-frame; and the chain that puts the window's frames on their output slots.
 * @param clipFps - The clip's grid rate.
 * @param placementOf - Where the clip sits on the output grid.
 * @param placementOf.startFrame - The output frame it starts at.
 * @param placementOf.inFrame - Its first grid frame.
 * @param profile - The output profile.
 * @param frames - The output frames.
 * @returns The clip frames to read and the chain from them to `count` output frames on 1/fps.
 * @throws {never} Never.
 */
function clipOnOutput(clipFps: FrameRate, placementOf: { startFrame: number; inFrame: number }, profile: MiniToolPlanTransitionProfile, frames: MiniToolPlanFrames): { read: MiniToolPlanFrames; chain: string } {
  const [cn, cd, on, od] = [BigInt(clipFps.numerator), BigInt(clipFps.denominator), BigInt(profile.fps.numerator), BigInt(profile.fps.denominator)];
  const covering = (k: number): number => placementOf.inFrame + Number(((BigInt(k - placementOf.startFrame)) * od * cn) / (on * cd));
  const read = { start: covering(frames.start), end: covering(frames.end - 1) + 1 };
  const count = frames.end - frames.start;
  // The slot of window frame N: ceil((read.start + N − inFrame) × cd·on / (cn·od)) − (s − startFrame), clamped to 0.
  const [a, b] = [cd * on, cn * od];
  const slot = `max(ceil((N+${read.start - placementOf.inFrame})*${a}/${b})-${frames.start - placementOf.startFrame}\\,0)`;
  return { read, chain: `settb=${profile.fps.denominator}/${profile.fps.numerator},setpts=${slot},fps=fps=${profile.fps.numerator}/${profile.fps.denominator}:round=up,` +
    `tpad=stop_mode=clone:stop=${count},trim=end_frame=${count}` };
}

/**
 * Encode one transition chunk outside the overlap window (§7.17 chunk_encode row): the clip's grid frames on the output grid,
 * in its fitted rectangle, encoded with the profile so its headers equal the window chunks'.
 * @param recipe - The chunk.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function renderTransitionChunk(recipe: TransitionChunk, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { profile } = recipe;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const target = profileTarget(profile);
  const fit = transitionFitRect(recipe.target, profile);
  const placed = { ...target, displayRect: profile.alpha ? null : fit, colorMatrix: recipe.target.colorMatrix };
  const { read, chain } = clipOnOutput(recipe.grid.fps, recipe.placement, profile, recipe.frames);
  const head = profile.alpha
    ? `${decodedPicture(recipe.target.colorMatrix, facts.range, fit.width, fit.height, { format: "yuva444p", bt709: true })},pad=${profile.width}:${profile.height}:${fit.x}:${fit.y}:color=black@0,format=yuva420p,${BT709_TAGS}`
    : picture(placed, facts.range, "t");
  const { video, muxer } = videoOutput(target, profile.fps);
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: read }, facts, request.directory, run, (input, graph) => [
    ...input, "-filter_complex", `${graph};[g]${head},${chain}[v]`, "-map", "[v]", ...video, "-an", ...muxer, request.output,
  ]);
}

/** The headless-gl renderer of the MiniToolContainerGl image (the gl variant of packages/ingest/Dockerfile), a separate program. */
const GL_RENDERER = "/app/gl-renderer/render.mjs";

/**
 * Render one chunk of a transition's overlap window (§7.17 transition_window row): each clip's grid frames on the output grid as
 * RGBA in its fitted rectangle; the headless-gl renderer draws output frame k at progress (k − startFrame) / frameCount; FFmpeg
 * encodes them with the profile.
 * @param recipe - The window chunk.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When an input is missing, the renderer or FFmpeg fails.
 */
async function renderTransitionWindow(recipe: MiniToolPlanTransitionWindow, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { profile, frames, window } = recipe;
  const { width, height } = profile;
  const count = frames.end - frames.start;
  const fill = `black@${profile.alpha ? 0 : 1}`;
  const decoded = await Promise.all(recipe.clips.map(async (clip, at) => {
    const file = local(request.inputs, clip.inputId);
    const facts = await sourceFacts(file, run);
    const { read, chain } = clipOnOutput(clip.grid.fps, clip.placement, profile, frames);
    const out = join(request.directory, `transition-${at}.rgba`);
    const convert = `${decodedPicture(clip.colorMatrix, facts.range, clip.fit.width, clip.fit.height, { format: profile.alpha ? "yuva444p" : "yuv444p", bt709: true })},` +
      `scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgba,pad=${width}:${height}:${clip.fit.x}:${clip.fit.y}:color=${fill},setsar=1`;
    await decodeGridWindow({ file, grid: clip.grid, source: clip.source, frames: read }, facts, request.directory, run, (input, graph) => [
      ...input, "-filter_complex", `${graph};[g]${convert},${chain},format=rgba[v]`, "-map", "[v]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", out,
    ]);
    return out;
  }));
  const rendered = join(request.directory, "transition-out.rgba");
  const description = join(request.directory, "transition-request.json");
  await writeJson(description, { width, height, frameCount: count, transition: recipe.transition, from: decoded[0], to: decoded[1], output: rendered,
    progress: Array.from({ length: count }, (_unused, at) => (frames.start + at - window.startFrame) / window.frameCount) });
  await runPlanCommand("node", [GL_RENDERER, description], run);
  const { video, muxer } = videoOutput(profileTarget(profile), profile.fps);
  await runPlanCommand("ffmpeg", [...HEAD, "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", `${profile.fps.numerator}/${profile.fps.denominator}`,
    "-i", rendered, "-vf", `scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=${profile.alpha ? "yuva420p" : "yuv420p"},setsar=1,${BT709_TAGS}`,
    ...video, "-an", ...muxer, request.output], run);
}

/**
 * Join a transition's chunks by stream copy and lay both clips' audio under them (§7.17 stitch and transition rows): each
 * clip's audio over its own span from its in-frame, a clip without audio as silence; a Cut joins them directly and a
 * transition crosses them over the window (`acrossfade c1=tri:c2=tri`). Both meet in stereo.
 * @param recipe - The transition stitch.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When the chunks' headers differ, an input is missing or FFmpeg fails.
 */
async function transitionStitch(recipe: MiniToolPlanTransitionStitch, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const files = recipe.chunks.map((chunk) => local(request.inputs, chunk.inputId));
  await sameCodecHeaders(files, run);
  const list = join(request.directory, "stitch.txt");
  await concatList(recipe.chunks.map((chunk, at) => ({ file: files[at]!, frames: chunk.frames.end - chunk.frames.start })), recipe.profile.fps, list);
  const args = [...HEAD, "-f", "concat", "-safe", "0", "-i", list, "-copyts"];
  const graph: string[] = [];
  const facts = await Promise.all(recipe.clips.map(async (clip) => (clip.audio ? sourceFacts(local(request.inputs, clip.inputId), run) : null)));
  if (facts.some((fact) => fact?.audio === true)) {
    let inputs = 1;
    recipe.clips.forEach((clip, at) => {
      const samples = gridSample(clip.frameCount, recipe.profile.fps);
      if (facts[at]?.audio !== true) { graph.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[d${at}]`); return; }
      args.push("-i", local(request.inputs, clip.inputId));
      const from = gridSample(clip.placement.inFrame, clip.grid.fps);
      graph.push(audioSamples(inputs, clip.grid.gridStart, from, from + samples, `c${at}`));
      inputs += 1;
      graph.push(`[c${at}]${facts[at].mono ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo"},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[d${at}]`);
    });
    graph.push(recipe.crossfade === null ? "[d0][d1]concat=n=2:v=0:a=1[a]" : `[d0][d1]acrossfade=ns=${gridSample(recipe.crossfade.frameCount, recipe.profile.fps)}:c1=tri:c2=tri[a]`);
  }
  const target = profileTarget(recipe.profile);
  args.push(...(graph.length === 0 ? [] : ["-filter_complex", graph.join(";")]), "-map", "0:v:0", "-c:v", "copy",
    ...(graph.length === 0 ? ["-an"] : audioOutput(target)), ...(target.format === "webm-vp9" ? ["-f", "webm"] : ["-movflags", "+faststart", "-f", "mp4"]), request.output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * The scale options that decode a model's video result (erase, expand, lip-sync) from its own tags: a tagged matrix the plan
 * knows, BT.601 otherwise (the providers encode RGB with swscale's default and write no tags); its range, limited when untagged.
 * @param stream - The result's ffprobe video stream.
 * @returns The `in_color_matrix` and `in_range` options.
 * @throws {never} Never.
 */
export function modelResultDecode(stream: Record<string, unknown>): string {
  const tag = stream.color_space;
  const matrix = scaleMatrix(typeof tag === "string" && Object.hasOwn(TAGGED_MATRICES, tag) ? TAGGED_MATRICES[tag]! : "bt601");
  return `in_color_matrix=${matrix}:in_range=${stream.color_range === "pc" ? "pc" : "tv"}`;
}

/**
 * Probe a model's video result for its colour tags and return the scale options that decode it ({@link modelResultDecode}).
 * @param file - The result.
 * @param run - The lifetime and IO bounds.
 * @returns The options.
 * @throws {Error} When ffprobe fails.
 */
export async function probeModelResultDecode(file: string, run: Run): Promise<string> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_range",
    "-of", "json", file], run)).toString("utf8")) as { streams?: Record<string, unknown>[] };
  return modelResultDecode(answer.streams?.[0] ?? {});
}

/**
 * Composite an expand's backgrounds over a chunk (§7.17 model_composite row; execution design §8, §8.1): the source's grid
 * frames at their frozen rectangle over each background laid from its window's start in grid seconds, a later background
 * faded in over its overlap with the one before. The audio is the stitch's.
 * @param recipe - The composite.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When an input is missing or FFprobe or FFmpeg fails.
 */
async function compositeWindow(recipe: MiniToolPlanExpandComposite, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { target, grid, frames } = recipe;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const { rect } = placement(target);
  const origin = valueOf(grid.fps) === 0 ? 0 : frames.start / valueOf(grid.fps);
  const decodes = await Promise.all(recipe.backgrounds.map((background) => probeModelResultDecode(local(request.inputs, background.inputId), run)));
  const count = frames.end - frames.start;
  const { video, muxer } = videoOutput(target, grid.fps);
  await decodeGridWindow({ file, grid, source: recipe.source, frames }, facts, request.directory, run, (input, head) => {
    const args = [...input];
    const graph = [head, `[g]${decodedPicture(target.colorMatrix, facts.range, rect.width, rect.height, { format: "yuv420p", bt709: true })},${BT709_TAGS}[sv]`,
      `color=c=black:s=${target.width}x${target.height}:r=${grid.fps.numerator}/${grid.fps.denominator},format=yuv420p,setsar=1,${BT709_TAGS},trim=end_frame=${count}[b0]`];
    recipe.backgrounds.forEach((background, at) => {
      args.push("-i", local(request.inputs, background.inputId));
      const crop = background.crop === undefined ? "" : `crop=${background.crop.width}:${background.crop.height}:${background.crop.x}:${background.crop.y}:exact=1,`;
      const previous = recipe.backgrounds[at - 1];
      const overlap = previous === undefined ? 0 : valueOf(previous.window.end) - valueOf(background.window.start);
      const fade = overlap <= 0 ? "" : `,setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=${overlap.toFixed(6)}:alpha=1`;
      graph.push(`[${at + 1}:v:0]${crop}scale=${target.width}:${target.height}:${decodes[at]!}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${BT709_TAGS}${fade},` +
        `setpts=PTS-STARTPTS+(${(valueOf(background.window.start) - origin).toFixed(6)})/TB[f${at}]`, `[b${at}][f${at}]overlay[b${at + 1}]`);
    });
    graph.push(`[b${recipe.backgrounds.length}][sv]overlay=${rect.x}:${rect.y},trim=end_frame=${count}[c]`);
    return [...args, "-filter_complex", graph.join(";"), "-map", "[c]", ...video, "-an", ...muxer, request.output];
  });
}

/**
 * Run the pinned detector process on raw BGR frames (the separate Python process).
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
export async function detect(kind: "people" | "scene_cuts" | "faces", profile: unknown, frames: { width: number; height: number; count: number; args: string[] }, directory: string,
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
 * Detect people on the anchor's grid frame (§7.17 people anchor row): the frame rendered at the target size, the candidates in
 * that display geometry.
 * @param recipe - The people recipe.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When rendering, detection or writing fails.
 */
async function detectPeople(recipe: Extract<PresentationRecipe, { kind: "people" }>, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height } = recipe.target;
  const anchor = join(request.directory, "people-anchor.png");
  await renderFrame(recipe, request, run, anchor);
  const result = await detect("people", recipe.profile, { width, height, count: 1,
    args: [...HEAD.filter((arg) => arg !== "-y"), "-i", anchor, "-map", "0:v:0", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  await writeJson(request.output, { schemaVersion: 1, kind: "people", coordinateSpace: "display", width, height, candidates: readYuNetFaces(result.faces, { width, height }, true) });
}

/**
 * Detect scene cuts over grid frames [k0, k1) (§7.17 scene_cuts row): the frames in display geometry, each cut recorded by its
 * grid frame number.
 * @param recipe - The scene_cuts recipe.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When decoding, detection or writing fails.
 */
async function detectScenes(recipe: Extract<PresentationRecipe, { kind: "scene_cuts" }>, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height } = recipe.target;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const count = recipe.frames.end - recipe.frames.start;
  const raw = join(request.directory, "scene-frames.bgr");
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: recipe.frames }, facts, request.directory, run, (input, graph) => [
    ...input, "-filter_complex", `${graph};[g]${decodedPicture(recipe.target.colorMatrix, facts.range, width, height, { format: "bgr24" })}[v]`,
    "-map", "[v]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", raw,
  ]);
  const result = await detect("scene_cuts", recipe.profile, { width, height, count,
    args: [...HEAD.filter((arg) => arg !== "-y"), "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", `${width}x${height}`, "-i", raw, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"] },
  request.directory, request.signal, request.limits);
  const fps = valueOf(recipe.grid.fps);
  const frames = Array.from({ length: count }, (_unused, at) => ({ frameIndex: recipe.frames.start + at, pts: (recipe.frames.start + at) / fps }));
  await writeJson(request.output, { schemaVersion: 1, kind: "scene_cuts",
    cuts: readSceneCutObservations(result.cuts, frames).map((cut) => ({ frameIndex: cut.frameIndex, detectionScore: cut.detectionScore })) });
}

/** The bounds and lifetime an output is read back with. */
type ReadBack = Pick<PresentationRecipeRequest, "signal" | "limits">;

/**
 * Read back the media numbers of a written output.
 * @param output - The written file.
 * @param request - The lifetime and IO bounds.
 * @returns What ffprobe reads of it.
 * @throws {Error} When ffprobe fails.
 */
export async function readMediaMetadata(output: string, request: ReadBack): Promise<{ width: number | null; height: number | null; durationSeconds: number | null }> {
  return pickMediaMetadata(readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output, "own-file"),
    { signal: request.signal, stdoutBytes: request.limits.probeStdoutBytes, stderrTailBytes: request.limits.stderrTailBytes })).toString("utf8")));
}

/**
 * Read back the media numbers of a written video output.
 * @param output - The written file.
 * @param request - The lifetime and IO bounds.
 * @param kind - The recipe kind, for the failure message.
 * @returns Its width, height and duration.
 * @throws {Error} When ffprobe fails or the output has no complete video metadata.
 */
export async function readVideoMetadata(output: string, request: ReadBack, kind: string): Promise<{ width: number; height: number; durationSeconds: number }> {
  const metadata = await readMediaMetadata(output, request);
  if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null) throw new Error(`The ${kind} recipe produced no complete video metadata`);
  return { width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds };
}

const NO_MEDIA: MediaOfOutput = { width: null, height: null, durationSeconds: null, cover: null };

/**
 * Run one grid recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers, and for a packed stitch its packing geometry (the DO writes the manifest).
 * @throws {Error} When a process fails or the output has no complete video metadata.
 */
export async function executePresentationRecipe(request: PresentationRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { recipe, signal, limits } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  switch (recipe.kind) {
    case "frame": return { ...await renderFrame(recipe, request, run), durationSeconds: null, cover: null };
    case "people": await detectPeople(recipe, request, run); return NO_MEDIA;
    case "scene_cuts": await detectScenes(recipe, request, run); return NO_MEDIA;
    case "grid_count": throw new Error("A grid count is the job's count, never an output (§7.17 grid_count)");
    case "edit_encode": await encodeEditChunk(recipe, request, run); break;
    case "stitch": await ("clips" in recipe && recipe.clips !== undefined ? transitionStitch(recipe, request, run)
      : stitch(recipe as MiniToolPlanStitch | MiniToolPlanEditStitch, request, run)); break;
    case "model_composite": await compositeWindow(recipe, request, run); break;
    case "transition_window": await renderTransitionWindow(recipe, request, run); break;
    default: await renderWindow(recipe, request, run);
  }
  const metadata = await readVideoMetadata(request.output, request, recipe.kind);
  if (recipe.kind !== "stitch" || "clips" in recipe || "edit" in recipe || (recipe).target.alpha !== "packed") return { ...metadata, cover: null };
  const { rect, planeWidth } = placement((recipe).target);
  return { ...metadata, cover: null, packing: { packedWidth: (recipe).target.width, packedHeight: (recipe).target.height,
    colorRect: rect, alphaRect: { ...rect, x: rect.x + planeWidth + PACKED_PLANE_GAP } } };
}
