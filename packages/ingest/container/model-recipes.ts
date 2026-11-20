// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The erase, expand and tracking recipes (inner#1306 execution design §10.2–§10.5): the tracking join, the erase mask, the
 * expand window, its mask and condition frame, and the erase composite.
 */
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gridFrameSlot, gridSlotFrame, type ModelGrid } from "@shared/mini-tools/model-grid.js";
import type {
  MiniToolPlanBriaMask, MiniToolPlanGrid, MiniToolPlanEraseComposite, MiniToolPlanFrameAt, MiniToolPlanModelWindow, MiniToolPlanModelWindowMask, MiniToolPlanRecipe,
  MiniToolPlanRleJoin, MiniToolPlanTarget,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { readRleTrack, rleForeground } from "@ingest/container/rle-track.js";
import {
  BT709_TAGS, decodeGridWindow, local, picture, placement, probeModelResultDecode, readVideoMetadata, RecipeFailure, sourceFacts, videoOutput, type PlanLimits,
} from "@ingest/container/presentation-recipes.js";
import { decodedPicture } from "@ingest/container/playback-command.js";
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
 * The erase model's mask video (execution design §10.4): one frame per model slot, white where the range frame that slot shows
 * has foreground, lossless and full range, at the prepared input's size.
 * @param recipe - The mask.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RecipeFailure} `tracking_output_mismatch` when the RLE does not cover the range.
 * @throws {Error} When FFmpeg fails.
 */
async function eraseMask(recipe: MiniToolPlanBriaMask, request: ModelRecipeRequest, run: Run): Promise<void> {
  const track = await readRleTrack(local(request.inputs, recipe.inputId));
  if (track.length !== recipe.range.frameCount) throw new RecipeFailure("tracking_output_mismatch");
  const size = recipe.target;
  const raw = Buffer.alloc(size.width * size.height * recipe.model.frameCount);
  for (let slot = 0; slot < recipe.model.frameCount; slot += 1) {
    const mask = rleForeground(track[gridSlotFrame(recipe.model, recipe.fps, slot)] ?? null, size, 255);
    raw.set(mask, slot * size.width * size.height);
  }
  const file = join(request.directory, "erase-mask.gray");
  await writeFile(file, raw);
  const { filter, timing } = gridTiming(recipe.model);
  await runPlanCommand("ffmpeg", [...HEAD, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-i", file,
    "-vf", `${FULL_RANGE},${filter}`, ...LOSSLESS_MASK, ...timing, "-movflags", "+faststart", "-f", "mp4", request.output], run);
}

/**
 * The chain that puts grid frames [fs, …) on a model window's slots (§10.5): slot j shows the grid frame covering
 * span.start + j / fps, slots past the span repeat its last frame; exactly `count` slots.
 * @param grid - The grid fps and the window's first grid frame.
 * @param grid.fps - The grid rate.
 * @param grid.first - The first grid frame decoded.
 * @param spanStart - The span's start in grid seconds.
 * @param model - The model window grid.
 * @returns The filter chain text, on 1/fps.
 * @throws {never} Never.
 */
function onModelSlots(grid: { fps: MiniToolPlanGrid["fps"]; first: number }, spanStart: MiniToolPlanGrid["gridStart"], model: { fps: number; frameCount: number }): string {
  // slot(m) = ceil(((first + m) / gridFps − spanStart) × modelFps), clamped to 0.
  const a = grid.fps.denominator * spanStart.denominator;
  const b = spanStart.numerator * grid.fps.numerator;
  const c = grid.fps.numerator * spanStart.denominator;
  return `settb=1/${model.fps},setpts=max(ceil(((N+${grid.first})*${a}-${b})*${model.fps}/${c})\\,0),fps=fps=${model.fps}:round=up,` +
    `tpad=stop_mode=clone:stop=${model.frameCount},trim=end_frame=${model.frameCount}`;
}

