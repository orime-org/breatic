// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import type { Readable, Writable } from "node:stream";
import { rational } from "@shared/mini-tools/video-presentation-projection.js";
import {
  lipsyncPictureBytes, lipsyncResultSourceFrames, lipsyncSourceFrameAt, lipsyncSourceSpan, type LipsyncTimeline,
} from "@shared/mini-tools/lipsync-timeline.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
import type {
  MiniToolPlanDetectorProfile, MiniToolPlanLipsyncClip, MiniToolPlanLipsyncComposite, MiniToolPlanLipsyncFaces, MiniToolPlanLipsyncStem, MiniToolPlanPixelRect, MiniToolPlanTarget,
} from "@shared/upload/mini-tool-plan-types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { decodeCocoRleMask } from "@shared/mini-tools/coco-rle.js";
import { readYuNetFaces } from "@ingest/container/analysis-detection.js";
import { runPlanCommand, startPlanCommand, type PlanPipe } from "@ingest/container/plan-command.js";
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
      await handle.read(bytes, 0, size, Math.min(index, count - 1) * size);
      return pictureOf(bytes, width, height, alpha);
    },
    close: () => handle.close(),
  };
}

/** The frames of a raw stream in order, one at a time; null once the stream has ended. */
interface FrameStream { next(): Promise<Picture | null> }

/**
 * Read a program's raw 8-bit 4:2:0 stdout one frame at a time (execution design paragraph before §9.4): only the frame being
 * filled and the pipe's current chunk are held.
 * @param stdout - The stream.
 * @param width - The frame width.
 * @param height - The frame height.
 * @param alpha - Whether each frame carries an alpha plane.
 * @returns The frames.
 * @throws {never} Never; `next` throws when the stream ends inside a frame.
 */
