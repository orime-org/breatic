// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Extract the first frame of a video as a PNG cover image.
 *
 * Uses ffmpeg to read the video URL directly (only downloads the first few MB
 * for the initial frame), then encodes the frame to PNG with Sharp. Per the
 * format convention (#1826 §8) every image we produce ourselves is a PNG, so a
 * generated video's cover lands in the same format as an uploaded video's
 * (which the browser rasterises client-side). Same format, never the same
 * bytes — the two run different PNG encoders (libvips here, the browser's
 * there) and this path additionally decodes through a lossy MJPEG frame, so a
 * cover from one side never dedups against a cover from the other.
 *
 * ffmpeg only has to decode the video and emit that MJPEG frame; Sharp brings
 * the PNG encoder. Storing it is the caller's: the cover goes to R2 the way
 * every other asset does, through the ingest Worker (#181), which is also
 * where its hash is computed.
 *
 * Note the MJPEG step is lossy: the PNG wraps pixels that already carry JPEG
 * artefacts. It is what the WebP-era code did too, so this is not a regression,
 * but "PNG" here means the container, not an end-to-end lossless pipeline.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/**
 * Extract a video's first frame as a PNG.
 *
 * Cover extraction is best-effort, so this returns `undefined` for
 * any non-fatal failure path (ffmpeg missing, no output, exec error)
 * instead of throwing or logging here — the single call site (the
 * video job handler) owns the warn/audit decision on `undefined`,
 * keeping the logging in one application-boundary place.
 * @param videoUrl - Permanent video URL (R2)
 * @returns The PNG bytes and the type they are served as, so the caller stores
 *   them without re-declaring the format — the cover owns its own mime, which
 *   is what keeps the stored object and the ledger row from drifting apart.
 *   `undefined` if extraction / encoding fails (caller logs the decision).
 */
export async function extractVideoCover(
  videoUrl: string,
): Promise<{ png: Buffer; mimeType: string } | undefined> {
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
    // PNG codec — ffmpeg above only has to emit MJPEG.
    const png = await sharp(stdout).png().toBuffer();
    return { png, mimeType: "image/png" };
  } catch {
    // ffmpeg missing, extraction failed, or PNG encoding failed — all
    // non-fatal; returns undefined so the worker handler can decide to log
    // (cover stays best-effort → Film icon, #1824 invariant preserved).
    return undefined;
  }
}
