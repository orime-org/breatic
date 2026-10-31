// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { AUDIO_FORMAT_NAMES, audioFormatOf } from "@shared/understand/media-formats.js";

// inner#856: phone recordings (m4a), browser recordings (webm) and the audio
// tools' own m4a results are read; measured against the pinned model.
describe("the audio a reading sends", () => {
  it("sends m4a and webm under the names the endpoint takes", () => {
    expect(audioFormatOf("audio/mp4")).toBe("m4a");
    expect(audioFormatOf("audio/webm")).toBe("webm");
  });

  it("reads every spelling of a format as that format", () => {
    expect(audioFormatOf("audio/x-m4a")).toBe("m4a");
    expect(audioFormatOf("audio/m4a")).toBe("m4a");
    expect(audioFormatOf("audio/mp3")).toBe("mp3");
    expect(audioFormatOf("audio/x-wav")).toBe("wav");
  });

  it("still refuses the audio the endpoint does not take", () => {
    expect(audioFormatOf("audio/ogg")).toBeUndefined();
    expect(audioFormatOf("audio/flac")).toBeUndefined();
  });

  it("names the four formats it takes", () => {
    expect(AUDIO_FORMAT_NAMES).toBe("MP3 / WAV / M4A / WebM");
  });
});
