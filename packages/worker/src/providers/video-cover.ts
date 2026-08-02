// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Extract the first frame of a video as a PNG cover image.
 *
 * Uses ffmpeg to read the video URL directly (only downloads the first few MB
 * for the initial frame), then encodes the frame to PNG with Sharp. Per the
 * format convention (#1826 §8) every image we produce ourselves is a PNG, so
 * a generated video's cover lands in the same format as an uploaded video's
 * (which the browser rasterises client-side) — same container, not the same
 * bytes: this path goes through a lossy MJPEG intermediate, so the two never
 * share a content hash and never dedup against each other.
 *
 * ffmpeg only has to decode the video and emit an MJPEG frame; Sharp ships its
 * own PNG codec, so the cover's format never depends on the ffmpeg binary
 * having been built with a PNG encoder. The cover is then uploaded to the same
 * storage as the video.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { getStorageAdapter, storageKey, sha256Hex } from "@breatic/core";

const execFileAsync = promisify(execFile);

/**
 * Extract first frame from a video URL and upload as cover image.
 *
 * Cover extraction is best-effort, so this returns `undefined` for
 * any non-fatal failure path (ffmpeg missing, no output, exec error)
 * instead of throwing or logging here — the single call site (the
 * video job handler) owns the warn/audit decision on `undefined`,
 * keeping the logging in one application-boundary place.
 * @param videoUrl - Permanent video URL (OSS/S3/local)
 * @returns The cover's URL + storage identity (key / sha256 / byte size / mime,
 *   over the PNG bytes) so the caller can register it as a first-class
 *   studio_assets row (#1826 §4.5) WITHOUT re-declaring the format (the cover
 *   owns its own mime, so the register can't drift). `undefined` if extraction
 *   / encoding fails (caller logs the decision).
 */
export async function extractVideoCover(
  videoUrl: string,
): Promise<
  { url: string; key: string; sha256: string; sizeBytes: number; mimeType: string } | undefined
> {
  try {
    // ffmpeg reads the remote URL directly, outputs a single frame to stdout
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-i", videoUrl,
        "-vframes", "1",
        "-f", "image2",
        "-vcodec", "mjpeg",
        "-q:v", "2",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
    );

    if (!stdout || stdout.length === 0) {
      return undefined;
    }

    // Re-encode the frame to PNG (§8 format convention). Sharp bundles its own
    // PNG codec — ffmpeg above only has to emit MJPEG — so the identity below
    // is over the PNG bytes that actually get stored.
    const png = await sharp(stdout).png().toBuffer();

    const key = storageKey({
      taskType: "video",
      ext: "_cover.png",
    });

    const adapter = await getStorageAdapter();
    const url = await adapter.upload(key, png, "image/png");
    return {
      url,
      key,
      sha256: sha256Hex(png),
      sizeBytes: png.length,
      mimeType: "image/png",
    };
  } catch {
    // ffmpeg missing, extraction failed, or PNG encoding failed — all
    // non-fatal; returns undefined so the worker handler can decide to log
    // (cover stays best-effort → Film icon, #1824 invariant preserved).
    return undefined;
  }
}