/**
 * One expand window's model input (execution design §10.5): each slot shows the grid frame covering span.start + j / fps, scaled
 * into `sourceRoi` over the fill colour; lossless.
 * @param recipe - The window.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function modelWindow(recipe: MiniToolPlanModelWindow, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { frame, sourceRoi: roi, fill, model } = recipe;
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const hex = fill.map((channel) => channel.toString(16).padStart(2, "0")).join("");
  const chain = `${decodedPicture(recipe.target.colorMatrix, facts.range, roi.width, roi.height, { format: "yuv444p", bt709: true })},${BT709_TAGS},` +
    `pad=${frame.width}:${frame.height}:${roi.x}:${roi.y}:color=0x${hex},${onModelSlots({ fps: recipe.grid.fps, first: recipe.frames.start }, recipe.span.start, model)},` +
    `format=yuv420p,setsar=1,${BT709_TAGS}`;
  const lossless: MiniToolPlanTarget = { ...recipe.target, width: frame.width, height: frame.height, displayRect: null, crf: 0, alpha: "none", format: undefined };
  const { video, muxer } = videoOutput(lossless, { numerator: model.fps, denominator: 1 });
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: recipe.frames }, facts, request.directory, run, (input, graph) => [
    ...input, "-filter_complex", `${graph};[g]${chain}[v]`, "-map", "[v]", ...video, "-an", ...muxer, request.output,
  ]);
}

/**
 * One expand window's mask (execution design §10.5): black inside `sourceRoi`, white elsewhere, one frame per slot, lossless
 * and full range.
 * @param recipe - The mask.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function windowMask(recipe: MiniToolPlanModelWindowMask, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { frame, sourceRoi: roi, model } = recipe;
  const plane = Buffer.alloc(frame.width * frame.height, 255);
  for (let y = roi.y; y < roi.y + roi.height; y += 1) plane.fill(0, y * frame.width + roi.x, y * frame.width + roi.x + roi.width);
  const file = join(request.directory, "window-mask.gray");
  await writeFile(file, plane);
  await runPlanCommand("ffmpeg", [...HEAD, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${frame.width}x${frame.height}`, "-i", file,
    "-vf", `loop=loop=${model.frameCount - 1}:size=1:start=0,${FULL_RANGE},settb=1/${model.fps},setpts=N`, ...LOSSLESS_MASK,
    ...timingTo(model.fps, model.frameCount), "-movflags", "+faststart", "-f", "mp4", request.output], run);
}

/**
 * The PNG of one grid frame of a model result (execution design §10.5 condition step), decoded with the result's own colour
 * tags ({@link probeModelResultDecode}).
 * @param recipe - The condition frame.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function frameAt(recipe: MiniToolPlanFrameAt, request: ModelRecipeRequest, run: Run): Promise<void> {
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const decode = await probeModelResultDecode(file, run);
  await decodeGridWindow({ file, grid: recipe.grid, source: recipe.source, frames: { start: recipe.frameIndex, end: recipe.frameIndex + 1 } }, facts, request.directory, run,
    (input, graph) => [...input, "-filter_complex", `${graph};[g]scale=${recipe.target.width}:${recipe.target.height}:${decode},format=rgb24[v]`,
      "-map", "[v]", "-frames:v", "1", "-c:v", "png", "-f", "image2", request.output]);
}

/**
 * A one-frame 4:4:4 Y4M image on the grid rate: a header naming its size, rate and format, then the Y, U and V planes.
 * @param width - Its width.
 * @param height - Its height.
 * @param planes - The three planes, `width × height` bytes each.
 * @returns The file bytes.
 * @throws {never} Never.
 */
