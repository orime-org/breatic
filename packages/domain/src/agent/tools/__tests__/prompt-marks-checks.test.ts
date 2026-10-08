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

import { answerFor, checkProposal, inputSchema, makeProposeCanvasAction } from "../propose-canvas-action.js";

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
    edges: feeders.map((_, i) => ({ fromIndex: i, toIndex: feeders.length, into: "pool" })),
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
      edges: [{ fromIndex: 0, toIndex: 1, into: "image" }],
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

describe("where each wired node goes, said on its edge", () => {
  const note = { slot: { kind: "note" as const, label: "Pick the style picture into the style slot" } };
  const picture = (name: string): ProposalNode => ({ role: "source", type: "image", name });

  /**
   * Pictures wired into the model both templates use: an image pool of 11
   * and an optional style slot of 3. Each edge says where its picture goes.
   * @param into - One entry per picture: where its edge says it goes.
   * @param prompt - The generation's prompt.
   * @returns The proposal.
   */
  function routed(into: readonly (string | undefined)[], prompt: NonNullable<ProposalNode["prompt"]>): CanvasProposal {
    const base = edit(into.map((_, i) => picture(`Picture ${String(i + 1)}`)), prompt);
    return { ...base, edges: base.edges.map(({ fromIndex, toIndex }, i) => (into[i] === undefined ? { fromIndex, toIndex } : { fromIndex, toIndex, into: into[i] })) };
  }

  const marks = (n: number): NonNullable<ProposalNode["prompt"]> =>
    Array.from({ length: n }, (_, i) => reference(`picture ${String(i + 1)}`));

  it("asks for the way when the kind can go more than one way, naming each", () => {
    const answer = checkProposal(routed([undefined], [...marks(1), { text: " at night" }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/"Picture 1".*"pool".*"style_images"/s) });
  });

  it("refuses a way the model does not have, naming the ways it has", () => {
    const answer = checkProposal(routed(["first_frame"], [...marks(1), { text: " at night" }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/"first_frame".*"pool".*"style_images"/s) });
  });

  it("takes a picture into the pool with a reference mark", () => {
    expect(checkProposal(routed(["pool"], [...marks(1), { text: " at night" }]))).toEqual({ ok: true });
  });

  it("takes a picture into the style slot with a note and no reference mark", () => {
    expect(checkProposal(routed(["style_images"], [note, { text: "A night version." }]))).toEqual({ ok: true });
  });

  it("asks for a note for a picture going into a slot", () => {
    expect(checkProposal(routed(["style_images"], [{ text: "A night version." }]))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/"Picture 1".*style_images.*note/s),
    });
  });

  it("asks for a reference mark for each picture going into the pool", () => {
    expect(checkProposal(routed(["pool", "pool"], [...marks(1), { text: " at night" }]))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/"Picture 1".*"Picture 2"/s),
    });
  });

  it("holds the pool and the slot to their own room", () => {
    const pool12 = Array.from({ length: 12 }, () => "pool");
    expect(checkProposal(routed(pool12, [...marks(12), { text: " at night" }]))).toMatchObject({ ok: false, reason: expect.stringContaining("11") });
    expect(checkProposal(routed([...Array.from({ length: 11 }, () => "pool"), "style_images"], [note, ...marks(11), { text: " at night" }]))).toEqual({ ok: true });
    const style4 = Array.from({ length: 4 }, () => "style_images");
    expect(checkProposal(routed(style4, [note, note, note, note, { text: "A night version." }]))).toMatchObject({ ok: false, reason: expect.stringContaining("3") });
  });

  it("is not thrown by a mark a storyboard repeats in a later shot", () => {
    const characters = Array.from({ length: 6 }, (_, i) => picture(`Character ${String(i + 1)}`));
    const proposal: CanvasProposal = {
      nodes: [
        ...characters,
        picture("Style"),
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "multi_shot",
          model: "happyhorse-1.1-reference-to-video",
          params: { duration: 5 },
          shots: [
            { prompt: [note, ...Array.from({ length: 6 }, (_, i) => reference(`character ${String(i + 1)}`)), { text: " meet" }], duration: 3 },
            { prompt: [reference("character 1"), { text: " walks away" }], duration: 2 },
          ],
        },
      ],
      edges: [
        ...characters.map((_, i) => ({ fromIndex: i, toIndex: 7, into: "pool" })),
        { fromIndex: 6, toIndex: 7, into: "style_images" },
      ],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("needs no way where the kind can only go one way", () => {
    const proposal: CanvasProposal = {
      nodes: [picture("Style"), { role: "generate", type: "image", name: "Poster", mode: "t2i", model: "krea-v2-large-text-to-image", prompt: [note, { text: "A poster." }] }],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Poster",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("takes a text node's edge naming the prompt, its one way", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "Hello there." }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "",
      groupName: "Voice",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("refuses a text node's edge naming a way the model does not have, listing the ones it has", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "Hello there." }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "lyrics" }],
      rationale: "",
      groupName: "Voice",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"lyrics".*"pool"/s) });
  });

  it("is described on the edge for the agent", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/"into"/);
  });
});

