// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The propose tool takes a template on a generate node and judges the node it
 * expands into (inner#977).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@domain/agent/model-picture-capability.js", () => ({ resolveModelPictureCapability: vi.fn(async () => true) }));
vi.mock("@domain/agent/model-context-window.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveModelContextWindow: vi.fn(async () => 1_000_000),
}));

import { loadLocales, runWithLocale } from "@breatic/core";
import {
  canvasProposalSchema,
  GENERATION_TEMPLATES,
  setLocale,
  templateAnchor,
  templateGuideNode,
  type GenerationTemplate,
  type ProposalAnswer,
} from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { templateSegmentsText as shown } from "@domain/agent/tools/template-expansion.js";

import { describeTemplate } from "../get-generation-template.js";
import { answerFor, makeProposeCanvasAction, verdictFor } from "../propose-canvas-action.js";
import { inputSchema } from "../proposal-input.js";

import {
  agentShape,
  FIXTURES,
  joined,
  loadFixtureLocales,
  SHEET,
  STEPPED,
  withoutEdge,
  withoutNode,
  type Sent,
  type SentNode,
} from "./template-fixtures.js";

const NOTE = { slot: { kind: "note" as const, label: "Put the character's picture in Character first" } };

beforeEach(() => {
  loadFixtureLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/**
 * An empty picture wired into a generation that names a template.
 * @param template - The template id.
 * @returns The proposal as the agent sends it.
 */
function proposalWith(template: string): Parameters<typeof answerFor>[0] {
  return {
    nodes: [
      { role: "source", type: "image", name: "Character" },
      { role: "generate", type: "image", name: "Storyboard", template: { id: template }, prompt: [NOTE, { text: "A 5x5 storyboard of " }, { ref: 0 }, { text: "." }] },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    rationale: "A 25-panel storyboard of the character.",
    groupName: "Storyboard",
  };
}

describe("templates in proposals", () => {
  it("accepts a template on a node", () => {
    expect(inputSchema.safeParse(proposalWith("storyboard-grid-25")).success).toBe(true);
  });

  it("places the node the template expands into", () => {
    const answer = answerFor(proposalWith("storyboard-grid-25"));
    expect(answer.placed).toBe(true);
    if (!answer.placed) return;
    expect(answer.nodes[1]).toMatchObject({
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: { aspect_ratio: "1:1", resolution: "4k" },
    });
    expect(answer.nodes[1]?.prompt?.some((s) => s.ref === 0)).toBe(true);
  });

  it("refuses a template it does not have", () => {
    const answer = answerFor(proposalWith("no-such"));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining("No template") });
  });

  // inner#1807: the description indexes each template in one line, its goal,
  // what it makes and when to offer it; the full text is read with
  // get_generation_template.
  it("indexes every template in its description with its goal, the reader's words for it and when to offer it", () => {
    const said = makeProposeCanvasAction().description ?? "";
    for (const template of GENERATION_TEMPLATES) {
      expect(said).toContain(`${template.id} (${template.goal}, makes ${templateAnchor(template).type})`);
      expect(said).toContain(template.agentNote);
      for (const words of [...template.triggers.asks, ...template.triggers.offerWhen]) expect(said).toContain(words);
    }
    expect(said).toContain("get_generation_template");
  });

  it("carries no template's prompt or wiring, which the agent reads with get_generation_template", () => {
    for (const locale of ["en", "zh-CN"]) {
      setLocale(locale);
      const said = makeProposeCanvasAction().description ?? "";
      for (const template of GENERATION_TEMPLATES) expect(said, `${template.id} ${locale}`).not.toContain(shown(template));
      expect(said).not.toContain("Prompts, as segments");
      expect(said).not.toContain("To use one, send each of its nodes");
    }
    setLocale("en");
  });

  it("indexes the registry it is given and no other", () => {
    const said = makeProposeCanvasAction(FIXTURES).description ?? "";
    expect(said).toContain("fixture-steps");
    expect(said).not.toContain("storyboard-grid-25");
  });
});

describe("a template drawing on work generated upstream", () => {
  /**
   * A character generated first, wired into a storyboard from the template.
   * @param prompt - The storyboard prompt the agent sends.
   * @returns The proposal as the agent sends it.
   */
  function chained(
    prompt: NonNullable<Parameters<typeof answerFor>[0]["nodes"][number]["prompt"]>,
  ): Parameters<typeof answerFor>[0] {
    return {
      nodes: [
        { role: "generate", type: "image", name: "Character", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "A young courier in a red coat." }] },
        { role: "generate", type: "image", name: "Storyboard", template: { id: "storyboard-grid-25" }, prompt },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "Make the character, then a storyboard of it.",
      groupName: "Storyboard",
    };
  }

  it("is placed with a ref to the generated character and a note to generate it first", () => {
    const answer = answerFor(
      chained([
        { slot: { kind: "note", label: "Generate Character first" } },
        { text: "Use " },
        { ref: 0 },
        { text: " as the reference. A 5x5 storyboard of a courier crossing the city." },
      ]),
    );
    expect(answer.placed).toBe(true);
  });

  it("is refused with no prompt of its own, giving the template's words with a ref placeholder for the character", () => {
    const sent = chained([]);
    const answer = answerFor({ ...sent, nodes: [sent.nodes[0]!, { role: "generate", type: "image", name: "Storyboard", template: { id: "storyboard-grid-25" } }] });
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('{"ref": <index of the node wired in for') });
  });
});

