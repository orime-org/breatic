/**
 * Synthetic test fixtures — generated on the fly, never committed.
 *
 * Rationale: binary fixtures accumulate in git history as they get
 * replaced. Generating them from code keeps the repo small and makes
 * each test's input properties (size / format / color) explicit in
 * code instead of opaque in a .mp4 / .png blob.
 *
 * Sharp handles PNG / JPEG generation in-process.
 * FFmpeg handles MP4 / audio generation via its `lavfi` synthetic
 * source — the worker Docker image ships FFmpeg, so CI has it too.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export interface TestPngOptions {
  width?: number;
  height?: number;
  /** Solid background color. Default: red. */
  color?: { r: number; g: number; b: number };
  /** If true, encode with an alpha channel (default channels=4 if set). */
  alpha?: boolean;
}

/** Generate a solid-color PNG Buffer in memory. */
export async function makeTestPng(opts: TestPngOptions = {}): Promise<Buffer> {
  const width = opts.width ?? 200;
  const height = opts.height ?? 100;
  const color = opts.color ?? { r: 255, g: 0, b: 0 };
  const alpha = opts.alpha ?? true;
  return await sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { ...color, alpha: 1 } : color,
    },
  })
    .png()
    .toBuffer();
}

export interface TestMp4Options {
  width?: number;
  height?: number;
  /** Duration in seconds. Default: 1. */
  duration?: number;
  /** Frame rate. Default: 30. */
  rate?: number;
  /** Include a silent audio track (useful for cut/audio-denoise tests). */
  withAudio?: boolean;
}

/**
 * Generate a small MP4 using FFmpeg's synthetic `testsrc` source and
 * optional silent audio. Writes to the provided path.
 *
 * The output is H.264 yuv420p at low bitrate — small (under ~50 KB for
 * 1 second 200x100 video) and widely decodable.
 */
export async function makeTestMp4(outPath: string, opts: TestMp4Options = {}): Promise<void> {
  const width = opts.width ?? 200;
  const height = opts.height ?? 100;
  const duration = opts.duration ?? 1;
  const rate = opts.rate ?? 30;
  const withAudio = opts.withAudio ?? true;

  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", `testsrc=size=${width}x${height}:duration=${duration}:rate=${rate}`,
  ];
  if (withAudio) {
    args.push(
      "-f", "lavfi",
      "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
      "-shortest",
    );
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "48k");
  args.push(outPath);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { shell: false });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) =>
      reject(new Error(`makeTestMp4: failed to spawn ffmpeg: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`makeTestMp4: ffmpeg exited ${code}\n${stderr.slice(-1000)}`));
    });
  });
}

/** Allocate an isolated temp dir for a single test and return a disposer. */
export function createTestTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `breatic-worker-test-${randomBytes(4).toString("hex")}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