describe("marks the reader can act on", () => {
  const char: ProposalNode = { ...CHARACTER, name: "Char" };

  it("refuses into on an edge whose node the model takes no way at all, naming it", () => {
    const proposal: CanvasProposal = {
      nodes: [char, { role: "generate", type: "image", name: "Gen", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "a courier at night" }] }],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "",
      groupName: "g",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"nano-banana-2" takes no image node.*"Char"/) });
  });

  it("still places that edge when it says nothing about where the node goes", () => {
    const proposal: CanvasProposal = {
      nodes: [char, { role: "generate", type: "image", name: "Gen", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "a courier at night" }] }],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "g",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("places a lone generation whose asset mark the reader fills by wiring a node of their own", () => {
    // The reader said they already have the material: the proposal places the
    // generation only, and the reader wires their node in and @s it.
    const answer = answerFor({ nodes: [{ role: "generate", type: "image", name: "Grid", template: "storyboard-grid-25" }], edges: [], rationale: "" });
    expect(answer.placed).toBe(true);
  });

  it("tells a text node wired into a model drawing no prompt box that its edge goes nowhere", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Line", prompt: [{ text: "hello there" }] },
        { role: "generate", type: "video", name: "Talk", mode: "talking_head", model: "omnihuman-1.5", prompt: [{ slot: { kind: "note", label: "Pick the face and the voice" } }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "",
      groupName: "g",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"omnihuman-1.5" takes no text node, so the edge from "Line" goes nowhere/) });
  });

  it("tells the agent into names a text node's box too", () => {
    const edge = inputSchema.shape.edges.element.shape.into.description ?? "";
    expect(edge).toMatch(/"lyrics"/);
  });

  it("keeps asset marks for nodes going into the pool, and a note for every node going into a slot", () => {
    const shape = inputSchema.shape.nodes.element.shape;
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/never a node going into a slot/);
    expect(shape.prompt.description ?? "").toMatch(/a node going into a slot or the lyrics box takes a note of its own instead/);
    expect(shape.prompt.description ?? "").toMatch(/an empty node left unwired/);
  });

});

describe("the lyrics box a song model draws, a second way for words (table B)", () => {
  const lyrics: ProposalNode = { role: "written", type: "text", name: "Lyrics", prompt: [{ text: "la la la" }] };
  /**
   * A song generation fed the lyrics node.
   * @param prompt - Its prompt.
   * @param into - What the edge says, if anything.
   * @returns The proposal.
   */
  function song(prompt: NonNullable<ProposalNode["prompt"]>, into?: string): CanvasProposal {
    return {
      nodes: [lyrics, { role: "generate", type: "audio", name: "Song", mode: "t2m", model: "mureka-v9.5-generate-song", prompt }],
      edges: [{ fromIndex: 0, toIndex: 1, ...(into === undefined ? {} : { into }) }],
      rationale: "",
      groupName: "Song",
    };
  }
  const toLyrics = { slot: { kind: "note" as const, label: "@ Lyrics in the lyrics box" } };

  it("places the lyrics node sent into the lyrics box with a note", () => {
    expect(checkProposal(song([{ text: "upbeat pop" }, toLyrics], "lyrics"))).toEqual({ ok: true });
  });

  it("asks which box when the edge does not say, naming both", () => {
    expect(checkProposal(song([{ text: "upbeat pop" }, toLyrics]))).toMatchObject({ ok: false, reason: expect.stringMatching(/"Lyrics".*"pool".*"lyrics"/s) });
  });

  it("asks for a note for the node sent into the lyrics box", () => {
    expect(checkProposal(song([{ text: "upbeat pop" }], "lyrics"))).toMatchObject({ ok: false, reason: expect.stringMatching(/"Lyrics" into lyrics.*0 note/s) });
  });

  it("places the words sent into the prompt with an asset mark", () => {
    expect(checkProposal(song([{ text: "upbeat pop, " }, reference("the lyrics")], "pool"))).toEqual({ ok: true });
  });
});

