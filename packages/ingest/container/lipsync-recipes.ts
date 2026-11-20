// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lip-sync container recipes (frames-split design §7.17 rows `lipsync_faces`, `lipsync_clip`, `lipsync_stem`,
 * `lipsync_composite`; execution design §9.2–§9.4; multi-person lip-sync DD §7.2; inner#1306 test plan §97 D18-3, D20).
 *
 * Faces are detected on the whole prepared frame and kept by their intersection with the person's tracked foreground.
 * The clip and the composite map every result frame to its source presentation frame through the shared timeline, and move
 * pixels in 8-bit 4:2:0 planes here, because each frame has its own face rectangle and mask. Frames move through pipes
 * (execution design paragraph before §9.4): FFmpeg decodes raw frames to its stdout, each is processed as it arrives and
 * written to the encoding FFmpeg's stdin; only a clip's reused crops and a composite chunk whose source frames go back are
 * kept in a file. The tracks and transform tables are in
 * prepared-video pixels; the prepared video presents the original's frames at its picture size (§7.17 lipsync rows).
 */
import { once } from "node:events";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  lipsyncClipCropFrames, lipsyncPictureBytes, lipsyncResultFrameCount, lipsyncResultSourceFrames, lipsyncSourceFrameAt, lipsyncSourceSpan, type LipsyncGrid, type LipsyncTimeline,
} from "@shared/mini-tools/lipsync-timeline.js";
import type {
  MiniToolPlanDetectorProfile, MiniToolPlanLipsyncClip, MiniToolPlanLipsyncComposite, MiniToolPlanLipsyncFaces, MiniToolPlanLipsyncStem, MiniToolPlanPixelRect, MiniToolPlanTarget,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { readYuNetFaces } from "@ingest/container/analysis-detection.js";
import { runPlanCommand, startPlanCommand, type PlanPipe } from "@ingest/container/plan-command.js";
import { readRleTrack, rleForeground } from "@ingest/container/rle-track.js";
import {
  BT709_TAGS, RecipeFailure, detect, landedGridInput, local, modelResultDecode, picture, placement, readMediaMetadata, readVideoMetadata, sourceFacts, videoOutput,
  writeJson, type PlanLimits,
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
 * Decode one frame's foreground mask.
 * @param track - The track.
 * @param frame - The prepared frame.
 * @param size - The prepared video's size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns One byte per pixel, 1 on the person's foreground; null when the frame has no mask.
 * @throws {RecipeFailure} `tracking_output_mismatch` when the counts do not cover the frame.
 */
function maskAt(track: readonly (string | null)[], frame: number, size: { width: number; height: number }): Uint8Array | null {
  const counts = track[frame];
  return counts === null || counts === undefined ? null : rleForeground(counts, size, 1);
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
 * @throws {RecipeFailure} `empty_foreground` when no frame has foreground, `no_face` when no frame has a face in it,
 * `tracking_output_mismatch` when the track is not a per-frame counts array covering the frame.
 * @throws {Error} When decoding, detection or writing fails.
 */
async function findFaces(recipe: MiniToolPlanLipsyncFaces, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const video = local(request.inputs, recipe.inputId);
  const { width, height, frames } = await videoFacts(video, run);
  const track = await readRleTrack(local(request.inputs, recipe.track));
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

/**
 * View one raw 8-bit 4:2:0 picture's bytes as its planes.
 * @param bytes - The picture's bytes, `lipsyncPictureBytes` long.
 * @param width - Its width.
 * @param height - Its height.
 * @param alpha - Whether it carries an alpha plane.
 * @returns The picture over the same bytes.
 * @throws {never} Never.
 */
function pictureOf(bytes: Uint8Array, width: number, height: number, alpha: boolean): Picture {
  const luma = width * height;
  const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
  return { width, height, y: bytes.subarray(0, luma), u: bytes.subarray(luma, luma + chroma), v: bytes.subarray(luma + chroma, luma + 2 * chroma),
    a: alpha ? bytes.subarray(luma + 2 * chroma, luma * 2 + 2 * chroma) : null };
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
  const size = lipsyncPictureBytes(width, height, alpha);
  const count = Math.floor((await handle.stat()).size / size);
  return {
    count,
    async read(index: number): Promise<Picture> {
      const bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, size, index * size);
      return pictureOf(bytes, width, height, alpha);
    },
    close: () => handle.close(),
  };
}

/** The frames of a raw stream in order, one at a time; null once the stream has ended. */
interface FrameStream { next(): Promise<Picture | null> }

/**
 * Read a program's raw 8-bit 4:2:0 stdout one frame at a time (execution design paragraph before §9.4): only the frame being
 * filled and the pipe's current chunk are held. Once the stdout ends the program's own end is awaited first, so a decode that
 * failed part-way rejects with its exit, not as a short stream.
 * @param decode - The running program; its stdout is read.
 * @param width - The frame width.
 * @param height - The frame height.
 * @param alpha - Whether each frame carries an alpha plane.
 * @returns The frames.
 * @throws {never} Never; `next` rejects with the program's failure, or throws when a clean stream ends inside a frame.
 */
function frameStream(decode: PlanPipe, width: number, height: number, alpha: boolean): FrameStream {
  const chunks = decode.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  /**
   * Ask for the next chunk. Asking at once also marks the stream as read: Node resumes an unread child stdout when the
   * child exits, and the frames it held would be lost.
   * @returns The pending chunk.
   * @throws {never} Never; the awaiting reader sees a failure.
   */
  const ask = (): Promise<IteratorResult<Buffer>> => { const chunk = chunks.next(); chunk.catch(() => undefined); return chunk; };
  let ahead = ask();
  const size = lipsyncPictureBytes(width, height, alpha);
  let pending: Buffer = Buffer.alloc(0);
  return {
    async next(): Promise<Picture | null> {
      const bytes = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        if (pending.length === 0) {
          const chunk = await ahead;
          if (chunk.done !== true) ahead = ask();
          if (chunk.done === true) {
            await decode.done;
            if (filled === 0) return null;
            throw new Error("A raw frame stream ended inside a frame");
          }
          pending = chunk.value;
        }
        const length = Math.min(size - filled, pending.length);
        pending.copy(bytes, filled, 0, length);
        pending = pending.subarray(length);
        filled += length;
      }
      return pictureOf(bytes, width, height, alpha);
    },
  };
}

/**
 * Start a decode whose raw 8-bit 4:2:0 frames arrive on its stdout.
 * @param args - The FFmpeg input arguments and the graph or filters that present the frames, ending before the output.
 * @param alpha - Whether the frames carry alpha.
 * @param run - The lifetime and IO bounds.
 * @returns The running decode.
 * @throws {DOMException} When the lifetime is already cancelled.
 */
function startDecode(args: string[], alpha: boolean, run: Run): PlanPipe {
  return startPlanCommand("ffmpeg", [...args, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "pipe:1"], run, { stdout: true });
}

/**
 * Write one picture's planes to a raw stream, waiting while the reader is behind.
 * @param stdin - The stream.
 * @param frame - The picture.
 * @param done - The reading program's end: it may not end before its input does.
 * @returns Nothing once the planes are taken.
 * @throws {Error} When the stream fails or the program ends first.
 */
async function writePicture(stdin: Writable, frame: Picture, done: Promise<void>): Promise<void> {
  for (const plane of [frame.y, frame.u, frame.v, frame.a]) {
    if (plane === null || stdin.write(plane)) continue;
    await Promise.race([once(stdin, "drain"), done.then(() => { throw new Error("The encoder ended before its input"); })]);
  }
}

/**
 * Stop a program that may still run and wait for it, its own failure no longer relevant.
 * @param pipe - The program, or null when it never started.
 * @returns Nothing once it has closed.
 * @throws {never} Never.
 */
async function settle(pipe: PlanPipe | null): Promise<void> {
  if (pipe === null) return;
  pipe.stop();
  await pipe.done.catch(() => undefined);
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
 * The result timeline's frames on a grid (§7.17 lipsync_clip row): its clock (fps.numerator ticks a second) and frame step
 * (fps.denominator ticks), the end in ticks and the frame count; the last frame ends at the result duration.
 * @param timeline - The frozen timeline.
 * @param grid - The grid.
 * @returns The result grid.
 * @throws {never} Never.
 */
function resultGrid(timeline: LipsyncTimeline, grid: LipsyncGrid): { clock: number; step: number; end: number; count: number } {
  return { clock: grid.fps.numerator, step: grid.fps.denominator, end: Math.round(timeline.duration * grid.fps.numerator), count: lipsyncResultFrameCount(timeline, grid) };
}

/**
 * Start an encode of raw 4:2:0 frames written to its stdin, on a clock, one frame per `tick` ticks from 0, the last ending at `end`.
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
 * @returns The running encode.
 * @throws {DOMException} When the lifetime is already cancelled.
 */
function startEncode(frame: { width: number; height: number; alpha: boolean }, timing: { clock: number; tick: number; end: number },
  target: MiniToolPlanTarget, output: string, run: Run): PlanPipe & { stdin: Writable } {
  const { video, muxer } = videoOutput(target, { numerator: timing.clock, denominator: timing.tick }, { ticks: timing.clock, end: timing.end });
  const pipe = startPlanCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", frame.alpha ? "yuva420p" : "yuv420p",
    "-s", `${frame.width}x${frame.height}`, "-framerate", `${timing.clock}/${timing.tick}`, "-i", "pipe:0",
    "-vf", `settb=1/${timing.clock},setpts=N*${timing.tick},setsar=1,${BT709_TAGS}`, ...video, "-an", ...muxer, output], run, { stdin: true });
  return pipe as PlanPipe & { stdin: Writable };
}

/**
 * Close an encode's input and wait for it to finish writing.
 * @param encode - The running encode.
 * @returns Nothing once the output is written.
 * @throws {Error} When FFmpeg fails.
 */
async function finishEncode(encode: PlanPipe & { stdin: Writable }): Promise<void> {
  encode.stdin.end();
  await encode.done;
}

/**
 * Write one person's face clip (§7.17 lipsync_clip row, execution design §9.2): result frame k shows source frame
 * `lipsyncSourceFrameAt(timeline, grid, k)` cropped to that frame's face, H.264 of `timeline.duration` on the prepared
 * video's frame rate. The prepared video is decoded once, forward, on FFmpeg's stdout and each crop goes to the encoder's
 * stdin in result order (execution design paragraph before §9.4); every frame of `lipsyncClipCropFrames` is cropped into
 * the crop file as the decode passes it and read back from there.
 * @param recipe - The clip recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the prepared video ends before a frame the result shows, or decodes past the last one.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeClip(recipe: MiniToolPlanLipsyncClip, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const video = local(request.inputs, recipe.inputId);
  const { width, height } = await videoFacts(video, run);
  const [track, faces] = await Promise.all([readRleTrack(local(request.inputs, recipe.track)), readFaces(local(request.inputs, recipe.faces))]);
  const lipsyncGrid = { fps: recipe.grid.fps, frameCount: recipe.grid.frameCount };
  const grid = resultGrid(recipe.timeline, lipsyncGrid);
  const sources = lipsyncResultSourceFrames(recipe.timeline, lipsyncGrid);
  const highest = Math.max(...sources);
  const kept = new Set(lipsyncClipCropFrames(sources));
  const slots = new Int32Array(highest + 1).fill(-1);
  const cropBytes = lipsyncPictureBytes(recipe.cropSize, recipe.cropSize, false);
  const crops = await open(join(request.directory, "clip-crops.yuv"), "w+");
  let [decode, encode]: [PlanPipe | null, (PlanPipe & { stdin: Writable }) | null] = [null, null];
  try {
    encode = startEncode({ width: recipe.cropSize, height: recipe.cropSize, alpha: false }, { clock: grid.clock, tick: grid.step, end: grid.end },
      { width: recipe.cropSize, height: recipe.cropSize, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", ...recipe.encode, format: "mp4-h264" }, request.output, run);
    decode = startDecode(["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-i", video, "-map", "0:v:0", "-frames:v", String(highest + 1)], false, run);
    const frames = frameStream(decode, width, height, false);
    let position = -1;
    let stored = 0;
    for (const s of sources) {
      let crop: Picture | null = null;
      if (slots[s]! >= 0) {
        const bytes = Buffer.alloc(cropBytes);
        await crops.read(bytes, 0, cropBytes, slots[s]! * cropBytes);
        crop = pictureOf(bytes, recipe.cropSize, recipe.cropSize, false);
      }
      while (position < s) {
        const frame = await frames.next();
        if (frame === null) throw new RangeError("The prepared video ends before a frame the lip-sync clip shows");
        position += 1;
        if (position !== s && !kept.has(position)) continue;
        const passed = cropFace(frame, faces[position] ?? null, maskAt(track, position, { width, height }), recipe.cropSize);
        if (kept.has(position)) {
          slots[position] = stored;
          await crops.write(Buffer.concat([passed.y, passed.u, passed.v]), 0, cropBytes, stored * cropBytes);
          stored += 1;
        }
        if (position === s) crop = passed;
      }
      if (crop === null) throw new RangeError("A lip-sync clip's source frame was passed without being kept");
      await writePicture(encode.stdin, crop, encode.done);
    }
    if (await frames.next() !== null) throw new RangeError("The prepared video decoded past the frames the lip-sync clip shows");
    await decode.done;
    await finishEncode(encode);
  } finally {
    await Promise.all([settle(decode), settle(encode)]);
    await crops.close();
  }
}

/**
 * An exact time in seconds as samples on the 48 kHz grid, rounded to the nearest (halves away from 0).
 * @param time - The time.
 * @returns The samples.
 * @throws {never} Never.
 */
function stemSamples(time: { numerator: number; denominator: number }): bigint {
  const [a, b] = [BigInt(time.numerator) * 48000n, BigInt(time.denominator)];
  return (2n * a + b) / (2n * b);
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
  const samples = stemSamples(recipe.duration);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file"];
  const graph = recipe.rows.map((row, at) => {
    args.push("-i", local(request.inputs, row.inputId));
    return `[${at}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=PTS-STARTPTS,adelay=delays=${stemSamples(row.startTime)}S:all=1[r${at}]`;
  });
  const rows = recipe.rows.map((_row, at) => `[r${at}]`).join("");
  graph.push(`${rows}${recipe.rows.length === 1 ? "anull" : `amix=inputs=${recipe.rows.length}:normalize=0:duration=longest`},apad=whole_len=${samples},atrim=end_sample=${samples}[a]`);
  // The M4A brand: the Worker names stored bytes by their brand, and an isom-branded file reads as video/mp4.
  await runPlanCommand("ffmpeg", [...args, "-filter_complex", graph.join(";"), "-map", "[a]", "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-f", "ipod", request.output], run);
}

/**
 * One person of a composite chunk: its tables, the result frame each chunk frame shows (null past the result's end), and
 * the result streaming from the first of them with the frame last read and its index.
 */
interface CompositePerson {
  faces: FaceRect[]; track: (string | null)[]; shows: (number | null)[]; decode: PlanPipe | null; results: FrameStream | null;
  position: number; current: Picture | null; cropSize: number;
}

/** Where the prepared video's pixels land in the output picture: its size, its picture rectangle and the output's. */
interface Mapping { prepared: { width: number; height: number }; area: MiniToolPlanPixelRect; placed: MiniToolPlanPixelRect }

/**
 * Lay one person's generated face back onto a frame (§7.17 lipsync_composite row, DD §7.2 step 6): each output pixel whose
 * centre maps into the face rectangle of the prepared picture takes the result inverse-transformed through the crop fit,
 * weighted by the face's feathered edge times the person's tracked foreground; the alpha plane is left as the source has
 * it. The prepared picture rectangle is scaled onto the output's (an opaque odd side is rounded down there, §4.3). The edge
 * is feathered over `fraction` of the face's shorter side, at least one prepared pixel.
 * @param frame - The output picture, changed in place.
 * @param rect - The face rectangle in prepared pixels.
 * @param mask - The foreground mask at the prepared size.
 * @param map - Where the prepared pixels land in the output picture.
 * @param result - The person's result frame.
 * @param size - The crop side.
 * @param fraction - The plan's frozen face feather, a fraction of the face's shorter side.
 * @returns Nothing.
 * @throws {never} Never.
 */
function layFace(frame: Picture, rect: MiniToolPlanPixelRect, mask: Uint8Array, map: Mapping, result: Picture, size: number, fraction: number): void {
  const { prepared, area, placed } = map;
  const f = fit(rect, size);
  const feather = Math.max(1, Math.min(rect.width, rect.height) * fraction);
  const [sx, sy] = [area.width / placed.width, area.height / placed.height];
  /**
   * An output coordinate's position in the prepared picture, pixel i covering [i, i + 1) on both.
   * @param x - The output column.
   * @param y - The output row.
   * @returns The prepared position.
   * @throws {never} Never.
   */
  const toPrepared = (x: number, y: number): [number, number] => [area.x + (x - placed.x) * sx, area.y + (y - placed.y) * sy];
  const weights = new Float32Array(frame.width * frame.height);
  // The output pixels whose centres can fall in the face rectangle, inside the output picture.
  const x0 = Math.max(placed.x, Math.floor(placed.x + (rect.x - area.x) / sx));
  const y0 = Math.max(placed.y, Math.floor(placed.y + (rect.y - area.y) / sy));
  const x1 = Math.min(placed.x + placed.width, Math.ceil(placed.x + (rect.x + rect.width - area.x) / sx));
  const y1 = Math.min(placed.y + placed.height, Math.ceil(placed.y + (rect.y + rect.height - area.y) / sy));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const [px, py] = toPrepared(x + 0.5, y + 0.5);
      const edge = Math.min(px - rect.x, rect.x + rect.width - px, py - rect.y, rect.y + rect.height - py);
      if (edge <= 0) continue;
      const mx = Math.min(prepared.width - 1, Math.floor(px));
      const my = Math.min(prepared.height - 1, Math.floor(py));
      if (mask[my * prepared.width + mx] !== 1) continue;
      const weight = Math.min(1, edge / feather);
      const at = y * frame.width + x;
      weights[at] = weight;
      const value = sample(result.y, size, size, (px - rect.x) * (f.scaledWidth / rect.width) + f.padX - 0.5, (py - rect.y) * (f.scaledHeight / rect.height) + f.padY - 0.5);
      frame.y[at] = Math.round(frame.y[at]! * (1 - weight) + value * weight);
    }
  }
  const cw = Math.ceil(frame.width / 2);
  const rc = Math.ceil(size / 2);
  for (let cy = Math.floor(y0 / 2); cy < Math.ceil(y1 / 2); cy += 1) {
    for (let cx = Math.floor(x0 / 2); cx < Math.ceil(x1 / 2); cx += 1) {
      const quad = [[2 * cx, 2 * cy], [2 * cx + 1, 2 * cy], [2 * cx, 2 * cy + 1], [2 * cx + 1, 2 * cy + 1]];
      const weight = quad.reduce((sum, [x, y]) => sum + (x! < frame.width && y! < frame.height ? weights[y! * frame.width + x!]! : 0), 0) / 4;
      if (weight === 0) continue;
      // The chroma sample's centre in prepared-picture luma pixels, then in the result's chroma plane.
      const [lx, ly] = toPrepared(2 * cx + 1, 2 * cy + 1);
      const rx = ((lx - rect.x) * (f.scaledWidth / rect.width) + f.padX) / 2 - 0.5;
      const ry = ((ly - rect.y) * (f.scaledHeight / rect.height) + f.padY) / 2 - 0.5;
      const at = cy * cw + cx;
      frame.u[at] = Math.round(frame.u[at]! * (1 - weight) + sample(result.u, rc, rc, rx, ry) * weight);
      frame.v[at] = Math.round(frame.v[at]! * (1 - weight) + sample(result.v, rc, rc, rx, ry) * weight);
    }
  }
}