function y4m(width: number, height: number, planes: readonly Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F25:1 Ip A1:1 C444\nFRAME\n`, "ascii"), ...planes]);
}

/**
 * Composite the erase model's result over a chunk (execution design §10.4 composite row): each chunk frame inside the range
 * shows its model slot's result frame through its RLE mask, dilated by `matte.dilate` and feathered by `matte.feather`
 * (source × (1 − m) + result × m per 4:4:4 plane); outside the range the source. Every stream is laid out frame by frame on
 * the chunk's grid. The result is decoded with its own colour tags.
 * @param recipe - The composite.
 * @param request - Its files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RecipeFailure} `model_output_mismatch` when the result's frames are not the model grid's, `tracking_output_mismatch`
 * when the RLE does not cover the range.
 * @throws {Error} When FFprobe or FFmpeg fails.
 */
async function eraseComposite(recipe: MiniToolPlanEraseComposite, request: ModelRecipeRequest, run: Run): Promise<void> {
  const { target, range, model, matte, grid, frames } = recipe;
  const { rect } = placement(target);
  const directory = request.directory;
  const area = rect.width * rect.height;
  const count = frames.end - frames.start;
  const slots = new Map<number, number>();
  for (let n = 0; n < count; n += 1) {
    const inRange = frames.start + n - range.startFrame;
    if (inRange >= 0 && inRange < range.frameCount) slots.set(n, gridFrameSlot(model, grid.fps, inRange));
  }
  if (slots.size > 0) {
    const decoded = join(directory, "result.yuv");
    const result = local(request.inputs, recipe.result);
    await runPlanCommand("ffmpeg", [...HEAD, "-i", result, "-fps_mode", "passthrough",
      "-vf", `scale=${rect.width}:${rect.height}:${await probeModelResultDecode(result, run)}:out_color_matrix=bt709:out_range=tv,format=yuv444p`, "-f", "rawvideo", decoded], run);
    const resultFile = await open(decoded, "r");
    try {
      const { size } = await resultFile.stat();
      if (size !== model.frameCount * area * 3) throw new RecipeFailure("model_output_mismatch");
      const frame = Buffer.alloc(area * 3);
      for (const slot of new Set(slots.values())) {
        await resultFile.read(frame, 0, frame.length, slot * frame.length);
        await writeFile(join(directory, `result-${slot}.y4m`), y4m(rect.width, rect.height, [frame.subarray(0, area), frame.subarray(area, 2 * area), frame.subarray(2 * area)]));
      }
    } finally { await resultFile.close(); }
  }
  const track = await readRleTrack(local(request.inputs, recipe.rle));
  if (track.length !== range.frameCount) throw new RecipeFailure("tracking_output_mismatch");
  const blank = { result: join(directory, "blank-result.y4m"), mask: join(directory, "blank-mask.y4m") };
  await writeFile(blank.result, y4m(rect.width, rect.height, [new Uint8Array(area).fill(16), new Uint8Array(area).fill(128), new Uint8Array(area).fill(128)]));
  const maskArea = recipe.rleSize.width * recipe.rleSize.height;
  await writeFile(blank.mask, y4m(recipe.rleSize.width, recipe.rleSize.height, [new Uint8Array(maskArea), new Uint8Array(maskArea), new Uint8Array(maskArea)]));
  const resultList: string[] = [];
  const maskList: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const slot = slots.get(n);
    let [result, mask] = [blank.result, blank.mask];
    if (slot !== undefined) {
      result = join(directory, `result-${slot}.y4m`);
      const pixels = rleForeground(track[frames.start + n - range.startFrame] ?? null, recipe.rleSize, 255);
      mask = join(directory, `mask-${n}.y4m`);
      // Every plane carries the mask, so colour is blended by the same weight as luma.
      await writeFile(mask, y4m(recipe.rleSize.width, recipe.rleSize.height, [pixels, pixels, pixels]));
    }
    resultList.push(`file '${result}'`);
    maskList.push(`file '${mask}'`);
  }
  const lists = { result: join(directory, "results.txt"), mask: join(directory, "masks.txt") };
  await writeFile(lists.result, `ffconcat version 1.0\n${resultList.join("\n")}\n`);
  await writeFile(lists.mask, `ffconcat version 1.0\n${maskList.join("\n")}\n`);
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const widen = Array.from({ length: matte.dilate }, () => "dilation").join(",");
  const soften = matte.feather > 0 ? `gblur=sigma=${matte.feather}` : "";
  const maskChain = [`scale=${rect.width}:${rect.height}:flags=neighbor`, widen, soften].filter((part) => part !== "").join(",");
  // Every stream is retimed frame by frame onto the chunk's grid, so frame n of each meets frame n of the others.
  const onGrid = `settb=${grid.fps.denominator}/${grid.fps.numerator},setpts=N`;
  const { video, muxer } = videoOutput(target, grid.fps);
  await decodeGridWindow({ file, grid, source: recipe.source, frames }, facts, directory, run, (input, head) => [
    ...input, "-f", "concat", "-safe", "0", "-i", lists.result, "-f", "concat", "-safe", "0", "-i", lists.mask, "-filter_complex", [
      head, `[g]${decodedPicture(target.colorMatrix, facts.range, rect.width, rect.height, { format: "yuv444p", bt709: true })},${BT709_TAGS},${onGrid}[v]`,
      `[1:v:0]${onGrid},${BT709_TAGS}[r]`, `[2:v:0]${maskChain},${onGrid},${BT709_TAGS}[m]`,
      `[v][r][m]maskedmerge,trim=end_frame=${count},${picture({ ...target, colorMatrix: "bt709", toneMap: "none" }, "tv", "o")}[c]`,
    ].join(";"), "-map", "[c]", ...video, "-an", ...muxer, request.output,
  ]);
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
