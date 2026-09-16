// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a proposal has to hold together before it reaches a reader (#229).
 *
 * The tool hands back what the model sent, so the only thing standing between
 * a careless proposal and a card the reader presses is this check. Everything
 * it applies is read off the catalog rather than written here: whether the
 * mode needs source material, how that material reaches the generation, which
 * models the mode can reach, what each model declares its parameters to be,
 * and whether it is driven by a prompt at all.
 *
 * How MANY pieces of material a mode takes is nowhere in the catalog -- the
 * table naming them speaks in types, and one type covers a mode wanting two
 * pictures. So the count is the proposal's own to make: every empty node it
 * places is marked once in the prompt, and every mark has an empty node. Which
 * named slot a given node belongs in is left to the panel, the only thing that
 * knows.
 *
 * Every fixture below is derived from the live catalog. A model name written
 * here would make the test pass on the catalog of the day it was written.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  GENERATION_NODE_MODES,
  MODE_SOURCE_FIELDS,
  REFERENCE_POOL_PARAM,
  type CanvasProposal,
  type GenerationNodeType,
  type ProposalNode,
} from "@breatic/shared";

import {
  entriesForNode,
  modelsForMode,
  type ParamInfo,
} from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal } from "../propose-canvas-action.js";

/** A node type and one of its modes, with a model that mode can reach. */
interface Reachable {
  nodeType: GenerationNodeType;
  mode: string;
  model: string;
  /** The kinds of material this mode needs from the reader. */
  needs: GenerationNodeType[];
  /** True when that material arrives through the reference pool, fed by an edge. */
  byReference: boolean;
  /** How many places the panel offers to put material in. */
  slots: number;
  /** True when the model is driven by what the prompt says. */
  takesPrompt: boolean;
  /** Parameters whose values only the vendor's own list holds. */
  choices: string[];
  /** Every parameter the model declares, as the catalog projects it. */
  params: Record<string, ParamInfo>;
}

/**
 * Every mode of every generation node that has a model behind it.
 * @returns One entry per reachable mode, with what the catalog says about it.
 * @throws {never} Never.
 */
function reachableModes(): Reachable[] {
  const found: Reachable[] = [];
  for (const nodeType of Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]) {
    const entries = entriesForNode(nodeType);
    for (const mode of GENERATION_NODE_MODES[nodeType]) {
      const answer = modelsForMode(nodeType, mode);
      if (!answer.available) continue;
      const fields = MODE_SOURCE_FIELDS[nodeType]?.[mode] ?? [];
      const needs = [
        ...new Set(entries.flatMap((e) => e.sourcesByMode[mode] ?? [])),
      ] as GenerationNodeType[];
      for (const model of answer.models) {
        found.push({
          nodeType,
          mode,
          model: model.name,
          needs,
          byReference: fields.includes(REFERENCE_POOL_PARAM),
          slots: fields.filter((f) => f !== REFERENCE_POOL_PARAM).length,
          takesPrompt: model.takesPrompt,
          choices: Object.entries(model.params)
            .filter(([, p]) => p.valuesFrom !== undefined)
            .map(([name]) => name),
          params: model.params,
        });
      }
    }
  }
  return found;
}

/**
 * The first reachable mode matching a description of it.
 *
 * Picking rather than naming is what keeps this file free of model names: the
 * catalog decides which modes need material and how it arrives, so the
 * fixtures follow it.
 * @param wanted - What the mode has to be.
 * @param why - What to say when the catalog offers no such mode.
 * @returns The first match.
 * @throws {Error} When the catalog offers no such mode.
 */
function pick(wanted: (at: Reachable) => boolean, why: string): Reachable {
  const found = reachableModes().find(wanted);
  if (!found) throw new Error(`the catalog offers no ${why}`);
  return found;
}

/** A mode whose material arrives through the reference pool. */
const pooled = (): Reachable =>
  pick((at) => at.needs.length > 0 && at.byReference, "mode fed by the reference pool");

/** A mode whose material arrives through slots on the panel's toolbar. */
const slotted = (): Reachable =>
  pick((at) => at.needs.length > 0 && !at.byReference, "mode fed by a panel slot");

/** A mode offering more than one slot, which is more than one piece of material. */
const manySlotted = (): Reachable =>
  pick(
    (at) => at.needs.length > 0 && !at.byReference && at.slots > 1,
    "mode offering two slots",
  );

/** A mode asking nothing of the reader. */
const sourceless = (): Reachable => pick((at) => at.needs.length === 0, "mode needing no source");

/**
 * What a proposal is built out of, with the catalog's answer as the default.
 *
 * Every field defaults to what a sound proposal for that mode looks like, so
 * a case names only the one thing it is breaking.
 */