/**
 * A video's frames in presentation order on its own stream clock: each frame's presentation time and, for the last, its
 * end (its packet duration, or the step before it when none is recorded); the clock's tick as a fraction of a second; and
 * the scale options that decode it as a model result ({@link modelResultDecode}).
 * @param file - The video.
 * @param run - The lifetime and IO bounds.
 * @returns The tick, the frames' times in ticks and the decode options.
 * @throws {RangeError} When the result's tagged matrix has no decode value.
 * @throws {Error} When ffprobe fails or the stream has no time base.
 */
async function frameTimes(file: string, run: Run): Promise<{ tick: [bigint, bigint]; starts: bigint[]; end: bigint; lead: bigint; decode: string }> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries",
    "stream=time_base,color_space,color_range:packet=pts,dts,duration", "-of", "json", file], run)).toString("utf8")) as
    { streams?: ({ time_base?: string } & Record<string, unknown>)[]; packets?: { pts?: number; dts?: number; duration?: number }[] };
  const [numerator, denominator] = (answer.streams?.[0]?.time_base ?? "").split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator! <= 0 || denominator! <= 0) throw new Error("The lip-sync result has no time base");
  const packets = (answer.packets ?? []).filter((packet) => Number.isSafeInteger(packet.pts)).sort((a, b) => a.pts! - b.pts!);
  const starts = packets.map((packet) => BigInt(packet.pts!));
  const last = packets.at(-1);
  const duration = last?.duration !== undefined && last.duration > 0 ? BigInt(last.duration) : starts.length > 1 ? starts.at(-1)! - starts.at(-2)! : 0n;
  // How far a packet is presented after it is decoded: a demuxer that searches a seek time on the decode clock (the mov
  // demuxer of an MP4 without an edit list) lands on a keyframe up to this much later in presentation time.
  const lead = packets.reduce((most, packet) => Number.isSafeInteger(packet.dts) && packet.pts! - packet.dts! > most ? packet.pts! - packet.dts! : most, 0);
  return { tick: [BigInt(numerator!), BigInt(denominator!)], starts, end: (starts.at(-1) ?? 0n) + duration, lead: BigInt(lead), decode: modelResultDecode(answer.streams?.[0] ?? {}) };
}

