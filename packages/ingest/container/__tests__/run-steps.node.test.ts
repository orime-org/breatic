// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the container runs an operation's steps (inner#1305 §7.1). `sh`, `tr`
 * and `cat` stand in for ffmpeg and sox: what is under test is how one
 * command's output reaches the next, not the programs. The last part runs a
 * cut's own steps through the real ffmpeg.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opSteps, type RunStep } from "@ingest/jobs/op-args.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import { runSteps } from "../run-steps.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "run-steps-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A step running a stand-in program.
 * @param program - The stand-in.
 * @param args - Its arguments.
 * @returns The run step.
 */
function run(program: string, args: string[]): RunStep {
  return { kind: "run", program, args } as unknown as RunStep;
}

describe("runSteps", () => {
  it("runs single steps in order", async () => {
    const file = join(dir, "out.txt");
    await runSteps([run("sh", ["-c", `printf a > ${file}`]), run("sh", ["-c", `printf b >> ${file}`])]);
    expect(await readFile(file, "utf8")).toBe("ab");
  });

  it("feeds each command of a pipe the one before it, with nothing written between them", async () => {
    const file = join(dir, "out.txt");
    const pipe = {
      kind: "pipe",
      commands: [
        { program: "sh", args: ["-c", "printf abc"] },
        { program: "tr", args: ["a-z", "A-Z"] },
        { program: "sh", args: ["-c", `cat > ${file}`] },
      ],
    } as unknown as RunStep;
    await runSteps([pipe]);
    expect(await readFile(file, "utf8")).toBe("ABC");
  });

  it("fails the pipe when any command in it fails", async () => {
    const pipe = {
      kind: "pipe",
      commands: [
        { program: "sh", args: ["-c", "printf abc"] },
        { program: "sh", args: ["-c", "cat >/dev/null; exit 3"] },
        { program: "sh", args: ["-c", "cat >/dev/null"] },
      ],
    } as unknown as RunStep;
    await expect(runSteps([pipe])).rejects.toThrow();
  });

  // The writer fills the pipe buffer long before the reader is gone, so it
  // only ends when the reader's exit closes the pipe under it.
  it.each([
    ["the middle", [{ program: "sh", args: ["-c", "exit 3"] }, { program: "cat", args: [] }]],
    ["the last", [{ program: "cat", args: [] }, { program: "sh", args: ["-c", "exit 3"] }]],
  ])("fails the pipe at once when %s command exits while the first is still writing", async (_where, rest) => {
    const pipe = {
      kind: "pipe",
      commands: [{ program: "head", args: ["-c", "200000000", "/dev/zero"] }, ...rest],
    } as unknown as RunStep;
    // The writer's own failure is only the echo; the reason is the reader's.
    await expect(runSteps([pipe])).rejects.toThrow(/sh in a pipe exited 3/);
  }, 5_000);

  it("hands a measure step's stderr to the steps it decides on", async () => {
    const file = join(dir, "out.txt");
    const measure = {
      kind: "measure",
      program: "sh",
      args: ["-c", "printf 'noise\\n{\"x\": 7}' >&2"],
      then: (stderr: string): RunStep[] => [run("sh", ["-c", `printf '${stderr.split("\n")[1]}' > ${file}`])],
    } as unknown as RunStep;
    await runSteps([measure]);
    expect(await readFile(file, "utf8")).toBe('{"x": 7}');
  });

  it("fails on a single step that fails", async () => {
    await expect(runSteps([run("sh", ["-c", "exit 1"])])).rejects.toThrow();
  });
});

// The mov demuxer of an MP4 with B-frames and no edit list searches a seek time on the decode clock, which runs two frames
// behind the presentation clock here, so a cut starting just before a keyframe would land on that keyframe. Every frame n
// of the fixture has luma 20 + 4n and is presented at 0.08 + n / 25 s, keyframes every 10 frames; the file starts at 0.
describe("a cut of a B-frame MP4 without an edit list", () => {
  const PROBE: ProbeReport = {
    streams: [
      { index: 0, codecType: "video", codecName: "h264", width: 64, height: 64, attachedPic: false },
      { index: 1, codecType: "audio", codecName: "aac", width: null, height: null, attachedPic: false },
    ],
    durationSeconds: 2,
  };

  it("holds the ten frames presented from its start on, from every start", async () => {
    const source = join(dir, "source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=2,format=yuv420p,geq=lum='20+4*N':cb=128:cr=128", "-f", "lavfi", "-i", "sine=f=440:d=2",
      "-c:v", "libx264", "-qp", "1", "-bf", "2", "-x264-params", "b-adapt=0:colorprim=bt709:transfer=bt709:colormatrix=bt709", "-g", "10",
      "-pix_fmt", "yuv420p", "-video_track_timescale", "25", "-c:a", "aac", "-use_editlist", "0", source]);
    const wrong: string[] = [];
    for (let n = 1; n <= 14; n += 1) {
      const output = join(dir, `cut-${n}.mp4`);
      const start = 0.08 + n / 25;
      await runSteps(opSteps("cut", { range: { start, end: start + 0.4 } }, source, output, dir, PROBE));
      const planes = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=16:16:24:24", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        { maxBuffer: 1 << 24 });
      const frames = Array.from({ length: planes.length / 384 }, (_unused, frame) =>
        Math.round((planes.subarray(frame * 384, frame * 384 + 256).reduce((sum, value) => sum + value, 0) / 256 - 20) / 4));
      const expected = Array.from({ length: 10 }, (_unused, k) => n + k);
      if (JSON.stringify(frames) !== JSON.stringify(expected)) wrong.push(`from ${n}: ${frames.join(",")}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
