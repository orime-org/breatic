// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import type { ProbeReport } from "@ingest/media-metadata.js";
import { peaksSampleCount } from "@ingest/peaks-step.js";

const AUDIO = { index: 0, codecType: "audio", codecName: "mp3", width: null, height: null, attachedPic: false };
const ART = { index: 1, codecType: "video", codecName: "mjpeg", width: 300, height: 300, attachedPic: true };
const PICTURE = { index: 0, codecType: "video", codecName: "h264", width: 1280, height: 720, attachedPic: false };

/**
 * A report of these streams and this length.
 * @param streams - The streams.
 * @param durationSeconds - The length.
 * @returns The report.
 */
function report(streams: ProbeReport["streams"], durationSeconds: number | null): ProbeReport {
  return { streams, durationSeconds };
}

describe("which objects get peaks", () => {
  it("reads every 8 kHz sample of an audio object it was asked about", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([AUDIO], 61.5) })).toBe(492_000);
  });

  it("counts an mp3 carrying album art as audio", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([AUDIO, ART], 10) })).toBe(80_000);
  });

  it("rounds a part-sample length up", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([AUDIO], 0.0001) })).toBe(1);
  });

  it("reads none when it was not asked", () => {
    expect(peaksSampleCount({ wantPeaks: false, report: report([AUDIO], 10) })).toBeNull();
  });

  it("reads none for a video, sound and all", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([PICTURE, AUDIO], 10) })).toBeNull();
  });

  it("reads none for an object with no sound", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([ART], 10) })).toBeNull();
  });

  it("reads none when the length is unknown or zero", () => {
    expect(peaksSampleCount({ wantPeaks: true, report: report([AUDIO], null) })).toBeNull();
    expect(peaksSampleCount({ wantPeaks: true, report: report([AUDIO], 0) })).toBeNull();
  });
});
