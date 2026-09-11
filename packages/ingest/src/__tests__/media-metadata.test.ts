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
import { mediaNumbersFor, pickMediaMetadata } from "@ingest/media-metadata.js";
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

// A portrait video shot on a phone is stored landscape with a display matrix
// saying to turn it. ffprobe's `stream=width,height` reports the stored pair;
// ffmpeg autorotates on decode, so the cover cut in the same run comes out the
// other way round. Measured on ffmpeg 7.1.1 with the production argument list:
// a 1920x1080 stream with rotation 90 yields a 1080x1920 PNG.
describe("a stream the display matrix says to turn", () => {
  it.each([
    ["a quarter turn", 90],
    ["a quarter turn the other way", -90],
    ["three quarters", 270],
  ])("files %s the way it will be shown", (_case, rotation) => {
    const picked = pickMediaMetadata(
      report([{ ...VIDEO_STREAM, rotation }], 2),
    );

    expect(picked).toMatchObject({ width: 720, height: 1280 });
  });

  // An angle off a right angle cannot be judged from what ffprobe reports.
  // Measured on ffmpeg 7.1.1, `-display_rotation` against the production
  // argument lists: 89.6 reports 89 and the cover comes out 1080x1920, while
  // 89.0 also reports 89 and the cover comes out 1920x1080; 90.4 reports 90
  // and is turned, 90.6 also reports 90 and is not. The reported number is
  // therefore ambiguous in both directions, and every recorder writes an exact
  // right angle.
  it.each([
    ["no rotation at all", undefined],
    ["zero", 0],
    ["a half turn, which keeps the pair", 180],
    ["an angle no recorder writes", 45],
    ["a hair off a right angle, which reads as no turn", 89],
  ])("leaves the pair alone for %s", (_case, rotation) => {
    const picked = pickMediaMetadata(
      report([{ ...VIDEO_STREAM, ...(rotation !== undefined && { rotation }) }], 2),
    );

    expect(picked).toMatchObject({ width: 1280, height: 720 });
  });
});

// ffprobe answers a still photograph with the duration of one frame at the
// demuxer's default rate, and which demuxer it picks varies with the file:
// measured on ffmpeg 7.1.1, one JPEG read as `image2` with duration 0.04 and
// another as `jpeg_pipe` with none. The ticket's content type says what the
// bytes are, and it is the same authority that decides whether to cut a cover.
describe("how long the media runs", () => {
  it("answers no duration for an image, whatever ffprobe read", () => {
    const picked = mediaNumbersFor("image/jpeg", report([VIDEO_STREAM], 0.04));

    expect(picked).toMatchObject({
      width: 1280,
      height: 720,
      durationSeconds: null,
    });
  });

  it.each([
    ["a video", "video/mp4"],
    ["audio", "audio/mpeg"],
  ])("keeps what ffprobe read for %s", (_case, contentType) => {
    const picked = mediaNumbersFor(contentType, report([VIDEO_STREAM], 12.25));

    expect(picked.durationSeconds).toBe(12.25);
  });
});
