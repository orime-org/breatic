// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { MediaInputDescriptorSchema } from "@breatic/shared";

describe("MediaInputDescriptorSchema", () => {
  it("requires verified stream and channel indexes for each audio channel", () => {
    expect(MediaInputDescriptorSchema.parse({
      inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 1,
    })).toEqual({ inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 1 });
    expect(MediaInputDescriptorSchema.safeParse({ inputKind: "audio_channel", audioStreamIndex: 2 }).success).toBe(false);
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 1, videoStreamIndex: 0,
    }).success).toBe(false);
  });

  it("ties video observations to one real video stream and one audio channel", () => {
    expect(MediaInputDescriptorSchema.parse({
      inputKind: "video_channel", videoStreamIndex: 1, audioStreamIndex: 3, audioChannelIndex: 0,
    })).toEqual({ inputKind: "video_channel", videoStreamIndex: 1, audioStreamIndex: 3, audioChannelIndex: 0 });
    expect(MediaInputDescriptorSchema.safeParse({ inputKind: "video_channel", videoStreamIndex: 1 }).success).toBe(false);
  });

  it("represents silent video without inventing audio facts", () => {
    expect(MediaInputDescriptorSchema.parse({ inputKind: "video_silent", videoStreamIndex: 0 })).toEqual({
      inputKind: "video_silent", videoStreamIndex: 0,
    });
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "video_silent", videoStreamIndex: 0, audioStreamIndex: 0, audioChannelIndex: 0,
    }).success).toBe(false);
  });

  it("rejects negative and fractional probe indexes", () => {
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "audio_channel", audioStreamIndex: -1, audioChannelIndex: 0,
    }).success).toBe(false);
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "video_silent", videoStreamIndex: 0.5,
    }).success).toBe(false);
  });
});
