// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync container recipes (frames-split design §7.17 rows `lipsync_faces`, `lipsync_clip`, `lipsync_stem`,
 * `lipsync_composite`; execution design §9.2–§9.4; multi-person lip-sync DD §7.2; inner#1306 test plan §97 D18-3, D20).
 *
 * Faces are detected on the whole prepared frame and kept by their intersection with the person's tracked foreground.
 * The clip and the composite map every result frame to its source presentation frame through the shared timeline, and move
 * pixels in 8-bit 4:2:0 planes here, because each frame has its own face rectangle and mask: the source frames are decoded
 * once into a raw file, the result frames written to another and encoded by FFmpeg. The tracks and transform tables are in
 * prepared-video pixels; the prepared video presents the original's frames at its picture size (§7.17 lipsync rows).
 */
import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { rational } from "@shared/mini-tools/video-presentation-projection.js";
import { lipsyncSourceFrameAt, type LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
import type {
  MiniToolPlanDetectorProfile, MiniToolPlanLipsyncClip, MiniToolPlanLipsyncComposite, MiniToolPlanLipsyncFaces, MiniToolPlanLipsyncStem, MiniToolPlanPixelRect, MiniToolPlanTarget,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { decodeCocoRleMask } from "@ingest/container/coco-rle.js";
import { readYuNetFaces } from "@ingest/container/analysis-detection.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import {
  BT709_TAGS, RecipeFailure, detect, local, picture, placement, readMediaMetadata, readVideoMetadata, roundTimes, videoOutput, windowGraph, writeJson, type PlanLimits,
} from "@ingest/container/presentation-recipes.js";

/** The lip-sync recipes. */
export type LipsyncRecipe = MiniToolPlanLipsyncFaces | MiniToolPlanLipsyncClip | MiniToolPlanLipsyncStem | MiniToolPlanLipsyncComposite;
/** One lip-sync recipe's local files and lifetime. */
export interface LipsyncRecipeRequest {
  recipe: LipsyncRecipe;
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}
/** The lifetime and IO bounds of one command. */
type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** One 8-bit 4:2:0 picture: luma, the two chroma planes and, for a transparent picture, alpha at luma size. */
interface Picture { width: number; height: number; y: Uint8Array; u: Uint8Array; v: Uint8Array; a: Uint8Array | null }
/** A transform table row. */
type FaceRect = MiniToolPlanPixelRect | null;

// A clip or face crop is an intermediate model input: x264 at the quality the presentation carriers use.
const CLIP_ENCODE = { crf: 18, preset: "medium" } as const;
// The face's feathered edge, as a fraction of its shorter side (DD §7.2 step 6: feather(face) ∩ tracked foreground).
const FEATHER = 0.1;
const BLACK_Y = 16;
const NEUTRAL_C = 128;

/**
 * Whether a recipe is one of the lip-sync steps this module runs.
 * @param recipe - An admitted recipe.
 * @param recipe.kind - Its kind.
 * @returns True for the four lip-sync kinds.
 * @throws {never} Never.
 */
export function isLipsyncRecipe(recipe: { kind: string }): recipe is LipsyncRecipe {
  return recipe.kind === "lipsync_faces" || recipe.kind === "lipsync_clip" || recipe.kind === "lipsync_stem" || recipe.kind === "lipsync_composite";
}

/**
 * A video's coded size and frame count, as ffprobe counts its packets.
 * @param file - The video.
 * @param run - The lifetime and IO bounds.
 * @returns Its geometry and frames.
 * @throws {Error} When ffprobe fails or the file has no video.
 */
async function videoFacts(file: string, run: Run): Promise<{ width: number; height: number; frames: number }> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=width,height,nb_read_packets", "-of", "json", file], run)).toString("utf8")) as { streams?: { width?: number; height?: number; nb_read_packets?: string }[] };
  const stream = answer.streams?.[0];
  const frames = Number(stream?.nb_read_packets);
  if (stream?.width === undefined || stream.height === undefined || !Number.isSafeInteger(frames) || frames <= 0) throw new Error("The lip-sync video has no readable frames");
  return { width: stream.width, height: stream.height, frames };
}