function frameStream(stdout: Readable, width: number, height: number, alpha: boolean): FrameStream {
  const chunks = stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
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
  const { video, muxer } = videoOutput(target, BigInt(timing.clock), BigInt(timing.end));
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
 * Write one person's face clip (§7.17 lipsync_clip row, execution design §9.2): result frame t shows source frame
 * `lipsyncSourceFrameAt(timeline, table, t)` cropped to that frame's face, H.264 of `timeline.duration` on the prepared
 * video's frame rate. The prepared video is decoded once, forward, on FFmpeg's stdout and each crop goes to the encoder's
 * stdin as its frame arrives (execution design paragraph before §9.4): the first use of every source frame never goes back
 * on the result grid, and a frame the result shows again is cropped once into the crop file and read back from it.
 * @param recipe - The clip recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When a source frame's first use goes back, or the prepared video ends before a frame the result shows.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeClip(recipe: MiniToolPlanLipsyncClip, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const video = local(request.inputs, recipe.inputId);
  const { width, height } = await videoFacts(video, run);
  const [track, faces] = await Promise.all([readTrack(local(request.inputs, recipe.track)), readFaces(local(request.inputs, recipe.faces))]);
  const grid = resultGrid(recipe.timeline, recipe.table);
  const sources = lipsyncResultSourceFrames(recipe.timeline, recipe.table);
  const highest = Math.max(...sources);
  // Each source frame's last use, so a crop is kept in the crop file only when the result shows it again.
  const lastUse = new Int32Array(highest + 1).fill(-1);
  sources.forEach((s, k) => { lastUse[s] = k; });
  const slots = new Int32Array(highest + 1).fill(-1);
  const cropBytes = lipsyncPictureBytes(recipe.cropSize, recipe.cropSize, false);
  const crops = await open(join(request.directory, "clip-crops.yuv"), "w+");
  let [decode, encode]: [PlanPipe | null, (PlanPipe & { stdin: Writable }) | null] = [null, null];
  try {
    encode = startEncode({ width: recipe.cropSize, height: recipe.cropSize, alpha: false }, { clock: grid.clock, tick: grid.step, end: grid.end },
      { width: recipe.cropSize, height: recipe.cropSize, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", ...CLIP_ENCODE, format: "mp4-h264" }, request.output, run);
    decode = startDecode(["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-i", video, "-map", "0:v:0", "-frames:v", String(highest + 1)], false, run);
    const frames = frameStream(decode.stdout!, width, height, false);
    let position = -1;
    let stored = 0;
    for (const [k, s] of sources.entries()) {
      let crop: Picture;
      if (slots[s]! >= 0) {
        const bytes = Buffer.alloc(cropBytes);
        await crops.read(bytes, 0, cropBytes, slots[s]! * cropBytes);
        crop = pictureOf(bytes, recipe.cropSize, recipe.cropSize, false);
      } else {
        if (s <= position) throw new RangeError("A lip-sync clip's source frame is first used after a later one");
        let frame: Picture | null = null;
        while (position < s) {
          frame = await frames.next();
          if (frame === null) throw new RangeError("The prepared video ends before a frame the lip-sync clip shows");
          position += 1;
        }
        crop = cropFace(frame!, faces[s] ?? null, maskAt(track, s, { width, height }), recipe.cropSize);
        if (lastUse[s]! > k) {
          slots[s] = stored;
          await crops.write(Buffer.concat([crop.y, crop.u, crop.v]), 0, cropBytes, stored * cropBytes);
          stored += 1;
        }
      }
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

/** One person of a composite chunk: its tables and its result streaming over the chunk's window, null once it has ended. */
interface CompositePerson { faces: FaceRect[]; track: (string | null)[]; decode: PlanPipe | null; results: FrameStream | null; cropSize: number }

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
 * Where a video's frame starts, for opening it there: midway between that frame's presentation time and the one before, so
 * an accurate seek keeps the frame and drops the earlier ones; null when the video has no such frame.
 * @param file - The video.
 * @param frame - The frame, in presentation order.
 * @param run - The lifetime and IO bounds.
 * @returns The seek time in seconds, 0 for the first frame.
 * @throws {Error} When ffprobe fails.
 */
async function seekTo(file: string, frame: number, run: Run): Promise<number | null> {
  const times = (await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
    "-of", "csv=p=0", file], run)).toString("utf8").split("\n").filter((line) => line.trim() !== "").map(Number).filter((time) => Number.isFinite(time)).sort((x, y) => x - y);
  if (frame >= times.length) return null;
  return frame === 0 ? 0 : (times[frame - 1]! + times[frame]!) / 2;
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
 * `lipsyncSourceFrameAt(timeline, table, t_k)` with every person's result frame k laid onto that frame's face; a frame
 * without a face leaves the source; a transparent original keeps its alpha (VP9), an opaque one is H.264. The entries cover
 * only the source frames the chunk shows (`lipsyncChunkSourceWindow`). Frames move through pipes (execution design
 * paragraph before §9.4): each person's result is opened at the window and streamed, and so is the output; the source is
 * streamed when the chunk's source frames never go back, and only when they do is its window decoded to a raw file and
 * read by index.
 * @param recipe - The composite recipe.
 * @param request - The files, directory and lifetime.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the result frame step is not a whole number of the chunk's ticks, the raw source window is over the
 * plan's disk budget, or the source ends early.
 * @throws {Error} When decoding, reading or encoding fails.
 */
async function writeComposite(recipe: MiniToolPlanLipsyncComposite, request: LipsyncRecipeRequest, run: Run): Promise<void> {
  const { target, table, timeline, window } = recipe;
  if (target.alpha === "packed") throw new RangeError("A lip-sync composite is an opaque H.264 or a transparent VP9 chunk");
  const alpha = target.alpha === "straight";
  const { rect: placed } = placement(target);
  // Result frame j of the chunk lasts the prepared video's frame step, in this chunk's ticks.
  const step = table.runs[0]!.step * recipe.timescale;
  if (step % table.timescale !== 0) throw new RangeError("The result frame step is not a whole number of the chunk's ticks");
  const tick = step / table.timescale;
  const length = window.end - window.start;
  const sources = Array.from({ length }, (_unused, j) => lipsyncSourceFrameAt(timeline, table, ((window.start + j) * table.runs[0]!.step) / table.timescale));
  // The entries cover only the source frames this chunk shows, so the decoded frames start at the window's first.
  const shown = lipsyncSourceSpan(sources, { start: 0, end: length });
  const graph = await windowGraph(recipe.entries, BigInt(table.timescale), local(request.inputs, recipe.inputId), run, (label) => picture(target, label),
    (entry) => `color=c=black${alpha && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,format=${alpha ? "yuva420p" : "yuv420p"},setsar=1`);
  const sourceArgs = [...graph.args, "-filter_complex", graph.graph.join(";"), "-map", "[v]"];
  const persons: CompositePerson[] = [];
  let [held, streamed, encode]: [RawFrames | null, PlanPipe | null, (PlanPipe & { stdin: Writable }) | null] = [null, null, null];
  try {
    for (const person of recipe.persons) {
      const result = local(request.inputs, person.result);
      const [faces, track, at] = await Promise.all([readFaces(local(request.inputs, person.faces)), readTrack(local(request.inputs, person.track)), seekTo(result, window.start, run)]);
      const decode = at === null ? null : startDecode(["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-ss", String(at), "-i", result,
        "-map", "0:v:0", "-frames:v", String(length), "-vf", `scale=${person.cropSize}:${person.cropSize}:out_color_matrix=bt709:out_range=tv`], false, run);
      persons.push({ faces, track, decode, results: decode === null ? null : frameStream(decode.stdout!, person.cropSize, person.cropSize, false), cropSize: person.cropSize });
    }
    if (shown.goesBack) {
      if ((shown.end - shown.start) * lipsyncPictureBytes(target.width, target.height, alpha) > recipe.rawDiskBytes) {
        throw new RangeError("The lip-sync composite's raw source window is over the plan's disk budget");
      }
      const file = join(request.directory, "composite-source.yuv");
      await decodeRaw(sourceArgs, alpha, file, run);
      held = await rawFrames(file, target.width, target.height, alpha);
    } else streamed = startDecode(sourceArgs, alpha, run);
    const stream = streamed === null ? null : frameStream(streamed.stdout!, target.width, target.height, alpha);
    encode = startEncode({ width: target.width, height: target.height, alpha }, { clock: recipe.timescale, tick, end: length * tick }, target, request.output, run);
    let [position, current]: [number, Picture | null] = [shown.start - 1, null];
    for (const s of sources) {
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
        const result = person.results === null ? null : await person.results.next();
        if (result === null) { person.results = null; continue; }
        const rect = person.faces[s] ?? null;
        const mask = maskAt(person.track, s, placed);
        if (rect !== null && mask !== null) layFace(frame, rect, mask, placed, result, person.cropSize);
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
