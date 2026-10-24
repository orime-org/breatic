// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { ChatAttachedChip } from "@breatic/shared";
import type { UserContent } from "ai";

import { READER_LANGUAGE_REMINDER, userMessageForModel, userTurnForModel } from "@server/agent/user-turn.js";
import type { UserTurn } from "@server/agent/user-turn.js";

const CHIP: ChatAttachedChip = {
  id: "a1", type: "image", name: "cover.bin", data_snapshot: { url: "https://source.example/cover.bin" },
};
const PICTURE = {
  label: "Attachment 1: cover.bin",
  sourceUrl: "https://source.example/cover.bin",
  url: "https://media.example/canonical.agent-v1-1024-q85.jpg",
  mediaType: "image/jpeg" as const,
  sizeBytes: 321,
};

/** Prepared descriptors arrive from the single per-turn preparation callback. */
function turn(pictures = [PICTURE]): UserTurn & { pictures: typeof pictures } {
  return { chips: [CHIP], message: "What is shown?", pictures };
}

/** Text blocks in content order, leaving pictures in their own file parts. */
function textParts(content: UserContent): string[] {
  return typeof content === "string" ? [content] : content.flatMap((part) => part.type === "text" ? [part.text] : []);
}

describe("the main model receives prepared attachment JPEG files", () => {
  it("sends the prepared URL with complete image/jpeg MIME and keeps the original address in text", () => {
    const content = userTurnForModel(turn());

    expect(typeof content).toBe("object");
    expect(content).toContainEqual({ type: "file", data: PICTURE.url, mediaType: "image/jpeg" });
    expect(textParts(content).join("\n")).toContain(PICTURE.sourceUrl);
    expect(textParts(content).join("\n")).toContain("Attachment 1");
  });

  it("keeps the reader clock first and the language reminder at the end of the last text block", () => {
    const content = userMessageForModel("reader clock", turn());
    const texts = textParts(content);

    expect(texts[0]!.startsWith("reader clock\n\n")).toBe(true);
    expect(texts.at(-1)!.endsWith(READER_LANGUAGE_REMINDER)).toBe(true);
    expect(Array.isArray(content) ? content.at(-1) : undefined).toMatchObject({ type: "text" });
    expect(content).toContainEqual({ type: "file", data: PICTURE.url, mediaType: "image/jpeg" });
  });

  it("keeps prepared picture ordering stable before the final reminder", () => {
    const second = { ...PICTURE, label: "Attachment 2", sourceUrl: "https://source.example/second.png", url: "https://media.example/second.agent-v1-1024-q85.jpg" };
    const content = userMessageForModel("reader clock", turn([PICTURE, second]));
    const files = Array.isArray(content) ? content.filter((part) => part.type === "file") : [];

    expect(files).toEqual([
      { type: "file", data: PICTURE.url, mediaType: "image/jpeg" },
      { type: "file", data: second.url, mediaType: "image/jpeg" },
    ]);
    expect(textParts(content).at(-1)!.endsWith(READER_LANGUAGE_REMINDER)).toBe(true);
  });

  it("retains the exact old text representation when preparation produces no pictures", () => {
    const oldTurn = { chips: [CHIP], message: "What is shown?" };

    expect(userTurnForModel(turn([]))).toBe(userTurnForModel(oldTurn));
    expect(userMessageForModel("reader clock", turn([]))).toBe(userMessageForModel("reader clock", oldTurn));
  });

  it("keeps unavailable attachment labels, original sources and reasons in the sent text", () => {
    const unavailable: UserTurn & { pictureFailures: Array<{ label: string; sourceUrl: string; reason: string }> } = {
      chips: [CHIP], message: "What is shown?",
      pictureFailures: [{ label: PICTURE.label, sourceUrl: PICTURE.sourceUrl, reason: "source-not-found" }],
    };
    const content = userMessageForModel("reader clock", unavailable);
    const text = textParts(content).join("\n");

    expect(text).toContain(PICTURE.label);
    expect(text).toContain(PICTURE.sourceUrl);
    expect(text).toContain("source-not-found");
    expect(Array.isArray(content) ? content.filter((part) => part.type === "file") : []).toEqual([]);
    expect(textParts(content).at(-1)!.endsWith(READER_LANGUAGE_REMINDER)).toBe(true);
  });
});