describe("an empty node wired into a reference pool", () => {
  /**
   * The template proposal with the agent's own prompt on the generate node.
   * @param prompt - The prompt the agent wrote.
   * @param template - Whether the node names the template.
   * @returns The proposal as the agent sends it.
   */
  function withPrompt(
    prompt: NonNullable<Parameters<typeof answerFor>[0]["nodes"][number]["prompt"]>,
    template = true,
  ): Parameters<typeof answerFor>[0] {
    const sent = proposalWith("storyboard-grid-25");
    const generate = template
      ? { ...sent.nodes[1]!, prompt }
      : { role: "generate" as const, type: "image" as const, name: "Storyboard", mode: "i2i", model: "nano-banana-pro-edit-ultra", prompt };
    return { ...sent, nodes: [sent.nodes[0]!, generate] };
  }

  it("is refused when the prompt names it only in words, since the picture put there would not be sent", () => {
    const answer = answerFor(withPrompt([{ text: "Use [📎 character reference] as the reference. A 5x5 storyboard." }]));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('types 1 mark(s) into its words as text: "[📎 character reference]". A mark works only as a segment of its own, with the text segments kept to plain words: {"ref": <index>} for a node.') });
  });

  it("is placed when a ref mentions it", () => {
    const answer = answerFor(
      withPrompt([NOTE, { text: "Use " }, { ref: 0 }, { text: " as the reference. A 5x5 storyboard." }]),
    );
    expect(answer.placed).toBe(true);
  });

  it("holds a proposal without a template to the same rule", () => {
    const answer = answerFor(withPrompt([NOTE, { text: "A 5x5 storyboard of the character." }], false));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringMatching(/"Character".*ref/) });
  });
});

describe("the template prompts the agent reads inside a request", () => {
  it("are in the request's language, which the turn pins rather than the process", async () => {
    const { runWithLocale } = await import("@breatic/core");
    const { buildAgentConfig } = await import("@domain/agent/agent-config.js");
    const grid = GENERATION_TEMPLATES.find((template) => template.id === "storyboard-grid-25");
    if (!grid) throw new Error("no template");
    setLocale("en");
    const said = await runWithLocale("ja", async () => {
      const read = (await buildAgentConfig({ basePrompt: "base" })).tools["get_generation_template"];
      if (read?.execute === undefined) throw new Error("get_generation_template is not offered");
      return String(await read.execute({ id: grid.id }, { toolCallId: "t", messages: [], context: {} }));
    });
    const japanese = runWithLocale("ja", () => shown(grid));
    expect(japanese).not.toBe(shown(grid));
    expect(said).toContain(japanese);
  });
});

