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
  attachmentMarker,
  attachmentPart,
  attachmentSection,
  chipOfPart,
  messageLength,
  messageSegments,
  wordsForTitle,
  referenceCount,
  userTurnForModel,
} from "@shared/agent/attachments.js";
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

    expect(section).toContain("### Attachment 1: cover.png (type: image)");
    expect(section).toContain("https://cdn.example/cover.png");
    expect(section).toContain("### Attachment 2: brief.pdf (type: text)");
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

describe("an unnamed piece of the canvas", () => {
  it("is titled by its kind and node count", () => {
    const piece: ChatAttachedChip = {
      id: "canvas-2-x",
      type: "canvas",
      name: "",
      data_snapshot: { nodes: [{ id: "a" }, { id: "b" }], edges: [] },
    };

    expect(attachmentSection([piece])).toContain("### Attachment 1: canvas, 2 nodes (type: canvas)");
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

  it("is written as a marker carrying the attachment id", () => {
    expect(attachmentMarker("a1")).toBe("@[attachment:a1]");
  });

  it("reaches the model as the numbered attachment it points at", () => {
    const turn = userTurnForModel(
      [image, doc],
      `compare ${attachmentMarker("a2")} with ${attachmentMarker("a1")}`,
    );

    expect(turn.endsWith("compare [Attachment 2: brief.pdf] with [Attachment 1: cover.png]")).toBe(true);
  });

  it("tells apart two attachments with the same name and nameless canvas picks", () => {
    const turn = userTurnForModel(
      [image, twin, picked],
      `${attachmentMarker("a3")} ${attachmentMarker("a4")}`,
    );

    expect(turn).toContain("### Attachment 2: cover.png (type: image)");
    expect(turn).toContain("### Attachment 3: canvas, 2 nodes (type: canvas)");
    expect(turn.endsWith("[Attachment 2: cover.png] [Attachment 3: canvas, 2 nodes]")).toBe(true);
  });

  it("stays as typed text when its id is not attached to this message", () => {
    const words = `see ${attachmentMarker("elsewhere")}`;

    expect(userTurnForModel([image], words).endsWith(words)).toBe(true);
    expect(userTurnForModel([], words)).toBe(words);
  });

  it("reads as the attachment name in a title, and as nothing for an unnamed one", () => {
    expect(wordsForTitle([image, doc], `${attachmentMarker("a1")} and ${attachmentMarker("a2")}`)).toBe(
      "cover.png and brief.pdf",
    );
    expect(wordsForTitle([picked], `merge ${attachmentMarker("a4")} now`)).toBe("merge  now");
    expect(wordsForTitle([], `x ${attachmentMarker("a1")}`)).toBe(`x ${attachmentMarker("a1")}`);
  });

  it("counts as one character toward the message limit", () => {
    const words = `${attachmentMarker("a1")}${attachmentMarker("a1")} hi`;

    expect(messageLength([image], words)).toBe(5);
    expect(messageLength([], words)).toBe(words.length);
  });
});

describe("the typed words split around their references", () => {
  it("gives the text runs and the ids in order", () => {
    expect(messageSegments(`a ${attachmentMarker("x")}b${attachmentMarker("y")}`)).toEqual([
      { kind: "text", text: "a " },
      { kind: "reference", id: "x" },
      { kind: "text", text: "b" },
      { kind: "reference", id: "y" },
    ]);
  });

  it("is one text run when there is no reference", () => {
    expect(messageSegments("plain\nwords")).toEqual([{ kind: "text", text: "plain\nwords" }]);
    expect(messageSegments("")).toEqual([]);
  });
});

describe("how many references a message carries", () => {
  it("counts the ones pointing at its attachments only", () => {
    expect(referenceCount([image], `${attachmentMarker("a1")} ${attachmentMarker("a1")} ${attachmentMarker("x")}`)).toBe(2);
    expect(referenceCount([], attachmentMarker("a1"))).toBe(0);
  });
});
