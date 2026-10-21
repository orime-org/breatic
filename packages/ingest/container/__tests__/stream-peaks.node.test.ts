// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the media container reads an audio object's peaks (inner#1305 §4.4).
 * Node stands in for ffmpeg: what is under test is how its stdout is read and
 * when the result is kept, not the decoder.
 */

import { describe, expect, it } from "vitest";

import { audioPeaksSchema } from "@shared/upload/peaks.js";
import { streamPeaks } from "../stream-peaks.js";

/**
 * Arguments that make Node write these samples as f32le, then exit.
 * @param script - What the stand-in runs before exiting; `out(samples)` writes floats.
 * @returns Node's arguments.
 */
function standIn(script: string): string[] {
  const prelude =
    "const out = (s) => { const b = Buffer.alloc(s.length * 4); s.forEach((v, i) => b.writeFloatLE(v, i * 4)); process.stdout.write(b); };";
  return ["-e", `${prelude}${script}`];
}

/**
 * Read a result's JSON.
 * @param bytes - The result.
 * @returns The parsed file.
 */
function parsed(bytes: Uint8Array | null): unknown {
  return bytes === null ? null : audioPeaksSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

const LIVE = (): AbortSignal => AbortSignal.timeout(30_000);

describe("streamPeaks", () => {
  it("reads the program's samples into a peaks file", async () => {
    const got = await streamPeaks(process.execPath, standIn("out([0.5, -1, 0]);"), 3, LIVE());
    expect(parsed(got)).toEqual({ version: 1, peaks: [128, 255, 0] });
  });

  // An hour of 8 kHz mono floats is about 115 MB; the runner that buffers
  // stdout stops at 4 MiB, so this one must not hold the output.
  it("reads more than 4 MiB of output", async () => {
    const samples = 1_500_000;
    const got = await streamPeaks(
      process.execPath,
      standIn(`const n = ${samples}; const step = 100000; for (let i = 0; i < n; i += step) out(Array.from({ length: step }, (_, j) => (i + j === n - 1 ? 1 : 0.25)));`),
      samples,
      LIVE(),
    );
    const file = parsed(got) as { peaks: number[] };
    expect(file.peaks).toHaveLength(1000);
    expect(file.peaks[999]).toBe(255);
    expect(file.peaks[0]).toBe(64);
  });

  it("keeps nothing when the program exits non-zero", async () => {
    const got = await streamPeaks(process.execPath, standIn("out([0.5]); process.exitCode = 1;"), 1, LIVE());
    expect(got).toBeNull();
  });

  it("keeps nothing when the program cannot be started", async () => {
    const got = await streamPeaks("/nonexistent/ffmpeg", [], 1, LIVE());
    expect(got).toBeNull();
  });

  it("keeps nothing and stops the program when the deadline passes", async () => {
    const started = Date.now();
    const got = await streamPeaks(
      process.execPath,
      standIn("out([0.5]); setTimeout(() => {}, 60_000);"),
      1,
      AbortSignal.timeout(300),
    );
    expect(got).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps nothing when the program wrote no samples", async () => {
    const got = await streamPeaks(process.execPath, standIn(""), 10, LIVE());
    expect(got).toBeNull();
  });
});
