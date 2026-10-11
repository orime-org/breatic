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

describe("the Spaces the reader is in (inner#1413)", () => {
  const storyboard = { id: "s1", name: "Storyboard", kind: "document" as const };
  const cast = { id: "s2", name: "Cast", kind: "canvas" as const };
  const spaces = [storyboard, cast];

  it("lists every Space by name and kind, and marks the open one", () => {
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...storyboard, state: "loaded", content: "# Scene 1", total_chars: 9 },
    });

    expect(turn).toContain(
      '## Spaces in this project\n\n- "Storyboard" (document) — the reader has this one open\n- "Cast" (canvas)',
    );
  });

  it("marks none as open when the reader turned the open Space off", () => {
    const turn = userTurnForModel({ chips: [], message: "hi", spaces, spaces_total: 2 });

    expect(turn).toContain('- "Storyboard" (document)\n- "Cast" (canvas)');
    expect(turn).not.toContain("the reader has this one open");
    expect(turn).not.toContain("## The Space the reader has open");
  });

  it("says how many Spaces were left off the list", () => {
    const turn = userTurnForModel({ chips: [], message: "hi", spaces, spaces_total: 5 });

    expect(turn).toContain('- "Cast" (canvas)\n(3 more not listed)');
  });

  it("puts the reader's words under their own heading after the Spaces", () => {
    const turn = userTurnForModel({ chips: [], message: "summarise this", spaces, spaces_total: 2 });

    expect(turn.endsWith("\n\n## User message\n\nsummarise this")).toBe(true);
    expect(turn.startsWith("## Spaces in this project")).toBe(true);
  });

  it("puts the Spaces first, then the attachments, then the words", () => {
    const turn = userTurnForModel({
      chips: [image],
      message: "what is in this?",
      spaces,
      spaces_total: 2,
      current_space: { ...cast, state: "loaded", content: '{\n  "nodes": []\n}', total_chars: 16 },
    });

    const open = turn.indexOf('## The Space the reader has open: "Cast" (canvas)');
    const attached = turn.indexOf(attachmentSection([image]));
    const words = turn.indexOf("## User message\n\nwhat is in this?");
    expect(turn.indexOf("## Spaces in this project")).toBe(0);
    expect(open).toBeGreaterThan(0);
    expect(attached).toBeGreaterThan(open);
    expect(words).toBeGreaterThan(attached);
    expect(turn.endsWith("what is in this?")).toBe(true);
  });

  it("quotes a document's text so its headings are not read as the turn's own", () => {
    const content = "# Scene 1\n\nThe hero arrives.";
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...storyboard, state: "loaded", content, total_chars: content.length },
    });

    expect(turn).toContain(`## The Space the reader has open: "Storyboard" (document)\n\n${JSON.stringify(content)}`);
    expect(turn).not.toContain("\n# Scene 1");
  });

  it("carries a canvas's JSON as it came", () => {
    const content = JSON.stringify({ nodes: [{ id: "n1", name: "Hero" }], edges: [] }, null, 2);
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...cast, state: "loaded", content, total_chars: content.length },
    });

    expect(turn).toContain(`## The Space the reader has open: "Cast" (canvas)\n\n${content}\n\n## User message`);
  });

  it("says how much of a cut document it is shown", () => {
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...storyboard, state: "loaded", content: "# Sc", total_chars: 250_000 },
    });

    expect(turn).toContain('"# Sc"\n(Showing the first 4 of 250000 characters.)');
  });

  it("says a cut canvas has its long texts cut, and maybe some nodes left out", () => {
    const content = '{"edges":[],"nodes":[{"id":"n1"}]}';
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...cast, state: "loaded", content, total_chars: 250_000 },
    });

    expect(turn).toContain(
      `${content}\n(The canvas is over the limit: long texts in its nodes are cut short and end with "…", and ` +
        `if that was not enough, some nodes are left out with their links. Showing ${String(content.length)} of ` +
        "250000 characters.)",
    );
  });

  it("says an open Space is empty when it has nothing in it", () => {
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...cast, state: "loaded", content: "", total_chars: 0 },
    });

    expect(turn).toContain('## The Space the reader has open: "Cast" (canvas)\n\nThis Space is empty.');
  });

  it("says an open Space's content has not loaded yet", () => {
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces,
      spaces_total: 2,
      current_space: { ...storyboard, state: "loading" },
    });

    expect(turn).toContain('## The Space the reader has open: "Storyboard" (document)\n\nIts content has not loaded yet.');
  });

  it("says a timeline Space's content cannot be read", () => {
    const timeline = { id: "s3", name: "Edit", kind: "timeline" as const };
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces: [timeline],
      spaces_total: 1,
      current_space: { ...timeline, state: "unreadable" },
    });

    expect(turn).toContain('## The Space the reader has open: "Edit" (timeline)\n\nThe content of a timeline Space cannot be read.');
  });

  it("is the bare words when the project has no Space and nothing is attached", () => {
    expect(userTurnForModel({ chips: [], message: "hi", spaces: [], spaces_total: 0 })).toBe("hi");
  });
});
