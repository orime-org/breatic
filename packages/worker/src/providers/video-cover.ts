/**
 * Extract the first frame of a video as a JPEG cover image.
 *
 * Uses ffmpeg to read the video URL directly (only downloads the
 * first few MB for the initial frame) and outputs a JPEG buffer.
 * The cover is then uploaded to the same storage as the video.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStorageAdapter, storageKey } from "@breatic/core";

const execFileAsync = promisify(execFile);

/**
 * Extract first frame from a video URL and upload as cover image.
 *
 * Cover extraction is best-effort, so this returns `undefined` for
 * any non-fatal failure path (ffmpeg missing, no output, exec error)
 * instead of throwing or logging here — the single call site (the
 * video job handler) owns the warn/audit decision on `undefined`,
 * keeping the logging in one application-boundary place.
 *
 * @param videoUrl - Permanent video URL (OSS/S3/local)
 * @param opts - userId/projectId for storage key generation
 * @returns Cover image URL, or `undefined` if extraction fails
 *   (caller logs the decision)
 */
export async function extractVideoCover(
  videoUrl: string,
  opts: { userId: string; projectId?: string },
): Promise<string | undefined> {
  try {
    // ffmpeg reads the remote URL directly, outputs JPEG to stdout
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

    const key = storageKey({
      userId: opts.userId,
      projectId: opts.projectId,
      taskType: "video",
      ext: "_cover.jpg",
    });

    const adapter = await getStorageAdapter();
    return adapter.upload(key, stdout, "image/jpeg");
  } catch {
    // ffmpeg not installed or extraction failed — non-fatal,
    // returns undefined so worker handler can decide to log.
    return undefined;
  }
}
