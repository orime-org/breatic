// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal carrying the reader's material (inner#1315): a source node that
 * lands holding a picture, video or sound from our storage, and the slots a
 * generation fills straight from such nodes through `fills`.
 *
 * The registration behind each address is read before the check runs and
 * handed in as a table, so these cases hold the rules without a database.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocales } from "@breatic/core";
import type { CanvasProposal, GenerationNodeType, ProposalNode } from "@breatic/shared";
import type { MaterialFacts, MaterialTable } from "../propose-canvas-action.js";

import { modelsForMode } from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

const materialFacts = vi.fn();
vi.mock("@domain/asset/material-facts.js", () => ({ materialFacts }));

const { answerFor, checkProposal, inputSchema, makeProposeCanvasAction } = await import("../propose-canvas-action.js");

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

const PORTRAIT = "https://resource.example/image/2026-10-08/1_portrait.png";
const VOICE = "https://resource.example/audio/2026-10-08/1_voice.mp3";
const CLIP = "https://resource.example/video/2026-10-08/1_clip.mp4";
const SAVED = "https://resource.example/url/2026-10-08/1_found.jpg";

const FACTS: ReadonlyMap<string, MaterialFacts> = new Map<string, MaterialFacts>([
  [PORTRAIT, { kind: "image", media: { coverUrl: null, width: 768, height: 1024, duration: null, mimeType: "image/png", size: 1000 } }],
  [VOICE, { kind: "audio", media: { coverUrl: null, width: null, height: null, duration: 4, mimeType: "audio/mpeg", size: 2000 } }],
  [CLIP, { kind: "video", media: { coverUrl: "https://resource.example/video/2026-10-08/1_clip_cover.png", width: 1280, height: 720, duration: 5, mimeType: "video/mp4", size: 3000 } }],
  [SAVED, { kind: "image", media: { coverUrl: null, width: 500, height: 375, duration: null, mimeType: "image/jpeg", size: 400 } }],
]);

/**
 * A source node holding material.
 * @param type - Its kind.
 * @param name - What the reader sees.
 * @param material - The address it holds.
 * @returns The node.
 */
function held(type: GenerationNodeType, name: string, material: string): ProposalNode {
  return { role: "source", type, name, material };
}

/**
 * Words for a generation, when its model draws a prompt box.
 * @param type - The node's kind.
 * @param mode - Its mode.
 * @param model - Its model.
 * @returns A prompt, or none for a model that draws no box.
 */
function wordsFor(type: GenerationNodeType, mode: string, model: string): Pick<ProposalNode, "prompt"> {
  const answer = modelsForMode(type, mode);
  const chosen = answer.available ? answer.models.find((m) => m.name === model) : undefined;
  return chosen?.takesPrompt === true ? { prompt: [{ text: "Speak warmly." }] } : {};
}

/**
 * A talking head whose portrait and voice slots are filled from material.
 * @param fills - Which slots to fill, by node index.
 * @returns The generation node.
 */
function talkingHead(fills: Record<string, number[]>): ProposalNode {
  return {
    role: "generate",
    type: "video",
    name: "Talking head",
    mode: "talking_head",
    model: "omnihuman-1.5",
    fills,
    ...wordsFor("video", "talking_head", "omnihuman-1.5"),
  };
}

/**
 * A group around some nodes.
 * @param nodes - The nodes.
 * @param edges - The wiring.
 * @returns The proposal.
 */
function group(nodes: ProposalNode[], edges: CanvasProposal["edges"] = []): CanvasProposal {
  return { nodes, edges, rationale: "r", groupName: "Clip" };
}

/**
 * The reason a proposal is refused.
 * @param proposal - The proposal.
 * @returns The reason.
 * @throws {Error} When it is not refused.
 */
function refusal(proposal: CanvasProposal): string {
  const verdict = checkProposal(proposal, FACTS);
  if (verdict.ok) throw new Error("expected a refusal");
  return verdict.reason;
}

describe("a talking head filled from the reader's uploads (A1)", () => {
  /**
   * The group, built once the catalog is loaded.
   * @returns The proposal.
   */
  const proposal = (): CanvasProposal =>
    group([held("image", "Portrait", PORTRAIT), held("audio", "Voice", VOICE), talkingHead({ image: [0], audio: [1] })]);

  it("stands with no note for the filled slots", () => {
    expect(checkProposal(proposal(), FACTS)).toEqual({ ok: true });
  });

  it("lands each material node with the numbers its registration holds", () => {
    const answer = answerFor(inputSchema.parse(proposal()), FACTS);
    if (!answer.placed) throw new Error(answer.reason);
    expect(answer.nodes[0]?.materialMedia).toEqual(FACTS.get(PORTRAIT)?.media);
    expect(answer.nodes[1]?.materialMedia).toEqual(FACTS.get(VOICE)?.media);
  });
});

