// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the proposal check asks of the marks once the reader @s every
 * reference by hand (inner#977): no mark is paired with a node, but every
 * node they could @ has a bracket telling them to, a note is never words of a
 * written node, and the words a wired text node holds count against the cap
 * they will be @'d into.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, markText, t, templatePrompt, type CanvasProposal, type ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal, inputSchema, makeProposeCanvasAction } from "../propose-canvas-action.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A reference mark, the bracket asking the reader to @ something.
 * @param label - What to @.
 * @returns The segment.
 */
function reference(label: string): { slot: { kind: "asset"; label: string; note: string } } {
  return { slot: { kind: "asset", label, note: label } };
}

/** A character generated first, the upstream work a later node draws on. */
const CHARACTER: ProposalNode = {
  role: "generate",
  type: "image",
  name: "Character",
  mode: "t2i",
  model: "nano-banana-2",
  prompt: [{ text: "A courier in a red coat." }],
};

/**
 * An image-to-image node fed by the given nodes, all listed before it.
 * @param feeders - What is wired into it.
 * @param prompt - Its prompt.
 * @returns The proposal.
 */
function edit(feeders: ProposalNode[], prompt: NonNullable<ProposalNode["prompt"]>): CanvasProposal {
  return {
    nodes: [
      ...feeders,
      { role: "generate", type: "image", name: "Night", mode: "i2i", model: "nano-banana-pro-edit-ultra", prompt },
    ],
    edges: feeders.map((_, i) => ({ fromIndex: i, toIndex: feeders.length })),
    rationale: "A night version of the character.",
    groupName: "Night",
  };
}

describe("the marks a proposal sends", () => {
  it("takes a note with a label alone, and no longer takes a ref mark", () => {
    const base = edit([CHARACTER], [reference("the generated character"), { text: " at night" }]);
    const withNote = { ...base, nodes: base.nodes.map((n, i) => (i === 1 ? { ...n, prompt: [{ slot: { kind: "note", label: "Pick it in the panel" } }, ...(n.prompt ?? [])] } : n)) };
    expect(inputSchema.safeParse(withNote).success).toBe(true);
    const withRef = { ...base, nodes: base.nodes.map((n, i) => (i === 1 ? { ...n, prompt: [{ slot: { kind: "ref", label: "x", note: "x" } }] } : n)) };
    expect(inputSchema.safeParse(withRef).success).toBe(false);
  });
});

describe("every node the reader could @ has a bracket", () => {
  it("refuses generated work wired in with no reference mark, naming it", () => {
    const answer = checkProposal(edit([CHARACTER], [{ text: "Make it night." }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('"Character"') });
  });

  it("places it with one reference mark", () => {
    expect(checkProposal(edit([CHARACTER], [reference("the generated character"), { text: " at night" }]))).toEqual({ ok: true });
  });

  it("counts empty nodes and generated work together", () => {
    const photo: ProposalNode = { role: "source", type: "image", name: "Photo" };
    const answer = checkProposal(edit([photo, CHARACTER], [reference("the uploaded photo"), { text: " at night" }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/"Photo".*"Character"/) });
  });

  it("does not count a node the model's slot takes, which a note describes", () => {
    const frame: ProposalNode = { role: "source", type: "image", name: "First frame" };
    const proposal: CanvasProposal = {
      nodes: [
        frame,
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "i2v",
          model: "kling-video-o3-4k-image-to-video",
          prompt: [{ slot: { kind: "note", label: "Pick the first frame in the panel" } }, { text: "She walks forward." }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });
});

describe("a written node", () => {
  it("is refused when it carries a note, which never reaches its words", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ slot: { kind: "note", label: "Read it aloud" } }, { text: "Hello there." }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Voice",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining('"Script"') });
  });
});

describe("the words a wired text node holds", () => {
  /**
   * A script of the given length read by a speech model that takes 2000 characters.
   * @param length - How many characters the script holds.
   * @returns The proposal.
   */
  function speech(length: number): CanvasProposal {
    return {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "a".repeat(length) }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Voice",
    };
  }

  it("count against the cap as if the reader @s it, and the refusal names the node", () => {
    expect(checkProposal(speech(2100))).toMatchObject({ ok: false, reason: expect.stringContaining('"Script"') });
  });

  it("fit when the script is within the cap", () => {
    expect(checkProposal(speech(1000))).toEqual({ ok: true });
  });

  it("are refused against one shot's limit when the model takes shots", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "b".repeat(600) }] },
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "multi_shot",
          model: "kling-v3.0-4k-text-to-video",
          params: { duration: 5 },
          shots: [
            { prompt: [reference("the script the Agent wrote")], duration: 2 },
            { prompt: [{ text: "the pond at dusk" }], duration: 3 },
          ],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"Script".*512/) });
  });
});

