// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How attached items are laid out for the model, and what their size is
 * measured on.
 *
 * The browser and the server both measure the attachment section against the
 * same limit, so they have to measure the same text: this one function is
 * that text, and the user's own words are counted apart from it.
 */

import { describe, it, expect } from "vitest";

import {
  attachmentPart,
  attachmentSection,
  chipOfPart,
  userTurnForModel,
} from "@shared/agent/attachments.js";
import { chatAttachedChipSchema, chatMessageSchema } from "@shared/schemas/api.js";
import type { ChatAttachedChip } from "@shared/schemas/api.js";

const image: ChatAttachedChip = {
  id: "a1",
  type: "image",
  name: "cover.png",
  data_snapshot: { url: "https://cdn.example/cover.png" },
};
const doc: ChatAttachedChip = {
  id: "a2",
  type: "text",
  name: "brief.pdf",
  data_snapshot: { text: "Line one\nLine two" },
};

describe("attachmentSection", () => {
  it("is empty when nothing is attached", () => {
    expect(attachmentSection([])).toBe("");
  });

  it("names every item with its type and carries its snapshot", () => {
    const section = attachmentSection([image, doc]);

    expect(section).toContain("### cover.png (type: image)");
    expect(section).toContain("https://cdn.example/cover.png");
    expect(section).toContain("### brief.pdf (type: text)");
    expect(section).toContain(JSON.stringify(doc.data_snapshot, null, 2));
  });

  it("does not depend on the words typed beside it", () => {
    // The limit on attachments is measured on this alone, so a long question
    // must not change what the attachments weigh.
    const before = attachmentSection([doc]);
    userTurnForModel([doc], "y".repeat(10_000));
    expect(attachmentSection([doc])).toBe(before);
  });
});

describe("userTurnForModel", () => {
  it("is the typed words unchanged when nothing is attached", () => {
    expect(userTurnForModel([], "hello")).toBe("hello");
  });

  it("puts the attachments first and the typed words after them", () => {
    const turn = userTurnForModel([image], "what is in this?");

    expect(turn.startsWith(attachmentSection([image]))).toBe(true);
    expect(turn.endsWith("what is in this?")).toBe(true);
    expect(turn.indexOf("cover.png")).toBeLessThan(turn.indexOf("what is in this?"));
  });
});

describe("an attached item on the chat wire", () => {
  it("reads back the item it was written from", () => {
    expect(chipOfPart(attachmentPart(image))).toEqual(image);
  });

  it("reads nothing from any other part", () => {
    expect(chipOfPart({ type: "text" })).toBeUndefined();
  });
});

describe("what a message may carry", () => {
  it("refuses an item id longer than any node or file id", () => {
    expect(chatAttachedChipSchema.safeParse({ ...image, id: "x".repeat(129) }).success).toBe(false);
  });

  it("takes an id as long as a uuid", () => {
    expect(chatAttachedChipSchema.safeParse({ ...image, id: "0".repeat(36) }).success).toBe(true);
  });

  it("refuses a whole message carrying an oversized id", () => {
    const parsed = chatMessageSchema.safeParse({
      message: "hi",
      project_id: "00000000-0000-4000-8000-000000000000",
      conversation_id: "00000000-0000-4000-8000-000000000001",
      attached_chips: [{ ...image, id: "x".repeat(10_000) }],
    });
    expect(parsed.success).toBe(false);
  });
});
