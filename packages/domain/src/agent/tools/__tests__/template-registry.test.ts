// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every generation template, applied from either entry, makes a proposal the
 * check takes (inner#1345 design 6.9, domain side): the panel's expansion goes
 * straight through the proposal check in every locale, and the proposal the
 * agent would send goes through `answerFor`. The two shapes number their
 * nodes differently; read by identity they wire, @ and guide alike.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import {
  expandTemplate,
  GENERATION_TEMPLATES,
  proposalMarkSegments,
  setLocale,
  t,
  templateSkeleton,
  type CanvasProposal,
  type GenerationTemplate,
  type ProposalNode,
} from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor, checkProposal, type MaterialFacts, type MaterialTable } from "../propose-canvas-action.js";

import {
  agentShape,
  DOWNSTREAM,
  FIXTURE_LOCALES,
  FIXTURES,
  identityOf,
  loadFixtureLocales,
  PLACED_FIXTURES,
  SHEET,
  SLOTTED,
  SOLO,
  STANDALONE,
  STEPPED,
} from "./template-fixtures.js";

/** The five interface languages every template has words in. */
const LOCALES = ["en", "ja", "ko", "zh-CN", "zh-TW"];

beforeEach(() => {
  loadFixtureLocales();
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/** A proposal read by identity: its edges, each generate node's refs and fills, each node's template tag, and its guide nodes. */
interface Structure {
  edges: string[];
  refs: Record<string, string[]>;
  fills: Record<string, Record<string, string[]>>;
  tags: Record<string, unknown>;
  guides: { name: string; prompt: unknown; anchor: string }[];
  /** Who says each line, on a node sending a dialogue as lines (inner#1825 design 8.5). */
  lines: Record<string, number[]>;
}

/**
 * A proposal read by identity.
 * @param proposal - The proposal.
 * @param identity - Index to identity, the guide nodes left out.
 * @returns Its structure.
 */
function structureOf(proposal: Pick<CanvasProposal, "nodes" | "edges">, identity: ReadonlyMap<number, string>): Structure {
  const who = (index: number): string => identity.get(index) ?? (proposal.nodes[index]?.templateNode?.key === "guide" ? "guide" : `?${String(index)}`);
  return {
    edges: proposal.edges.map((edge) => `${who(edge.fromIndex)} > ${who(edge.toIndex)} : ${edge.into ?? ""}`).sort(),
    refs: Object.fromEntries(
      proposal.nodes.flatMap((node, index) =>
        node.role === "generate"
          ? [[who(index), proposalMarkSegments(node).flatMap((segment) => (segment.ref === undefined ? [] : [who(segment.ref)]))]]
          : [],
      ),
    ),
    fills: Object.fromEntries(
      proposal.nodes.flatMap((node, index) =>
        node.fills === undefined ? [] : [[who(index), Object.fromEntries(Object.entries(node.fills).map(([param, from]) => [param, from.map(who)]))]],
      ),
    ),
    // A tag's anchor is an index, read by identity too (inner#1825 design 4.2).
    tags: Object.fromEntries(
      proposal.nodes.flatMap((node, index) => {
        const tag = node.templateNode;
        if (tag === undefined || tag.key === "guide") return [];
        return [[who(index), tag.anchor === undefined ? tag : { ...tag, anchor: who(tag.anchor) }]];
      }),
    ),
    lines: Object.fromEntries(
      proposal.nodes.flatMap((node, index) => {
        const lines = (node as ProposalNode & { lines?: Array<{ speaker: number }> }).lines;
        return lines === undefined ? [] : [[who(index), lines.map((line) => line.speaker)]];
      }),
    ),
    guides: proposal.nodes.flatMap((node) =>
      node.templateNode?.key === "guide" ? [{ name: node.name, prompt: node.prompt, anchor: who(node.templateNode.anchor ?? -1) }] : [],
    ),
  };
}

/**
 * The panel's expansion of a template onto an anchor at index 0, with nothing
 * on the canvas yet (design 6.9 "panel shape"), or, for each input named in
 * `material`, the user's own node holding that address already connected to
 * the anchor (inner#1825 design 4.1, "panel" row).
 * @param template - The template.
 * @param material - Input key to the address the user's node holds.
 * @returns The proposal, and the identity of each index but the guide's.
 */
function panelShape(template: GenerationTemplate, material: ReadonlyMap<string, string> = new Map()): { proposal: CanvasProposal; identity: Map<number, string> } {
  const skeleton = templateSkeleton(template);
  const given = skeleton.inputs.filter((input) => material.has(input.key));
  const own = given.map((input, n): ProposalNode => ({ role: "source", type: input.type, name: `My ${input.key} ${String(n + 1)}`, material: material.get(input.key) }));
  const inputs = new Map(given.map((input, n) => [input.key, new Map(input.feeds.map((fed) => [fed, n + 1]))]));
  const wired = given.map((_, n) => ({ fromIndex: n + 1, toIndex: 0 }));
  const expansion = expandTemplate(template, { anchorAt: 0, base: 1 + own.length, inputs, wired, reuse: new Map(), guide: true });
  const anchor = expansion.rewritten.get(0);
  if (anchor === undefined) throw new Error("the expansion rewrites no anchor at 0");
  const nodes = [anchor, ...own, ...expansion.appended];
  const identity = new Map<number, string>([[0, `node:${skeleton.anchor}`]]);
  given.forEach((input, n) => identity.set(n + 1, `input:${input.key}`));
  for (const [index, node] of nodes.entries()) {
    const tag = node.templateNode;
    if (index <= own.length || tag?.key === "guide") continue;
    identity.set(index, tag === undefined ? `?${node.name}` : `${tag.input ? "input" : "node"}:${tag.key}`);
  }
  return { proposal: { nodes, edges: [...expansion.edges], rationale: "Start from the template.", groupName: "Template test" }, identity };
}

/** One address in the user's storage for each kind of material. */
const ADDRESS: Record<string, string> = {
  image: "https://resource.example/image/2026-11-10/1_mood.png",
  video: "https://resource.example/video/2026-11-10/1_clip.mp4",
  audio: "https://resource.example/audio/2026-11-10/1_song.mp3",
};

/**
 * The registration behind each address the shapes name.
 * @param addresses - The addresses.
 * @returns The table.
 */
function materialsOf(addresses: Iterable<string>): MaterialTable {
  return new Map<string, MaterialFacts>(
    [...addresses].map((url) => {
      const kind = (Object.entries(ADDRESS).find(([, one]) => one === url)?.[0] ?? "image") as MaterialFacts["kind"];
      return [url, { kind, media: { coverUrl: null, width: kind === "audio" ? null : 1280, height: kind === "audio" ? null : 720, duration: kind === "image" ? null : 30, mimeType: "application/octet-stream", size: 1000 } }];
    }),
  );
}

/**
 * Both shapes of one template in one locale: each passes, and they agree by identity.
 * @param template - The template.
 * @param registry - The registry the agent's proposal is judged against, or the real one.
 * @param material - Input key to the address its node already holds, in both shapes.
 */
function bothShapesAgree(template: GenerationTemplate, registry?: readonly GenerationTemplate[], material: ReadonlyMap<string, string> = new Map()): void {
  const panel = panelShape(template, material);
  const materials = materialsOf(material.values());
  expect(checkProposal(panel.proposal, materials)).toEqual({ ok: true });
  const agent = agentShape(template, { material });
  const answer = answerFor(agent.sent, materials, registry);
  expect(answer).toMatchObject({ placed: true });
  if (!answer.placed) return;
  // The user's own material node was on the canvas before the panel applied,
  // so the panel does not tag it; the agent's landing tags the material input
  // node it sends with its input and anchor (template-proposals pins that).
  // Every other part, and every other node's tag, still agrees.
  const onCanvas = new Set([...material.keys()].map((key) => `input:${key}`));
  /**
   * A structure with the tags of the nodes already on the canvas left out.
   * @param structure - The structure.
   * @returns It, without those tags.
   */
  const withoutCanvasTags = (structure: Structure): Structure => ({
    ...structure,
    tags: Object.fromEntries(Object.entries(structure.tags).filter(([who]) => !onCanvas.has(who))),
  });
  expect(withoutCanvasTags(structureOf(answer, identityOf(agent.at)))).toEqual(withoutCanvasTags(structureOf(panel.proposal, panel.identity)));
}

describe("every registered template passes from both entries", () => {
  for (const template of GENERATION_TEMPLATES) {
    for (const locale of LOCALES) {
      it(`${template.id} in ${locale}: the panel's expansion passes the check, the agent's proposal is placed, and the two agree`, () => {
        setLocale(locale);
        bothShapesAgree(template);
      });
    }
  }
});

describe("the multi-node fixture passes from both entries (design 6.9)", () => {
  for (const template of [SHEET, SOLO, STEPPED]) {
    for (const locale of FIXTURE_LOCALES) {
      it(`${template.id} in ${locale}: the panel's expansion passes the check, the agent's proposal is placed, and the two agree`, () => {
        setLocale(locale);
        bothShapesAgree(template, FIXTURES);
      });
    }
  }

  // inner#1825 design 4.1 and 4.2: an input into a slot, a node downstream of
  // the anchor, a node beside it no template edge touches.
  for (const template of [SLOTTED, DOWNSTREAM, STANDALONE]) {
    for (const locale of FIXTURE_LOCALES) {
      it(`${template.id} in ${locale}: the panel's expansion passes the check, the agent's proposal is placed, and the two agree`, () => {
        setLocale(locale);
        bothShapesAgree(template, PLACED_FIXTURES);
      });
    }
  }

  for (const locale of FIXTURE_LOCALES) {
    it(`fixture-slotted in ${locale}: a song the user already has goes into the audio slot through fills in both shapes, with no edge and no note`, () => {
      setLocale(locale);
      bothShapesAgree(SLOTTED, PLACED_FIXTURES, new Map([["song", ADDRESS.audio as string]]));
    });
  }

  it("guides the sheet fixture with its two steps from both entries", () => {
    setLocale("en");
    const panel = panelShape(SHEET);
    const guides = structureOf(panel.proposal, panel.identity).guides;
    expect(guides).toHaveLength(1);
    expect(guides[0]?.name).toBe("Fixture sheet");
    expect(guides[0]?.anchor).toBe("node:sheet");
    const words = JSON.stringify(guides[0]?.prompt);
    expect(words).toContain("Once Fixture sheet has generated, right-click it and pick Tools, then Grid split");
    expect(words).toContain("Drag the panel you like into a new node");
  });
});

/**
 * A registered template by id.
 * @param id - The id.
 * @returns The template.
 */
function registered(id: string): GenerationTemplate {
  const template = GENERATION_TEMPLATES.find((one) => one.id === id);
  if (template === undefined) throw new Error(`template "${id}" is not registered`);
  return template;
}

/**
 * The note labels on top of a node's prompt.
 * @param node - The node.
 * @returns Its notes.
 */
function notesOf(node: ProposalNode | undefined): string[] {
  return (node?.prompt ?? []).flatMap((segment) => (segment.slot?.kind === "note" ? [segment.slot.label] : []));
}

/** The sound templates whose one input goes into a slot of the anchor's model (inner#1825 design 4.1, section 9). */
const SLOT_INPUTS = [
  ["song-cover", "song", "audio"],
  ["voice-clone-line", "sample", "audio"],
  ["score-for-my-video", "video", "video"],
  ["music-mood-from-image", "image", "image"],
] as const;

describe("an input wired into a slot (inner#1825 design 4.1)", () => {
  for (const [id, input, into] of SLOT_INPUTS) {
    for (const locale of LOCALES) {
      it(`${id} in ${locale}: an empty ${input} node is wired into "${into}" with its note, from both entries`, () => {
        setLocale(locale);
        const template = registered(id);
        expect(template.inputs.find((one) => one.key === input)?.into).toBe(into);
        const panel = panelShape(template);
        const structure = structureOf(panel.proposal, panel.identity);
        expect(structure.edges).toContain(`input:${input} > node:${template.anchor} : ${into}`);
        expect(notesOf(panel.proposal.nodes[0])).toEqual([t(`canvas.template.${id}.input.${input}.note`)]);
        bothShapesAgree(template);
      });

      it(`${id} in ${locale}: a ${input} node already holding material goes into "${into}" through fills, with no edge and no note, from both entries`, () => {
        setLocale(locale);
        const template = registered(id);
        const material = new Map([[input, ADDRESS[into] as string]]);
        const panel = panelShape(template, material);
        expect(panel.proposal.nodes[0]?.fills).toEqual({ [into]: [1] });
        expect(notesOf(panel.proposal.nodes[0])).toEqual([]);
        expect(panel.proposal.edges.filter((edge) => edge.fromIndex === 1)).toEqual([]);
        // No new node is placed for the input.
        expect(panel.proposal.nodes.filter((node) => node.templateNode?.input === true)).toEqual([]);
        bothShapesAgree(template, undefined, material);
      });
    }
  }
});

describe("a node downstream of the anchor and a node beside it (inner#1825 design 4.2)", () => {
  for (const locale of LOCALES) {
    it(`clip-ambience-foley in ${locale}: the foley node is wired from the anchor's video into its "video" slot, from both entries`, () => {
      setLocale(locale);
      const template = registered("clip-ambience-foley");
      const downstream = template.edges.filter((edge) => edge.from === template.anchor);
      expect(downstream.map((edge) => edge.into)).toEqual(["video"]);
      const panel = panelShape(template);
      expect(structureOf(panel.proposal, panel.identity).edges).toContain(`node:${template.anchor} > node:${downstream[0]?.to ?? ""} : video`);
      bothShapesAgree(template);
    });

    it(`section-mapped-score in ${locale}: the three sections no template edge touches are placed tagged with their anchor, from both entries`, () => {
      setLocale(locale);
      const template = registered("section-mapped-score");
      expect(template.edges).toEqual([]);
      const standalone = template.nodes.filter((node) => node.key !== template.anchor).map((node) => node.key);
      expect(standalone).toHaveLength(3);
      const panel = panelShape(template);
      for (const key of standalone) {
        const node = panel.proposal.nodes.find((one) => one.templateNode?.key === key);
        expect(node?.templateNode, key).toEqual({ template: template.id, key, anchor: 0 });
      }
      bothShapesAgree(template);
      const agent = agentShape(template);
      const answer = answerFor(agent.sent);
      if (!answer.placed) return;
      const anchor = agent.at.get(`node:${template.anchor}`);
      for (const key of standalone) {
        expect(answer.nodes[agent.at.get(`node:${key}`) ?? -1]?.templateNode, key).toEqual({ template: template.id, key, anchor });
      }
    });
  }
});
