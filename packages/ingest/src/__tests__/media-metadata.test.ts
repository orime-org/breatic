// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Picking the three numbers out of what the media container reports
 * (#209 + #210, design §4.2).
 *
 * The container runs one ffprobe over whatever it was handed and returns every
 * stream, knowing nothing about what kind of media it is. Which stream carries
 * the pixel dimensions is this side's judgement, and it is not simply "the
 * first video stream": an MP3 with album art reports one, 300x300, and writing
 * that onto an audio asset would put the cover's size where the media's should
 * be.
 */

import { describe, it, expect } from "vitest";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

/**
 * Build a probe report around the streams a case cares about.
 * @param streams - The streams the container reported.
 * @param durationSeconds - What ffprobe read off the container format.
 * @returns The report shape the container answers with.
 */
function report(
  streams: ProbeReport["streams"],
  durationSeconds: number | null = null,
): ProbeReport {
  return { streams, durationSeconds };
}

const VIDEO_STREAM = {
  index: 0,
  codecType: "video" as const,
  codecName: "h264",
  width: 1280,
  height: 720,
  attachedPic: false,
};

const AUDIO_STREAM = {
  index: 1,
  codecType: "audio" as const,
  codecName: "aac",
  width: null,
  height: null,
  attachedPic: false,
};

const ALBUM_ART_STREAM = {
  index: 1,
  codecType: "video" as const,
  codecName: "png",
  width: 300,
  height: 300,
  attachedPic: true,
};

describe("the stream the dimensions come from", () => {
  it("reads them off a video stream", () => {
    expect(pickMediaMetadata(report([VIDEO_STREAM, AUDIO_STREAM], 60))).toEqual({
      width: 1280,
      height: 720,
      durationSeconds: 60,
    });
  });

  it("reads them off a still image, which probes as a single video stream", () => {
    expect(
      pickMediaMetadata(
        report([{ ...VIDEO_STREAM, codecName: "png", width: 800, height: 600 }]),
      ),
    ).toEqual({ width: 800, height: 600, durationSeconds: null });
  });

  it("leaves them empty for audio, which has no video stream at all", () => {
    expect(pickMediaMetadata(report([AUDIO_STREAM], 2.5))).toEqual({
      width: null,
      height: null,
      durationSeconds: 2.5,
    });
  });

  it("ignores album art, so an MP3 does not inherit the cover's size", () => {
    expect(
      pickMediaMetadata(report([AUDIO_STREAM, ALBUM_ART_STREAM], 5.04)),
    ).toEqual({ width: null, height: null, durationSeconds: 5.04 });
  });

  it("takes the real stream when art is listed before it", () => {
    expect(
      pickMediaMetadata(report([ALBUM_ART_STREAM, VIDEO_STREAM], 60)),
    ).toEqual({ width: 1280, height: 720, durationSeconds: 60 });
  });

  it("takes the first of several video streams", () => {
    expect(
      pickMediaMetadata(
        report([
          VIDEO_STREAM,
          { ...VIDEO_STREAM, index: 2, width: 640, height: 360 },
        ]),
      ),
    ).toEqual({ width: 1280, height: 720, durationSeconds: null });
  });

  it("leaves them empty when the video stream reports no dimensions", () => {
    expect(
      pickMediaMetadata(report([{ ...VIDEO_STREAM, width: null, height: null }])),
    ).toEqual({ width: null, height: null, durationSeconds: null });
  });

  it("leaves them empty when only one dimension came back", () => {
    expect(
      pickMediaMetadata(report([{ ...VIDEO_STREAM, height: null }])),
    ).toEqual({ width: null, height: null, durationSeconds: null });
  });
});

describe("the duration", () => {
  it("comes off the container format, not off any stream", () => {
    expect(pickMediaMetadata(report([AUDIO_STREAM], 12.34)).durationSeconds).toBe(
      12.34,
    );
  });

  it("stays empty when the format carried none", () => {
    expect(pickMediaMetadata(report([VIDEO_STREAM])).durationSeconds).toBeNull();
  });

  it("stays empty at zero, which is a still frame rather than a duration", () => {
    expect(pickMediaMetadata(report([VIDEO_STREAM], 0)).durationSeconds).toBeNull();
  });

  it("stays empty when the format reported a negative duration", () => {
    expect(pickMediaMetadata(report([VIDEO_STREAM], -1)).durationSeconds).toBeNull();
  });
});

describe("a report with nothing in it", () => {
  it("answers three empty values rather than throwing", () => {
    expect(pickMediaMetadata(report([]))).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
    });
  });
});
