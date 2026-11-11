// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The video join run through a real ffmpeg (inner#1825 §6.4): a clip whose
 * sound runs past its picture must not leave the picture and the sound of
 * the join out of step. Runs where an ffmpeg is on the machine (the
 * container image's 8.0.1 locally); skipped where none is, as in CI.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { lengthArgs, opSteps, readProgressLength } from "@ingest/jobs/op-args.js";
import { probeArgs, readProbeOutput } from "@ingest/probe-command.js";

/** Where the ffmpeg tools are, or null when the machine has none. */
const BIN = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].find((dir) => existsSync(join(dir, "ffmpeg")) && existsSync(join(dir, "ffprobe"))) ?? null;

const dir = mkdtempSync(join(tmpdir(), "join-real-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run one of the ffmpeg tools.
 * @param program - `ffmpeg` or `ffprobe`.
 * @param args - Its arguments.
 * @returns What it wrote.
 */
function run(program: string, args: readonly string[]): string {
  return execFileSync(join(BIN ?? "", program), args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

/**
 * Make a clip: a picture of one length and a tone of another.
 * @param name - The file name.
 * @param picture - The picture's seconds.
 * @param sound - The tone's seconds.
 * @returns The file's path.
 */
function clip(name: string, picture: number, sound: number): string {
  const path = join(dir, name);
  run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${String(picture)}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${String(sound)}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
  ]);
  return path;
}

/**
 * Each stream's length in a file.
 * @param path - The file.
 * @returns The picture's and the sound's seconds.
 */
function lengths(path: string): { video: number; audio: number } {
  const out = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path]);
  const streams = (JSON.parse(out) as { streams: { codec_type: string; duration: string }[] }).streams;
  const of = (type: string): number => Number(streams.find((stream) => stream.codec_type === type)?.duration);
  return { video: of("video"), audio: of("audio") };
}

describe.skipIf(BIN === null)("join through a real ffmpeg", () => {
  it("keeps the picture and the sound the same length when a clip's sound runs 0.15 s past its picture, with a 0.1 s crossfade", () => {
    const first = clip("long-sound.mp4", 1, 1.15);
    const second = clip("even.mp4", 1, 1);
    const probe = (path: string): ReturnType<typeof readProbeOutput> => readProbeOutput(run("ffprobe", probeArgs(path, "own-file")));
    const output = join(dir, "joined.mp4");
    const steps = opSteps("join", { crossfade: 0.1 }, first, output, dir, probe(first), [{ path: second, probe: probe(second) }]);
    for (const step of steps) if (step.kind === "run") run(step.program, step.args);
    const joined = lengths(output);
    // Within one frame at 25 fps.
    expect(Math.abs(joined.video - joined.audio), JSON.stringify(joined)).toBeLessThanOrEqual(0.04);
  });
});

describe.skipIf(BIN === null)("a clip whose container states no length, as a browser's recorder writes it", () => {
  it("is measured by reading it through, and then joins", () => {
    const live = join(dir, "recorded.webm");
    run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libvpx", "-c:a", "libopus", "-f", "webm", "-live", "1", live,
    ]);
    const probed = readProbeOutput(run("ffprobe", probeArgs(live, "own-file")));
    expect(probed.durationSeconds).toBeNull();
    const length = readProgressLength(run("ffmpeg", lengthArgs(live)));
    expect(length).toBeCloseTo(2, 1);
    const second = clip("after.mp4", 1, 1);
    const output = join(dir, "joined-recorded.mp4");
    const steps = opSteps("join", { crossfade: 0 }, live, output, dir, { ...probed, durationSeconds: length }, [
      { path: second, probe: readProbeOutput(run("ffprobe", probeArgs(second, "own-file"))) },
    ]);
    for (const step of steps) if (step.kind === "run") run(step.program, step.args);
    const joined = lengths(output);
    expect(joined.video).toBeCloseTo(3, 1);
  });
});

describe("readProgressLength", () => {
  it("reads the last time ffmpeg's progress reports, in seconds, and nothing from no report", () => {
    expect(readProgressLength("out_time_us=1000000\nprogress=continue\nout_time_us=2040000\nprogress=end\n")).toBe(2.04);
    expect(readProgressLength("progress=end\n")).toBeNull();
    expect(readProgressLength("out_time_us=N/A\nprogress=end\n")).toBeNull();
  });
});
