/**
 * Video "scene extension" handler — pad the frame outward with black.
 *
 * Not true AIGC scene extension (which would hallucinate plausible
 * pixels). Mirrors the pre-migration browser ffmpeg.wasm behaviour in
 * `videoSceneExtensionWithFfmpeg.ts` — widens the canvas by padding
 * black bars into the requested outer frame, respecting the user's
 * framing offsets from the mixed-editor drag handles.
 *
 * If/when a true outpainting pipeline is wanted, register it under a
 * distinct tool name (e.g. `video.scene-extend-ai`) and keep this one
 * for visual parity with the legacy front-end.
 *
 * Params:
 *   video:     http(s) URL
 *   frame:     { w, h, ox, oy } — outer frame the source should fit into.
 *              `w/h` must be >= container (clamped), `ox/oy` must be
 *              non-positive (clamped) — matches the front-end contract.
 *   container: { width, height } — original content box (>= 1).
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { downloadToTempDir } from "../runtime/download.js";
import { uploadTempFileToStorage } from "../runtime/upload.js";
import { spawnCollected } from "../runtime/spawn.js";

interface Frame {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

interface Container {
  width: number;
  height: number;
}

interface SceneExtensionParams {
  video: string;
  frame: Frame;
  container: Container;
}

function parseFrame(raw: unknown, i: string): Frame {
  if (typeof raw !== "object" || raw == null) {
    throw new Error(`video/scene-extension: ${i} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ["w", "h", "ox", "oy"]) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`video/scene-extension: ${i}.${key} must be a finite number`);
    }
  }
  return { w: r.w as number, h: r.h as number, ox: r.ox as number, oy: r.oy as number };
}

function parseContainer(raw: unknown): Container {
  if (typeof raw !== "object" || raw == null) {
    throw new Error("video/scene-extension: `container` must be an object");
  }
  const r = raw as Record<string, unknown>;
  const width = r.width;
  const height = r.height;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    throw new Error("video/scene-extension: `container.width` must be a positive finite number");
  }
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    throw new Error("video/scene-extension: `container.height` must be a positive finite number");
  }
  return { width, height };
}

function parseParams(raw: Record<string, unknown>): SceneExtensionParams {
  const video = raw.video;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/scene-extension: `video` must be an http(s) URL");
  }
  const frame = parseFrame(raw.frame, "`frame`");
  const container = parseContainer(raw.container);
  return { video, frame, container };
}

/**
 * Mirror of the front-end coordinate normalisation. Both code paths
 * must round and clamp identically so results are visually identical
 * after migration.
 */
function normalise(frame: Frame, container: Container): {
  cw: number;
  ch: number;
  fw: number;
  fh: number;
  ox: number;
  oy: number;
} {
  const cw = Math.max(1, Math.round(container.width));
  const ch = Math.max(1, Math.round(container.height));
  const fw = Math.max(cw, Math.round(frame.w));
  const fh = Math.max(ch, Math.round(frame.h));
  const ox = Math.min(0, Math.round(frame.ox));
  const oy = Math.min(0, Math.round(frame.oy));
  return { cw, ch, fw, fh, ox, oy };
}

/**
 * Build the FFmpeg `pad=...` filter. Output dimensions are expressed
 * in terms of input dimensions (`iw/ih`) so a source scaled to `cw × ch`
 * by the player lands in a frame of `fw × fh` at (-ox, -oy).
 *
 * Even-rounding (`trunc(.../2)*2`) is required for yuv420p output.
 */
function buildPadFilter(
  cw: number,
  ch: number,
  fw: number,
  fh: number,
  ox: number,
  oy: number,
): string {
  const scaleW = fw / cw;
  const scaleH = fh / ch;
  const offsetXPct = -ox / cw;
  const offsetYPct = -oy / ch;
  const outWExpr = `trunc(max(iw\\,iw*${scaleW.toFixed(8)})/2)*2`;
  const outHExpr = `trunc(max(ih\\,ih*${scaleH.toFixed(8)})/2)*2`;
  const xExpr = `trunc(max(0\\,iw*${offsetXPct.toFixed(8)})/2)*2`;
  const yExpr = `trunc(max(0\\,ih*${offsetYPct.toFixed(8)})/2)*2`;
  return `pad=${outWExpr}:${outHExpr}:${xExpr}:${yExpr}:black,setsar=1`;
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, frame, container } = parseParams(rawParams);
  const { cw, ch, fw, fh, ox, oy } = normalise(frame, container);

  if (fw === cw && fh === ch && ox === 0 && oy === 0) {
    // Degenerate case — frame matches container. Skip the re-encode.
    return { url: video, cost: 0 };
  }

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  const vf = buildPadFilter(cw, ch, fw, fh, ox, oy);

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  const url = await uploadTempFileToStorage({
    path: outputPath,
    userId: ctx.userId,
    projectId: ctx.projectId,
    taskType: ctx.taskType,
    ext: ".mp4",
    contentType: "video/mp4",
  });

  return { url, cost: 0 };
};

export default handler;
