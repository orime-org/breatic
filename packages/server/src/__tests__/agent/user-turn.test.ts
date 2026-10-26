// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One user message as the model is sent it: what it attached, then what it
 * typed, with each reference written as the numbered attachment it points at.
 */

import { describe, it, expect } from "vitest";

import { attachmentMarker, attachmentSection } from "@breatic/shared";
import type { ChatAttachedChip } from "@breatic/shared";
import { UNCHANGED_SPACE_NOTE, openSpaceKey, userMessageForModel, userTurnForModel as modelUserTurn } from "@server/agent/user-turn.js";

/**
 * Narrow the legacy fixtures, which supply no prepared pictures, to their text contract.
 * @param args - The original fixture arguments.
 * @returns The unchanged text result.
 * @throws {Error} When a fixture unexpectedly produces native media content.
 */
function userTurnForModel(...args: Parameters<typeof modelUserTurn>): string {
  const content = modelUserTurn(...args);
  if (typeof content !== "string") throw new Error("A legacy fixture without prepared pictures must remain text");
  return content;
}

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

  describe("a canvas over the limit", () => {
    const content = '{"edges":[],"nodes":[{"id":"n1"}]}';
    const whole = {
      selected_total: 0,
      selected_attached: 0,
      selected_whole: 0,
      slim: false,
      texts_cut: 0,
      names_only: 0,
      edges_not_listed: 0,
      nodes_not_listed: 0,
      groups_not_listed: 0,
    };
    const lead = `${content}\n(The canvas is over the limit, so it is shown in less detail: ${String(content.length)} of 250000 characters.`;
    const slimSentence =
      " Nodes that are not complete carry at most their id, type, name, group and texts, the media and nodes they refer to, who wrote their replies, how long their shots are, and the mode, model and settings they would run.";

    /**
     * The turn for an over-limit canvas with the given reductions.
     * @param detail - What was done, over a canvas that fits whole.
     * @returns The turn.
     */
    const over = (detail: Partial<typeof whole>): string =>
      userTurnForModel({
        chips: [],
        message: "hi",
        spaces,
        spaces_total: 2,
        current_space: { ...cast, state: "loaded", content, total_chars: 250_000, detail: { ...whole, ...detail } },
      });

    it("writes no note when the canvas went whole, even with nodes selected", () => {
      const turn = userTurnForModel({
        chips: [],
        message: "hi",
        spaces,
        spaces_total: 2,
        current_space: {
          ...cast,
          state: "loaded",
          content,
          total_chars: content.length,
          detail: { ...whole, selected_total: 2, selected_whole: 2 },
        },
      });

      expect(turn).toContain(`${content}\n\n## User message`);
      expect(turn).not.toContain("over the limit");
    });

    it("says only that nodes went slim, and that selecting them shows them whole", () => {
      expect(over({ slim: true })).toContain(
        `${lead}${slimSentence} To see nodes in full, ask the reader to select them or add them to the Agent.)`,
      );
    });

    it("says every step that was taken, and points only to adding when selecting would not help", () => {
      const turn = over({
        selected_total: 5,
        selected_attached: 1,
        selected_whole: 2,
        slim: true,
        texts_cut: 7,
        names_only: 4,
        edges_not_listed: 3,
        nodes_not_listed: 2,
        groups_not_listed: 1,
      });

      expect(turn).toContain(
        `${lead} The reader selected 5 nodes; 2 of them are complete here and 1 are complete in the attachments.` +
          `${slimSentence}` +
          ' 7 texts are cut short; each ends with "…[+N]", N being the characters left out.' +
          " 4 nodes show only their id, type, name and group." +
          " 3 links are not listed." +
          " 2 nodes are not listed." +
          " 1 groups are not listed; nodes inside them still name them as parentId." +
          " To see nodes in full, ask the reader to add them to the Agent.)",
      );
    });

    it("leaves out the attachments clause when no selected node is attached", () => {
      expect(over({ selected_total: 2, selected_whole: 2, slim: true })).toContain(
        `${lead} The reader selected 2 nodes; 2 of them are complete here.${slimSentence}` +
          " To see nodes in full, ask the reader to select them or add them to the Agent.)",
      );
    });

    it("points only to adding when a selected node went slim, though nothing else was cut", () => {
      expect(over({ selected_total: 2, selected_whole: 1, slim: true })).toContain(
        " To see nodes in full, ask the reader to add them to the Agent.)",
      );
    });
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

describe("userMessageForModel", () => {
  it("opens with the reader's clock and closes with the reminder of the reader's language", () => {
    expect(userMessageForModel("The reader's clock reads 09:00.", { chips: [], message: "画一只猫" })).toBe(
      "The reader's clock reads 09:00.\n\n画一只猫\n\n" +
        "(Reply and write every text the user will read or edit in the language this message is written in, " +
        "unless the user has asked for a specific language or the work itself sets one. " +
        "Keep the product terms the system prompt lists in English, even where this message translates them.)",
    );
  });

  it("keeps the message body between the clock and the reminder", () => {
    const message = userMessageForModel("clock", { chips: [image], message: "what is in this?" });
    expect(message).toContain(userTurnForModel({ chips: [image], message: "what is in this?" }));
  });
});

describe("an open Space unchanged since it was last sent in full", () => {
  const cast = { id: "s2", name: "Cast", kind: "canvas" as const };
  const content = '{"edges":[],"nodes":[{"id":"n1"}]}';
  const open = { ...cast, state: "loaded" as const, content, total_chars: content.length };

  it("is one line under its heading", () => {
    const turn = userTurnForModel(
      { chips: [], message: "hi", spaces: [cast], spaces_total: 1, current_space: open },
      true,
    );

    expect(turn).toContain(`## The Space the reader has open: "Cast" (canvas)\n\n${UNCHANGED_SPACE_NOTE}\n\n## User message`);
    expect(turn).not.toContain(content);
  });

  it("is sent in full when it is not unchanged", () => {
    const turn = userTurnForModel({ chips: [], message: "hi", spaces: [cast], spaces_total: 1, current_space: open });

    expect(turn).toContain(content);
  });

  it("is known by the section it would be sent as, heading included", () => {
    const key = openSpaceKey(open)?.key;

    expect(openSpaceKey(open)?.spaceId).toBe("s2");
    expect(openSpaceKey({ ...open })?.key).toBe(key);
    expect(openSpaceKey({ ...open, content: `${content} ` })?.key).not.toBe(key);
    expect(openSpaceKey({ ...open, name: "Renamed" })?.key).not.toBe(key);
  });

  it("has nothing to be known by when it holds nothing to stand in for", () => {
    expect(openSpaceKey(undefined)).toBeUndefined();
    expect(openSpaceKey({ ...cast, state: "loading" })).toBeUndefined();
    expect(openSpaceKey({ ...cast, state: "unreadable" })).toBeUndefined();
    expect(openSpaceKey({ ...open, content: "", total_chars: 0 })).toBeUndefined();
  });
});
