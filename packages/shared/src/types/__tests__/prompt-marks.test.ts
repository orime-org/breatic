// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a prompt written the way the box shows it back into its segments
 * (inner#977): a template's prompt lives in the locale files as the sentence
 * the reader will see, marks and all.
 */
import { describe, expect, it } from "vitest";

import { markedSegments, promptTextOf } from "@shared/types/canvas-proposal";

describe("markedSegments", () => {
  it("reads each mark as the place it stands for", () => {
    expect(markedSegments("Use [📎 a photo] to show [✏️ the story].")).toEqual([
      { text: "Use " },
      { slot: { kind: "asset", label: "a photo", note: "a photo" } },
      { text: " to show " },
      { slot: { kind: "tweak", label: "the story", note: "the story" } },
      { text: "." },
    ]);
  });

  it("gives back the same sentence the box will show", () => {
    const sentence = "以 [📎 角色参考图] 为参考。故事：[✏️ 故事内容]。";
    expect(promptTextOf(markedSegments(sentence))).toBe(sentence);
  });

  it("leaves words without marks as words", () => {
    expect(markedSegments("just words")).toEqual([{ text: "just words" }]);
    expect(markedSegments("")).toEqual([]);
  });
});