interface Built {
  /** One empty node per entry, of that kind. */
  sources?: GenerationNodeType[];
  /** How many places in the prompt are marked as the reader's to fill. */
  marks?: number;
  /** How many places are marked as the reader's to choose. */
  tweaks?: number;
  /** Whether each empty node is wired into the generation. */
  wired?: boolean;
  /** What the prompt says, or nothing at all. */
  text?: string;
  /** What the proposal fills in. */
  params?: Record<string, unknown>;
}

/**
 * A proposal for one mode, sound unless a field says otherwise.
 * @param at - The node type, mode and model to propose.
 * @param built - What to build it out of.
 * @returns The proposal.
 * @throws {never} Never.
 */
function propose(at: Reachable, built: Built = {}): CanvasProposal {
  const sources = built.sources ?? at.needs;
  const marks = built.marks ?? sources.length;
  const tweaks = built.tweaks ?? (at.choices.length > 0 ? 1 : 0);
  const wired = built.wired ?? at.byReference;
  const text = built.text ?? "white ground, centred";
  const nodes: ProposalNode[] = sources.map((type, i) => ({
    role: "source",
    type,
    name: `Your material ${String(i + 1)}`,
  }));
  nodes.push({
    role: "generate",
    type: at.nodeType,
    name: "Result",
    mode: at.mode,
    model: at.model,
    params: built.params ?? {},
    prompt: [
      ...(text === "" ? [] : [{ text }]),
      ...Array.from({ length: marks }, (_, i) => ({
        slot: {
          kind: "asset" as const,
          label: `your material ${String(i + 1)}`,
          note: "Put it in the empty node",
        },
      })),
      ...Array.from({ length: tweaks }, () => ({
        slot: { kind: "tweak" as const, label: "the voice", note: "Pick one in the panel" },
      })),
    ],
  });
  return {
    nodes,
    edges: wired ? sources.map((_, i) => ({ fromIndex: i, toIndex: sources.length })) : [],
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

describe("a mode whose material arrives through the reference pool", () => {
  it("stands when the empty node, the edge and the mark are all there", () => {
    expect(checkProposal(propose(pooled()))).toEqual({ ok: true });
  });

  it("is refused when the proposal carries no node to put it in", () => {
    // The mark saying what goes there is left in place, so the only thing
    // left to refuse this is the missing node and the missing edge.
    const at = pooled();

    expect(checkProposal(propose(at, { sources: [], marks: 1 })).ok).toBe(false);
  });

  it("is refused when nothing in the prompt says what goes there", () => {
    expect(checkProposal(propose(pooled(), { marks: 0 })).ok).toBe(false);
  });

  it("is refused when the empty node holds the wrong kind of material", () => {
    const at = pooled();
    const other: GenerationNodeType = at.needs[0] === "image" ? "audio" : "image";

    expect(checkProposal(propose(at, { sources: [other] })).ok).toBe(false);
  });

  it("stands when it asks for two pieces of material, each wired and marked", () => {
    // The table naming a mode's material speaks in TYPES: two pictures is one
    // type, so nothing in the catalog says whether this mode wants one or two.
    // What holds it together is the proposal agreeing with itself.
    const at = pooled();
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];

    expect(checkProposal(propose(at, { sources: twice }))).toEqual({ ok: true });
  });

  it("is refused when two empty nodes share one mark", () => {
    const at = pooled();
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];

    expect(checkProposal(propose(at, { sources: twice, marks: 1 })).ok).toBe(false);
  });

  it("is refused when a mark has no empty node to go with it", () => {
    expect(checkProposal(propose(pooled(), { marks: 2 })).ok).toBe(false);
  });

  it("is refused when it adds a node of a kind this mode cannot read", () => {
    // The material this mode runs on is there; the extra one is not material
    // at all, and the canvas has no edge that would carry it in anyway.
    const at = pooled();
    const other: GenerationNodeType = at.needs[0] === "image" ? "audio" : "image";

    expect(
      checkProposal(propose(at, { sources: [at.needs[0] as GenerationNodeType, other] })).ok,
    ).toBe(false);
  });

  it("is refused when an empty node is left unwired", () => {
    // The pool is fed by an edge and by nothing else, so an empty node with
    // no edge is one the reader's file never reaches the generation from.
    expect(checkProposal(propose(pooled(), { wired: false })).ok).toBe(false);
  });
});

