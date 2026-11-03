// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { parseVideoFrameProbe } from "../video-frame-probe.js";

interface ProbeFixture {
  streams: Record<string, unknown>[];
  frames: Record<string, unknown>[];
  format: Record<string, unknown>;
}

// Complete decoded raw frame transcripts and endpoints follow inner#1306.
// Metadata duration is retained where the real report disagrees. Presentation
// windows and edit lists are resolved above this raw ffprobe JSON adapter.
const cfrPts = [
  "0.000000", "0.125000", "0.250000", "0.375000", "0.500000", "0.625000",
  "0.750000", "0.875000", "1.000000", "1.125000", "1.250000", "1.375000",
  "1.500000", "1.625000", "1.750000", "1.875000", "2.000000",
] as const;
const cfrFrames = [
  { frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.125 },
  { frameIndex: 2, pts: 0.25 }, { frameIndex: 3, pts: 0.375 },
  { frameIndex: 4, pts: 0.5 }, { frameIndex: 5, pts: 0.625 },
  { frameIndex: 6, pts: 0.75 }, { frameIndex: 7, pts: 0.875 },
  { frameIndex: 8, pts: 1 }, { frameIndex: 9, pts: 1.125 },
  { frameIndex: 10, pts: 1.25 }, { frameIndex: 11, pts: 1.375 },
  { frameIndex: 12, pts: 1.5 }, { frameIndex: 13, pts: 1.625 },
  { frameIndex: 14, pts: 1.75 }, { frameIndex: 15, pts: 1.875 },
  { frameIndex: 16, pts: 2 },
];
const vfrPts = ["0.000000", "0.062500", "0.187500", "0.437500", "0.750000", "1.812500", "3.437500", "4.937500"] as const;
const vfrFrames = [
  { frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.0625 },
  { frameIndex: 2, pts: 0.1875 }, { frameIndex: 3, pts: 0.4375 },
  { frameIndex: 4, pts: 0.75 }, { frameIndex: 5, pts: 1.8125 },
  { frameIndex: 6, pts: 3.4375 }, { frameIndex: 7, pts: 4.9375 },
];
const positivePts = [
  "0.250000", "0.375000", "0.500000", "0.625000", "0.750000", "0.875000",
  "1.000000", "1.125000", "1.250000", "1.375000", "1.500000", "1.625000",
  "1.750000", "1.875000", "2.000000", "2.125000", "2.250000",
] as const;
const positiveFrames = [
  { frameIndex: 0, pts: 0.25 }, { frameIndex: 1, pts: 0.375 },
  { frameIndex: 2, pts: 0.5 }, { frameIndex: 3, pts: 0.625 },
  { frameIndex: 4, pts: 0.75 }, { frameIndex: 5, pts: 0.875 },
  { frameIndex: 6, pts: 1 }, { frameIndex: 7, pts: 1.125 },
  { frameIndex: 8, pts: 1.25 }, { frameIndex: 9, pts: 1.375 },
  { frameIndex: 10, pts: 1.5 }, { frameIndex: 11, pts: 1.625 },
  { frameIndex: 12, pts: 1.75 }, { frameIndex: 13, pts: 1.875 },
  { frameIndex: 14, pts: 2 }, { frameIndex: 15, pts: 2.125 },
  { frameIndex: 16, pts: 2.25 },
];

/**
 * Constructs a fresh JSON transcript of the complete video-frame probe.
 * @returns Independent ffprobe fields with every decoded raw frame present.
 * @throws {never} Never.
 */
function makeProbe(pts: readonly string[] = cfrPts, duration = "0.125000"): ProbeFixture {
  return {
    streams: [{ codec_type: "video", width: 256, height: 128, time_base: "1/16384", start_time: "0.000000", duration: "2.125000", nb_frames: String(pts.length) }],
    frames: pts.map((timestamp) => ({ best_effort_timestamp_time: timestamp, duration_time: duration })),
    format: { duration: "2.125000" },
  };
}