/**
 * The result frame each result-grid frame of a chunk shows (DD §7.2 step 6, row R4: by presentation time, never by frame
 * number): grid frame k at k·step/clock s shows the frame whose start, from the result's first frame, is nearest that time,
 * ties to the earlier (the fps filter's round=near); null once the time is past the result's end. The indices never
 * decrease, so the result is read forward once.
 * @param times - The result's frame times.
 * @param times.tick - Its clock's tick in seconds.
 * @param times.starts - Each frame's presentation time in ticks, in order.
 * @param times.end - The last frame's end in ticks.
 * @param grid - The result grid.
 * @param grid.clock - Its timescale.
 * @param grid.step - Its frame step in that timescale.
 * @param window - The chunk's result-grid frames.
 * @returns One result frame index or null per chunk frame.
 * @throws {never} Never.
 */
function resultFramesShown(times: { tick: [bigint, bigint]; starts: bigint[]; end: bigint }, grid: { clock: number; step: number }, window: { start: number; end: number }): (number | null)[] {
  const { tick: [numerator, denominator], starts, end } = times;
  const first = starts[0] ?? 0n;
  // A frame time p ticks after the first frame is p·numerator/denominator s; grid time k·step/clock s; compared exactly.
  const scale = numerator * BigInt(grid.clock);
  const shows: (number | null)[] = [];
  let at = 0;
  for (let k = window.start; k < window.end; k += 1) {
    const time = BigInt(k) * BigInt(grid.step) * denominator;
    if (starts.length === 0 || (end - first) * scale <= time) { shows.push(null); continue; }
    // The frame starting nearest the grid time, ties to the earlier (the fps filter's round=near): a result written on its
    // own clock starts a frame a hair after the grid time and is still that grid frame's.
    while (at + 1 < starts.length) {
      const [current, next] = [(starts[at]! - first) * scale, (starts[at + 1]! - first) * scale];
      if (next > time && next - time >= time - current) break;
      at += 1;
    }
    shows.push(at);
  }
  return shows;
}

