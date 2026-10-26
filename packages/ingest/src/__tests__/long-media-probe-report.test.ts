// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { buildLongMediaProbeReport } from "@ingest/long-media-probe-report.js";

describe("buildLongMediaProbeReport", () => {
  it("returns one source timeline for video with multichannel audio", () => {
    const report = buildLongMediaProbeReport(JSON.stringify({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          start_pts: "250",
          duration_ts: "2500",
          time_base: "1/25",
          disposition: { attached_pic: 0 },
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "aac",
          channels: 2,
          channel_layout: "stereo",
          sample_rate: "48000",
          start_pts: "0",
          duration_ts: "576000",
          time_base: "1/48000",
        },
      ],
    }), "a".repeat(64), "whole-file-v1");

    expect(report.mediaInputs).toHaveLength(1);
    expect(report.mediaInputs[0]).toMatchObject({
      descriptor: { inputKind: "source_file", mediaKind: "video" },
      sourceRange: { startUs: "0", endUs: "110000000" },
    });
  });

  it("returns one source timeline for a multichannel audio file", () => {
    const report = buildLongMediaProbeReport(JSON.stringify({
      streams: [{
        index: 0,
        codec_type: "audio",
        codec_name: "flac",
        channels: 6,
        channel_layout: "5.1",
        sample_rate: "48000",
        start_pts: "0",
        duration_ts: "960000",
        time_base: "1/48000",
      }],
    }), "b".repeat(64), "whole-file-v1");

    expect(report.mediaInputs).toHaveLength(1);
    expect(report.mediaInputs[0]).toMatchObject({
      descriptor: { inputKind: "source_file", mediaKind: "audio" },
      sourceRange: { startUs: "0", endUs: "20000000" },
    });
  });
});