describe("a kind the canvas will not wire into the node (table A, first row)", () => {
  it("is refused with the way it does reach the node: picked into its slot, the edge left off", () => {
    const answer = checkProposal({
      nodes: [
        { role: "source", type: "video", name: "Clip" },
        { role: "generate", type: "audio", name: "Sfx", mode: "sfx", model: "hunyuan-video-foley", prompt: [{ text: "rain on glass" }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "video" }],
      rationale: "",
      groupName: "g",
    });
    expect(answer).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"hunyuan-video-foley" takes a video node in its "video" slot, picked in the panel: leave this edge off'),
    });
  });
});

describe("the lyrics set as a parameter (table D)", () => {
  it("is refused with the way words reach the lyrics box", () => {
    const answer = checkProposal({
      nodes: [{ role: "generate", type: "audio", name: "Song", mode: "t2m", model: "mureka-v9.5-generate-song", params: { lyrics: "la la" }, prompt: [{ text: "pop" }] }],
      edges: [],
      rationale: "",
    });
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('wired in with into: "lyrics"') });
  });
});

describe("a mark's label", () => {
  it.each([
    ["asset", "the hero ]"],
    ["tweak", "the {hero}'s line"],
  ] as const)("refuses a %s label holding the bracket that closes it, which would not read back", (kind, label) => {
    const proposal = edit([CHARACTER], [{ slot: { kind, label, note: "x" } }, { text: " at night" }]);
    expect(inputSchema.safeParse(proposal).success).toBe(false);
  });

  it("refuses a note label holding the bracket that closes it", () => {
    const proposal = edit([CHARACTER], [reference("the character"), { slot: { kind: "note", label: "Pick the photo (front) in the slot" } }]);
    expect(inputSchema.safeParse(proposal).success).toBe(false);
  });

  it("takes a label holding another kind's bracket", () => {
    const proposal = edit([CHARACTER], [{ slot: { kind: "asset", label: "the hero (front)", note: "x" } }, { text: " at night" }]);
    expect(inputSchema.safeParse(proposal).success).toBe(true);
  });
});

describe("what the note and the capabilities say", () => {
  it("says a note can ask for a text node @'d in the lyrics box", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/or that a text node is @'d in the lyrics box/);
  });
});

