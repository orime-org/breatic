// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every refusal that tells the agent how a node goes into a generation reads
 * the one answer `entriesFor` gives, and that answer holds: a proposal built
 * the way it says passes the check for that node, for every model in the
 * catalog, every kind of node and whatever the node holds (inner#1315).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import {
  GENERATION_NODE_MODES,
  PANEL_EDITOR_PARAM,
  type CanvasProposal,
  type GenerationNodeType,
  type PromptSegment,
  type ProposalNode,
} from "@breatic/shared";

import { modelsForMode, waysIn, type ModelInfo } from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal, type MaterialFacts, type MaterialTable } from "../propose-canvas-action.js";
import { boxReason, entriesFor, type Entry, type Holding } from "../proposal-routing.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

const MEDIA = { coverUrl: null, width: 640, height: 480, duration: 3, mimeType: "application/octet-stream", size: 100 };

const ADDRESS: Record<string, string> = {
  image: "https://resource.example/image/2026-10-09/1_probe.png",
  video: "https://resource.example/video/2026-10-09/1_probe.mp4",
  audio: "https://resource.example/audio/2026-10-09/1_probe.mp3",
};

const MATERIALS: MaterialTable = new Map<string, MaterialFacts>(
  Object.entries(ADDRESS).map(([kind, url]) => [url, { kind: kind as MaterialFacts["kind"], media: MEDIA }]),
);

/** The note an empty or slotted probe gets. */
const NOTE: PromptSegment = { slot: { kind: "note", label: "Put the file in Probe and pick it" } };

/** One model in one mode, as a generation node can be set. */
interface Setting {
  nodeType: GenerationNodeType;
  mode: string;
  chosen: ModelInfo;
}

/**
 * Every model a generation node can be set to, outside the multi-shot mode
 * whose shots a probe has nothing to do with.
 * @returns Each setting.
 */
function settings(): Setting[] {
  return (Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]).flatMap((nodeType) =>
    GENERATION_NODE_MODES[nodeType].flatMap((mode) => {
      const reach = modelsForMode(nodeType, mode);
      if (!reach.available) return [];
      return reach.models.filter((chosen) => chosen.storyboard === undefined).map((chosen) => ({ nodeType, mode, chosen }));
    }),
  );
}

/**
 * The probe node, holding what it is asked to.
 * @param kind - Its kind.
 * @param holding - What it holds.
 * @returns The node.
 */
function probe(kind: string, holding: Holding): ProposalNode {
  if (holding === "words") return { role: "written", type: "text", name: "Probe", prompt: [{ text: "Words to use." }] };
  const type = kind as GenerationNodeType;
  return holding === "material" ? { role: "source", type, name: "Probe", material: ADDRESS[kind] } : { role: "source", type, name: "Probe" };
}

/**
 * A group of the probe and one generation, the probe going in by one entry.
 * @param setting - The generation's model.
 * @param node - The probe.
 * @param entry - The way it goes in, or none to leave it unwired.
 * @returns The proposal.
 */
function follow(setting: Setting, node: ProposalNode, entry: Entry | undefined): CanvasProposal {
  const { nodeType, mode, chosen } = setting;
  const prompt: PromptSegment[] = chosen.takesPrompt ? [{ text: "Make it. " }] : [];
  const empty = node.role !== "written" && node.material === undefined;
  if (entry?.by === "edge" && entry.way.mark === "ref") prompt.push({ ref: 0 });
  if (entry?.way.mark === "note" && entry.by !== "fills") prompt.push(NOTE);
  else if (entry?.way.mark === "ref" && empty) prompt.push(NOTE);
  const gen: ProposalNode = {
    role: "generate",
    type: nodeType,
    name: "Gen",
    mode,
    model: chosen.name,
    ...(prompt.length > 0 ? { prompt } : {}),
    ...(entry?.by === "fills" ? { fills: { [entry.way.into]: [0] } } : {}),
  };
  return {
    nodes: [node, gen],
    edges: entry?.by === "edge" ? [{ fromIndex: 0, toIndex: 1, into: entry.way.into }] : [],
    rationale: "A probe.",
    groupName: "Probe",
  };
}

