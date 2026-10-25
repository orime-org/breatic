// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  readLongMediaProbeReport,
  type LongMediaProbeReport,
} from "@shared/media/long-media-probe.js";

const stereoReport: LongMediaProbeReport = {
  version: 1,
  sourceFingerprint: "sha256:0123456789abcdef",
  selectedVideoStreamIndex: null,
  streams: [
    {
      index: 2,
      kind: "audio",
      codec: "pcm_s16le",
      channels: 2,
      channelLayout: "stereo",
      channelMembers: [
        { channelIndex: 0, member: "FL" },
        { channelIndex: 1, member: "FR" },
      ],
      sampleRate: 48000,
      startUs: "100000",
      endUs: "5100000",
      timeBase: { numerator: "1", denominator: "48000" },
    },
  ],
  mediaInputs: [
    {
      mediaInputId: "source-audio-2-channel-0",
      descriptor: { inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 0 },
      sourceRange: { startUs: "100000", endUs: "5100000" },
    },
    {
      mediaInputId: "source-audio-2-channel-1",
      descriptor: { inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 1 },
      sourceRange: { startUs: "100000", endUs: "5100000" },
    },
  ],
};

describe("readLongMediaProbeReport", () => {
  it("accepts verified per-channel inputs whose stream ranges use integer microseconds", () => {
    expect(readLongMediaProbeReport(stereoReport)).toEqual(stereoReport);
  });

  it("rejects a channel descriptor that points beyond the probed channel count", () => {
    const invalid = structuredClone(stereoReport);
    invalid.mediaInputs[1]!.descriptor = {
      inputKind: "audio_channel",
      audioStreamIndex: 2,
      audioChannelIndex: 2,
    };

    expect(() => readLongMediaProbeReport(invalid)).toThrow(/channel/i);
  });

  it("rejects missing channel mappings instead of treating an unknown layout as mono", () => {
    const invalid = structuredClone(stereoReport);
    const audio = invalid.streams[0];
    if (audio?.kind !== "audio") throw new Error("Expected audio stream fixture");
    audio.channelMembers = [{ channelIndex: 0, member: "unknown" }];

    expect(() => readLongMediaProbeReport(invalid)).toThrow(/mapping/i);
  });

  it("allows unknown layout member names when channel indexes are fully measured", () => {
    const measuredUnknownLayout = structuredClone(stereoReport);
    const audio = measuredUnknownLayout.streams[0];
    if (audio?.kind !== "audio") throw new Error("Expected audio stream fixture");
    audio.channelLayout = "unknown";
    audio.channelMembers = [
      { channelIndex: 0, member: "unknown" },
      { channelIndex: 1, member: "unknown" },
    ];

    expect(readLongMediaProbeReport(measuredUnknownLayout)).toEqual(measuredUnknownLayout);
  });

  it("requires exactly one understanding input for each probed audio channel", () => {
    const missingChannel = structuredClone(stereoReport);
    missingChannel.mediaInputs.pop();

    expect(() => readLongMediaProbeReport(missingChannel)).toThrow(/missing required input/i);

    const duplicateChannel = structuredClone(stereoReport);
    duplicateChannel.mediaInputs[1]!.descriptor = {
      inputKind: "audio_channel",
      audioStreamIndex: 2,
      audioChannelIndex: 0,
    };

    expect(() => readLongMediaProbeReport(duplicateChannel)).toThrow(/duplicate audio channel/i);
  });

  it("keeps the selected video in each channel input and represents silent video explicitly", () => {
    const videoSource: LongMediaProbeReport = {
      version: 1,
      sourceFingerprint: "sha256:video-source",
      selectedVideoStreamIndex: 0,
      streams: [{
        index: 0,
        kind: "video",
        codec: "h264",
        width: 1920,
        height: 1080,
        startUs: "0",
        endUs: "10000000",
        timeBase: { numerator: "1", denominator: "90000" },
      }],
      mediaInputs: [{
        mediaInputId: "video-0",
        descriptor: { inputKind: "video_silent", videoStreamIndex: 0 },
        sourceRange: { startUs: "0", endUs: "10000000" },
      }],
    };

    expect(readLongMediaProbeReport(videoSource)).toEqual(videoSource);

    const ignoredVideo = structuredClone(stereoReport);
    ignoredVideo.streams.push({
      index: 0,
      kind: "video",
      codec: "h264",
      width: 1920,
      height: 1080,
      startUs: "0",
      endUs: "5100000",
      timeBase: { numerator: "1", denominator: "90000" },
    });

    expect(() => readLongMediaProbeReport(ignoredVideo)).toThrow(/selected video/i);
  });

  it("rejects non-positive source ranges and imprecise numeric timestamps", () => {
    const invalid = structuredClone(stereoReport);
    invalid.mediaInputs[0]!.sourceRange = { startUs: "100", endUs: "100" };

    expect(() => readLongMediaProbeReport(invalid)).toThrow(/range/i);
    expect(() => readLongMediaProbeReport({ ...stereoReport, streams: [{
      ...stereoReport.streams[0], startUs: 1,
    }] })).toThrow();
  });
});
