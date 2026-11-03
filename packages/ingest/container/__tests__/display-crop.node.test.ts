// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniToolPlanFrameCrop } from "@shared/upload/mini-tool-plan-types.js";
import { cropPlanDisplayFrame, executePlanRecipe, type PlanDisplayFrame, type PlanRecipeRequest } from "@ingest/container/plan-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";

vi.mock("@ingest/container/plan-command.js", () => ({ runPlanCommand: vi.fn() }));

// Original coordinate-color PNG fixtures for inner#1306. Expected crops use
// source[x+p,y+q], retaining odd dimensions and unpremultiplied RGBA values.
const cases = [
  { name: "Q4 odd origin and dimensions", source: "rgb-11x9", sourceWidth: 11, sourceHeight: 9, rect: { x: 3, y: 1, width: 5, height: 3 }, expected: "q4-odd-origin-5x3" },
  { name: "Q7 one pixel", source: "rgb-10x10", sourceWidth: 10, sourceHeight: 10, rect: { x: 2, y: 3, width: 1, height: 1 }, expected: "q7-subpixel-selection-1x1" },
  { name: "Q9 bottom right", source: "rgb-7x5", sourceWidth: 7, sourceHeight: 5, rect: { x: 4, y: 2, width: 3, height: 3 }, expected: "q9-right-bottom-3x3" },
  { name: "Q10 whole frame", source: "rgb-7x5", sourceWidth: 7, sourceHeight: 5, rect: { x: 0, y: 0, width: 7, height: 5 }, expected: "q10-whole-7x5" },
  { name: "RGBA transparent boundary", source: "rgba-7x5-border-alpha", sourceWidth: 7, sourceHeight: 5, rect: { x: 4, y: 2, width: 3, height: 3 }, expected: "rgba-right-bottom-alpha-3x3" },
];
let directory: string;
let request: PlanRecipeRequest;
let frame: PlanDisplayFrame;
let crop: MiniToolPlanFrameCrop;
let output: string;
let expectedPng: Buffer;