const CASES: ReadonlyArray<{ kind: string; holding: Holding }> = [
  { kind: "image", holding: "material" },
  { kind: "image", holding: "empty" },
  { kind: "video", holding: "material" },
  { kind: "video", holding: "empty" },
  { kind: "audio", holding: "material" },
  { kind: "audio", holding: "empty" },
  { kind: "text", holding: "words" },
];

describe("every way entriesFor names is one the check takes", () => {
  it("passes the probe by each entry, for every model, kind and holding", () => {
    const refused: string[] = [];
    let followed = 0;
    for (const setting of settings()) {
      for (const { kind, holding } of CASES) {
        for (const entry of entriesFor(setting.chosen, kind, holding)) {
          followed += 1;
          const verdict = checkProposal(follow(setting, probe(kind, holding), entry), MATERIALS);
          if (!verdict.ok && verdict.reason.includes('"Probe"')) {
            refused.push(`${setting.chosen.name} ${setting.mode} ${kind}/${holding} ${entry.by} ${entry.way.into}: ${verdict.reason}`);
          }
        }
      }
    }
    expect(followed).toBeGreaterThan(100);
    expect(refused).toEqual([]);
  });

  it("names no entry where the model takes nothing of that kind, and the check agrees", () => {
    const missed: string[] = [];
    for (const setting of settings()) {
      for (const { kind, holding } of CASES) {
        if (entriesFor(setting.chosen, kind, holding).length > 0) continue;
        const node = probe(kind, holding);
        const tries: CanvasProposal[] = [
          follow(setting, node, { by: "edge", way: { into: "pool", room: 1, mark: "ref" } }),
          ...Object.keys(setting.chosen.params).map((into) => follow(setting, node, { by: "fills", way: { into, room: 1, mark: "note" } })),
        ];
        for (const proposal of tries) {
          if (checkProposal(proposal, MATERIALS).ok) missed.push(`${setting.chosen.name} ${setting.mode} ${kind}/${holding}: ${JSON.stringify(proposal.edges)} ${JSON.stringify(proposal.nodes[1]?.fills)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

/**
 * The first setting whose ways for a kind match.
 * @param kind - The kind of node.
 * @param test - What its ways for that kind must be.
 * @returns The setting.
 */
function settingWhere(kind: string, test: (setting: Setting) => boolean): Setting {
  const found = settings().find(test);
  if (found === undefined) throw new Error(`No model in the catalog has that shape for ${kind}`);
  return found;
}

/**
 * The ways one setting takes a kind, by mark.
 * @param setting - The setting.
 * @param kind - The kind.
 * @returns The marks in declaration order.
 */
function marks(setting: Setting, kind: string): string[] {
  return (waysIn(setting.chosen).get(kind as "image") ?? []).map((way) => way.mark);
}

describe("each refusal tells the agent a way that is there", () => {
  it("leaves a ref out, rather than asking for a pool, where the model has no pool for the node", () => {
    const setting = settingWhere("image", (s) => s.chosen.takesPrompt && !marks(s, "image").includes("ref"));
    const proposal = follow(setting, probe("image", "empty"), undefined);
    const gen = proposal.nodes[1] as ProposalNode;
    proposal.nodes[1] = { ...gen, prompt: [...(gen.prompt ?? []), NOTE, { ref: 0 }] };
    const verdict = checkProposal(proposal, MATERIALS);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("Leave the ref out") });
    expect(verdict.ok ? "" : verdict.reason).not.toContain('into: "pool"');
  });

  it("offers material a slot through fills, never by an edge, when its edge names no way", () => {
    const setting = settingWhere("image", (s) => marks(s, "image").includes("ref") && marks(s, "image").includes("note"));
    const slot = (waysIn(setting.chosen).get("image") ?? []).find((way) => way.mark === "note")?.into ?? "";
    const proposal = follow(setting, probe("image", "material"), undefined);
    proposal.edges = [{ fromIndex: 0, toIndex: 1 }];
    const verdict = checkProposal(proposal, MATERIALS);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(`through fills "${slot}"`) });
    expect(verdict.ok ? "" : verdict.reason).not.toContain(`into: "${slot}"`);
  });

  it("does not call a written text node empty when fills points at it", () => {
    const setting = settingWhere("image", (s) => s.chosen.takesPrompt && marks(s, "image").includes("note"));
    const slot = (waysIn(setting.chosen).get("image") ?? []).find((way) => way.mark === "note")?.into ?? "";
    const proposal = follow(setting, probe("text", "words"), undefined);
    proposal.nodes[1] = { ...(proposal.nodes[1] as ProposalNode), fills: { [slot]: [0] } };
    const verdict = checkProposal(proposal, MATERIALS);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('into: "pool"') });
    expect(verdict.ok ? "" : verdict.reason).not.toContain("empty");
  });

  it("places an empty node the canvas will not wire unwired with a note, from fills and from params", () => {
    const setting = settingWhere("video", (s) => s.nodeType === "audio" && marks(s, "video").includes("note"));
    const slot = (waysIn(setting.chosen).get("video") ?? []).find((way) => way.mark === "note")?.into ?? "";
    const viaFills = follow(setting, probe("video", "empty"), undefined);
    viaFills.nodes[1] = { ...(viaFills.nodes[1] as ProposalNode), fills: { [slot]: [0] } };
    const viaParams = follow(setting, probe("video", "empty"), undefined);
    viaParams.nodes[1] = { ...(viaParams.nodes[1] as ProposalNode), params: { [slot]: "x" } };
    for (const proposal of [viaFills, viaParams]) {
      const verdict = checkProposal(proposal, MATERIALS);
      expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(`unwired, with a note saying to pick it into "${slot}"`) });
      expect(verdict.ok ? "" : verdict.reason).not.toContain("by an edge");
    }
  });

  it("names the way a generation here takes unused material", () => {
    const setting = settingWhere("image", (s) => !marks(s, "image").includes("ref") && marks(s, "image").includes("note"));
    const slot = (waysIn(setting.chosen).get("image") ?? []).find((way) => way.mark === "note")?.into ?? "";
    const proposal = follow(setting, probe("image", "material"), undefined);
    const verdict = checkProposal(proposal, MATERIALS);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(`through fills "${slot}" on "Gen"`) });
    expect(verdict.ok ? "" : verdict.reason).not.toContain('into: "pool"');
  });

  it("tells a generation filling a slot from itself that it cannot, rather than how it goes into itself", () => {
    const setting = settingWhere("video", (s) => s.nodeType === "audio" && marks(s, "video").includes("note"));
    const slot = (waysIn(setting.chosen).get("video") ?? []).find((way) => way.mark === "note")?.into ?? "";
    const proposal = follow(setting, probe("video", "material"), undefined);
    proposal.nodes[1] = { ...(proposal.nodes[1] as ProposalNode), fills: { [slot]: [1] } };
    const verdict = checkProposal(proposal, MATERIALS);
    expect(verdict).toMatchObject({ ok: false, reason: `fills "${slot}" on "Gen" points at "Gen" itself, and a node cannot fill its own slot. Check the index the fill means.` });
  });

  it("sends words to the lyrics box only where the panel draws it", () => {
    const setting = settings().find((s) => s.chosen.params[PANEL_EDITOR_PARAM] !== undefined);
    if (setting === undefined) throw new Error("the catalog serves no song model");
    const lyrics = setting.chosen.params[PANEL_EDITOR_PARAM];
    if (lyrics === undefined) throw new Error("the song model declares no lyrics box");
    const hidden: ModelInfo = { ...setting.chosen, params: { ...setting.chosen.params, [PANEL_EDITOR_PARAM]: { ...lyrics, noControl: true } } };
    const gen: ProposalNode = { role: "generate", type: setting.nodeType, name: "Song", mode: setting.mode, model: setting.chosen.name };
    expect(boxReason(setting.chosen, gen, PANEL_EDITOR_PARAM)).toContain(`by an edge with into: "${PANEL_EDITOR_PARAM}"`);
    expect(boxReason(hidden, gen, PANEL_EDITOR_PARAM)).toBe(`The panel draws no box for "${PANEL_EDITOR_PARAM}" here, so nothing set for it reaches the model. Leave it out.`);
  });
});
