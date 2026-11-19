// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

  it("uses the first decoded audio frame when a WAV stream omits start_pts", () => {
    const report = buildLongMediaProbeReport(JSON.stringify({
      frames: [{ stream_index: 0, pts: 0, best_effort_timestamp: 0 }],
      streams: [{
        index: 0,
        codec_name: "pcm_s16le",
        codec_type: "audio",
        sample_rate: "16000",
        channels: 2,
        time_base: "1/16000",
        duration_ts: 5248000,
        disposition: { attached_pic: 0 },
      }],
      format: { format_name: "wav", duration: "328.000000" },
    }), "c".repeat(64), "whole-file-v1");

    expect(report.mediaInputs).toHaveLength(1);
    expect(report.mediaInputs[0]).toMatchObject({
      descriptor: { inputKind: "source_file", mediaKind: "audio" },
      sourceRange: { startUs: "0", endUs: "328000000" },
    });
  });

  // FFprobe on a VP9 + Opus WebM (FFmpeg 7.1): Matroska writes no stream duration, so neither stream carries duration_ts.
  const webm = JSON.stringify({
    frames: [{ stream_index: 1, pts: 0, best_effort_timestamp: 0 }],
    streams: [
      { index: 0, codec_name: "vp9", codec_type: "video", width: 852, height: 480, time_base: "1/1000", start_pts: 0, disposition: { attached_pic: 0 } },
      { index: 1, codec_name: "opus", codec_type: "audio", sample_rate: "48000", channels: 1, channel_layout: "mono", time_base: "1/1000", start_pts: -7, disposition: { attached_pic: 0 } },
    ],
    format: { duration: "3.008000" },
  });

  it("refuses a WebM whose streams declare no duration and come with no measured window", () => {
    expect(() => buildLongMediaProbeReport(webm, "d".repeat(64), "whole-file-v1")).toThrow("The long media stream time is not measured");
  });

  it("times a WebM's streams from the container's measured windows", () => {
    const report = buildLongMediaProbeReport(webm, "d".repeat(64), "whole-file-v1", [
      { index: 0, start: { numerator: "0", denominator: "1" }, end: { numerator: "3", denominator: "1" } },
      // 2994 ms plus a trimmed last frame of 312 samples at 48 kHz.
      { index: 1, start: { numerator: "0", denominator: "1" }, end: { numerator: "144024", denominator: "48000" } },
    ]);

    expect(report.mediaInputs[0]).toMatchObject({
      descriptor: { inputKind: "source_file", mediaKind: "video" },
      sourceRange: { startUs: "0", endUs: "3000500" },
    });
  });
});