beforeEach(async () => {
  vi.resetAllMocks(); directory = await mkdtemp(join(tmpdir(), "saved-display-crop-unit-")); output = join(directory, "cropped.png");
  frame = { path: join(directory, "display.png"), width: 11, height: 9, anchor: { frameIndex: 1, pts: 0.25 } };
  crop = { sourceWidth: 11, sourceHeight: 9, rect: { x: 3, y: 1, width: 5, height: 3 } };
  await writeFile(frame.path, await readFile(new URL("./fixtures/people-crop/inputs/rgb-11x9.png", import.meta.url)));
  expectedPng = await readFile(new URL("./fixtures/people-crop/expected/q4-odd-origin-5x3.png", import.meta.url));
  request = {
    recipe: { kind: "inspect_video", inputId: "10000000-0000-4000-8000-000000000001" }, input: join(directory, "original.mov"), output,
    directory, facts: { source: { width: 11, height: 9, rotation: 0, hasAudio: false, timeBase: "1/4",
      frameTable: { frames: [{ frameIndex: 0, pts: 0 }, frame.anchor], videoEnd: 0.5 } }, raw: {} },
    signal: new AbortController().signal, limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  };
  vi.mocked(runPlanCommand).mockImplementation(async (_program, args) => { await writeFile(args.at(-1)!, expectedPng); return Buffer.alloc(0); });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("saved display pixel crop with process IO mocked", () => {
  it.each(cases)("retains $name on the same upright PNG", async (item) => {
    frame = { ...frame, width: item.sourceWidth, height: item.sourceHeight };
    const sourcePng = await readFile(new URL(`./fixtures/people-crop/inputs/${item.source}.png`, import.meta.url));
    await writeFile(frame.path, sourcePng);
    expectedPng = await readFile(new URL(`./fixtures/people-crop/expected/${item.expected}.png`, import.meta.url));
    const saved = { sourceWidth: item.sourceWidth, sourceHeight: item.sourceHeight, rect: item.rect };
    expect(await cropPlanDisplayFrame(request, frame, saved, output)).toEqual({ path: output, width: item.rect.width, height: item.rect.height });
    const [program, args, options] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(program).toBe("ffmpeg"); expect(args[args.indexOf("-i") + 1]).toBe(frame.path);
    expect(args[args.indexOf("-vf") + 1]).toBe(`crop=${item.rect.width}:${item.rect.height}:${item.rect.x}:${item.rect.y}:exact=1`);
    expect(args).not.toContain("yuv420p"); expect(args).not.toContain("-s");
    expect(options).toEqual({ signal: request.signal, stdoutBytes: request.limits.probeStdoutBytes, stderrTailBytes: request.limits.stderrTailBytes });
    expect(await readFile(frame.path)).toEqual(sourcePng); expect(frame.anchor).toEqual({ frameIndex: 1, pts: 0.25 });
  });

  it("checks the saved geometry even when the rectangle fits the wrong orientation", async () => {
    await expect(cropPlanDisplayFrame(request, frame, { ...crop, sourceWidth: 9, sourceHeight: 11 }, output))
      .rejects.toThrow("Display crop source geometry differs from its original frame");
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it.each([
    { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: -1, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 0 },
    { x: 11, y: 0, width: 1, height: 1 }, { x: 0, y: 9, width: 1, height: 1 },
    { x: 10, y: 0, width: 2, height: 1 }, { x: 0, y: 8, width: 1, height: 2 },
    { x: 1.25, y: 0, width: 1, height: 1 }, { x: 0, y: 1.25, width: 1, height: 1 },
    { x: 0, y: 0, width: 1.25, height: 1 }, { x: 0, y: 0, width: 1, height: 1.25 },
    { x: 0, y: 0, width: Infinity, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 },
  ])("refuses a rectangle before FFmpeg could clamp it: %j", async (rect) => {
    await expect(cropPlanDisplayFrame(request, frame, { ...crop, rect }, output)).rejects.toBeInstanceOf(RangeError);
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it("preserves cancellation before starting a crop process", async () => {
    const controller = new AbortController(); const error = new DOMException("original cancelled", "AbortError"); controller.abort(error);
    await expect(cropPlanDisplayFrame({ ...request, signal: controller.signal }, frame, crop, output)).rejects.toBe(error);
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it("preserves the original crop subprocess error", async () => {
    const error = new Error("PNG crop failed"); vi.mocked(runPlanCommand).mockRejectedValue(error);
    await expect(cropPlanDisplayFrame(request, frame, crop, output)).rejects.toBe(error);
  });

  it.each([Buffer.from("invalid PNG"), null])("refuses a missing or malformed produced PNG", async (bytes) => {
    vi.mocked(runPlanCommand).mockImplementation(async () => { if (bytes !== null) await writeFile(output, bytes); return Buffer.alloc(0); });
    await expect(cropPlanDisplayFrame(request, frame, crop, output)).rejects.toThrow();
  });

  it("requires actual output geometry to equal the original integer selection", async () => {
    vi.mocked(runPlanCommand).mockImplementation(async () => { await writeFile(output, await readFile(frame.path)); return Buffer.alloc(0); });
    await expect(cropPlanDisplayFrame(request, frame, crop, output)).rejects.toThrow("Cropped display PNG differs from its saved pixel rectangle");
  });

  it("wires an explicitly displayed frame recipe through its saved pixel crop", async () => {
    const sourcePng = await readFile(frame.path);
    vi.mocked(runPlanCommand).mockImplementation(async (_program, args) => {
      const filter = args[args.indexOf("-vf") + 1]!;
      await writeFile(args.at(-1)!, filter.startsWith("crop=") ? expectedPng : sourcePng); return Buffer.alloc(0);
    });
    expect(await executePlanRecipe({ ...request, recipe: { kind: "frame", inputId: "10000000-0000-4000-8000-000000000001", frameIndex: 1, orientation: "display", crop } }))
      .toEqual({ width: 5, height: 3, durationSeconds: null, cover: null });
  });
});
