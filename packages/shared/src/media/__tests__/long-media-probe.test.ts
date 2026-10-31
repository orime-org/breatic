// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { readLongMediaProbeReport, type LongMediaProbeReport } from "@shared/media/long-media-probe.js";

const report: LongMediaProbeReport = {
  version: 1,
  sourceFingerprint: "a".repeat(64),
  selectedVideoStreamIndex: 0,
  streams: [
    { index: 0, kind: "video", startUs: "0", endUs: "10000000" },
    { index: 1, kind: "audio", startUs: "100000", endUs: "9000000" },
    { index: 2, kind: "audio", startUs: "200000", endUs: "9500000" },
  ],
  mediaInputs: [{
    mediaInputId: "source-file-1",
    descriptor: { inputKind: "source_file", mediaKind: "video" },
    sourceRange: { startUs: "0", endUs: "10000000" },
  }],
};

describe("readLongMediaProbeReport", () => {
  it("accepts the complete source file as one input over one shared timeline", () => {
    expect(readLongMediaProbeReport(report)).toEqual(report);
  });

  it("rejects multiple understanding inputs derived from one source", () => {
    expect(() => readLongMediaProbeReport({
      ...report,
      mediaInputs: [report.mediaInputs[0], { ...report.mediaInputs[0], mediaInputId: "source-file-2" }],
    })).toThrow();
  });

  it("requires the selected video and input kind to match probe facts", () => {
    expect(() => readLongMediaProbeReport({ ...report, selectedVideoStreamIndex: 9 })).toThrow(/selected video/i);
    expect(() => readLongMediaProbeReport({
      ...report,
      mediaInputs: [{ ...report.mediaInputs[0], descriptor: { inputKind: "source_file", mediaKind: "audio" } }],
    })).toThrow(/file kind/i);
  });

  it("requires the file range to cover the complete timeline", () => {
    expect(() => readLongMediaProbeReport({
      ...report,
      mediaInputs: [{ ...report.mediaInputs[0], sourceRange: { startUs: "100000", endUs: "9500000" } }],
    })).toThrow(/complete file timeline/i);
  });
});
