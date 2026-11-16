// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid cut in the media container (inner#1968, design 3.2.2): output i is
 * the i-th cell left after `skip`, row by row, cut at `gridTileRects` of the
 * picture's upright size; the first tile turns the picture upright with vips
 * once and every tile is cut from that copy.
 */

import { describe, expect, it } from "vitest";
import { gridTileRects } from "@shared/mini-tools/grid-tiles.js";

import { gridCellsOf, inputRefusal, mediumOf, opSteps, outputFileName, outputRefusal } from "@ingest/jobs/op-args.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const IN = "/tmp/job/source";
const OUT = "/tmp/job/out.png";
const WORK = "/tmp/job";

/**
 * A still picture's probe.
 * @param width - Its stored width.
 * @param height - Its stored height.
 * @param rotation - Degrees its EXIF orientation turns it, when any.
 * @returns The probe.
 */
function picture(width: number, height: number, rotation?: number): ProbeReport {
  return {
    streams: [{ index: 0, codecType: "video", codecName: "mjpeg", width, height, attachedPic: false, ...(rotation === undefined ? {} : { rotation }) }],
    durationSeconds: null,
  };
}

/**
 * The crop arguments of one tile's last step.
 * @param params - The run's params.
 * @param index - The output.
 * @param probe - The source's probe.
 * @returns x, y, width and height as numbers.
 */
function cropOf(params: Record<string, unknown>, index: number, probe: ProbeReport): number[] {
  const steps = opSteps("grid", params, IN, OUT, WORK, probe, [], index);
  const last = steps.at(-1)!;
  if (last.kind !== "run" || last.program !== "vips" || last.args[0] !== "crop") throw new Error("the last step is not a vips crop");
  return last.args.slice(3).map(Number);
}

describe("the grid's outputs", () => {
  it("writes PNG images and takes only a picture of a known size", () => {
    expect(mediumOf("grid")).toBe("image");
    expect(outputFileName("grid")).toBe("out.png");
    expect(inputRefusal("grid", picture(1000, 700))).toBeNull();
    expect(inputRefusal("grid", { streams: [{ index: 0, codecType: "audio", codecName: "aac", width: null, height: null, attachedPic: false }], durationSeconds: 3 })).toBe("tool_failed");
    expect(outputRefusal(picture(333, 233), "image")).toBeNull();
    expect(outputRefusal({ streams: [], durationSeconds: null }, "image")).toBe("tool_failed");
  });

  it("cuts cells row by row, leaving out the skipped ones", () => {
    expect(gridCellsOf({ rows: 2, cols: 3, skip: [1, 4] })).toEqual([0, 2, 3, 5]);
    expect(gridCellsOf({ rows: 2, cols: 2, skip: [] })).toEqual([0, 1, 2, 3]);
  });

  it("cuts each output at its cell's gridTileRects rectangle", () => {
    const params = { rows: 3, cols: 3, skip: [4] };
    const rects = gridTileRects(1000, 700, 3, 3);
    gridCellsOf(params).forEach((cell, index) => {
      const rect = rects[cell]!;
      expect(cropOf(params, index, picture(1000, 700))).toEqual([rect.x, rect.y, rect.width, rect.height]);
    });
  });

  it("measures a picture its EXIF orientation turns a quarter at its upright size", () => {
    const rects = gridTileRects(700, 1000, 2, 2);
    expect(cropOf({ rows: 2, cols: 2, skip: [] }, 3, picture(1000, 700, 90))).toEqual([rects[3]!.x, rects[3]!.y, rects[3]!.width, rects[3]!.height]);
  });

  it("turns the picture upright on the first tile only, and cuts every tile from that copy", () => {
    const params = { rows: 2, cols: 2, skip: [] };
    const first = opSteps("grid", params, IN, OUT, WORK, picture(800, 600), [], 0);
    expect(first.map((step) => (step.kind === "run" ? step.args[0] : step.kind))).toEqual(["autorot", "crop"]);
    expect(first[0]).toMatchObject({ program: "vips", args: ["autorot", IN, `${WORK}/upright.v`] });
    const later = opSteps("grid", params, IN, OUT, WORK, picture(800, 600), [], 2);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ program: "vips", args: ["crop", `${WORK}/upright.v`, `${OUT}[keep=icc]`, "0", "300", "400", "300"] });
  });

  it("refuses an output past the cells it cuts", () => {
    expect(() => opSteps("grid", { rows: 1, cols: 2, skip: [1] }, IN, OUT, WORK, picture(100, 100), [], 1)).toThrow();
  });
});
