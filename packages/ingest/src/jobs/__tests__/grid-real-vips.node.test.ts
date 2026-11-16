// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid cut run through a real vips (inner#1968, design 3.2.2): every
 * tile holds exactly the source's pixels inside its `gridTileRects`
 * rectangle. Runs where vips and ffmpeg are on the machine (the media
 * container's image has both); skipped where they are not, as in CI.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { gridTileRects } from "@shared/mini-tools/grid-tiles.js";

import { gridCellsOf, opSteps } from "@ingest/jobs/op-args.js";
import { probeArgs, readProbeOutput } from "@ingest/probe-command.js";

/**
 * The directory holding a program, or null when the machine has none.
 * @param program - Its name.
 * @returns The directory.
 */
function binOf(program: string): string | null {
  return [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].find((dir) => existsSync(join(dir, program))) ?? null;
}

const VIPS = binOf("vips");
const FFMPEG = binOf("ffmpeg");
const ready = VIPS !== null && FFMPEG !== null && binOf("ffprobe") !== null;

const dir = mkdtempSync(join(tmpdir(), "grid-real-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run one program and read what it wrote.
 * @param program - Its name.
 * @param args - Its arguments.
 * @returns Its stdout, as text.
 */
function run(program: string, args: readonly string[]): string {
  return execFileSync(join(binOf(program) ?? "", program), args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

/**
 * A picture's pixels as raw RGB, optionally only a rectangle of it.
 * @param file - The picture.
 * @param crop - The rectangle, when only part is wanted.
 * @returns The bytes.
 */
function pixels(file: string, crop?: { x: number; y: number; width: number; height: number }): Uint8Array {
  const filter = crop === undefined ? [] : ["-vf", `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`];
  const args = ["-v", "error", "-i", file, ...filter, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  return new Uint8Array(execFileSync(join(FFMPEG ?? "", "ffmpeg"), args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
}

describe.skipIf(!ready)("a grid cut by a real vips", () => {
  it("cuts each picked cell to exactly the source's pixels in its rectangle", () => {
    const source = join(dir, "source.png");
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1000x700:rate=1", "-frames:v", "1", source]);
    const probe = readProbeOutput(run("ffprobe", probeArgs(source, "own-file")));
    const params = { rows: 3, cols: 3, skip: [4] };
    const rects = gridTileRects(1000, 700, 3, 3);
    gridCellsOf(params).forEach((cell, index) => {
      const tile = join(dir, `tile-${String(index)}.png`);
      for (const step of opSteps("grid", params, source, tile, dir, probe, [], index)) {
        if (step.kind !== "run") throw new Error("a grid step is a single run");
        run(step.program, step.args);
      }
      expect(pixels(tile)).toEqual(pixels(source, rects[cell]));
    });
  });
});
