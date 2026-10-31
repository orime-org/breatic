// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read an audio object's peaks while ffmpeg decodes it (inner#1305 §4.4).
 *
 * The decoded samples are folded into stretches as they arrive and never held:
 * an hour at 8 kHz is about 115 MB of floats, which `runTool` would buffer and
 * cut off at its ceiling.
 */

import { spawn } from "node:child_process";

import { encodeAudioPeaks, peakBuckets } from "@shared/audio-peaks.js";
import { SOURCE_BROKE_OFF } from "@ingest/probe-command.js";

/**
 * Run the decoder and read its stdout into a peaks file.
 * @param program - `ffmpeg`.
 * @param args - Its argument list (`peaksArgs`).
 * @param expectedSamples - How many samples the object holds at the peaks' rate.
 * @param signal - The run's deadline; the decoder is killed when it passes.
 * @returns The peaks file's bytes, or null when the decoder failed, was cut
 *   off, read a source that broke off or wrote nothing.
 */
export function streamPeaks(
  program: string,
  args: string[],
  expectedSamples: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const buckets = peakBuckets(expectedSamples);
    let wrote = false;
    let brokeOff = false;
    let stderrTail = "";
    let settled = false;
    /**
     * Answer once, whatever ends the run first.
     * @param bytes - The answer.
     */
    const settle = (bytes: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      resolve(bytes);
    };
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    // A damaged source writes a line per bad frame before the mark that its
    // read broke off, so the mark is looked for chunk by chunk, with the end of
    // the chunk before in case it was split; only the tail is kept for the log.
    child.stderr.on("data", (chunk: Buffer) => {
      const seen = stderrTail + chunk.toString("utf8");
      brokeOff ||= seen.includes(SOURCE_BROKE_OFF);
      stderrTail = seen.slice(-2000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      wrote = true;
      buckets.add(chunk);
    });
    child.on("error", (err) => {
      console.error("media_peaks_failed", { err: err.message });
      settle(null);
    });
    child.on("close", (code) => {
      if (code !== 0 || !wrote || brokeOff) {
        console.error("media_peaks_failed", { code, wrote, brokeOff, stderr: stderrTail });
        settle(null);
        return;
      }
      settle(encodeAudioPeaks(buckets.finish()));
    });
  });
}