/**
 * Read a SAM3 track: a JSON array of COCO compressed counts, one per prepared frame in order (§97 D18-3).
 * @param file - The track.
 * @returns Each frame's counts, null where the track has no mask.
 * @throws {TypeError} When the file is not such an array.
 */
async function readTrack(file: string): Promise<(string | null)[]> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => item === null || typeof item === "string")) throw new TypeError("Expected a track of compressed counts per frame");
  return value as (string | null)[];
}

/**
 * Decode one frame's foreground mask.
 * @param track - The track.
 * @param frame - The prepared frame.
 * @param size - The prepared video's size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns One byte per pixel, 1 on the person's foreground; null when the frame has no mask.
 * @throws {RangeError} When the counts do not cover the frame.
 */
function maskAt(track: readonly (string | null)[], frame: number, size: { width: number; height: number }): Uint8Array | null {
  const counts = track[frame];
  if (counts === null || counts === undefined) return null;
  // The decoder writes VOID bytes: foreground 0, background 255.
  return decodeCocoRleMask({ size: [size.height, size.width], counts }, size).map((value) => (value === 0 ? 1 : 0));
}

/**
 * Read a transform table (the `lipsync_faces` output).
 * @param file - The table.
 * @returns Each frame's face rectangle by frame index.
 * @throws {TypeError} When the file is not a table.
 */
async function readFaces(file: string): Promise<FaceRect[]> {
  const value = JSON.parse(await readFile(file, "utf8")) as { frames?: { frameIndex?: unknown; faceRect?: FaceRect }[] };
  if (!Array.isArray(value.frames)) throw new TypeError("Expected a transform table");
  const rects: FaceRect[] = [];
  for (const row of value.frames) {
    if (typeof row.frameIndex !== "number" || !Number.isSafeInteger(row.frameIndex) || row.frameIndex < 0) throw new TypeError("Expected a frame index per row");
    rects[row.frameIndex] = row.faceRect ?? null;
  }
  return Array.from({ length: rects.length }, (_unused, at) => rects[at] ?? null);
}

/**
 * Find one person's face on every prepared frame (§7.17 lipsync_faces row; §97 D18-3, D20-4): YuNet runs on whole frames,
 * and of the faces it finds on a frame the one with the largest intersection with the person's foreground is kept, the
 * larger face on a tie; a frame where no face meets the foreground has none.
 * @param recipe - The faces recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once the table is written.
 * @throws {RecipeFailure} `empty_foreground` when no frame has foreground, `no_face` when no frame has a face in it.
 * @throws {Error} When decoding, detection or writing fails.
 */