describe("a node wired into an optional slot", () => {
  /**
   * The given number of empty pictures wired into a model whose style slot
   * takes up to three and whose pool takes the rest.
   * @param count - How many empty pictures are wired in.
   * @param prompt - The node's prompt.
   * @returns The proposal.
   */
  function styled(count: number, prompt: NonNullable<ProposalNode["prompt"]>): CanvasProposal {
    const pictures = Array.from({ length: count }, (_, i): ProposalNode => ({ role: "source", type: "image", name: `Picture ${String(i + 1)}` }));
    return edit(pictures, prompt);
  }

  const note = { slot: { kind: "note" as const, label: "Pick the style picture into the style slot" } };

  it("takes a note pointing it into the slot in place of a reference mark", () => {
    expect(checkProposal(styled(2, [note, reference("the uploaded character"), { text: " at night" }]))).toEqual({ ok: true });
  });

  it("still asks for an instruction for every picture, naming the slot", () => {
    expect(checkProposal(styled(1, [{ text: "Make it night." }]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("style_images slot"),
    });
  });

  it("lets notes stand in no more often than the slot holds pictures", () => {
    expect(checkProposal(styled(5, [note, note, note, note, reference("the uploaded character")]))).toMatchObject({ ok: false });
    expect(checkProposal(styled(5, [note, note, note, reference("the character"), reference("the scene")]))).toEqual({ ok: true });
  });
});

describe("an optional slot and the reference pool", () => {
  /**
   * Empty pictures wired into the model both templates use: a pool of 11 and a style slot of 3.
   * @param count - How many pictures.
   * @param marks - How many asset marks.
   * @param notes - How many notes.
   * @returns The proposal.
   */
  function crowd(count: number, marks: number, notes: number): CanvasProposal {
    const pictures = Array.from({ length: count }, (_, i): ProposalNode => ({ role: "source", type: "image", name: `Picture ${String(i + 1)}` }));
    const prompt: NonNullable<ProposalNode["prompt"]> = [
      ...Array.from({ length: notes }, () => ({ slot: { kind: "note" as const, label: "Pick this one into the style slot" } })),
      ...Array.from({ length: marks }, (_, i) => reference(`picture ${String(i + 1)}`)),
      { text: " at night" },
    ];
    return edit(pictures, prompt);
  }

  it("leaves the pictures a note sends to the slot out of the pool's ceiling", () => {
    expect(checkProposal(crowd(13, 11, 2))).toEqual({ ok: true });
    expect(checkProposal(crowd(14, 11, 3))).toEqual({ ok: true });
  });

  it("still refuses a pool past its ceiling once the slot is full", () => {
    expect(checkProposal(crowd(15, 12, 3))).toMatchObject({ ok: false, reason: expect.stringContaining("holds 11 image") });
  });

  it("names only a slot that takes the kind wired in", () => {
    const clips: ProposalNode[] = [
      { role: "source", type: "video", name: "Clip 1" },
      { role: "source", type: "video", name: "Clip 2" },
    ];
    const proposal: CanvasProposal = {
      nodes: [...clips, { role: "generate", type: "video", name: "Cut", mode: "t2v", model: "seedance-2.5-text-to-video", prompt: [{ text: "A city at dusk." }] }],
      edges: [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2 }],
      rationale: "",
      groupName: "Cut",
    };
    const answer = checkProposal(proposal);
    expect(answer).toMatchObject({ ok: false });
    expect(answer.ok ? "" : answer.reason).not.toContain("style_images");
  });

  it("asks in the prompt's description for a note for each node an optional slot takes", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/a note of its own/);
  });
});

describe("a mark the agent writes as words", () => {
  const written = [
    ["a reference", "[📎 the uploaded photo]"],
    ["a fill-in", "{✏️ the story}"],
    ["a note", "(💡 pick it in the panel)"],
  ] as const;

  it.each(written)("is refused when %s is typed into the words, naming the slot segment to send", (_, mark) => {
    const answer = checkProposal(edit([CHARACTER], [reference("the generated character"), { text: ` Use ${mark} at night.` }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/"Night".*"slot"/s) });
  });

  it("is refused in a shot too", () => {
    const proposal: CanvasProposal = {
      nodes: [
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "multi_shot",
          model: "kling-v3.0-4k-text-to-video",
          params: { duration: 5 },
          shots: [
            { prompt: [{ text: "A boat {✏️ where it goes}" }], duration: 2 },
            { prompt: [{ text: "the pond at dusk" }], duration: 3 },
          ],
        },
      ],
      edges: [],
      rationale: "",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining('"Clip"') });
  });

  it("hands back a mark copied from a box with its label alone, and every mark at once", () => {
    const copied = `${markText({ kind: "asset", label: "the character photo", note: "x" })} in the rain, {✏️ the weather}`;
    const answer = checkProposal(edit([CHARACTER], [reference("the generated character"), { text: ` ${copied}` }]));
    expect(answer).toMatchObject({ ok: false });
    const reason = answer.ok ? "" : answer.reason;
    expect(reason).toContain('"label":"the character photo"');
    expect(reason).toContain('"label":"the weather"');
    expect(reason).not.toContain(t("canvas.promptMark.reference", { label: "" }).trim());
    expect(reason).not.toContain('"note":"…"');
  });

  it("tells a written node to take a reference or note out, the way the role check does", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "Scene 1: [📎 the hero photo] walks in" }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Voice",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining("takes no reference or note mark") });
  });

  it("leaves plain brackets the prompt means as words alone", () => {
    expect(checkProposal(edit([CHARACTER], [reference("the generated character"), { text: " at night [cinematic] {wide}" }]))).toEqual({ ok: true });
  });
});

describe("the templates as the agent is shown them", () => {
  it("lists each prompt as the segments to send, labels without the words the canvas adds", () => {
    const said = makeProposeCanvasAction().description ?? "";
    for (const template of GENERATION_TEMPLATES) {
      for (const segment of templatePrompt(template)) {
        if (segment.slot) expect(said).toContain(JSON.stringify({ slot: segment.slot }));
      }
    }
    expect(said).not.toContain(t("canvas.promptMark.reference", { label: "" }).trim());
  });

  it("says on a reference label that the words asking the reader to @ are added for it", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/added for you/);
  });
});

describe("what the agent is told about marks", () => {
  it("says the reader @s by hand and keeps no pairing or ref mark", () => {
    const said = JSON.stringify(inputSchema.toJSONSchema()) + (makeProposeCanvasAction().description ?? "");
    expect(said).not.toMatch(/\bref\b|k-th|pairs with/);
    expect(said).toMatch(/@/);
    expect(said).toMatch(/note/);
  });

  it("asks for the prompt in the language the reader writes in", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/language the reader/);
  });
});
