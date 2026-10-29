// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { MediaInputDescriptorSchema } from "@breatic/shared";

describe("MediaInputDescriptorSchema", () => {
  it("accepts one descriptor for the complete audio or video source file", () => {
    expect(MediaInputDescriptorSchema.parse({ inputKind: "source_file", mediaKind: "audio" }))
      .toEqual({ inputKind: "source_file", mediaKind: "audio" });
    expect(MediaInputDescriptorSchema.parse({ inputKind: "source_file", mediaKind: "video" }))
      .toEqual({ inputKind: "source_file", mediaKind: "video" });
  });

  it("rejects per-channel or partial-stream input descriptors", () => {
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "audio_channel", audioStreamIndex: 2, audioChannelIndex: 0,
    }).success).toBe(false);
    expect(MediaInputDescriptorSchema.safeParse({
      inputKind: "source_file", mediaKind: "video", audioChannelIndex: 0,
    }).success).toBe(false);
  });
});