/**
 * A picture's own copy, for laying faces onto a source frame the next result frame shows again.
 * @param frame - The picture.
 * @returns The copy.
 * @throws {never} Never.
 */
function copyPicture(frame: Picture): Picture {
  // `new Uint8Array` copies; a Buffer's `slice` would share the bytes the encoder may still be writing.
  return { ...frame, y: new Uint8Array(frame.y), u: new Uint8Array(frame.u), v: new Uint8Array(frame.v), a: frame.a === null ? null : new Uint8Array(frame.a) };
}

/**
 * Write one composite chunk (§7.17 lipsync_composite row, §5.4): result frames [window.start, window.end) on the result clock
 * from 0, opening with a keyframe; result frame k shows the original's presentation frame
 * `lipsyncSourceFrameAt(timeline, grid, k)` with every person's result frame laid onto that frame's face, the result frame
 * being the one whose presentation time is nearest k's on the result grid (`resultFramesShown`); a frame without a face, or past
 * the person's result, leaves the source; a transparent original keeps its alpha (VP9), an opaque one is H.264. The entries cover
 * only the source frames the chunk shows (`lipsyncChunkSourceWindow`). Frames move through pipes (execution design
 * paragraph before §9.4): each person's result is opened at the window and streamed, and so is the output; the source is
 * streamed when the chunk's source frames never go back, and only when they do is its window decoded to a raw file and
 * read by index.
 * @param recipe - The composite recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the result frame step is not a whole number of the chunk's ticks, the raw source window is over the
 * plan's disk budget, the source or a person's result ends early, or a person's result has a tagged matrix with no decode value.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeComposite(recipe: MiniToolPlanLipsyncComposite, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const { target, timeline, frames: window } = recipe;
  const grid = { fps: recipe.grid.fps, frameCount: recipe.grid.frameCount };
  if (target.alpha === "packed") throw new RangeError("A lip-sync composite is an opaque H.264 or a transparent VP9 chunk");
  const alpha = target.alpha === "straight";
  const { rect: placed } = placement(target);
  // Tracks and face tables are in the prepared video's pixels; its picture rectangle is shown on the output's (§5.3, §4.3).
  const { prepared } = recipe;
  const map: Mapping = { prepared, area: prepared.displayRect ?? { x: 0, y: 0, width: prepared.width, height: prepared.height }, placed };
  const length = window.end - window.start;
  const sources = Array.from({ length }, (_unused, j) => lipsyncSourceFrameAt(timeline, grid, window.start + j));
  // Only the source grid frames this chunk shows are decoded, indexed from the first of them.
  const shown = lipsyncSourceSpan(sources, { start: 0, end: length });
  const file = local(request.inputs, recipe.inputId);
  const facts = await sourceFacts(file, run);
  const landed = await landedGridInput({ file, grid: recipe.grid, source: recipe.source, frames: { start: shown.start, end: shown.end } }, facts, request.directory, run);
  const sourceArgs = [...landed.input, "-filter_complex", `${landed.graph};[g]${picture(target, facts.range, "p")}[v]`, "-map", "[v]"];
  const persons: CompositePerson[] = [];
  let [held, streamed, encode]: [RawFrames | null, PlanPipe | null, (PlanPipe & { stdin: Writable }) | null] = [null, null, null];
  try {
    for (const person of recipe.persons) {
      const result = local(request.inputs, person.result);
      const [faces, track, times] = await Promise.all([readFaces(local(request.inputs, person.faces)), readRleTrack(local(request.inputs, person.track)), frameTimes(result, run)]);
      const shows = resultFramesShown(times, { clock: grid.fps.numerator, step: grid.fps.denominator }, window);
      const used = shows.filter((index): index is number => index !== null);
      let decode: PlanPipe | null = null;
      if (used.length > 0) {
        const [from, to] = [used[0]!, used.at(-1)!];
        // The first frame shown is the first at or after the midpoint between it and the one before, on the file's own packet
        // clock (`-seek_timestamp 1`, `-copyts`). The demuxer seek opens `lead` earlier, so the keyframe it lands on, searched
        // on the decode clock, is never past that frame; `select` then drops the frames before the midpoint.
        const seconds = (ticks: bigint): number => Number(ticks * times.tick[0]) / Number(times.tick[1]);
        const at = from === 0 ? 0 : (seconds(times.starts[from - 1]!) + seconds(times.starts[from]!)) / 2;
        // Floored to whole microseconds: a float residue near 0 would print as "1e-17", which `-ss` does not parse.
        const seek = (Math.floor(Math.max(0, at - seconds(times.lead)) * 1e6) / 1e6).toFixed(6);
        decode = startDecode(["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-copyts", "-noaccurate_seek", "-seek_timestamp", "1",
          "-ss", seek, "-i", result, "-map", "0:v:0", "-frames:v", String(to - from + 1),
          "-vf", `select=gte(t\\,${at}),scale=${person.cropSize}:${person.cropSize}:${times.decode}:out_color_matrix=bt709:out_range=tv`], false, run);
      }
      persons.push({ faces, track, shows, decode, results: decode === null ? null : frameStream(decode, person.cropSize, person.cropSize, false),
        position: (used[0] ?? 0) - 1, current: null, cropSize: person.cropSize });
    }
    if (shown.goesBack) {
      if ((shown.end - shown.start) * lipsyncPictureBytes(target.width, target.height, alpha) > recipe.rawDiskBytes) {
        throw new RangeError("The lip-sync composite's raw source window is over the plan's disk budget");
      }
      const file = join(request.directory, "composite-source.yuv");
      await decodeRaw(sourceArgs, alpha, file, run);
      held = await rawFrames(file, target.width, target.height, alpha);
      if (held.count < shown.end - shown.start) throw new RangeError("The lip-sync composite's source ends before a frame it shows");
      if (held.count > shown.end - shown.start) throw new RangeError("The lip-sync composite's source decoded past the frames it shows");
    } else streamed = startDecode(sourceArgs, alpha, run);
    const stream = streamed === null ? null : frameStream(streamed, target.width, target.height, alpha);
    const tick = grid.fps.denominator;
    encode = startEncode({ width: target.width, height: target.height, alpha }, { clock: grid.fps.numerator, tick, end: length * tick }, target, request.output, run);
    let [position, current]: [number, Picture | null] = [shown.start - 1, null];
    for (const [j, s] of sources.entries()) {
      let frame: Picture;
      if (held !== null) frame = await held.read(s - shown.start);
      else {
        while (position < s) {
          current = await stream!.next();
          if (current === null) throw new RangeError("The lip-sync composite's source ends before a frame it shows");
          position += 1;
        }
        frame = copyPicture(current!);
      }
      for (const person of persons) {
        const shows = person.shows[j];
        // Past the result's end the source face stays.
        if (shows === null || shows === undefined) continue;
        while (person.position < shows) {
          person.current = await person.results!.next();
          if (person.current === null) throw new RangeError("A lip-sync person's result ends before a frame it shows");
          person.position += 1;
        }
        const result = person.current!;
        const rect = person.faces[s] ?? null;
        const mask = maskAt(person.track, s, prepared);
        if (rect !== null && mask !== null) layFace(frame, rect, mask, map, result, person.cropSize, recipe.feather);
      }
      await writePicture(encode.stdin, frame, encode.done);
    }
    if (stream !== null && await stream.next() !== null) throw new RangeError("The lip-sync composite's source decoded past the frames it shows");
    await streamed?.done;
    for (const person of persons) {
      if (person.results !== null && await person.results.next() !== null) throw new RangeError("A lip-sync person's result decoded past the chunk");
      await person.decode?.done;
    }
    await finishEncode(encode);
  } finally {
    await Promise.all([settle(streamed), settle(encode), ...persons.map((person) => settle(person.decode))]);
    await held?.close();
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