describe("complete ffprobe decoded raw frame adapter", () => {
  it("reads every CFR decoded frame and its raw ending timestamp", () => {
    expect(parseVideoFrameProbe(makeProbe())).toEqual({
      frameTable: { frames: cfrFrames, videoEnd: 2.125 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: false,
    });
  });

  it("keeps all VFR decoded frames beyond the reported video stream duration", () => {
    const report = makeProbe(vfrPts, "0.062500");
    report.streams[0]!.duration = "3.500000";
    report.streams.push({ codec_type: "audio", time_base: "1/48000", duration: "5.000000", nb_frames: "236" });
    report.format.duration = "5.000000";
    expect(parseVideoFrameProbe(report)).toEqual({
      frameTable: { frames: vfrFrames, videoEnd: 5 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: true,
    });
  });

  it("ends at the last decoded raw video frame when the audio track is longer", () => {
    const report = makeProbe();
    report.streams.push({ codec_type: "audio", time_base: "1/48000", duration: "4.000000", nb_frames: "189" });
    report.format.duration = "4.000000";
    expect(parseVideoFrameProbe(report)).toEqual({
      frameTable: { frames: cfrFrames, videoEnd: 2.125 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: true,
    });
  });

  it("preserves positive raw PTS and derives its endpoint without applying a presentation window", () => {
    const report = makeProbe(positivePts);
    report.streams[0]!.start_time = "0.250000";
    expect(parseVideoFrameProbe(report)).toEqual({
      frameTable: { frames: positiveFrames, videoEnd: 2.375 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: false,
    });
  });

  it("keeps negative and repeated presentation timestamps without dropping frames", () => {
    expect(parseVideoFrameProbe(makeProbe(["-0.125000", "0.000000", "0.000000", "0.125000"]))).toEqual({
      frameTable: { frames: [{ frameIndex: 0, pts: -0.125 }, { frameIndex: 1, pts: 0 }, { frameIndex: 2, pts: 0 }, { frameIndex: 3, pts: 0.125 }], videoEnd: 0.25 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: false,
    });
  });

  it("uses best-effort presentation time before a different pts_time", () => {
    const report = makeProbe(["0.750000"]);
    report.frames[0]!.pts_time = "0.500000";
    expect(parseVideoFrameProbe(report).frameTable).toEqual({ frames: [{ frameIndex: 0, pts: 0.75 }], videoEnd: 0.875 });
  });

  it("accepts pts_time when best-effort timestamps were not emitted", () => {
    const report = makeProbe(["0.125000"]);
    delete report.frames[0]!.best_effort_timestamp_time;
    report.frames[0]!.pts_time = "0.125000";
    expect(parseVideoFrameProbe(report).frameTable).toEqual({ frames: [{ frameIndex: 0, pts: 0.125 }], videoEnd: 0.25 });
  });

  it("accepts the last packet duration when duration_time was not emitted", () => {
    const report = makeProbe(["0.125000"]);
    delete report.frames[0]!.duration_time;
    report.frames[0]!.pkt_duration_time = "0.125000";
    expect(parseVideoFrameProbe(report).frameTable).toEqual({ frames: [{ frameIndex: 0, pts: 0.125 }], videoEnd: 0.25 });
  });

  it("reads main video geometry independently of audio and secondary video tracks", () => {
    const report = makeProbe();
    report.streams.unshift({ codec_type: "audio", time_base: "1/48000", duration: "4.000000" });
    report.streams.push({ codec_type: "video", width: 640, height: 480, time_base: "1/90000", side_data_list: [{ rotation: 90 }] });
    expect(parseVideoFrameProbe(report)).toEqual({
      frameTable: { frames: cfrFrames, videoEnd: 2.125 },
      timeBase: "1/16384", width: 256, height: 128, rotation: 0, hasAudio: true,
    });
  });

  it("records display-matrix rotation without changing the encoded pixel dimensions", () => {
    const report = makeProbe();
    report.streams[0]!.side_data_list = [{ side_data_type: "Display Matrix", rotation: -90 }];
    expect(parseVideoFrameProbe(report)).toEqual({
      frameTable: { frames: cfrFrames, videoEnd: 2.125 },
      timeBase: "1/16384", width: 256, height: 128, rotation: -90, hasAudio: false,
    });
  });

  it("does not require non-final packet durations to preserve the VFR decoded timestamps", () => {
    const report = makeProbe(vfrPts, "0.062500");
    for (const frame of report.frames.slice(0, -1)) delete frame.duration_time;
    expect(parseVideoFrameProbe(report).frameTable).toEqual({ frames: vfrFrames, videoEnd: 5 });
  });

  it("leaves the original ffprobe report intact", () => {
    const report = makeProbe();
    const before = structuredClone(report);
    parseVideoFrameProbe(report);
    expect(report).toEqual(before);
  });

  it.each([null, undefined, [], {}, ""])("rejects a missing report structure %j", (report) => {
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it("rejects a report without a video stream", () => {
    const report = makeProbe();
    report.streams = [{ codec_type: "audio", time_base: "1/48000", duration: "4.000000" }];
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it("rejects a video without decoded frames", () => {
    const report = makeProbe();
    report.frames = [];
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it("rejects descending decoded timestamps instead of sorting away the error", () => {
    expect(() => parseVideoFrameProbe(makeProbe(["0.000000", "0.250000", "0.125000"]))).toThrow();
  });

  it.each([undefined, null, "", " ", "N/A", "NaN", "Infinity", "-Infinity", "1e309", "0.125junk", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects an unusable decoded timestamp %j", (timestamp) => {
    const report = makeProbe();
    report.frames[8]!.best_effort_timestamp_time = timestamp;
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it.each([undefined, null, "", " ", "N/A", "NaN", "Infinity", "-Infinity", "0", "-0.125", "0.125junk", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects an unusable last decoded duration %j", (duration) => {
    const report = makeProbe();
    report.frames[16]!.duration_time = duration;
    report.streams[0]!.avg_frame_rate = "8/1";
    report.streams[0]!.r_frame_rate = "8/1";
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it.each([undefined, null, "", " ", "N/A", "0/0", "0/1", "1/0", "-1/16384", "1/-2", "1.5/2", "1/16384junk"])("rejects an invalid video time base %j", (timeBase) => {
    const report = makeProbe();
    report.streams[0]!.time_base = timeBase;
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });

  it.each([undefined, null, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects invalid main video dimensions %j", (dimension) => {
    const widthReport = makeProbe();
    widthReport.streams[0]!.width = dimension;
    expect(() => parseVideoFrameProbe(widthReport)).toThrow();
    const heightReport = makeProbe();
    heightReport.streams[0]!.height = dimension;
    expect(() => parseVideoFrameProbe(heightReport)).toThrow();
  });

  it("rejects a non-finite final endpoint derived from finite timestamp and duration", () => {
    const report = makeProbe([String(Number.MAX_VALUE)], String(Number.MAX_VALUE));
    expect(() => parseVideoFrameProbe(report)).toThrow();
  });
});