describe("empty nodes counted, a slot's and an unused kind's left out", () => {
  /**
   * A first-frame slot node listed before a pool node, both empty, feeding
   * Kling O3 image-to-video, the pool node @'d by the given number of refs.
   * @param refs - How many refs to the pool node the prompt carries.
   * @returns The proposal as the agent sends it.
   */
  function slotThenPool(refs: number): Parameters<typeof answerFor>[0] {
    const prompt = [
      { slot: { kind: "note" as const, label: "Pick the first frame into the image slot" } },
      { slot: { kind: "note" as const, label: "Put the character in Character first" } },
      { text: "She walks forward. " },
      ...(refs >= 2 ? [{ ref: 1 }, { text: " looks back. " }] : []),
      { ref: 1 },
      { text: " stays the same." },
    ];
    return {
      nodes: [
        { role: "source", type: "image", name: "First frame" },
        { role: "source", type: "image", name: "Character" },
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "i2v",
          model: "kling-video-o3-4k-image-to-video",
          prompt,
        },
      ],
      edges: [
        { fromIndex: 0, toIndex: 2, into: "image" },
        { fromIndex: 1, toIndex: 2, into: "pool" },
      ],
      rationale: "A clip from a first frame, keeping the character.",
      groupName: "Clip",
    };
  }

  it("places one ref for the pool node and a note for each empty node", () => {
    expect(answerFor(slotThenPool(1))).toMatchObject({ placed: true });
  });

  it("places the pool node @'d twice", () => {
    const answer = answerFor(slotThenPool(2));
    expect(answer).toMatchObject({ placed: true });
  });

  /**
   * A picture and a voice, both empty, wired into a reference-to-video node
   * whose pool takes pictures only, in the given order; a second node in the
   * group takes the voice.
   * @param voiceFirst - Whether the voice is listed before the picture.
   * @returns The proposal as the agent sends it.
   */
  function pictureAndVoice(voiceFirst: boolean): Parameters<typeof answerFor>[0] {
    const picture = { role: "source" as const, type: "image" as const, name: "Character" };
    const voice = { role: "source" as const, type: "audio" as const, name: "Voice" };
    const picked = voiceFirst ? 1 : 0;
    const note = { slot: { kind: "note" as const, label: "Put the character in Character first" } };
    return {
      nodes: [
        voiceFirst ? voice : picture,
        voiceFirst ? picture : voice,
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "ref",
          model: "happyhorse-1.1-reference-to-video",
          prompt: [note, { ref: picked }, { text: " walks through the rain." }],
        },
        {
          role: "generate",
          type: "video",
          name: "Talking",
          mode: "ref",
          model: "wan-3.0-reference-to-video",
          prompt: [note, { slot: { kind: "note" as const, label: "Put the voice in Voice first" } }, { ref: picked }, { text: " speaks to camera in " }, { ref: voiceFirst ? 0 : 1 }, { text: "." }],
        },
      ],
      edges: [2, 3].flatMap((toIndex) => [
        { fromIndex: voiceFirst ? 0 : 1, toIndex },
        { fromIndex: voiceFirst ? 1 : 0, toIndex, into: "pool" },
      ]),
      rationale: "Two clips of the character.",
      groupName: "Clips",
    };
  }

  it("needs one ref for the picture whichever order the voice is listed in", () => {
    expect(answerFor(pictureAndVoice(false))).toMatchObject({ placed: true });
    expect(answerFor(pictureAndVoice(true))).toMatchObject({ placed: true });
  });
});

/**
 * The answer, held to having been placed.
 * @param answer - What the tool answered.
 * @returns The placed proposal.
 */
function placedAnswer(answer: ProposalAnswer): Extract<ProposalAnswer, { placed: true }> {
  expect(answer).toMatchObject({ placed: true });
  if (!answer.placed) throw new Error(answer.reason);
  return answer;
}

/**
 * The identities of the nodes whose edges run into one node, in edge order.
 * @param answer - The placed proposal.
 * @param at - Where each identity sits.
 * @param into - The receiving identity.
 * @returns The senders' identities.
 */
function sendersInto(answer: Extract<ProposalAnswer, { placed: true }>, at: Map<string, number>, into: string): string[] {
  const identity = new Map([...at].map(([id, index]) => [index, id]));
  return answer.edges.filter((edge) => edge.toIndex === at.get(into)).map((edge) => identity.get(edge.fromIndex) ?? "?");
}

/** The note the fixture sheet's anchor carries for its generated sketch, in English. */
const SKETCH_FIRST = "Generate Sketch first, then pick it into the style slot";

/**
 * A lone anchor of the stepped fixture.
 * @param name - Its name.
 * @returns The node as the agent sends it.
 */
