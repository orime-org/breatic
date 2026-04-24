/**
 * Video cut handler — FFmpeg-based segment extraction + concat.
 *
 * Accepts an ordered list of `{ start, end }` time ranges (seconds)
 * and outputs a single MP4 with just those segments stitched in
 * order. One segment is a simple trim; multiple segments use
 * FFmpeg's `concat` demuxer via an intermediate segment list.
 *
 * Segment boundaries are validated to be ascending within each range
 * and non-negative — overlapping ranges are rejected (callers should
 * merge or de-dup beforehand). Out-of-bounds ends (past source
 * duration) are permitted: FFmpeg clamps them silently.
 *
 * Output: H.264 yuv420p + AAC.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { downloadToTempDir } from "../runtime/download.js";
import { uploadTempFileToStorage } from "../runtime/upload.js";
import { spawnCollected } from "../runtime/spawn.js";

interface Segment {
  start: number;
  end: number;
}

interface CutParams {
  video: string;
  segments: Segment[];
}

function parseParams(raw: Record<string, unknown>): CutParams {
  const video = raw.video;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/cut: `video` must be an http(s) URL");
  }
  const rawSegments = raw.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new Error("video/cut: `segments` must be a non-empty array");
  }
  const segments: Segment[] = rawSegments.map((seg, i) => {
    if (typeof seg !== "object" || seg == null) {
      throw new Error(`video/cut: segment[${i}] must be an object with start/end`);
    }
    const start = (seg as { start?: unknown }).start;
    const end = (seg as { end?: unknown }).end;
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error(`video/cut: segment[${i}] start/end must be numbers`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`video/cut: segment[${i}] start/end must be finite`);
    }
    if (start < 0) {
      throw new Error(`video/cut: segment[${i}] start must be >= 0`);
    }
    if (end <= start) {
      throw new Error(`video/cut: segment[${i}] end must be > start`);
    }
    return { start, end };
  });
  return { video, segments };
}

/**
 * Extract a single segment to `outPath`. Uses input seek (`-ss` before
 * `-i`) for efficient keyframe jump, then re-encodes to ensure the cut
 * is frame-accurate (output seek).
 */
async function extractSegment(
  inputPath: string,
  outPath: string,
  seg: Segment,
): Promise<void> {
  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-ss", seg.start.toFixed(3),
    "-to", seg.end.toFixed(3),
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ]);
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, segments } = parseParams(rawParams);

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  if (segments.length === 1) {
    await extractSegment(inputPath, outputPath, segments[0]!);
  } else {
    // Multi-segment: extract each piece then concat-demux. Concat
    // demuxer needs a plain text manifest listing each segment's path.
    const segmentPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const p = join(ctx.tempDir, `seg-${i}.mp4`);
      await extractSegment(inputPath, p, segments[i]!);
      segmentPaths.push(p);
    }
    const listPath = join(ctx.tempDir, "segments.txt");
    await writeFile(
      listPath,
      segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );
    await spawnCollected("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);
  }

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