describe("a slot a node of its kind cannot be wired into (A2)", () => {
  it("fills the video slot of a music model on an audio node", () => {
    const proposal = group([
      held("video", "Clip", CLIP),
      { role: "generate", type: "audio", name: "Score", mode: "a2m", model: "sonilo-video-to-music", fills: { video: [0] }, ...wordsFor("audio", "a2m", "sonilo-video-to-music") },
    ]);

    expect(checkProposal(proposal, FACTS)).toEqual({ ok: true });
  });
});

describe("material wired into the reference pool (A3)", () => {
  it("stands with the ref that @s it for the reader", () => {
    const proposal = group(
      [
        held("image", "Found photo", SAVED),
        {
          role: "generate",
          type: "image",
          name: "Watercolour",
          mode: "i2i",
          model: "nano-banana-pro-edit-ultra",
          prompt: [{ text: "Repaint " }, { ref: 0 }, { text: " as a watercolour." }],
        },
      ],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(checkProposal(proposal, FACTS)).toEqual({ ok: true });
  });
});

describe("the address is ours (A5)", () => {
  it("refuses an address outside our storage, pointing at save_image", () => {
    const reason = refusal(group([held("image", "Web photo", "https://elsewhere.example/a.jpg"), talkingHead({ image: [0] })]));

    expect(reason).toContain("not in our storage");
    expect(reason).toContain("save_image");
  });

  it("refuses an address in our storage that does not exist, asking for it to be copied again", () => {
    const typo = "https://resource.example/image/2026-10-08/1_portrait-typo.png";
    const materials: MaterialTable = new Map<string, MaterialFacts | "missing">([...FACTS, [typo, "missing"]]);
    const verdict = checkProposal(group([held("image", "Portrait", typo), talkingHead({ image: [0] })]), materials);
    if (verdict.ok) throw new Error("expected a refusal");

    expect(verdict.reason).toContain("does not exist");
    expect(verdict.reason).toContain("exactly");
    expect(verdict.reason).not.toContain("first");
  });

  it("refuses material of another kind than its node", () => {
    expect(refusal(group([held("image", "Portrait", VOICE), talkingHead({ image: [0] })]))).toMatch(/audio/);
  });

  it("refuses material on a node that is not a source", () => {
    const node: ProposalNode = { ...talkingHead({}), material: PORTRAIT };
    expect(refusal(group([node]))).toMatch(/source/);
  });
});

describe("fills (A6 and the four rules of round two)", () => {
  it("refuses fills on a node that does not generate", () => {
    const node: ProposalNode = { ...held("image", "Portrait", PORTRAIT), fills: { image: [0] } };
    expect(refusal(group([node, talkingHead({ image: [0] })]))).toMatch(/takes no mode, model, parameters, fills/);
  });

  it("refuses a slot the model does not have", () => {
    expect(refusal(group([held("image", "Portrait", PORTRAIT), talkingHead({ first_frame: [0] })]))).toMatch(/first_frame/);
  });

  it("refuses filling the pool, which is wired", () => {
    const proposal = group([
      held("image", "Photo", PORTRAIT),
      { role: "generate", type: "image", name: "Edit", mode: "i2i", model: "nano-banana-pro-edit-ultra", fills: { images: [0] }, prompt: [{ text: "Edit it." }] },
    ]);
    expect(refusal(proposal)).toMatch(/pool/);
  });

  it("refuses an index pointing at an empty node", () => {
    const empty: ProposalNode = { role: "source", type: "image", name: "Portrait" };
    expect(refusal(group([empty, talkingHead({ image: [0] })]))).toMatch(/empty/);
  });

  it("refuses material of a kind the slot does not take", () => {
    expect(refusal(group([held("audio", "Voice", VOICE), talkingHead({ image: [0] })]))).toMatch(/image/);
  });

  it("refuses the same index twice", () => {
    const proposal = group([
      held("image", "Style", PORTRAIT),
      { role: "generate", type: "image", name: "Edit", mode: "i2i", model: "nano-banana-pro-edit-ultra", fills: { style_images: [0, 0] }, prompt: [{ text: "Edit it." }] },
    ]);
    expect(refusal(proposal)).toMatch(/same material twice/);
  });

  it("refuses the same material twice in one slot", () => {
    const proposal = group([
      held("image", "Style A", PORTRAIT),
      held("image", "Style B", PORTRAIT),
      { role: "generate", type: "image", name: "Edit", mode: "i2i", model: "nano-banana-pro-edit-ultra", fills: { style_images: [0, 1] }, prompt: [{ text: "Edit it." }] },
    ]);
    expect(refusal(proposal)).toMatch(/same/);
  });

  it("refuses more material than the slot holds", () => {
    const proposal = group([
      held("image", "Portrait A", PORTRAIT),
      held("image", "Portrait B", SAVED),
      talkingHead({ image: [0, 1] }),
    ]);
    expect(refusal(proposal)).toMatch(/takes 1/);
  });

  it("counts an edge into the same slot against its room", () => {
    const empty: ProposalNode = { role: "source", type: "image", name: "Another portrait" };
    const head = talkingHead({ image: [0] });
    const proposal = group(
      [held("image", "Portrait", PORTRAIT), empty, { ...head, prompt: [...(head.prompt ?? []), { slot: { kind: "note", label: "Pick the other portrait" } }] }],
      [{ fromIndex: 1, toIndex: 2, into: "image" }],
    );
    expect(refusal(proposal)).toMatch(/takes 1/);
  });

  it("refuses material wired into a slot, pointing at fills", () => {
    const head = talkingHead({});
    const proposal = group(
      [held("image", "Portrait", PORTRAIT), { ...head, prompt: [...(head.prompt ?? []), { slot: { kind: "note", label: "Pick the portrait" } }] }],
      [{ fromIndex: 0, toIndex: 1, into: "image" }],
    );
    expect(refusal(proposal)).toMatch(/fills/);
  });

  it("refuses material nothing uses", () => {
    expect(refusal(group([held("image", "Portrait", PORTRAIT), talkingHead({})]))).toMatch(/fills/);
  });
});

describe("what the model may send", () => {
  it("takes material on a node and fills on a generation", () => {
    const sent = {
      nodes: [
        { role: "source", type: "image", name: "Portrait", material: PORTRAIT },
        { role: "generate", type: "video", name: "Talk", mode: "talking_head", model: "omnihuman-1.5", fills: { image: [0] } },
      ],
      edges: [],
      rationale: "r",
      groupName: "g",
    };
    expect(inputSchema.safeParse(sent).success).toBe(true);
  });

  it("lists fills last among a node's fields, where the default model writes it", () => {
    // Listed before mode and model, the default model never wrote it in a real
    // run, even when told to copy an input holding it (inner#1315).
    const node = inputSchema.shape.nodes.element;
    expect(Object.keys(node.shape).at(-1)).toBe("fills");
  });

  it("refuses the media numbers, which the check writes", () => {
    const sent = {
      nodes: [{ role: "source", type: "image", name: "Portrait", material: PORTRAIT, materialMedia: { width: 1 } }],
      edges: [],
      rationale: "r",
    };
    expect(inputSchema.safeParse(sent).success).toBe(false);
  });
});

describe("the places a group's source nodes can go", () => {
  it("refuses more empty nodes than the panels hold", () => {
    const empty = (name: string): ProposalNode => ({ role: "source", type: "image", name });
    const head = talkingHead({});
    const notes = [{ slot: { kind: "note" as const, label: "Pick a portrait" } }, { slot: { kind: "note" as const, label: "Pick the other" } }];
    expect(refusal(group([empty("A"), empty("B"), { ...head, prompt: [...(head.prompt ?? []), ...notes] }]))).toMatch(/hold 1 at a time/);
  });

  it("counts material filling a slot against the same places", () => {
    const empty: ProposalNode = { role: "source", type: "image", name: "Another portrait" };
    const head = talkingHead({ image: [0] });
    const proposal = group([
      held("image", "Portrait", PORTRAIT),
      empty,
      { ...head, prompt: [...(head.prompt ?? []), { slot: { kind: "note", label: "Pick the other portrait" } }] },
    ]);
    expect(refusal(proposal)).toMatch(/hold 1 at a time/);
  });
});

describe("the tool reads the registration for the studio it runs in", () => {
  it("asks for each material address and lands the answer", async () => {
    materialFacts.mockResolvedValue(new Map([[PORTRAIT, FACTS.get(PORTRAIT)], [VOICE, FACTS.get(VOICE)]]));
    const proposal = group([held("image", "Portrait", PORTRAIT), held("audio", "Voice", VOICE), talkingHead({ image: [0], audio: [1] })]);
    const execute = makeProposeCanvasAction().execute;
    if (!execute) throw new Error("no execute");

    const answer = await execute(inputSchema.parse(proposal), { toolCallId: "t", messages: [], context: { studioId: "s1" } });

    expect(materialFacts).toHaveBeenCalledWith("s1", [PORTRAIT, VOICE]);
    expect(answer).toMatchObject({ placed: true });
  });

  it("reads nothing for a proposal with no material", async () => {
    materialFacts.mockClear();
    const proposal = group([{ role: "generate", type: "image", name: "Cat", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "A cat." }] }]);
    const execute = makeProposeCanvasAction().execute;
    if (!execute) throw new Error("no execute");

    await execute(inputSchema.parse(proposal), { toolCallId: "t", messages: [] } as never);

    expect(materialFacts).not.toHaveBeenCalled();
  });
});

describe("a ref to material a slot takes through fills (inner#1315)", () => {
  it("is told the node already fills the slot and takes no ref, never to wire it into the pool", () => {
    const clip: ProposalNode = {
      role: "generate",
      type: "video",
      name: "Clip",
      mode: "i2v",
      model: "kling-video-o3-4k-image-to-video",
      fills: { image: [0] },
      prompt: [{ text: "Animate " }, { ref: 0 }],
    };
    const reason = refusal(group([held("image", "Portrait", PORTRAIT), clip]));

    expect(reason).toMatch(/"Portrait".*fills.*leave the ref out/s);
    expect(reason).not.toContain('into: "pool"');
  });
});