function stepped(name = "Lighthouse"): SentNode {
  return { role: "generate", type: "image", name, template: { id: "fixture-steps" }, prompt: [{ text: "A lighthouse at dawn." }] };
}

/**
 * The one-node fixture applied to a reference picture.
 * @returns The proposal as the agent sends it.
 */
function solo(): Sent {
  return {
    nodes: [
      { role: "source", type: "image", name: "Reference" },
      { role: "generate", type: "image", name: "Watercolour", template: { id: "fixture-solo" }, prompt: [{ slot: { kind: "note", label: "Put the reference in Reference first" } }, { text: "Redraw " }, { ref: 0 }] },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    rationale: "A watercolour of the reference.",
    groupName: "Watercolour",
  };
}

describe("a template's full text, generated from its skeleton (design 6.7 step 7)", () => {
  it("lists the fixture's nodes with key, role, type, mode and model, its edges, inputs, resource, steps, note and prompt fragments", () => {
    const said = describeTemplate(SHEET);
    for (const word of [
      "fixture-sheet",
      "sheet",
      "sketch",
      "palette",
      "generate",
      "source",
      "i2i",
      "nano-banana-pro-edit-ultra",
      "style_images",
      "pose",
      "front",
      "back",
      "character",
      "templates/fixture-sheet/palette.png",
      SHEET.agentNote,
      "Once Fixture sheet has generated, right-click it and pick Tools, then Grid split",
      "Drag the panel you like into a new node",
      "A rough sketch of ",
      " side by side on one sheet.",
    ]) {
      expect(said).toContain(word);
    }
    expect(said).toMatch(/\{"ref": <index of the node wired in[^>]*\bpose\b[^>]*>\}/);
    expect(said).toMatch(/\{"ref": <index of the node wired in[^>]*\bpalette\b[^>]*>\}/);
    expect(said).toMatch(/\{"ref": <index of the node wired in[^>]*\bfront\b[^>]*>\}/);
    expect(said).not.toContain("📎");
    // The inputs' notes stay out: the agent writes its own.
    for (const note of ["Put a pose picture in Pose first", "Put the front view in Front view first", "Put the back view in Back view first", "Put the character in Character first"]) {
      expect(said).not.toContain(note);
    }
  });
});

describe("the guide text node answerFor appends (design 6.7 step 8)", () => {
  it("appends one guide after a lone anchor and names the group after the template", () => {
    const answer = placedAnswer(answerFor({ nodes: [stepped()], edges: [], rationale: "A lighthouse." }, undefined, FIXTURES));
    expect(answer.nodes).toHaveLength(2);
    expect(answer.nodes[0]?.name).toBe("Lighthouse");
    expect(answer.nodes[0]?.templateNode).toBeUndefined();
    expect(answer.nodes[1]).toEqual(templateGuideNode(STEPPED, 0));
    expect(answer.nodes[1]).toMatchObject({ role: "written", type: "text", name: "Fixture steps", templateNode: { template: "fixture-steps", key: "guide", anchor: 0 } });
    expect(answer.groupName).toBe("Fixture steps");
    expect(answer.edges).toEqual([]);
  });

  it("appends one guide per anchor after the agent's nodes, keeping the agent's indices and group name", () => {
    const sent: Sent = { nodes: [stepped("Dawn"), stepped("Dusk")], edges: [], rationale: "Two lighthouses.", groupName: "Two lighthouses" };
    const answer = placedAnswer(answerFor(sent, undefined, FIXTURES));
    expect(answer.nodes.map((node) => node.name)).toEqual(["Dawn", "Dusk", "Fixture steps", "Fixture steps"]);
    expect(answer.nodes[2]).toEqual(templateGuideNode(STEPPED, 0));
    expect(answer.nodes[3]).toEqual(templateGuideNode(STEPPED, 1));
    expect(answer.groupName).toBe("Two lighthouses");
  });

  it("appends no guide for a template without steps", () => {
    const answer = placedAnswer(answerFor(solo(), undefined, FIXTURES));
    expect(answer.nodes).toHaveLength(2);
    expect(answer.groupName).toBe("Watercolour");
  });

  it("writes the guide and the group name in the request's language", () => {
    setLocale("en");
    const english = templateGuideNode(STEPPED, 0);
    const japanese = runWithLocale("ja", () => templateGuideNode(STEPPED, 0));
    expect(japanese?.name).toBe("フィクスチャ手順");
    expect(japanese).not.toEqual(english);
    const answer = placedAnswer(runWithLocale("ja", () => answerFor({ nodes: [stepped()], edges: [], rationale: "A lighthouse." }, undefined, FIXTURES)));
    expect(answer.nodes[1]).toEqual(japanese);
    expect(answer.groupName).toBe("フィクスチャ手順");
  });
});

describe("templateNode on the nodes of a matched instance (design 6.7 step 3)", () => {
  for (const anchorKey of [false, true]) {
    it(`marks each non-anchor template node, gives the resource its path, and marks nothing else (anchor key ${anchorKey ? "written" : "left out"})`, () => {
      const shape = agentShape(SHEET, { anchorKey });
      const answer = placedAnswer(answerFor(shape.sent, undefined, FIXTURES));
      expect(answer.nodes.some((node) => "template" in node)).toBe(false);
      const parsed = canvasProposalSchema.parse(answer);
      const node = (identity: string): (typeof parsed.nodes)[number] | undefined => parsed.nodes[shape.at.get(identity) ?? -1];
      expect(node("node:sketch")?.templateNode).toEqual({ template: "fixture-sheet", key: "sketch" });
      expect(node("node:palette")?.templateNode).toEqual({ template: "fixture-sheet", key: "palette" });
      expect(node("node:palette")?.resource).toBe("templates/fixture-sheet/palette.png");
      expect(node("node:sheet")?.templateNode).toBeUndefined();
      expect(node("node:sheet")?.resource).toBeUndefined();
      for (const input of ["pose", "front", "back", "character"]) {
        expect(node(`input:${input}`)?.templateNode).toBeUndefined();
        expect(node(`input:${input}`)?.resource).toBeUndefined();
      }
      expect(parsed.nodes).toHaveLength(shape.sent.nodes.length + 1);
      expect(parsed.nodes[shape.sent.nodes.length]).toEqual(templateGuideNode(SHEET, shape.at.get("node:sheet") ?? -1));
    });
  }

  it("asks no note for the resource it wires into the upstream node", () => {
    const shape = agentShape(SHEET);
    const sketch = shape.sent.nodes[shape.at.get("node:sketch") ?? -1];
    const notes = (sketch?.prompt ?? []).flatMap((segment) => ("slot" in segment && segment.slot.kind === "note" ? [segment.slot.label] : []));
    expect(notes).toEqual(["Put a pose picture in Pose first", "Put the character in Character first"]);
    placedAnswer(answerFor(shape.sent, undefined, FIXTURES));
  });

  it("leaves no templateNode on a tagged node no instance matches, filling its defaults all the same", () => {
    const sent: Sent = {
      nodes: [{ role: "generate", type: "image", name: "Sketch", template: { id: "fixture-sheet", key: "sketch" }, prompt: [{ text: "A sketch." }] }],
      edges: [],
      rationale: "A sketch.",
    };
    const answer = placedAnswer(answerFor(sent, undefined, FIXTURES));
    expect(answer.nodes).toHaveLength(1);
    expect(answer.nodes[0]).toMatchObject({ mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "1:1" } });
    expect(answer.nodes[0]?.templateNode).toBeUndefined();
  });

  it("places two instances chained, the first anchor standing as the second's input", () => {
    const first = solo();
    const sent: Sent = {
      ...first,
      nodes: [
        ...first.nodes,
        { role: "generate", type: "image", name: "Second", template: { id: "fixture-solo" }, prompt: [{ slot: { kind: "note", label: "Generate Watercolour first" } }, { text: "Redraw " }, { ref: 1 }] },
      ],
      edges: [...first.edges, { fromIndex: 1, toIndex: 2, into: "pool" }],
    };
    const answer = placedAnswer(answerFor(sent, undefined, FIXTURES));
    expect(answer.nodes).toHaveLength(3);
    expect(answer.nodes.map((node) => node.templateNode)).toEqual([undefined, undefined, undefined]);
  });

  it("places two whole instances in one proposal, each with its own guide", () => {
    const shape = agentShape(SHEET);
    const size = shape.sent.nodes.length;
    const anchor = shape.at.get("node:sheet") ?? -1;
    const answer = placedAnswer(answerFor(joined(shape.sent, shape.sent), undefined, FIXTURES));
    expect(answer.nodes).toHaveLength(size * 2 + 2);
    expect(answer.nodes[size * 2]).toEqual(templateGuideNode(SHEET, anchor));
    expect(answer.nodes[size * 2 + 1]).toEqual(templateGuideNode(SHEET, anchor + size));
    const sketch = shape.at.get("node:sketch") ?? -1;
    expect(answer.nodes[sketch]?.templateNode).toEqual({ template: "fixture-sheet", key: "sketch" });
    expect(answer.nodes[sketch + size]?.templateNode).toEqual({ template: "fixture-sheet", key: "sketch" });
  });

  it("reorders the input edges into each node to the order the template declares its inputs, and drops the input tags", () => {
    const shape = agentShape(SHEET, { tagInputs: true });
    const reversed: Sent = { ...shape.sent, edges: [...shape.sent.edges].reverse() };
    const answer = placedAnswer(answerFor(reversed, undefined, FIXTURES));
    expect(sendersInto(answer, shape.at, "node:sheet").filter((id) => id.startsWith("input:"))).toEqual(["input:front", "input:back", "input:character"]);
    expect(sendersInto(answer, shape.at, "node:sketch").filter((id) => id.startsWith("input:"))).toEqual(["input:pose", "input:character"]);
    expect(answer.nodes.some((node) => "template" in node)).toBe(false);
  });
});

