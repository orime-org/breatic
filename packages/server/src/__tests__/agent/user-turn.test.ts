// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One user message as the model is sent it: what it attached, then what it
 * typed, with each reference written as the numbered attachment it points at.
 */

import { describe, it, expect } from "vitest";

import { attachmentMarker, attachmentSection } from "@breatic/shared";
import type { ChatAttachedChip } from "@breatic/shared";
import { userTurnForModel } from "@server/agent/user-turn.js";

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

describe("userTurnForModel", () => {
  it("is the typed words unchanged when nothing is attached", () => {
    expect(userTurnForModel({ chips: [], message: "hello" })).toBe("hello");
  });

  it("puts the attachments first and the typed words after them", () => {
    const turn = userTurnForModel({ chips: [image], message: "what is in this?" });

    expect(turn.startsWith(attachmentSection([image]))).toBe(true);
    expect(turn.endsWith("what is in this?")).toBe(true);
    expect(turn.indexOf("cover.png")).toBeLessThan(turn.indexOf("what is in this?"));
  });

  it("leaves the attachment section measured apart from the words", () => {
    // The limit on attachments is measured on the section alone, so a long
    // question must not change what the attachments weigh.
    const before = attachmentSection([doc]);
    userTurnForModel({ chips: [doc], message: "y".repeat(10_000) });
    expect(attachmentSection([doc])).toBe(before);
  });
});

describe("a reference to an attachment inside the typed words", () => {
  const twin: ChatAttachedChip = { ...image, id: "a3" };
  const picked: ChatAttachedChip = {
    id: "a4",
    type: "canvas",
    name: "",
    data_snapshot: { nodes: [{ id: "n1" }, { id: "n2" }], edges: [] },
  };

  it("reaches the model as the numbered attachment it points at", () => {
    const turn = userTurnForModel({
      chips: [image, doc],
      message: `compare ${attachmentMarker("a2")} with ${attachmentMarker("a1")}`,
    });

    expect(turn.endsWith("compare [Attachment 2: brief.pdf] with [Attachment 1: cover.png]")).toBe(true);
  });

  it("tells apart two attachments with the same name and nameless canvas picks", () => {
    const turn = userTurnForModel({
      chips: [image, twin, picked],
      message: `${attachmentMarker("a3")} ${attachmentMarker("a4")}`,
    });

    expect(turn).toContain("### Attachment 2: cover.png (type: image)");
    expect(turn).toContain("### Attachment 3: canvas, 2 nodes (type: canvas)");
    expect(turn.endsWith("[Attachment 2: cover.png] [Attachment 3: canvas, 2 nodes]")).toBe(true);
  });

  it("stays as typed text when its id is not attached to this message", () => {
    const words = `see ${attachmentMarker("elsewhere")}`;

    expect(userTurnForModel({ chips: [image], message: words }).endsWith(words)).toBe(true);
    expect(userTurnForModel({ chips: [], message: words })).toBe(words);
  });
});