describe("a mode whose material arrives through a panel slot", () => {
  it("stands with the empty node and no edge at all", () => {
    // The canvas has no legal wiring from an audio node into an audio node;
    // the reader picks the node in the toolbar slot instead.
    expect(checkProposal(propose(slotted()))).toEqual({ ok: true });
  });

  it("is refused when it wires the empty node in anyway", () => {
    expect(checkProposal(propose(slotted(), { wired: true })).ok).toBe(false);
  });

  it("is refused when it offers two of one kind and none of the other", () => {
    // Counting the empty nodes says two for two marks; it does not say one of
    // them holds the driving footage this mode cannot run without.
    const at = pick((m) => m.needs.length > 1 && !m.byReference, "mode needing two kinds");
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];

    expect(checkProposal(propose(at, { sources: twice })).ok).toBe(false);
  });

  it("stands when it fills every slot the panel offers", () => {
    const at = manySlotted();
    const each = Array.from(
      { length: at.slots },
      (_, i) => at.needs[i] ?? (at.needs[0] as GenerationNodeType),
    );

    expect(checkProposal(propose(at, { sources: each }))).toEqual({ ok: true });
  });
});

describe("a mode that needs nothing of the reader", () => {
  it("stands as one node with no edges", () => {
    expect(checkProposal(propose(sourceless(), { sources: [], marks: 0 }))).toEqual({
      ok: true,
    });
  });

  it("is refused when it carries an empty node anyway", () => {
    // Nothing goes in it and nothing on screen says so, which is the same
    // dead end as a missing one.
    const at = sourceless();

    expect(checkProposal(propose(at, { sources: ["image"], marks: 1 })).ok).toBe(false);
  });
});

describe("what the generation is driven by", () => {
  it("refuses a prompt-driven model with nothing written in the prompt", () => {
    const at = pick((m) => m.takesPrompt, "prompt-driven model");

    expect(checkProposal(propose(at, { text: "" })).ok).toBe(false);
  });

  it("stands without a prompt when the model is not driven by one", () => {
    const at = pick((m) => !m.takesPrompt, "model that takes no prompt");

    expect(checkProposal(propose(at, { text: "" }))).toEqual({ ok: true });
  });
});

describe("a choice only the reader can see", () => {
  it("is refused when nothing in the prompt says to make it", () => {
    const at = pick((m) => m.choices.length > 0, "model whose value list is the vendor's");

    expect(checkProposal(propose(at, { tweaks: 0 })).ok).toBe(false);
  });

  it("is refused when the proposal fills the value in itself", () => {
    // The list is fetched from the vendor and shown in the panel; a value
    // written here is one nobody checked against it.
    const at = pick((m) => m.choices.length > 0, "model whose value list is the vendor's");

    expect(
      checkProposal(propose(at, { params: { [at.choices[0] as string]: "some-voice" } })).ok,
    ).toBe(false);
  });
});

describe("what the model is allowed to fill in", () => {
  it("refuses a parameter the chosen model never declared", () => {
    const at = sourceless();

    expect(
      checkProposal(propose(at, { sources: [], marks: 0, params: { a_parameter_no_model_declares: 1 } }))
        .ok,
    ).toBe(false);
  });

  it("refuses a value the control does not offer", () => {
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => (p.options ?? []).length > 0)
          .map(([name]) => ({ at, name })),
      )
      .at(0);
    if (!found) throw new Error("the catalog offers no parameter with a list of values");

    const wrong = propose(found.at, { params: { [found.name]: "a-value-no-control-offers" } });

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a number outside the range the model declares", () => {
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => p.max !== undefined && (p.options ?? []).length === 0)
          .map(([name, p]) => ({ at, name, max: p.max as number })),
      )
      .at(0);
    if (!found) throw new Error("the catalog offers no parameter with a declared range");

    const wrong = propose(found.at, { params: { [found.name]: found.max + 1 } });

    expect(checkProposal(wrong).ok).toBe(false);
  });
});

describe("wiring that could not be placed", () => {
  it("refuses an edge pointing outside the group", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    wrong.edges = [{ fromIndex: 0, toIndex: 7 }];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses an edge looping a node onto itself", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    wrong.edges = [{ fromIndex: 0, toIndex: 0 }];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a group with nothing in it that generates", () => {
    const wrong = propose(pooled());
    wrong.nodes = wrong.nodes.slice(0, 1);
    wrong.edges = [];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a group with two nodes that generate", () => {
    // One press builds one thing. A chain of generations is a workflow, and
    // the empty nodes of the second could not be told from the first's.
    const two = propose(sourceless(), { sources: [], marks: 0 });
    two.nodes = [two.nodes[0] as ProposalNode, { ...(two.nodes[0] as ProposalNode) }];

    expect(checkProposal(two).ok).toBe(false);
  });
});

describe("what the catalog does not offer", () => {
  it("refuses a mode the proposed node does not have", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    (wrong.nodes[0] as ProposalNode).mode = "a_mode_no_node_offers";

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a model that mode cannot reach", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    (wrong.nodes[0] as ProposalNode).model = "a-model-the-catalog-never-had";

    expect(checkProposal(wrong).ok).toBe(false);
  });
});