describe("template tags are checked before the defaults are filled (design 6.7 step 2)", () => {
  /**
   * The verdict over the fixtures.
   * @param sent - The proposal.
   * @returns Its refusal id, or "ok".
   */
  function refusalOf(sent: Sent): string {
    const verdict = verdictFor(sent, undefined, FIXTURES);
    return verdict.ok ? "ok" : verdict.refusal;
  }

  /**
   * The one-node fixture's proposal with one node replaced.
   * @param at - The node's index.
   * @param node - The node in its place.
   * @returns The proposal.
   */
  function soloWith(at: number, node: SentNode): Sent {
    const sent = solo();
    return { ...sent, nodes: sent.nodes.map((n, i) => (i === at ? node : n)) };
  }

  it("refuses a template id the registry does not have", () => {
    const verdict = verdictFor(soloWith(1, { ...(solo().nodes[1] as SentNode), template: { id: "no-such" } }), undefined, FIXTURES);
    expect(verdict).toEqual({ ok: false, refusal: "template-unknown", reason: 'No template "no-such". Templates: fixture-sheet, fixture-solo, fixture-steps, fixture-shots.' });
  });

  it("refuses a key the template does not have", () => {
    expect(refusalOf(soloWith(1, { ...(solo().nodes[1] as SentNode), template: { id: "fixture-solo", key: "nope" } }))).toBe("template-key-unknown");
  });

  it("refuses an input the template does not have", () => {
    expect(refusalOf(soloWith(0, { role: "source", type: "image", name: "Reference", template: { id: "fixture-solo", input: "nope" } }))).toBe("template-key-unknown");
  });

  it("refuses an input tag on a node of another type than the input", () => {
    expect(refusalOf(soloWith(0, { role: "source", type: "video", name: "Reference", template: { id: "fixture-solo", input: "reference" } }))).toBe("template-key-kind");
  });

  it("refuses a key on a node of another role than the template's", () => {
    const shape = agentShape(SHEET);
    const at = shape.at.get("node:sketch") ?? -1;
    const nodes = shape.sent.nodes.map((node, i): SentNode => (i === at ? { role: "source", type: "image", name: "Sketch", template: { id: "fixture-sheet", key: "sketch" } } : node));
    expect(refusalOf({ ...shape.sent, nodes })).toBe("template-key-kind");
  });

  it("refuses a key on a node of another type than the template's", () => {
    const shape = agentShape(SHEET);
    const at = shape.at.get("node:sketch") ?? -1;
    const nodes = shape.sent.nodes.map((node, i) => (i === at ? ({ ...node, type: "video" as const }) : node));
    expect(refusalOf({ ...shape.sent, nodes })).toBe("template-key-kind");
  });

  it("accepts the input tag on the node given for that input", () => {
    expect(refusalOf(soloWith(0, { role: "source", type: "image", name: "Reference", template: { id: "fixture-solo", input: "reference" } }))).toBe("ok");
  });

  it("refuses a resource node that carries material of its own", () => {
    const picture = "https://resource.example/image/2026-10-09/1_pic.png";
    const shape = agentShape(SHEET);
    const at = shape.at.get("node:palette") ?? -1;
    const nodes = shape.sent.nodes.map((node, i) => (i === at ? ({ ...node, material: picture }) : node));
    const media = { coverUrl: null, width: 640, height: 480, duration: null, mimeType: "image/png", size: 100 };
    const verdict = verdictFor({ ...shape.sent, nodes }, new Map([[picture, { kind: "image", media }]]), FIXTURES);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "ok" : verdict.refusal).not.toBe("template-unknown");
  });

  it("asks nothing of an upstream node and resource left behind once the agent changes the anchor's model and unwires them", () => {
    const shape = withoutEdge(agentShape(SHEET), "node:sketch", "node:sheet", SKETCH_FIRST);
    const anchor = shape.at.get("node:sheet") ?? -1;
    const nodes = shape.sent.nodes.map((node, i) => (i === anchor ? ({ ...node, model: "gpt-image-2.5-sunburst-edit" }) : node));
    const answer = placedAnswer(answerFor({ ...shape.sent, nodes }, undefined, FIXTURES));
    expect(answer.nodes[shape.at.get("node:sketch") ?? -1]?.templateNode).toBeUndefined();
    expect(answer.nodes[shape.at.get("node:palette") ?? -1]?.templateNode).toBeUndefined();
    expect(answer.nodes[shape.at.get("node:palette") ?? -1]?.resource).toBe("templates/fixture-sheet/palette.png");
  });

  it("refuses a node taking two inputs of one type whose pool holds one untagged node of that type", () => {
    expect(refusalOf(withoutNode(agentShape(SHEET), "input:back", "Put the back view in Back view first").sent)).toBe("template-input-missing");
  });

  it("refuses a loose resource with no edge as unused material", () => {
    const sent: Sent = {
      nodes: [
        { role: "source", type: "image", name: "Palette", template: { id: "fixture-sheet", key: "palette" } },
        { role: "generate", type: "image", name: "Gen", mode: "i2i", model: "nano-banana-pro-edit-ultra", prompt: [{ text: "Make it." }] },
      ],
      edges: [],
      rationale: "r",
      groupName: "Group",
    };
    expect(refusalOf(sent)).toBe("material-unused");
  });

  it("refuses a template's resource with no edge as a missing template edge", () => {
    expect(refusalOf(withoutEdge(agentShape(SHEET), "node:palette", "node:sketch").sent)).toBe("template-edge-missing");
  });
});

