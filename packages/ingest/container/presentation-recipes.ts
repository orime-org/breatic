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
import { PACKED_PLANE_GAP, checkGridFrames } from "@shared/mini-tools/video-encode-plan.js";
import { gridFilterChain, gridLandingLate, gridSeekPosition, type SourceKeyframeStats } from "@shared/upload/frame-grid.js";
import type { FrameRate } from "@shared/upload/frame-grid-rate.js";
import type {
  MiniToolPlanEditEncode, MiniToolPlanEditStitch, MiniToolPlanFrames, MiniToolPlanGrid, MiniToolPlanRecipe, MiniToolPlanStitch, MiniToolPlanToolSource,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { BT709_TAGS, audioOutput, decodedPicture, picture, placement, videoOutput } from "@ingest/container/playback-command.js";
import { editEncode, editMuxer, editPicture } from "@ingest/container/edit-command.js";
import { alphaDecoderArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import { pngSize } from "@ingest/png-size.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";
import { readSceneCutObservations } from "@ingest/container/analysis-detection.js";

export { BT709_TAGS, picture, placement, videoOutput };

/** Caller-frozen process IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** The recipes this module runs. */
export type PresentationRecipe = MiniToolPlanRecipe;
/** The process lifetime and IO bounds of one command. */
export type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** One recipe's local files and lifetime. */
export interface PresentationRecipeRequest {
  /** Any admitted recipe. */
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
async function renderFrame(recipe: Extract<MiniToolPlanRecipe, { kind: "frame" }>, request: PresentationRecipeRequest, run: Run,
  output = request.output): Promise<{ width: number; height: number }> {
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
 * opening with a keyframe; a segment adds the original's audio over the same grid time, a chunk has none.
 * @param recipe - The segment or chunk recipe.
 * @param request - Its files and lifetime.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When FFmpeg fails.
 */
async function renderWindow(recipe: Extract<PresentationRecipe, { kind: "segment" | "chunk_encode" }>, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { target, grid, frames } = recipe;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const audioId = recipe.kind === "chunk_encode" || !recipe.audio ? null : recipe.audioInputId ?? recipe.inputId;
  const audioFile = audioId === null ? null : local(request.inputs, audioId);
  const heard = audioFile !== null && (audioFile === file ? facts.audio : (await sourceFacts(audioFile, run)).audio);
  const count = frames.end - frames.start;
  const chain = picture(target, facts.range, "p");
  const { video, muxer } = videoOutput(target, grid.fps);
  await decodeGridWindow({ file, grid, source: recipe.source, frames }, facts, request.directory, run, (input, graph) => [
    ...input, ...(heard ? ["-i", audioFile] : []),
    "-filter_complex", `${graph};[g]${chain}[v]${heard ? `;${gridAudio(1, grid, frames)}` : ""}`,
    "-map", "[v]", ...video, ...(heard ? audioOutput(target) : ["-an"]), ...muxer, request.output,
  ]);
  await checkWritten(request.output, { start: 0, end: count }, run);
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
 * chunks' grid frames; an edit stitch writes the edit file with no audio in its tier's container.
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
  if (recipe.audio) {
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
export async function detect(kind: "scene_cuts", profile: unknown, frames: { width: number; height: number; count: number; args: string[] }, directory: string,
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
    case "scene_cuts": await detectScenes(recipe, request, run); return NO_MEDIA;
    case "grid_count": throw new Error("A grid count is the job's count, never an output (§7.17 grid_count)");
    case "edit_encode": await encodeEditChunk(recipe, request, run); break;
    case "stitch": await stitch(recipe, request, run); break;
    default: await renderWindow(recipe, request, run);
  }
  const metadata = await readVideoMetadata(request.output, request, recipe.kind);
  if (recipe.kind !== "stitch" || "edit" in recipe || recipe.target.alpha !== "packed") return { ...metadata, cover: null };
  const { rect, planeWidth } = placement(recipe.target);
  return { ...metadata, cover: null, packing: { packedWidth: recipe.target.width, packedHeight: recipe.target.height,
    colorRect: rect, alphaRect: { ...rect, x: rect.x + planeWidth + PACKED_PLANE_GAP } } };
}
