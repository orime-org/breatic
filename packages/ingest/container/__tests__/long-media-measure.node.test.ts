// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeArgs } from "@ingest/probe-command.js";
import { buildLongMediaProbeReport } from "@ingest/long-media-probe-report.js";
import * as probeOwner from "../long-media-probe.js";

let dir: string;

/**
 * Write one FFmpeg fixture.
 * @param name - The file name.
 * @param args - FFmpeg arguments before the output path.
 * @returns Its path.
 */
function make(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, path]);
  return path;
}

/**
 * The probe this container runs first, on a local file.
 * @param path - The fixture.
 * @returns FFprobe's JSON.
 */
function probed(path: string): string {
  return execFileSync("ffprobe", probeArgs(path, "own-file")).toString("utf8");
}

/**
 * The measuring entry, read at call time so its absence fails each case on its own.
 * @returns It.
 */
function measure(): (objectUrl: string, stdout: string, signal: AbortSignal, from: "own-file") => Promise<{ index: number; start: { numerator: string; denominator: string }; end: { numerator: string; denominator: string } }[]> {
  const value: unknown = Reflect.get(probeOwner, "measureLongMediaStreams");
  expect(value, "measureLongMediaStreams is exported").toBeTypeOf("function");
  return value as never;
}

/**
 * An exact time in seconds as a number, for range assertions.
 * @param time - The time.
 * @param time.numerator - Its numerator.
 * @param time.denominator - Its denominator.
 * @returns Seconds.
 */
function seconds(time: { numerator: string; denominator: string }): number {
  return Number(time.numerator) / Number(time.denominator);
}

const video3s = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=3"];
const sine3s = ["-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=3"];
let avWebm: string;
let opusWebm: string;
let aacMp4: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "long-media-measure-"));
  avWebm = make("av.webm", [...video3s, ...sine3s, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-shortest"]);
  opusWebm = make("opus.webm", [...sine3s, "-c:a", "libopus"]);
  aacMp4 = make("av.mp4", [...video3s, ...sine3s, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("measuring the streams of a long-media source that declare no duration", () => {
  it("measures the video from its packets and the audio from its decoded frames in a WebM", async () => {
    const stdout = probed(avWebm);
    const measured = await measure()(avWebm, stdout, AbortSignal.timeout(60_000), "own-file");

    expect(measured.map(({ index }) => index).sort()).toEqual([0, 1]);
    const video = measured.find(({ index }) => index === 0)!;
    const audio = measured.find(({ index }) => index === 1)!;
    expect(seconds(video.start)).toBe(0);
    expect(seconds(video.end)).toBe(3);
    // Decoding drops the Opus pre-skip, so the audio starts at 0 and ends near 3 s rather than at its packets' 3.014 s.
    expect(seconds(audio.start)).toBe(0);
    expect(seconds(audio.end)).toBeGreaterThan(2.99);
    expect(seconds(audio.end)).toBeLessThan(3.01);
    const report = buildLongMediaProbeReport(stdout, "e".repeat(64), "whole-file-v1", measured);
    expect(report.mediaInputs[0]!.sourceRange.startUs).toBe("0");
  });

  it("measures an audio-only WebM from its decoded frames", async () => {
    const measured = await measure()(opusWebm, probed(opusWebm), AbortSignal.timeout(60_000), "own-file");
    expect(measured).toHaveLength(1);
    expect(seconds(measured[0]!.end)).toBeGreaterThan(2.99);
  });

  it("measures nothing for an MP4 whose streams declare their durations", async () => {
    await expect(measure()(aacMp4, probed(aacMp4), AbortSignal.timeout(60_000), "own-file")).resolves.toEqual([]);
  });
});
