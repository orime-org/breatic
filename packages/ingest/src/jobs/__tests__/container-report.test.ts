// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect } from "vitest";

import { readContainerReport } from "@ingest/jobs/container-report.js";

describe("readContainerReport", () => {
  it("reads a finished run", () => {
    expect(readContainerReport({ ok: true, cpuUsec: 12, media: {} })).toEqual({
      ok: true,
      cpuUsec: 12,
      media: {},
    });
  });

  // §8.3: denoise on a silent video says why it failed.
  it("keeps the cause a failed run names", () => {
    expect(readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "no_audio_track" })?.reason).toBe(
      "no_audio_track",
    );
  });

  // A source the container could not read through is our failure, not the file's.
  it("keeps internal as the cause of a source that did not arrive", () => {
    expect(readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "internal" })?.reason).toBe("internal");
  });

  it("drops a cause it does not know, leaving the failure unnamed", () => {
    const read = readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "disk_full" });
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty("reason");
  });

  it("refuses a body without ok", () => {
    expect(readContainerReport({ cpuUsec: 1 })).toBeNull();
    expect(readContainerReport(null)).toBeNull();
  });

  // S6d D3-3 (inner#1306 §91): a packed carrier output's geometry travels with the report so the DO can write the manifest.
  const GEOMETRY = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
  const planReport = (output: Record<string, unknown>): Record<string, unknown> => ({ schemaVersion: 2, attemptId: "a-1", ok: true, cpuUsec: 5,
    outputs: [{ outputIndex: 0, storageKey: "video/s.mp4.stitch", width: 192, height: 64, durationSeconds: 2, cover: null, ...output }] });

  it("PK01 keeps a planned output's packed geometry", () => {
    expect(readContainerReport(planReport({ packing: GEOMETRY }))).toMatchObject({ outputs: [{ outputIndex: 0, packing: GEOMETRY }] });
    expect(readContainerReport(planReport({}))).toMatchObject({ outputs: [{ outputIndex: 0 }] });
    expect((readContainerReport(planReport({})) as unknown as { outputs: Record<string, unknown>[] }).outputs[0]).not.toHaveProperty("packing");
  });

  it.each([
    ["a width that is not a number", { ...GEOMETRY, packedWidth: "192" }],
    ["a rectangle without its height", { ...GEOMETRY, alphaRect: { x: 96, y: 0, width: 95 } }],
    ["a packing that is not an object", "alpha-packed"],
  ])("PK02 refuses a planned output whose packing has %s", (_name, packing) => {
    expect(readContainerReport(planReport({ packing: GEOMETRY }))).not.toBeNull();
    expect(readContainerReport(planReport({ packing }))).toBeNull();
  });

  // Frames-split design §7.17 grid_count: a count job reports the last decoded frame's time and the decoded frames.
  const COUNTED = { lastVideoTime: { numerator: 49, denominator: 25 }, sourceFrames: 50 };
  const countReport = (count: unknown): Record<string, unknown> => ({ schemaVersion: 2, attemptId: "a-1", ok: true, cpuUsec: 5, outputs: [], count });

  it("GC08 keeps a planned report's count", () => {
    expect(readContainerReport(countReport(COUNTED))).toEqual({ schemaVersion: 2, attemptId: "a-1", ok: true, cpuUsec: 5, outputs: [], count: COUNTED });
    expect(readContainerReport(planReport({}))).not.toHaveProperty("count");
  });

  it.each([
    ["a fractional frame count", { ...COUNTED, sourceFrames: 1.5 }],
    ["a time without its denominator", { ...COUNTED, lastVideoTime: { numerator: 49 } }],
    ["a count that is not an object", 50],
  ])("GC09 refuses a planned report whose count has %s", (_name, count) => {
    expect(readContainerReport(countReport(COUNTED))).not.toBeNull();
    expect(readContainerReport(countReport(count))).toBeNull();
  });
});