describe("a way over its room (table C)", () => {
  it("says to wire fewer, and nothing about another way, when the kind has one way", () => {
    const pictures = Array.from({ length: 4 }, (_, i): ProposalNode => ({ role: "source", type: "image", name: `P${String(i + 1)}` }));
    const proposal: CanvasProposal = {
      nodes: [...pictures, { role: "generate", type: "image", name: "Edit", mode: "i2i", model: "qwen-image-edit-multiple-angles", prompt: [{ text: "edit " }, ...pictures.map((p) => reference(p.name))] }],
      edges: pictures.map((_, i) => ({ fromIndex: i, toIndex: 4, into: "pool" })),
      rationale: "",
      groupName: "g",
    };
    const answer = checkProposal(proposal);
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining("Wire fewer.") });
    expect(answer).not.toMatchObject({ reason: expect.stringContaining("another way") });
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

describe("a note for every node going into a slot (design 5.7, user 2026-10-08)", () => {
  const pick = { slot: { kind: "note" as const, label: "Pick the picture into the slot" } };

  it("asks for a note for a node wired into a required slot", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "source", type: "image", name: "First frame" },
        { role: "generate", type: "video", name: "Clip", mode: "i2v", model: "seedance-2.5-image-to-video", prompt: [{ text: "She walks forward." }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"First frame" into image.*0 note/s) });
  });

  /**
   * An unwired empty node beside one generation, the way a kind the canvas
   * will not wire in reaches it: picked into a slot in the panel.
   * @param source - The empty node.
   * @param generation - The generation.
   * @returns The proposal.
   */
  function unwired(source: ProposalNode, generation: ProposalNode): CanvasProposal {
    return { nodes: [source, generation], edges: [], rationale: "", groupName: "g" };
  }
  const mood: ProposalNode = { role: "source", type: "image", name: "Mood picture" };
  const music = (prompt: NonNullable<ProposalNode["prompt"]>): ProposalNode => ({
    role: "generate", type: "audio", name: "Music", mode: "t2m", model: "lyria-3-pro-music", prompt,
  });

  it("asks for a note for an unwired empty node an optional slot takes", () => {
    expect(checkProposal(unwired(mood, music([{ text: "calm piano music" }])))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/"Mood picture".*note/s),
    });
    expect(checkProposal(unwired(mood, music([pick, { text: "calm piano music" }])))).toEqual({ ok: true });
  });

  it("asks for a note for an unwired empty node a required slot takes", () => {
    const clip: ProposalNode = { role: "source", type: "video", name: "Clip" };
    const sfx = (prompt: NonNullable<ProposalNode["prompt"]>): ProposalNode => ({
      role: "generate", type: "audio", name: "Sfx", mode: "sfx", model: "hunyuan-video-foley", prompt,
    });
    expect(checkProposal(unwired(clip, sfx([{ text: "rain on glass" }])))).toMatchObject({ ok: false, reason: expect.stringContaining('"Clip"') });
    expect(checkProposal(unwired(clip, sfx([{ slot: { kind: "note", label: "Pick the clip into the video slot" } }, { text: "rain on glass" }])))).toEqual({ ok: true });
  });

  it("asks no note for an unwired empty node no slot in the group takes", () => {
    const picture: ProposalNode = { role: "source", type: "image", name: "Photo" };
    const proposal = unwired(picture, {
      role: "generate", type: "image", name: "Edit", mode: "i2i", model: "qwen-image-edit-multiple-angles",
      prompt: [{ text: "turn " }, reference("the photo")],
    });
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("asks for a note for an empty node whose only edge goes into a model that takes nothing from it", () => {
    const photo: ProposalNode = { role: "source", type: "image", name: "Photo" };
    const clip = (prompt: NonNullable<ProposalNode["prompt"]>): ProposalNode => ({
      role: "generate", type: "video", name: "Clip", mode: "i2v", model: "seedance-2.5-image-to-video", prompt,
    });
    const proposal = (prompt: NonNullable<ProposalNode["prompt"]>): CanvasProposal => ({
      nodes: [photo, { ...CHARACTER, name: "Char" }, clip(prompt)],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "g",
    });
    expect(checkProposal(proposal([{ text: "she walks" }]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"Photo" goes into no generation by its edges'),
    });
    expect(checkProposal(proposal([{ slot: { kind: "note", label: "Pick Photo into the image slot" } }, { text: "she walks" }]))).toEqual({ ok: true });
  });

  it("does not count a note a wired slot node already uses toward an unwired one", () => {
    const wired: ProposalNode = { role: "source", type: "image", name: "Style" };
    const loose: ProposalNode = { role: "source", type: "image", name: "Loose" };
    const proposal: CanvasProposal = {
      nodes: [wired, loose, { role: "generate", type: "image", name: "Poster", mode: "t2i", model: "krea-v2-large-text-to-image", prompt: [pick, { text: "A poster." }] }],
      edges: [{ fromIndex: 0, toIndex: 2 }],
      rationale: "",
      groupName: "Poster",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining('"Loose"') });
  });
});

describe("notes in a multi-shot node", () => {
  it("are sent in a shot, and the refusal for a main prompt holding them says so", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "source", type: "image", name: "Style" },
        {
          role: "generate", type: "video", name: "Clip", mode: "multi_shot", model: "seedance-2.5-text-to-video", params: { duration: 5 },
          prompt: [{ slot: { kind: "note", label: "Pick the style picture into the style slot" } }],
          shots: [{ prompt: [{ text: "a boat" }], duration: 2 }, { prompt: [{ text: "the pond" }], duration: 3 }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "style_images" }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining("notes into the shots") });
    expect(inputSchema.shape.nodes.element.shape.shots.description ?? "").toMatch(/notes go in a shot too/);
  });
});

describe("a label that would not read back", () => {
  it("refuses a line break, which the box splits into two paragraphs", () => {
    expect(inputSchema.safeParse(edit([CHARACTER], [reference("the\nhero"), { text: " at night" }])).success).toBe(false);
  });
});

describe("a mark typed across two text segments", () => {
  it("is still read as a mark typed into the words", () => {
    const answer = checkProposal(edit([CHARACTER], [reference("the generated character"), { text: " Use [📎 the " }, { text: "photo] at night." }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining("types 1 mark") });
  });
});
