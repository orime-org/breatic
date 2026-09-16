// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a proposal has to hold together before it reaches a reader (#229).
 *
 * The tool hands back what the model sent, so the only thing standing between
 * a careless proposal and a card the reader presses is this check. Three
 * things decide it, and all three are read off the catalog rather than
 * written here: whether the mode needs source material, which models that
 * mode can reach, and which parameters the chosen model declares. A proposal
 * that names a mode needing a source has to arrive with the empty node to put
 * it in, the edge that feeds it in, and a place in the prompt saying what
 * goes there -- miss any of the three and the reader is handed a group that
 * cannot generate.
 *
 * Every fixture below is derived from the live catalog. A model name written
 * here would make the test pass on the catalog of the day it was written.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  GENERATION_NODE_MODES,
  type CanvasProposal,
  type GenerationNodeType,
} from "@breatic/shared";

import { entriesForNode, modelsForMode } from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal } from "../propose-canvas-action.js";

/** A node type and one of its modes, with a model that mode can reach. */
interface Reachable {
  nodeType: GenerationNodeType;
  mode: string;
  model: string;
}

/**
 * Find a mode of some generation node whose need for source material matches.
 *
 * Picking rather than naming is what keeps this file free of model names: the
 * catalog decides which modes need a source, so the fixtures follow it.
 * @param wantsSource - True to find a mode that needs source material.
 * @returns The first match.
 * @throws {Error} When the catalog offers no such mode.
 */
function findMode(wantsSource: boolean): Reachable {
  for (const nodeType of Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]) {
    const entries = entriesForNode(nodeType);
    for (const mode of GENERATION_NODE_MODES[nodeType]) {
      const needsSource = entries.some((e) => (e.sourcesByMode[mode] ?? []).length > 0);
      if (needsSource !== wantsSource) continue;
      const answer = modelsForMode(nodeType, mode);
      if (!answer.available || answer.models.length === 0) continue;
      const first = answer.models[0];
      if (first) return { nodeType, mode, model: first.name };
    }
  }
  throw new Error(
    `the catalog offers no reachable mode that ${wantsSource ? "needs" : "needs no"} source material`,
  );
}

/**
 * A proposal for one generation node, with no source node and no edge.
 * @param at - The node type, mode and model to propose.
 * @returns The proposal.
 * @throws {never} Never.
 */
function loneGenerateNode(at: Reachable): CanvasProposal {
  return {
    nodes: [
      {
        role: "generate",
        type: at.nodeType,
        name: "Result",
        mode: at.mode,
        model: at.model,
        params: {},
        prompt: [{ text: "a still life on a white ground" }],
      },
    ],
    edges: [],
    modelNote: "",
    rationale: "",
  };
}

/**
 * The same proposal with the empty node, the edge and the asset slot added.
 * @param at - The node type, mode and model to propose.
 * @returns The proposal.
 * @throws {never} Never.
 */
function pairedWithSource(at: Reachable): CanvasProposal {
  return {
    nodes: [
      { role: "source", type: at.nodeType, name: "Your product photo" },
      {
        role: "generate",
        type: at.nodeType,
        name: "Result",
        mode: at.mode,
        model: at.model,
        params: {},
        prompt: [
          { text: "white ground, " },
          { slot: { kind: "asset", label: "your product photo", note: "Put it in the node on the left" } },
          { text: " centred" },
        ],
      },
    ],
    edges: [{ fromIndex: 0, toIndex: 1 }],
    modelNote: "",
    rationale: "",
  };
}

beforeEach(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("a mode that needs source material", () => {
  it("is refused when the proposal carries no node to put it in", () => {
    const at = findMode(true);
    // The slot saying what goes there is left in place, so the only thing
    // left to refuse this is the missing node and the missing edge.
    const alone = pairedWithSource(at);
    alone.nodes = alone.nodes.slice(1);
    alone.edges = [];

    const verdict = checkProposal(alone);

    expect(verdict.ok).toBe(false);
  });

  it("is refused when nothing in the prompt says what goes there", () => {
    const at = findMode(true);
    const stripped = pairedWithSource(at);
    stripped.nodes[1]!.prompt = [{ text: "white ground, centred" }];

    const verdict = checkProposal(stripped);

    expect(verdict.ok).toBe(false);
  });

  it("stands when the empty node, the edge and the slot are all there", () => {
    const at = findMode(true);

    expect(checkProposal(pairedWithSource(at))).toEqual({ ok: true });
  });
});

describe("a mode that needs nothing of the reader", () => {
  it("stands as one node with no edges", () => {
    const at = findMode(false);
    expect(checkProposal(loneGenerateNode(at))).toEqual({ ok: true });
  });
});

describe("wiring that could not be placed", () => {
  it("refuses an edge pointing outside the group", () => {
    const at = findMode(false);
    const wrong = loneGenerateNode(at);
    wrong.edges = [{ fromIndex: 0, toIndex: 7 }];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses an edge looping a node onto itself", () => {
    const at = findMode(false);
    const wrong = loneGenerateNode(at);
    wrong.edges = [{ fromIndex: 0, toIndex: 0 }];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a group with nothing in it that generates", () => {
    const at = findMode(true);
    const wrong = pairedWithSource(at);
    wrong.nodes = wrong.nodes.slice(0, 1);
    wrong.edges = [];

    expect(checkProposal(wrong).ok).toBe(false);
  });
});

describe("what the catalog does not offer", () => {
  it("refuses a mode the proposed node does not have", () => {
    const at = findMode(false);
    const wrong = loneGenerateNode(at);
    wrong.nodes[0]!.mode = "a_mode_no_node_offers";

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a model that mode cannot reach", () => {
    const at = findMode(false);
    const wrong = loneGenerateNode(at);
    wrong.nodes[0]!.model = "a-model-the-catalog-never-had";

    expect(checkProposal(wrong).ok).toBe(false);
  });
});