async function findFaces(recipe: MiniToolPlanLipsyncFaces, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const video = local(request.inputs, recipe.inputId);
  const { width, height, frames } = await videoFacts(video, run);
  const track = await readTrack(local(request.inputs, recipe.track));
  const answer = await detect("faces", recipe.profile satisfies MiniToolPlanDetectorProfile, { width, height, count: frames,
    args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-i", video, "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  // One frame is answered as the people detector answers its anchor, more as one row list per frame.
  const detections: unknown[] = frames === 1 ? [answer.faces] : Array.isArray(answer.frames) ? answer.frames : [];
  if (detections.length !== frames) throw new TypeError("Expected the detector's rows for every frame");
  let foreground = false;
  const rows = detections.map((found, frameIndex) => {
    const mask = maskAt(track, frameIndex, { width, height });
    if (mask === null || !mask.includes(1)) return { frameIndex, faceRect: null };
    foreground = true;
    let best: { rect: MiniToolPlanPixelRect; inside: number } | null = null;
    for (const face of readYuNetFaces(found, { width, height }, true)) {
      const rect = face.pixelCrop!;
      let inside = 0;
      for (let y = rect.y; y < Math.min(height, rect.y + rect.height); y += 1) for (let x = rect.x; x < Math.min(width, rect.x + rect.width); x += 1) inside += mask[y * width + x]!;
      if (inside > 0 && (best === null || inside > best.inside || (inside === best.inside && rect.width * rect.height > best.rect.width * best.rect.height))) best = { rect, inside };
    }
    return { frameIndex, faceRect: best?.rect ?? null };
  });
  if (!foreground) throw new RecipeFailure("empty_foreground");
  if (rows.every((row) => row.faceRect === null)) throw new RecipeFailure("no_face");
  await writeJson(request.output, { frames: rows });
}

/**
 * Decode a video's frames into one raw 8-bit 4:2:0 file, frames in presentation order.
 * @param args - The FFmpeg input arguments and the graph or filters that present the frames, ending before the output.
 * @param alpha - Whether the frames carry alpha.
 * @param file - The raw file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function decodeRaw(args: string[], alpha: boolean, file: string, run: Run): Promise<void> {
  await runPlanCommand("ffmpeg", [...args, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", file], run);
}

/** Random access to the frames of a raw file. */
interface RawFrames { read(index: number): Promise<Picture>; count: number; close(): Promise<void> }

/**
 * Open a raw 8-bit 4:2:0 file for reading frames by index.
 * @param file - The raw file.
 * @param width - The frame width.
 * @param height - The frame height.
 * @param alpha - Whether each frame carries an alpha plane.
 * @returns The reader.
 * @throws {Error} When the file cannot be opened.
 */
async function rawFrames(file: string, width: number, height: number, alpha: boolean): Promise<RawFrames> {
  const handle: FileHandle = await open(file, "r");
  const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
  const size = width * height * (alpha ? 2 : 1) + 2 * chroma;
  const count = Math.floor((await handle.stat()).size / size);
  return {
    count,
    async read(index: number): Promise<Picture> {
      const bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, size, Math.min(index, count - 1) * size);
      const luma = width * height;
      return { width, height, y: bytes.subarray(0, luma), u: bytes.subarray(luma, luma + chroma), v: bytes.subarray(luma + chroma, luma + 2 * chroma),
        a: alpha ? bytes.subarray(luma + 2 * chroma, size) : null };
    },
    close: () => handle.close(),
  };
}

/**
 * Sample a plane at a fractional position, bilinearly, clamped to its edges.
 * @param plane - The plane.
 * @param width - Its width.
 * @param height - Its height.
 * @param x - The column, pixel centres on integers.
 * @param y - The row.
 * @returns The value.
 * @throws {never} Never.
 */
function sample(plane: Uint8Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = plane[y0 * width + x0]! * (1 - fx) + plane[y0 * width + x1]! * fx;
  const bottom = plane[y1 * width + x0]! * (1 - fx) + plane[y1 * width + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

/** How a face rectangle is fitted into the square crop (§97 D20-4): scaled to fit, centred, the odd padding pixel below or right. */
interface Fit { rect: MiniToolPlanPixelRect; scaledWidth: number; scaledHeight: number; padX: number; padY: number }

/**
 * Fit a face rectangle into a square crop.
 * @param rect - The face rectangle.
 * @param size - The crop side.
 * @returns The fit.
 * @throws {never} Never.
 */
function fit(rect: MiniToolPlanPixelRect, size: number): Fit {
  const scale = size / Math.max(rect.width, rect.height);
  const scaledWidth = Math.min(size, Math.round(rect.width * scale));
  const scaledHeight = Math.min(size, Math.round(rect.height * scale));
  return { rect, scaledWidth, scaledHeight, padX: Math.floor((size - scaledWidth) / 2), padY: Math.floor((size - scaledHeight) / 2) };
}

/**
 * Crop one source frame to a person's face (§7.17 lipsync_clip row): the face rectangle fitted into the square, the padding
 * and every pixel outside the person's mask black, so other people are hidden.
 * @param frame - The source frame.
 * @param rect - The frame's face rectangle, or null for an all-black crop.
 * @param mask - The frame's foreground mask, or null for none.
 * @param size - The crop side.
 * @returns The crop.
 * @throws {never} Never.
 */
function cropFace(frame: Picture, rect: FaceRect, mask: Uint8Array | null, size: number): Picture {
  const chroma = Math.ceil(size / 2);
  const out: Picture = { width: size, height: size, y: new Uint8Array(size * size).fill(BLACK_Y), u: new Uint8Array(chroma * chroma).fill(NEUTRAL_C),
    v: new Uint8Array(chroma * chroma).fill(NEUTRAL_C), a: null };
  if (rect === null || mask === null) return out;
  const f = fit(rect, size);
  const sx = rect.width / f.scaledWidth;
  const sy = rect.height / f.scaledHeight;
  const keep = new Uint8Array(size * size);
  for (let oy = f.padY; oy < f.padY + f.scaledHeight; oy += 1) {
    const y = rect.y + (oy - f.padY + 0.5) * sy - 0.5;
    const my = Math.min(frame.height - 1, Math.max(0, Math.round(y)));
    for (let ox = f.padX; ox < f.padX + f.scaledWidth; ox += 1) {
      const x = rect.x + (ox - f.padX + 0.5) * sx - 0.5;
      const mx = Math.min(frame.width - 1, Math.max(0, Math.round(x)));
      if (mask[my * frame.width + mx] !== 1) continue;
      keep[oy * size + ox] = 1;
      out.y[oy * size + ox] = Math.round(sample(frame.y, frame.width, frame.height, x, y));
    }
  }
  const cw = Math.ceil(frame.width / 2);
  const ch = Math.ceil(frame.height / 2);
  for (let cy = 0; cy < chroma; cy += 1) {
    for (let cx = 0; cx < chroma; cx += 1) {
      const kept = (keep[2 * cy * size + 2 * cx] ?? 0) + (keep[2 * cy * size + 2 * cx + 1] ?? 0) + (keep[(2 * cy + 1) * size + 2 * cx] ?? 0) + (keep[(2 * cy + 1) * size + 2 * cx + 1] ?? 0);
      if (kept === 0) continue;
      const x = (rect.x + (2 * cx + 1 - f.padX) * sx) / 2 - 0.5;
      const y = (rect.y + (2 * cy + 1 - f.padY) * sy) / 2 - 0.5;
      const weight = kept / 4;
      out.u[cy * chroma + cx] = Math.round(NEUTRAL_C + (sample(frame.u, cw, ch, x, y) - NEUTRAL_C) * weight);
      out.v[cy * chroma + cx] = Math.round(NEUTRAL_C + (sample(frame.v, cw, ch, x, y) - NEUTRAL_C) * weight);
    }
  }
  return out;
}

/**
 * The result timeline's frames on the prepared video's frame rate (§7.17 lipsync_clip row): its clock and frame step, the
 * end in ticks and the frame count; the last frame ends at the result duration.
 * @param timeline - The frozen timeline.
 * @param table - The prepared video's presentation table.
 * @returns The grid.
 * @throws {never} Never.
 */
function resultGrid(timeline: LipsyncTimeline, table: VideoPresentationTable): { clock: number; step: number; end: number; count: number } {
  const clock = table.timescale;
  const step = table.runs[0]!.step;
  const end = Math.round(timeline.duration * clock);
  return { clock, step, end, count: Math.ceil(end / step) };
}

/**
 * Append a picture's planes to a raw file.
 * @param handle - The open raw file.
 * @param frame - The picture.
 * @returns Nothing once written.
 * @throws {Error} When writing fails.
 */
async function appendPicture(handle: FileHandle, frame: Picture): Promise<void> {
  await handle.write(frame.y);
  await handle.write(frame.u);
  await handle.write(frame.v);
  if (frame.a !== null) await handle.write(frame.a);
}

/**
 * Encode raw 4:2:0 frames on a clock, one frame per `tick` ticks from 0, the last ending at `end`.
 * @param raw - The raw file.
 * @param frame - The frames' geometry and whether they carry alpha.
 * @param frame.width - Their width.
 * @param frame.height - Their height.
 * @param frame.alpha - Whether each carries alpha.
 * @param timing - The clock, the ticks per frame and the end.
 * @param timing.clock - The timescale.
 * @param timing.tick - The ticks per frame.
 * @param timing.end - The end in ticks.
 * @param target - The encode target.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function encodeRaw(raw: string, frame: { width: number; height: number; alpha: boolean }, timing: { clock: number; tick: number; end: number },
  target: MiniToolPlanTarget, output: string, run: Run): Promise<void> {
  const { video, muxer } = videoOutput(target, BigInt(timing.clock), BigInt(timing.end));
  await runPlanCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", frame.alpha ? "yuva420p" : "yuv420p",
    "-s", `${frame.width}x${frame.height}`, "-framerate", `${timing.clock}/${timing.tick}`, "-i", raw,
    "-vf", `settb=1/${timing.clock},setpts=N*${timing.tick},setsar=1,${BT709_TAGS}`, ...video, "-an", ...muxer, output], run);
}

/**
 * Write one person's face clip (§7.17 lipsync_clip row, execution design §9.2): result frame t shows source frame
 * `lipsyncSourceFrameAt(timeline, table, t)` cropped to that frame's face, H.264 of `timeline.duration` on the prepared
 * video's frame rate.
 * @param recipe - The clip recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeClip(recipe: MiniToolPlanLipsyncClip, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const video = local(request.inputs, recipe.inputId);
  const { width, height } = await videoFacts(video, run);
  const [track, faces] = await Promise.all([readTrack(local(request.inputs, recipe.track)), readFaces(local(request.inputs, recipe.faces))]);
  const source = join(request.directory, "clip-source.yuv");
  await decodeRaw(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-i", video, "-map", "0:v:0"], false, source, run);
  const frames = await rawFrames(source, width, height, false);
  const grid = resultGrid(recipe.timeline, recipe.table);
  const raw = join(request.directory, "clip-result.yuv");
  const out = await open(raw, "w");
  try {
    const crops = new Map<number, Picture>();
    for (let k = 0; k < grid.count; k += 1) {
      const s = lipsyncSourceFrameAt(recipe.timeline, recipe.table, (k * grid.step) / grid.clock);
      let crop = crops.get(s);
      if (crop === undefined) {
        crop = cropFace(await frames.read(s), faces[s] ?? null, maskAt(track, s, { width, height }), recipe.cropSize);
        crops.set(s, crop);
      }
      await appendPicture(out, crop);
    }
  } finally {
    await out.close();
    await frames.close();
  }
  await encodeRaw(raw, { width: recipe.cropSize, height: recipe.cropSize, alpha: false }, { clock: grid.clock, tick: grid.step, end: grid.end },
    { width: recipe.cropSize, height: recipe.cropSize, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", ...CLIP_ENCODE, format: "mp4-h264" }, request.output, run);
}

/**
 * Write one person's dialogue stem (§7.17 lipsync_stem row): each row placed at its start time on the 48 kHz grid and summed
 * without normalising, silence elsewhere, exactly `duration` long, AAC.
 * @param recipe - The stem recipe.
 * @param request - The files and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function writeStem(recipe: MiniToolPlanLipsyncStem, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const samples = roundTimes(rational(recipe.duration), 48000n);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file"];
  const graph = recipe.rows.map((row, at) => {
    args.push("-i", local(request.inputs, row.inputId));
    return `[${at}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=PTS-STARTPTS,adelay=delays=${roundTimes(rational(row.startTime), 48000n)}S:all=1[r${at}]`;
  });
  const rows = recipe.rows.map((_row, at) => `[r${at}]`).join("");
  graph.push(`${rows}${recipe.rows.length === 1 ? "anull" : `amix=inputs=${recipe.rows.length}:normalize=0:duration=longest`},apad=whole_len=${samples},atrim=end_sample=${samples}[a]`);
  // The M4A brand: the Worker names stored bytes by their brand, and an isom-branded file reads as video/mp4.
  await runPlanCommand("ffmpeg", [...args, "-filter_complex", graph.join(";"), "-map", "[a]", "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-f", "ipod", request.output], run);
}

/** One person of a composite chunk, read. */
interface CompositePerson { faces: FaceRect[]; track: (string | null)[]; results: RawFrames; cropSize: number }

/**
 * Lay one person's generated face back onto a frame (§7.17 lipsync_composite row, DD §7.2 step 6): each picture pixel in the
 * face rectangle takes the result inverse-transformed through the crop fit, weighted by the face's feathered edge times
 * the person's tracked foreground; the alpha plane is left as the source has it.
 * @param frame - The picture, changed in place.
 * @param rect - The face rectangle in picture pixels.
 * @param mask - The foreground mask in prepared pixels.
 * @param area - Where the prepared video sits in the frame.
 * @param result - The person's result frame.
 * @param size - The crop side.
 * @returns Nothing.
 * @throws {never} Never.
 */
function layFace(frame: Picture, rect: MiniToolPlanPixelRect, mask: Uint8Array, area: MiniToolPlanPixelRect, result: Picture, size: number): void {
  const f = fit(rect, size);
  const feather = Math.max(1, Math.min(rect.width, rect.height) * FEATHER);
  const weights = new Float32Array(frame.width * frame.height);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(area.width, rect.x + rect.width);
  const y1 = Math.min(area.height, rect.y + rect.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (mask[y * area.width + x] !== 1) continue;
      const edge = Math.min(x + 0.5 - rect.x, rect.x + rect.width - x - 0.5, y + 0.5 - rect.y, rect.y + rect.height - y - 0.5);
      const weight = Math.min(1, Math.max(0, edge / feather));
      if (weight === 0) continue;
      const at = (area.y + y) * frame.width + area.x + x;
      weights[at] = weight;
      const value = sample(result.y, size, size, (x + 0.5 - rect.x) * (f.scaledWidth / rect.width) + f.padX - 0.5, (y + 0.5 - rect.y) * (f.scaledHeight / rect.height) + f.padY - 0.5);
      frame.y[at] = Math.round(frame.y[at]! * (1 - weight) + value * weight);
    }
  }
  const cw = Math.ceil(frame.width / 2);
  const rc = Math.ceil(size / 2);
  for (let cy = Math.floor((area.y + y0) / 2); cy < Math.ceil((area.y + y1) / 2); cy += 1) {
    for (let cx = Math.floor((area.x + x0) / 2); cx < Math.ceil((area.x + x1) / 2); cx += 1) {
      const quad = [[2 * cx, 2 * cy], [2 * cx + 1, 2 * cy], [2 * cx, 2 * cy + 1], [2 * cx + 1, 2 * cy + 1]];
      const weight = quad.reduce((sum, [x, y]) => sum + (x! < frame.width && y! < frame.height ? weights[y! * frame.width + x!]! : 0), 0) / 4;
      if (weight === 0) continue;
      // The chroma sample's centre in prepared-picture luma pixels, then in the result's chroma plane.
      const lx = 2 * cx + 1 - area.x;
      const ly = 2 * cy + 1 - area.y;
      const rx = ((lx - rect.x) * (f.scaledWidth / rect.width) + f.padX) / 2 - 0.5;
      const ry = ((ly - rect.y) * (f.scaledHeight / rect.height) + f.padY) / 2 - 0.5;
      const at = cy * cw + cx;
      frame.u[at] = Math.round(frame.u[at]! * (1 - weight) + sample(result.u, rc, rc, rx, ry) * weight);
      frame.v[at] = Math.round(frame.v[at]! * (1 - weight) + sample(result.v, rc, rc, rx, ry) * weight);
    }
  }
}

/**
 * Write one composite chunk (§7.17 lipsync_composite row, §5.4): result frames [window.start, window.end) on the result clock
 * from 0, opening with a keyframe; result frame k shows the original's presentation frame
 * `lipsyncSourceFrameAt(timeline, table, t_k)` with every person's result frame k laid onto that frame's face; a frame
 * without a face leaves the source; a transparent original keeps its alpha (VP9), an opaque one is H.264.
 * @param recipe - The composite recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the result frame step is not a whole number of the chunk's ticks, or a time is malformed.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeComposite(recipe: MiniToolPlanLipsyncComposite, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const { target, table, timeline, window } = recipe;
  if (target.alpha === "packed") throw new RangeError("A lip-sync composite is an opaque H.264 or a transparent VP9 chunk");
  const alpha = target.alpha === "straight";
  const { rect: placed } = placement(target);
  const graph = await windowGraph(recipe.entries, BigInt(table.timescale), local(request.inputs, recipe.inputId), run, (label) => picture(target, label),
    (entry) => `color=c=black${alpha && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,format=${alpha ? "yuva420p" : "yuv420p"},setsar=1`);
  const source = join(request.directory, "composite-source.yuv");
  await decodeRaw([...graph.args, "-filter_complex", graph.graph.join(";"), "-map", "[v]"], alpha, source, run);
  const frames = await rawFrames(source, target.width, target.height, alpha);
  const persons: CompositePerson[] = [];
  try {
    for (const [at, person] of recipe.persons.entries()) {
      const file = join(request.directory, `composite-person-${at}.yuv`);
      await decodeRaw(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-i", local(request.inputs, person.result), "-map", "0:v:0",
        "-frames:v", String(window.end), "-vf", `scale=${person.cropSize}:${person.cropSize}:out_color_matrix=bt709:out_range=tv`], false, file, run);
      const [faces, track] = await Promise.all([readFaces(local(request.inputs, person.faces)), readTrack(local(request.inputs, person.track))]);
      persons.push({ faces, track, results: await rawFrames(file, person.cropSize, person.cropSize, false), cropSize: person.cropSize });
    }
    // Result frame j of the chunk lasts the prepared video's frame step, in this chunk's ticks.
    const step = table.runs[0]!.step * recipe.timescale;
    if (step % table.timescale !== 0) throw new RangeError("The result frame step is not a whole number of the chunk's ticks");
    const tick = step / table.timescale;
    const raw = join(request.directory, "composite-result.yuv");
    const out = await open(raw, "w");
    try {
      for (let k = window.start; k < window.end; k += 1) {
        const s = lipsyncSourceFrameAt(timeline, table, (k * table.runs[0]!.step) / table.timescale);
        const frame = await frames.read(s);
        for (const person of persons) {
          const rect = person.faces[s] ?? null;
          const mask = maskAt(person.track, s, placed);
          if (rect === null || mask === null || k >= person.results.count) continue;
          layFace(frame, rect, mask, placed, await person.results.read(k), person.cropSize);
        }
        await appendPicture(out, frame);
      }
    } finally {
      await out.close();
    }
    await encodeRaw(raw, { width: target.width, height: target.height, alpha }, { clock: recipe.timescale, tick, end: (window.end - window.start) * tick }, target, request.output, run);
  } finally {
    await frames.close();
    for (const person of persons) await person.results.close();
  }
}

/**
 * Run one lip-sync recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers (none for the transform table).
 * @throws {RecipeFailure} When the faces step finds no foreground or no face.
 * @throws {Error} When a process fails or a video output has no complete metadata.
 */
export async function executeLipsyncRecipe(request: LipsyncRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { recipe, signal, limits } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  if (recipe.kind === "lipsync_faces") {
    await findFaces(recipe, request, run);
    return { width: null, height: null, durationSeconds: null, cover: null };
  }
  if (recipe.kind === "lipsync_stem") {
    await writeStem(recipe, request, run);
    return { ...await readMediaMetadata(request.output, request), cover: null };
  }
  if (recipe.kind === "lipsync_clip") await writeClip(recipe, request, run);
  else await writeComposite(recipe, request, run);
  return { ...await readVideoMetadata(request.output, request, recipe.kind), cover: null };
}
