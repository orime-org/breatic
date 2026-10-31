// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a transcription asks the model (inner#856).
 *
 * The wording keeps the spoken language, a new line per speaker and Chinese
 * in one script. It names no answer language, because
 * that line makes the model translate.
 */

import { describe, expect, it } from "vitest";

import { isTranscription, transcribeQuestion } from "@worker/handlers/transcribe-question.js";

const HEAD =
  "Transcribe the speech in this audio. Write the words exactly as they are spoken, in the language they are spoken in; do not translate, summarise or describe. Output only the transcript. Start a new line whenever a different person starts speaking.";

describe("the question a transcription asks", () => {
  it("asks for the speech as spoken, in simplified characters, fillers kept", () => {
    expect(transcribeQuestion("audio", true, "zh-CN")).toBe(
      `${HEAD} Write any Chinese in Simplified Chinese characters. Keep filler words (such as um, uh, er, 嗯, 呃, 那个, 就是说), repetitions and false starts exactly as spoken.`,
    );
  });

  it("names the video and leaves the fillers out when asked to", () => {
    const asked = transcribeQuestion("video", false, "en");
    expect(asked).toContain("Transcribe the speech in this video.");
    expect(asked).toContain(
      "Leave out filler words (such as um, uh, er, 嗯, 呃, 那个, 就是说), stutters and repeated words, without changing any other word.",
    );
    expect(asked).not.toContain("Keep filler words");
  });

  it("writes Chinese in traditional characters for a zh-TW reader only", () => {
    expect(transcribeQuestion("audio", true, "zh-TW")).toContain(
      "Write any Chinese in Traditional Chinese characters.",
    );
    for (const locale of ["ja", "ko", "en", undefined, "xx"]) {
      expect(transcribeQuestion("audio", true, locale)).toContain(
        "Write any Chinese in Simplified Chinese characters.",
      );
    }
  });

  it("names no answer language", () => {
    expect(transcribeQuestion("audio", true, "ja")).not.toMatch(/Answer in/);
  });
});

describe("which reading a task is", () => {
  it("is a transcription only when its params say so", () => {
    expect(isTranscription({ reading: "transcribe" })).toBe(true);
    expect(isTranscription({})).toBe(false);
    expect(isTranscription({ reading: "anything" })).toBe(false);
  });
});
