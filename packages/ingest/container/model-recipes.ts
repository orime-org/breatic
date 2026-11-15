// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The erase, expand and tracking recipes (inner#1306 execution design §10.2–§10.5): the tracking join, the erase mask, the
 * expand window, its mask and condition frame, and the erase composite.
 */
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gridFrameSlot, gridSlotFrame, presentationGridFrames, type ModelGrid } from "@shared/mini-tools/model-grid.js";
import { presentationRunOffsets, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
import type {
  MiniToolPlanBriaMask, MiniToolPlanEraseComposite, MiniToolPlanFrameAt, MiniToolPlanModelWindow, MiniToolPlanModelWindowMask, MiniToolPlanRecipe,
  MiniToolPlanRleJoin, MiniToolPlanTarget,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { presentationTimes, readRleTrack, rleForeground } from "@ingest/container/rle-track.js";
import {
  BT709_TAGS, decodedPicture, local, minus, modelResultDecode, picture, placement, probeModelResultDecode, readVideoMetadata, RecipeFailure, roundTimes, seconds, span,
  videoOutput, windowGraph, type PlanLimits,
} from "@ingest/container/presentation-recipes.js";
import { rational } from "@shared/mini-tools/video-presentation-projection.js";
import { pngSize } from "@ingest/png-size.js";

/** The recipes this module runs. */
export type ModelRecipe = MiniToolPlanRleJoin | MiniToolPlanBriaMask | MiniToolPlanModelWindow | MiniToolPlanModelWindowMask | MiniToolPlanFrameAt | MiniToolPlanEraseComposite;
/** One model recipe's local files and lifetime. */
export interface ModelRecipeRequest {
  recipe: ModelRecipe;
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}
/** The process lifetime and IO bounds of one command. */
type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** A presented frame's interval in seconds. */
interface TableFrame { start: number; end: number }

const HEAD = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file"];
// A lossless full-range H.264 mask: what the erase model and VACE read as white and black exactly.
const LOSSLESS_MASK = ["-c:v", "libx264", "-crf", "0", "-bf", "0", "-pix_fmt", "yuv420p", "-color_range", "pc"];
const FULL_RANGE = "scale=in_range=pc:out_range=pc,format=yuv420p";

/**
 * Whether a recipe is one this module runs.
 * @param recipe - A validated recipe.
 * @returns True for the tracking join, the erase and expand steps and the erase composite.
 * @throws {never} Never.
 */
export function isModelRecipe(recipe: MiniToolPlanRecipe): recipe is ModelRecipe {
  return recipe.kind === "rle_join" || recipe.kind === "bria_mask" || recipe.kind === "model_window" || recipe.kind === "model_window_mask"
    || recipe.kind === "frame_at" || (recipe.kind === "model_composite" && recipe.mode === "erase");
}

/**
 * The presented frames [startFrame, startFrame + count) of a table, in seconds.
 * @param table - The presentation table.
 * @param startFrame - The first frame's ordinal.
 * @param count - How many frames.
 * @returns Each frame's [start, end).
 * @throws {RangeError} When a frame lies outside the table.
 */
function tableFrames(table: VideoPresentationTable, startFrame: number, count: number): TableFrame[] {
  const offsets = presentationRunOffsets(table);
  if (startFrame < 0 || startFrame + count > offsets.at(-1)!) throw new RangeError("Frames lie outside the presentation table");
  const frames: TableFrame[] = [];
  let run = 0;
  for (let index = startFrame; index < startFrame + count; index += 1) {
    while (offsets[run + 1]! <= index) run += 1;
    const entry = table.runs[run]!;
    const start = entry.start + (index - offsets[run]!) * entry.step;
    frames.push({ start: start / table.timescale, end: (start + entry.duration) / table.timescale });
  }
  return frames;
}

/**
 * Join the forward and reversed tracking clips' RLE over the range (execution design §10.2): the reversed clip back in source
 * order without its anchor frame when a forward clip follows, then the forward clip.
 * @param recipe - The join.
 * @param request - Its files.
 * @returns Nothing once written.
 * @throws {RecipeFailure} `tracking_output_mismatch` when a clip's frames or a mask's size differ, `empty_foreground` when no
 * frame has foreground.
 */
async function joinTracks(recipe: MiniToolPlanRleJoin, request: ModelRecipeRequest): Promise<void> {
  const tracks = await Promise.all(recipe.inputs.map(async (input) => {
    const track = await readRleTrack(local(request.inputs, input.inputId));
    if (track.length !== input.frameCount) throw new RecipeFailure("tracking_output_mismatch");
    return { order: input.order, track };
  }));
  const forward = tracks.find((track) => track.order === "forward")?.track;
  const reverse = tracks.find((track) => track.order === "reverse")?.track;
  const before = reverse === undefined ? [] : [...reverse].reverse();
  const joined = [...(forward === undefined ? before : before.slice(0, Math.max(0, before.length - 1))), ...(forward ?? [])];
  let empty = true;
  for (const counts of joined) {
    const mask = rleForeground(counts, recipe, 255);
    if (empty && mask.includes(255)) empty = false;
  }
  if (empty) throw new RecipeFailure("empty_foreground");
  await writeFile(request.output, JSON.stringify(joined));
}

/**
 * Frame timing on a clock of `clock` ticks a second: each frame lasts until the next, the last until `end`.
 * @param clock - Ticks a second.
 * @param end - The end tick.
 * @returns The encoder timing arguments.
 * @throws {never} Never.
 */
function timingTo(clock: number, end: number): string[] {
  return ["-fps_mode", "passthrough", "-enc_time_base:v", `1/${clock}`, "-video_track_timescale", String(clock),
    "-bsf:v", `setts=duration=if(eq(NEXT_PTS\\,NOPTS)\\,${end}-PTS\\,NEXT_PTS-PTS)`];
}

/**
 * The timing of a grid's frames from 0: frame N at N / rate on a 1/90000 clock, the last lasting to frameCount / rate.
 * @param grid - The grid.
 * @returns The filter text and the encoder timing arguments.
 * @throws {never} Never.
 */
function gridTiming(grid: ModelGrid): { filter: string; timing: string[] } {
  return { filter: `settb=1/90000,setpts=round(N*90000/${grid.rate})`, timing: timingTo(90000, Math.round((grid.frameCount * 90000) / grid.rate)) };
}

/**
 * The erase model's mask video (execution design §10.4): one frame per grid slot, white where that slot's RLE frame has
 * foreground, lossless and full range, at the prepared input's size.
 * @param recipe - The mask.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RecipeFailure} `tracking_output_mismatch` when the RLE does not cover the range at the target size.
 * @throws {Error} When FFmpeg fails.
 */
async function eraseMask(recipe: MiniToolPlanBriaMask, request: ModelRecipeRequest, run: Run): Promise<void> {
  const track = await readRleTrack(local(request.inputs, recipe.inputId));
  if (track.length !== recipe.range.frameCount) throw new RecipeFailure("tracking_output_mismatch");
  const frames = presentationGridFrames(recipe.table, recipe.range.startFrame, recipe.range.frameCount);
  const size = recipe.target;
  const raw = Buffer.alloc(size.width * size.height * recipe.grid.frameCount);
  for (let slot = 0; slot < recipe.grid.frameCount; slot += 1) {
    const mask = rleForeground(track[gridSlotFrame(recipe.grid, frames, slot)] ?? null, size, 255);
    raw.set(mask, slot * size.width * size.height);
  }
  const file = join(request.directory, "erase-mask.gray");
  await writeFile(file, raw);
  const { filter, timing } = gridTiming(recipe.grid);
  await runPlanCommand("ffmpeg", [...HEAD, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-i", file,
    "-vf", `${FULL_RANGE},${filter}`, ...LOSSLESS_MASK, ...timing, "-movflags", "+faststart", "-f", "mp4", request.output], run);
}

/**
 * One expand window's model input (execution design §10.5): each grid slot shows the frame covering span.start + j / fps,
 * scaled into `sourceRoi` over the fill colour; slots past the span repeat its last frame; lossless.
 * @param recipe - The window.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When FFmpeg fails.
 */
async function modelWindow(recipe: MiniToolPlanModelWindow, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { frame, sourceRoi: roi, fill, grid } = recipe;
  const clock = BigInt(recipe.timescale);
  const origin = span(recipe.entries[0]!).start;
  const hex = fill.map((channel) => channel.toString(16).padStart(2, "0")).join("");
  // The frames are tagged BT.709 limited range before the pad, so the RGB fill colour is converted with that matrix.
  const window = await windowGraph(recipe.entries, clock, local(request.inputs, recipe.inputId), run,
    (label, colour) => `${decodedPicture(recipe.target, roi.width, roi.height, colour, label, { format: "yuv444p", bt709: true })},${BT709_TAGS},` +
      `pad=${frame.width}:${frame.height}:${roi.x}:${roi.y}:color=0x${hex}`,
    () => `color=c=0x${hex}:s=${frame.width}x${frame.height}:r=1:d=1,format=yuv444p,${BT709_TAGS}`);
  // The span can start or end between the window clock's ticks, so it is placed on a 1/90000 clock.
  const fine = 90000n;
  const shift = roundTimes(minus(recipe.span.start, origin), fine);
  const end = roundTimes(minus(recipe.span.end, origin), fine);
  // The window's frames up to the span's end, then one clone placed at the end so `fps` emits the slot the last frames fall
  // into; frames before the span's start all land on 0, so slot 0 shows the one covering the start.
  window.graph.push(`${window.graph.pop()!.replace(/\[v\]$/u, "[w]")};[w]settb=1/${fine},trim=end=${seconds([end, fine])},tpad=stop_mode=clone:stop=1,` +
    `setpts=if(lte(PTS\\,PREV_INPTS)\\,${end - shift}\\,max(PTS-${shift}\\,0)),` +
    `fps=fps=${grid.fps}:round=up,tpad=stop_mode=clone:stop=${grid.frameCount},trim=end_frame=${grid.frameCount},format=yuv420p,setsar=1,${BT709_TAGS}[v]`);
  const lossless: MiniToolPlanTarget = { ...recipe.target, width: frame.width, height: frame.height, displayRect: null, crf: 0, alpha: "none", format: undefined };
  const { video, muxer } = videoOutput(lossless, BigInt(grid.fps), BigInt(grid.frameCount));
  await runPlanCommand("ffmpeg", [...window.args, "-filter_complex", window.graph.join(";"), "-map", "[v]", ...video, "-an", ...muxer, request.output], run);
}

/**
 * One expand window's mask (execution design §10.5): black inside `sourceRoi`, white elsewhere, one frame per grid slot,
 * lossless and full range.
 * @param recipe - The mask.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function windowMask(recipe: MiniToolPlanModelWindowMask, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { frame, sourceRoi: roi, grid } = recipe;
  const plane = Buffer.alloc(frame.width * frame.height, 255);
  for (let y = roi.y; y < roi.y + roi.height; y += 1) plane.fill(0, y * frame.width + roi.x, y * frame.width + roi.x + roi.width);
  const file = join(request.directory, "window-mask.gray");
  await writeFile(file, plane);
  await runPlanCommand("ffmpeg", [...HEAD, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${frame.width}x${frame.height}`, "-i", file,
    "-vf", `loop=loop=${grid.frameCount - 1}:size=1:start=0,${FULL_RANGE},settb=1/${grid.fps},setpts=N`, ...LOSSLESS_MASK,
    ...timingTo(grid.fps, grid.frameCount), "-movflags", "+faststart", "-f", "mp4", request.output], run);
}

/**
 * The PNG of the frame whose presentation time is closest to `time`, the earlier on a tie (execution design §10.5 condition),
 * decoded from the previous window's model result with its own colour tags ({@link modelResultDecode}).
 * @param recipe - The condition frame.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When the result's tagged matrix has no decode value.
 * @throws {Error} When the video has no frame or FFmpeg fails.
 */
async function frameAt(recipe: MiniToolPlanFrameAt, request: ModelRecipeRequest, run: Run): Promise<void> {
  const source = local(request.inputs, recipe.inputId);
  const { times, stream } = await presentationTimes(source, run);
  if (times.length === 0) throw new Error("The condition video has no frame");
  const [numerator, denominator] = rational(recipe.time);
  const target = Number(numerator) / Number(denominator);
  let best = 0;
  times.forEach((time, at) => { if (Math.abs(time - target) < Math.abs(times[best]! - target) - 1e-9) best = at; });
  await runPlanCommand("ffmpeg", [...HEAD, "-i", source, "-vf", `select=eq(n\\,${best}),scale=${recipe.target.width}:${recipe.target.height}:${modelResultDecode(stream)},format=rgb24`,
    "-frames:v", "1", "-fps_mode", "passthrough", "-f", "image2", "-c:v", "png", "-update", "1", request.output], run);
}

/**
 * A one-frame 4:4:4 Y4M image: a header naming its size and format, then the Y, U and V planes.
 * @param width - Its width.
 * @param height - Its height.
 * @param planes - The three planes, `width × height` bytes each.
 * @returns The file bytes.
 * @throws {never} Never.
 */
function y4m(width: number, height: number, planes: readonly Uint8Array[]): Buffer {
  // A 1/90000 frame rate, so the concat list's durations place each image on that clock.
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F90000:1 Ip A1:1 C444\nFRAME\n`, "ascii"), ...planes]);
}

/**
 * Composite the erase model's result over a chunk (execution design §10.4 composite row): each frame in the range shows its
 * grid slot's result frame through its RLE mask, dilated by `matte.dilate` pixels and feathered by `matte.feather`, at the
 * picture's size (source × (1 − m) + result × m, per 4:4:4 plane, so the source outside the mask is kept as decoded);
 * outside the range the source. The result's own timestamps are ignored: the result frames and masks are laid out per chunk
 * frame with the chunk's presented durations, on its clock. The result is decoded with its own colour tags ({@link modelResultDecode}).
 * @param recipe - The composite.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RecipeFailure} `model_output_mismatch` when a chunk with frames in the range reads a result with another frame
 * count than the grid, `tracking_output_mismatch` when the RLE does not cover the range.
 * @throws {RangeError} When the result's tagged matrix has no decode value.
 * @throws {Error} When FFprobe or FFmpeg fails.
 */
async function eraseComposite(recipe: MiniToolPlanEraseComposite, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { target, range, grid, matte } = recipe;
  const { rect } = placement(target);
  const clock = BigInt(recipe.timescale);
  const directory = request.directory;
  const area = rect.width * rect.height;
  const rangeFrames = presentationGridFrames(recipe.table, range.startFrame, range.frameCount);
  const count = recipe.window.end - recipe.window.start;
  const chunk = tableFrames(recipe.table, recipe.window.start, count);
  // The grid slot each of this chunk's frames inside the range shows; a chunk outside the range decodes no result.
  const slots = new Map<number, number>();
  for (let n = 0; n < count; n += 1) {
    const inRange = recipe.window.start + n - range.startFrame;
    if (inRange >= 0 && inRange < range.frameCount) slots.set(n, gridFrameSlot(grid, rangeFrames, inRange));
  }
  if (slots.size > 0) {
    const decoded = join(directory, "result.yuv");
    const result = local(request.inputs, recipe.result);
    await runPlanCommand("ffmpeg", [...HEAD, "-i", result, "-fps_mode", "passthrough",
      "-vf", `scale=${rect.width}:${rect.height}:${await probeModelResultDecode(result, run)}:out_color_matrix=bt709:out_range=tv,format=yuv444p`, "-f", "rawvideo", decoded], run);
    const resultFile = await open(decoded, "r");
    try {
      const { size } = await resultFile.stat();
      if (size !== grid.frameCount * area * 3) throw new RecipeFailure("model_output_mismatch");
      const frame = Buffer.alloc(area * 3);
      for (const slot of new Set(slots.values())) {
        await resultFile.read(frame, 0, frame.length, slot * frame.length);
        await writeFile(join(directory, `result-${slot}.y4m`), y4m(rect.width, rect.height, [frame.subarray(0, area), frame.subarray(area, 2 * area), frame.subarray(2 * area)]));
      }
    } finally { await resultFile.close(); }
  }
  const track = await readRleTrack(local(request.inputs, recipe.rle));
  if (track.length !== range.frameCount) throw new RecipeFailure("tracking_output_mismatch");
  // Each concat list holds one image format; a blank result is black and a blank mask keeps the source.
  const blank = { result: join(directory, "blank-result.y4m"), mask: join(directory, "blank-mask.y4m") };
  await writeFile(blank.result, y4m(rect.width, rect.height, [new Uint8Array(area).fill(16), new Uint8Array(area).fill(128), new Uint8Array(area).fill(128)]));
  const maskArea = recipe.rleSize.width * recipe.rleSize.height;
  await writeFile(blank.mask, y4m(recipe.rleSize.width, recipe.rleSize.height, [new Uint8Array(maskArea), new Uint8Array(maskArea), new Uint8Array(maskArea)]));
  const resultList: string[] = [];
  const maskList: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const duration = (n + 1 < count ? chunk[n + 1]!.start : chunk[n]!.end) - chunk[n]!.start;
    const inRange = recipe.window.start + n - range.startFrame;
    const slot = slots.get(n);
    let result = blank.result;
    let mask = blank.mask;
    if (slot !== undefined) {
      result = join(directory, `result-${slot}.y4m`);
      const pixels = rleForeground(track[inRange] ?? null, recipe.rleSize, 255);
      mask = join(directory, `mask-${n}.y4m`);
      // Every plane carries the mask, so colour is blended by the same weight as luma.
      await writeFile(mask, y4m(recipe.rleSize.width, recipe.rleSize.height, [pixels, pixels, pixels]));
    }
    resultList.push(`file '${result}'`, `duration ${duration.toFixed(6)}`);
    maskList.push(`file '${mask}'`, `duration ${duration.toFixed(6)}`);
  }
  // The concat demuxer applies the last duration only when the last file is listed once more.
  resultList.push(resultList.at(-2)!); maskList.push(maskList.at(-2)!);
  const lists = { result: join(directory, "results.txt"), mask: join(directory, "masks.txt") };
  await writeFile(lists.result, `ffconcat version 1.0\n${resultList.join("\n")}\n`);
  await writeFile(lists.mask, `ffconcat version 1.0\n${maskList.join("\n")}\n`);
  const window = await windowGraph(recipe.entries, clock, local(request.inputs, recipe.inputId), run, (label, colour) => decodedPicture(target, rect.width, rect.height, colour, label, { format: "yuv444p", bt709: true }),
    () => `color=c=black:s=${rect.width}x${rect.height}:r=1:d=1,format=yuv444p`);
  const { args, graph } = window;
  const resultInput = window.inputs;
  args.push("-f", "concat", "-safe", "0", "-i", lists.result, "-f", "concat", "-safe", "0", "-i", lists.mask);
  const widen = Array.from({ length: matte.dilate }, () => "dilation").join(",");
  const soften = matte.feather > 0 ? `gblur=sigma=${matte.feather}` : "";
  const maskChain = [`scale=${rect.width}:${rect.height}:flags=neighbor`, widen, soften].filter((part) => part !== "").join(",");
  // All three inputs carry the source's BT.709 limited-range tags, so no conversion is inserted before the merge; the mask's
  // values are weights.
  graph.push(`[${resultInput}:v:0]settb=1/${clock},${BT709_TAGS}[r]`, `[${resultInput + 1}:v:0]${maskChain},settb=1/${clock},${BT709_TAGS}[m]`,
    `[v][r][m]maskedmerge,trim=end_frame=${count},${picture({ ...target, colorMatrix: "bt709", toneMap: "none" }, "o", null)}[c]`);
  const { video, muxer } = videoOutput(target, clock, roundTimes(minus(span(recipe.entries[recipe.entries.length - 1]!).end, span(recipe.entries[0]!).start), clock));
  await runPlanCommand("ffmpeg", [...args, "-filter_complex", graph.join(";"), "-map", "[c]", ...video, "-an", ...muxer, request.output], run);
}

/**
 * Run one model recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers.
 * @throws {RecipeFailure} When an input does not meet the recipe (its reason is the report's).
 * @throws {Error} When a process fails or the output has no complete metadata.
 */
export async function executeModelRecipe(request: ModelRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { recipe, signal, limits } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  if (recipe.kind === "rle_join") {
    await joinTracks(recipe, request);
    return { width: null, height: null, durationSeconds: null, cover: null };
  }
  if (recipe.kind === "frame_at") {
    await frameAt(recipe, request, run);
    const size = pngSize(new Uint8Array(await readFile(request.output)));
    return { width: size?.width ?? null, height: size?.height ?? null, durationSeconds: null, cover: null };
  }
  if (recipe.kind === "bria_mask") await eraseMask(recipe, request, run);
  else if (recipe.kind === "model_window") await modelWindow(recipe, request, run);
  else if (recipe.kind === "model_window_mask") await windowMask(recipe, request, run);
  else await eraseComposite(recipe, request, run);
  return { ...await readVideoMetadata(request.output, request, recipe.kind), cover: null };
}
