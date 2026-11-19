// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A prompt read out of its fragment in two steps (breatic#1488 §9): collab
 * holds the fragment and reads it into pieces (words and mentions, notes left
 * out), and the MCP service, which holds the model catalog and so knows each
 * chip's words, joins the pieces into the text the model reads. The two steps
 * must give exactly what `serializePromptFragment` gives in one, so the
 * pieces carry every stretch of text the fragment holds, the space the editor
 * keeps after a line's last mention included. The same pieces also give the
 * text an external agent reads, a mention written as `@[name](node id)`.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { serializePromptFragment } from "@shared/canvas/model/fragment-prompt.js";
import { agentPromptSegments, promptMarkup, promptPieces, serializeDialoguePieces, serializePromptPieces } from "@shared/canvas/model/prompt-pieces.js";
import { dialogueText } from "@shared/canvas/dialogue.js";
import { writeDialogueLines, writeProposalPrompt, type ProposalMention } from "@shared/canvas/model/proposal-prompt.js";
import type { ReferenceRailItem } from "@shared/canvas/model/derive-references.js";

const HERO: ProposalMention = { sourceNodeId: "img-1", label: "Hero", kind: "image", thumbnail: "https://cdn.example.com/h.png" };
const SCRIPT: ProposalMention = { sourceNodeId: "txt-1", label: "Script", kind: "text" };

const POOL: ReferenceRailItem[] = [
  { refId: "img-1->gen", sourceNodeId: "img-1", sourceNodeType: "image", sourceNodeName: "Hero" },
  { refId: "txt-1->gen", sourceNodeId: "txt-1", sourceNodeType: "text", sourceNodeName: "Script", textContent: "a quiet harbour at dawn" },
];
const TOKENS = { "img-1": "image 1" };

/**
 * A prompt fragment attached to a document, written the way a proposal lands.
 * @param write - Writes into the fragment.
 * @returns The fragment.
 */
function fragmentOf(write: (fragment: Y.XmlFragment) => void): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prompt");
  write(fragment);
  return fragment;
}

const mentions = [HERO, SCRIPT];
const FIXTURES: Array<[string, Y.XmlFragment]> = [
  ["plain words", fragmentOf((f) => writeProposalPrompt(f, [{ text: "A red bicycle" }]))],
  [
    "a media chip and a text chip on two lines",
    fragmentOf((f) => writeProposalPrompt(f, [{ text: "Make " }, { ref: 0 }, { text: " brighter\nin " }, { ref: 1 }], (i) => mentions[i])),
  ],
  [
    "a note above the words",
    fragmentOf((f) => writeProposalPrompt(f, [{ slot: { kind: "note", label: "Pick a style first" } }, { text: "Portrait of " }, { ref: 0 }], (i) => mentions[i])),
  ],
  [
    "dialogue lines with speakers",
    fragmentOf((f) =>
      writeDialogueLines(f, [
        { speaker: 1, prompt: [{ text: "Hello there." }] },
        { speaker: 2, prompt: [{ text: "About " }, { ref: 1 }] },
      ], (i) => mentions[i]),
    ),
  ],
];

describe("promptPieces and serializePromptPieces", () => {
  it.each(FIXTURES)("give the text serializePromptFragment gives, for %s", (_label, fragment) => {
    expect(serializePromptPieces(promptPieces(fragment), POOL, TOKENS)).toBe(serializePromptFragment(fragment, POOL, TOKENS));
  });

  it("carry each mention's node and kind, every stretch of text as stored, each line's speaker, and leave notes out", () => {
    const fragment = FIXTURES[2]![1];
    // writeProposalPrompt keeps a space after a line's last mention, as the
    // editor does; the model reads it, so the pieces keep it too.
    expect(promptPieces(fragment)).toEqual([
      { pieces: [{ text: "Portrait of " }, { mention: { sourceNodeId: "img-1", kind: "image" } }, { text: " " }] },
    ]);
    expect(promptPieces(FIXTURES[3]![1]).map((block) => block.speaker)).toEqual([1, 2]);
  });

  it("survive a JSON round trip, the way they travel from collab to the MCP service", () => {
    const fragment = FIXTURES[1]![1];
    const travelled = JSON.parse(JSON.stringify(promptPieces(fragment))) as ReturnType<typeof promptPieces>;
    expect(serializePromptPieces(travelled, POOL, TOKENS)).toBe(serializePromptFragment(fragment, POOL, TOKENS));
  });
});

describe("promptMarkup", () => {
  it("writes each mention as @[its label](its node id), notes in their marked form, lines apart", () => {
    expect(promptMarkup(FIXTURES[1]![1])).toBe("Make @[Hero](img-1) brighter\n\nin @[Script](txt-1) ");
    expect(promptMarkup(FIXTURES[2]![1])).toContain("Portrait of @[Hero](img-1)");
    expect(promptMarkup(FIXTURES[2]![1])).toContain("Pick a style first");
  });
});

describe("agentPromptSegments", () => {
  it("turns each @[label](node id) into a ref into one shared list of mentions, each node once", () => {
    expect(agentPromptSegments("Make @[Hero](n1) wave at @[Dog](n2) and @[Hero again](n1)!", [])).toEqual({
      segments: [{ text: "Make " }, { ref: 0 }, { text: " wave at " }, { ref: 1 }, { text: " and " }, { ref: 0 }, { text: "!" }],
      mentions: ["n1", "n2"],
    });
  });

  it("continues a mention list another prompt of the same change began", () => {
    expect(agentPromptSegments("@[Dog](n2) then @[Cat](n3)", ["n1", "n2"])).toEqual({
      segments: [{ ref: 1 }, { text: " then " }, { ref: 2 }],
      mentions: ["n1", "n2", "n3"],
    });
  });

  it("keeps a marked note and words to fill as the marks they are", () => {
    const { segments } = agentPromptSegments("A shot of {✏️ subject} (💡 keep it short)", []);
    expect(segments.filter((s) => "slot" in s && s.slot !== undefined).map((s) => (s as { slot: { kind: string } }).slot.kind)).toEqual(["tweak", "note"]);
  });

  it("reads back what promptMarkup writes", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("p");
    const mentions: ProposalMention[] = [{ sourceNodeId: "n1", label: "Hero", kind: "image" }];
    writeProposalPrompt(fragment, [{ text: "Paint " }, { ref: 0 }, { text: " at dusk" }], (i) => mentions[i]);
    expect(agentPromptSegments(promptMarkup(fragment), [])).toEqual({ segments: [{ text: "Paint " }, { ref: 0 }, { text: " at dusk" }], mentions: ["n1"] });
  });
});

describe("serializing pieces as the editor does", () => {
  it("joins lines with the separator a box asks for", () => {
    const blocks = [{ pieces: [{ text: "verse one" }] }, { pieces: [{ text: "verse two" }] }];
    expect(serializePromptPieces(blocks, [], {})).toBe("verse one\n\nverse two");
    expect(serializePromptPieces(blocks, [], {}, "\n")).toBe("verse one\nverse two");
  });

  it("writes a dialogue as the script the dialogue side sends", () => {
    const blocks = [
      { pieces: [{ text: "Hello there." }], speaker: 1 },
      { pieces: [{ text: "Hi!" }], speaker: 2 },
    ];
    const names = ["Ann", "Bo"];
    expect(serializeDialoguePieces(blocks, [], names, {})).toBe(
      dialogueText(
        [
          { speaker: 1, text: "Hello there." },
          { speaker: 2, text: "Hi!" },
        ],
        names.map((speaker) => ({ speaker })),
      ),
    );
  });
});