describe("the consistency check (design 6.7 step 3)", () => {
  it("asks no template edge into a node whose model the agent changed", () => {
    const shape = withoutNode(agentShape(SHEET), "node:palette");
    const sketch = shape.at.get("node:sketch") ?? -1;
    const nodes = shape.sent.nodes.map((node, i) => (i === sketch ? ({ ...node, model: "gpt-image-2.5-sunburst-edit" }) : node));
    expect(verdictFor({ ...shape.sent, nodes }, undefined, FIXTURES)).toEqual({ ok: true });
  });

  it("keeps two instances apart: the second's missing key is not filled by the first's node", () => {
    let second = withoutNode(agentShape(SHEET), "node:sketch", SKETCH_FIRST);
    second = withoutNode(second, "node:palette");
    second = withoutNode(second, "input:pose");
    const verdict = verdictFor(joined(agentShape(SHEET).sent, second.sent), undefined, FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-key-missing", reason: expect.stringContaining('"sketch"') });
  });

  it("is asked after the structural edge checks", () => {
    const sent: Sent = { nodes: [stepped(), solo().nodes[1] as SentNode], edges: [{ fromIndex: 0, toIndex: 5 }], rationale: "r", groupName: "Group" };
    expect(verdictFor(sent, undefined, FIXTURES)).toMatchObject({ ok: false, refusal: "edge-outside" });
  });

  it("is asked before the generate node checks", () => {
    const anchor = { role: "generate", type: "image", name: "Watercolour", template: { id: "fixture-solo" }, prompt: [{ text: "Redraw " }, { ref: 3 }] } as SentNode;
    expect(verdictFor({ nodes: [anchor], edges: [], rationale: "r" }, undefined, FIXTURES)).toMatchObject({ ok: false, refusal: "template-input-missing" });
  });
});

describe("the consistency check, round-1 review (inner#1345)", () => {
  /**
   * The verdict over the fixtures.
   * @param sent - The proposal.
   * @returns Its refusal id, or "ok".
   */
  function refusalOf(sent: Sent, templates = FIXTURES): string {
    const verdict = verdictFor(sent, undefined, templates);
    return verdict.ok ? "ok" : verdict.refusal;
  }

  it("gives an input fed into two nodes its node before the inputs fed into one take it", () => {
    const shape = agentShape(SHEET);
    const character = shape.at.get("input:character") ?? -1;
    const sheet = shape.at.get("node:sheet") ?? -1;
    const edges = [...shape.sent.edges];
    const at = edges.findIndex((edge) => edge.fromIndex === character && edge.toIndex === sheet);
    const [moved] = edges.splice(at, 1);
    expect(refusalOf({ ...shape.sent, edges: [moved as Sent["edges"][number], ...edges] })).toBe("ok");
  });

  it("refuses a template edge sent into another place than the template's", () => {
    const shape = agentShape(SHEET);
    const sketch = shape.at.get("node:sketch") ?? -1;
    const sheet = shape.at.get("node:sheet") ?? -1;
    const edges = shape.sent.edges.map((edge) => (edge.fromIndex === sketch && edge.toIndex === sheet ? { ...edge, into: "pool" } : edge));
    const verdict = verdictFor({ ...shape.sent, edges }, undefined, FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-edge-into", reason: expect.stringContaining('"style_images"') });
  });

  // Look goes into First and into Final: each wiring leaves one of the two out.
  for (const [left, wired] of [
    ["into First", { fromIndex: 2, toIndex: 0, into: "pool" }],
    ["into Final", { fromIndex: 2, toIndex: 1, into: "pool" }],
  ] as const) {
  it(`refuses a node two template edges leave when the one ${left} is not wired`, () => {
    const fan: GenerationTemplate = {
      id: "fixture-fan",
      anchor: "final",
      nodes: [
        { key: "final", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: {} },
        { key: "first", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: {} },
        { key: "look", role: "source", type: "image", resource: "templates/fixture-fan/look.png" },
      ],
      edges: [
        { from: "look", to: "first", into: "pool" },
        { from: "look", to: "final", into: "pool" },
        { from: "first", to: "final", into: "pool" },
      ],
      inputs: [],
      steps: [],
      agentNote: "a fixture with one resource feeding two generations",
      goal: "character",
      triggers: { asks: ["a fixture"], offerWhen: ["a fixture is wanted"] },
    };
    const note = { slot: { kind: "note" as const, label: "Generate First first" } };
    const sent: Sent = {
      nodes: [
        { role: "generate", type: "image", name: "Final", template: { id: "fixture-fan" }, prompt: [note, { text: "Final of " }, { ref: 1 }, ...(wired.toIndex === 0 ? [{ text: " in " }, { ref: 2 }] : [])] },
        { role: "generate", type: "image", name: "First", template: { id: "fixture-fan", key: "first" }, prompt: [{ text: "A first take" }, ...(wired.toIndex === 1 ? [{ text: " in " }, { ref: 2 }] : [])] },
        { role: "source", type: "image", name: "Look", template: { id: "fixture-fan", key: "look" } },
      ],
      edges: [{ fromIndex: 1, toIndex: 0, into: "pool" }, wired],
      rationale: "r",
      groupName: "Fan",
    };
    const verdict = verdictFor(sent, undefined, [...FIXTURES, fan]);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-edge-missing", reason: expect.stringContaining('node 2 ("Look")') });
  });
  }

  it("says where a missing key goes: its role, type, the node it is wired into and how", () => {
    const shape = withoutNode(agentShape(SHEET), "node:sketch", SKETCH_FIRST);
    const verdict = verdictFor(withoutNode(shape, "node:palette").sent, undefined, FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-key-missing" });
    const reason = verdict.ok ? "" : verdict.reason;
    expect(reason).toContain('a generate image "sketch" node');
    expect(reason).toContain('"style_images"');
  });
});
