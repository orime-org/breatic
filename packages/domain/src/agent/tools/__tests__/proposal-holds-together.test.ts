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
 * A proposal also has to agree with itself: every empty node it places is
 * marked once in the prompt, and every mark has an empty node. Which named
 * slot a given node belongs in is left to the panel, the only thing that
 * knows.
 *
 * Every fixture below is derived from the live catalog. A model name written
 * here would make the test pass on the catalog of the day it was written.
 *
 * What the fixtures read is the catalog's answer, which is what the tool
 * reads, so a fixture is not an independent statement of how many pieces a
 * mode takes -- it says the tool agrees with itself about the shape of a
 * correct proposal, and the cases below then build incorrect ones. What holds
 * that answer to the panel a reader will actually see is the nine cases in
 * `declarations-have-claimants.test.ts`, which compare the declarations
 * against the panel's own registries.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  canConnect,
  GENERATION_NODE_MODES,
  markText,
  PANEL_EDITOR_PARAM,
  REFERENCE_POOL_PARAM,
  type CanvasProposal,
  type GenerationNodeType,
  type ProposalNode,
} from "@breatic/shared";

import {
  entriesForNode,
  materialNeeded,
  modelsForMode,
  type ParamInfo,
} from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal, inputSchema } from "../propose-canvas-action.js";

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
  /** How many separate pieces of material the panel asks the reader for. */
  pieces: number;
  /** True when the model is driven by what the prompt says. */
  takesPrompt: boolean;
  /** Parameters only the reader can fill, in the panel, once the group is there. */
  choices: string[];
  /** The most prompt text one call takes, when the model states a cap. */
  maxInputChars?: number;
  /** The most pieces the reference pool holds, when the model caps it. */
  poolCap?: number;
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
      const needs = [
        ...new Set(entries.flatMap((e) => e.sourcesByMode[mode] ?? [])),
      ] as GenerationNodeType[];
      for (const model of answer.models) {
        const places = Object.entries(model.params).filter(
          ([, p]) => p.filledBySource === true,
        );
        found.push({
          nodeType,
          mode,
          model: model.name,
          needs,
          byReference: places.some(([, p]) => p.fromReferencePool === true),
          slots: places.filter(([, p]) => p.fromReferencePool !== true).length,
          pieces: materialNeeded(nodeType, mode, model.name),
          takesPrompt: model.takesPrompt,
          choices: Object.entries(model.params)
            .filter(([name, p]) => p.valuesFrom !== undefined || name === PANEL_EDITOR_PARAM)
            .map(([name]) => name),
          ...(model.maxInputChars === undefined ? {} : { maxInputChars: model.maxInputChars }),
          ...(model.params[REFERENCE_POOL_PARAM]?.maxItems === undefined
            ? {}
            : { poolCap: model.params[REFERENCE_POOL_PARAM].maxItems }),
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
    // A group forms once there are two nodes, and it carries a name.
    ...(nodes.length > 1 ? { groupName: "Your group" } : {}),
  };
}

/**
 * The bracketed text a proposal's marks put in the prompt box.
 * @param proposal - The proposal whose generation node to read.
 * @returns Every mark's text, joined the way the box will hold them.
 * @throws {never} Never.
 */
function markTextOf(proposal: CanvasProposal): string {
  const generate = proposal.nodes.find((n) => n.role === "generate");
  return (generate?.prompt ?? []).map((s) => (s.slot ? markText(s.slot) : "")).join("");
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

  it("is refused when it wires in more than the pool holds", () => {
    // The pool has a ceiling as well as a floor, and the panel refuses over
    // it by name. A group past it is placed, filled, and then turned away.
    const at = pick((m) => m.byReference && m.poolCap !== undefined, "pool with a declared cap");
    const cap = at.poolCap ?? 0;
    const tooMany = Array.from({ length: cap + 1 }, () => at.needs[0] as GenerationNodeType);

    expect(checkProposal(propose(at, { sources: tooMany })).ok).toBe(false);
  });

  it("stands at exactly what the pool holds", () => {
    const at = pick((m) => m.byReference && m.poolCap !== undefined, "pool with a declared cap");
    const full = Array.from({ length: at.poolCap ?? 0 }, () => at.needs[0] as GenerationNodeType);

    expect(checkProposal(propose(at, { sources: full }))).toEqual({ ok: true });
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

  it("is refused when it offers fewer empty nodes than the panel asks for", () => {
    // The panel refuses on every empty slot it has, and how many it has is
    // its own table's to say. The catalog's speaks in kinds -- two pictures
    // is one kind twice -- so a group one node short reads as complete here
    // and dies at the Generate button.
    const at = pick(
      (m) => !m.byReference && m.pieces > 1,
      "mode asking for more than one piece",
    );
    const short = Array.from(
      { length: at.pieces - 1 },
      (_, i) => at.needs[i] ?? (at.needs[0] as GenerationNodeType),
    );

    expect(checkProposal(propose(at, { sources: short })).ok).toBe(false);
  });

  it("stands when it fills every slot the panel offers", () => {
    const at = manySlotted();
    const each = Array.from(
      { length: at.pieces },
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

  it("is refused when the prompt marks a place with no empty node behind it", () => {
    // A bracket saying "put your photo here" with nothing to put it in reads
    // as an instruction the reader cannot carry out.
    const at = sourceless();

    expect(checkProposal(propose(at, { sources: [], marks: 1 })).ok).toBe(false);
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

describe("what only the reader can fill in", () => {
  it("is refused when nothing in the prompt says to fill it", () => {
    const at = pick((m) => m.choices.length > 0, "model with something only the reader fills");

    expect(checkProposal(propose(at, { tweaks: 0 })).ok).toBe(false);
  });

  it("is refused when the proposal fills the value in itself", () => {
    // The list is fetched from the vendor and shown in the panel; a value
    // written here is one nobody checked against it.
    const at = pick((m) => m.choices.length > 0, "model with something only the reader fills");

    expect(
      checkProposal(propose(at, { params: { [at.choices[0] as string]: "anything" } })).ok,
    ).toBe(false);
  });

  it("is refused when the words go in a box of the panel's own", () => {
    // The lyrics live in their own shared text beside the prompt, so a value
    // written into the parameters reaches nothing and the box stays empty --
    // and the panel refuses to generate on an empty one.
    const at = pick((m) => PANEL_EDITOR_PARAM in m.params, "model with its own text box");

    expect(checkProposal(propose(at, { params: { [PANEL_EDITOR_PARAM]: "la la la" } })).ok).toBe(
      false,
    );
  });

  it("is refused when nothing in the prompt says to write those words", () => {
    const at = pick((m) => PANEL_EDITOR_PARAM in m.params, "model with its own text box");

    expect(checkProposal(propose(at, { tweaks: 0 })).ok).toBe(false);
  });

  it("stands with nothing marked when the switch takes that box away", () => {
    // An instrumental track has no words to write, and the panel takes the
    // lyrics box off the screen. A bracket telling the reader to write lyrics
    // would point at a box that is not there.
    const at = pick(
      (m) => m.params[PANEL_EDITOR_PARAM]?.gate?.kind === "flagOff",
      "model whose text box a switch takes away",
    );
    const flag = (at.params[PANEL_EDITOR_PARAM]?.gate as { param: string }).param;

    expect(checkProposal(propose(at, { tweaks: 0, params: { [flag]: true } }))).toEqual({
      ok: true,
    });
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

  it("refuses a value for a parameter the canvas itself fills", () => {
    // That parameter carries the reader's material, which arrives by wiring a
    // node in. A URL written here is one the canvas would overwrite anyway.
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => p.filledBySource === true)
          .map(([name]) => ({ at, name })),
      )
      .at(0);
    if (!found) throw new Error("the catalog offers no parameter the canvas fills");

    expect(
      checkProposal(propose(found.at, { params: { [found.name]: ["https://example.test/a.png"] } }))
        .ok,
    ).toBe(false);
  });

  it("refuses a value for a parameter the panel draws no control for", () => {
    // Nothing on screen would show it and nothing would let the reader change
    // it, so a value set here is one they can neither see nor undo.
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => p.noControl === true)
          .map(([name, p]) => ({ at, name, value: (p.options ?? [])[0] ?? p.default })),
      )
      .at(0);
    if (!found) throw new Error("the catalog offers no parameter without a control");

    expect(checkProposal(propose(found.at, { params: { [found.name]: found.value } })).ok).toBe(
      false,
    );
  });

  it("refuses a value for a control the switch it hangs on leaves off", () => {
    // The panel draws those wheels whatever the switch says and the run
    // throws their values out until it is on, so a group that arrives with
    // them set generates a picture without the look they describe.
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => p.gate?.kind === "flagOn")
          .map(([name, p]) => ({ at, name, value: (p.options ?? [])[0], flag: (p.gate as { param: string }).param })),
      )
      .find((x) => x.value !== undefined);
    if (!found) throw new Error("the catalog offers no control behind a switch");

    expect(checkProposal(propose(found.at, { params: { [found.name]: found.value } })).ok).toBe(
      false,
    );
  });

  it("stands when the same proposal turns that switch on", () => {
    const found = reachableModes()
      .flatMap((at) =>
        Object.entries(at.params)
          .filter(([, p]) => p.gate?.kind === "flagOn")
          .map(([name, p]) => ({ at, name, value: (p.options ?? [])[0], flag: (p.gate as { param: string }).param })),
      )
      .find((x) => x.value !== undefined);
    if (!found) throw new Error("the catalog offers no control behind a switch");

    expect(
      checkProposal(
        propose(found.at, { params: { [found.flag]: true, [found.name]: found.value } }),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a prompt longer than the model takes", () => {
    // The panel counts what the vendor will receive, and refuses past the cap
    // with the whole script already in the box.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");

    expect(checkProposal(propose(at, { text: "a".repeat((at.maxInputChars ?? 0) + 1) })).ok).toBe(
      false,
    );
  });

  it("counts a line break the way the box will hold it", () => {
    // The canvas starts a new block at every line break and the editor puts
    // two characters between blocks, so a script with paragraphs is longer in
    // the box than in the proposal.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");
    const cap = at.maxInputChars ?? 0;
    const marks = [...markTextOf(propose(at, { text: "" }))].length;
    // One line break short of the cap on its own; two characters over it once
    // the box holds it.
    const lines = "a".repeat(cap - marks - 1) + "\n";

    expect(checkProposal(propose(at, { text: lines })).ok).toBe(false);
  });

  it("stands when a blank line keeps the prompt inside the cap", () => {
    // The editor collapses a run of block breaks back to one blank line, so a
    // script with paragraphs is no longer in the box than the panel measures.
    // Counted any other way, the agent trims the reader's own words.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");
    const cap = at.maxInputChars ?? 0;
    const marks = [...markTextOf(propose(at, { text: "" }))].length;
    // Two paragraphs with a blank line between them, exactly at the cap as
    // the panel will measure it: the words, the two characters the break
    // becomes, and the marks.
    const half = "a".repeat((cap - marks - 2) / 2);
    const script = `${half}\n\n${half}`;

    expect(checkProposal(propose(at, { text: script }))).toEqual({ ok: true });
  });

  it("refuses a prompt the marks push past the cap", () => {
    // The brackets are text in that box like any other, so a prompt that fits
    // on its own words alone is over once they are in it.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");
    const marks = markTextOf(propose(at, { text: "" }));
    if (marks === "") throw new Error("that model's proposal carries no marks to count");

    expect(checkProposal(propose(at, { text: "a".repeat(at.maxInputChars ?? 0) })).ok).toBe(false);
  });

  it("stands at exactly the cap, counting what the box will hold", () => {
    // Every marked place is text in that box too, so the count is of the
    // written prompt rather than of the words alone.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");
    const marks = markTextOf(propose(at, { text: "" }));
    const room = (at.maxInputChars ?? 0) - [...marks].length;

    expect(checkProposal(propose(at, { text: "a".repeat(room) }))).toEqual({ ok: true });
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

  it("refuses an edge that does not end at the node that generates", () => {
    // The canvas would draw it, and it says the reader's two files feed each
    // other rather than the generation.
    const at = pooled();
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];
    const wrong = propose(at, { sources: twice });
    wrong.edges = [...wrong.edges, { fromIndex: 0, toIndex: 1 }];

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses an empty node that arrives configured", () => {
    // An empty node is a place to drop a file. Given a mode and a model it is
    // a second generation, which is a chain this does not build.
    const at = pooled();
    const wrong = propose(at);
    const source = wrong.nodes[0] as ProposalNode;
    source.mode = at.mode;
    source.model = at.model;

    expect(checkProposal(wrong).ok).toBe(false);
  });

  it("refuses a group with nothing in it that generates", () => {
    const wrong = propose(pooled());
    wrong.nodes = wrong.nodes.slice(0, 1);
    wrong.edges = [];

    expect(checkProposal(wrong).ok).toBe(false);
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

describe("what the schema turns away before any of this runs", () => {
  /**
   * Whether the tool's own input schema accepts this call.
   * @param call - The proposal as the model would send it.
   * @returns True when the schema lets it through.
   * @throws {never} Never.
   */
  function accepted(call: unknown): boolean {
    return inputSchema.safeParse(call).success;
  }

  /**
   * A one-node proposal carrying the given slot, to test the slot's fields.
   * @param slot - The slot to put in the prompt.
   * @returns The call.
   * @throws {never} Never.
   */
  function withSlot(slot: { kind: string; label: string; note: string }): unknown {
    const at = pick((m) => m.takesPrompt, "model driven by its prompt");
    return {
      nodes: [
        {
          role: "generate",
          type: at.nodeType,
          name: "Result",
          mode: at.mode,
          model: at.model,
          params: {},
          prompt: [{ text: "something" }, { slot }],
        },
      ],
      edges: [],
      modelNote: "a note about the model",
      rationale: "why this shape",
    };
  }

  it("refuses a note that is nothing but space", () => {
    // The note is a line on the card, telling the reader what is left for
    // them. A blank one draws a bullet with nothing beside it, which reads
    // as a step nobody wrote down.
    expect(accepted(withSlot({ kind: "tweak", label: "the voice", note: "x" }))).toBe(true);
    expect(accepted(withSlot({ kind: "tweak", label: "the voice", note: " " }))).toBe(false);
  });

  it("refuses a label that is nothing but space", () => {
    // The label is what goes between the brackets in the prompt, so a blank
    // one puts a mark in the reader's box that names nothing.
    expect(accepted(withSlot({ kind: "tweak", label: " ", note: "pick one" }))).toBe(false);
  });
});

/**
 * A proposal is a whole flow now, not one thing that generates (#263).
 *
 * The agent reads what the user asked for and decides the shape: one text
 * node, an empty source feeding a generation, or a group carrying both. What
 * the check still asks is whether that group states itself -- every empty node
 * readable by someone, every edge standing for a reference, every written node
 * actually able to hold the words it carries.
 */
describe("a flow of any shape", () => {
  /** A node holding words the reader can read before pressing anything. */
  const written = (name = "Your copy"): ProposalNode => ({
    role: "written",
    type: "text",
    name,
    prompt: [
      { text: "A pour-over kettle, " },
      { slot: { kind: "tweak", label: "your brand", note: "Put your own brand here" } },
      { text: ", slow and warm." },
    ],
  });

  it("places words alone, with nothing that generates", () => {
    const verdict = checkProposal({
      nodes: [written()],
      edges: [],
      rationale: "Copy you can use as it stands.",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("places one source feeding three generations", () => {
    const at = pooled();
    const one = propose(at);
    const generate = one.nodes[one.nodes.length - 1];
    if (!generate) throw new Error("the fixture built no generation");
    const sources = one.nodes.slice(0, -1);

    const verdict = checkProposal({
      nodes: [...sources, generate, { ...generate }, { ...generate }],
      edges: sources.flatMap((_, i) => [
        { fromIndex: i, toIndex: sources.length },
        { fromIndex: i, toIndex: sources.length + 1 },
        { fromIndex: i, toIndex: sources.length + 2 },
      ]),
      modelNote: "",
      rationale: "Three angles off the one photo.",
      groupName: "Three angles",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("refuses words carried by a node that cannot hold them", () => {
    const verdict = checkProposal({
      nodes: [{ ...written(), type: "image" }],
      edges: [],
      rationale: "",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("text node") });
  });

  it("refuses an empty text node, which the reader makes in one click", () => {
    const at = pooled();
    const one = propose(at);

    const verdict = checkProposal({
      ...one,
      nodes: [...one.nodes, { role: "source", type: "text", name: "Some words" }],
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("text node") });
  });

  it("refuses a written node dressed up as a generation", () => {
    const at = pooled();
    const verdict = checkProposal({
      nodes: [{ ...written(), mode: at.mode, model: at.model }],
      edges: [],
      rationale: "",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("no mode") });
  });

  it("refuses words asking the reader for material", () => {
    const verdict = checkProposal({
      nodes: [
        {
          ...written(),
          prompt: [{ slot: { kind: "asset", label: "your photo", note: "Drop it in" } }],
        },
      ],
      edges: [],
      rationale: "",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("mention") });
  });

  it("refuses a ring, which says nothing about what comes first", () => {
    const at = pooled();
    const one = propose(at);
    const generate = one.nodes[one.nodes.length - 1];
    if (!generate) throw new Error("the fixture built no generation");

    const verdict = checkProposal({
      ...one,
      nodes: [...one.nodes, { ...generate }],
      edges: [
        { fromIndex: one.nodes.length - 1, toIndex: one.nodes.length },
        { fromIndex: one.nodes.length, toIndex: one.nodes.length - 1 },
      ],
      groupName: "A ring",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("ring") });
  });

  it("refuses an edge ending at a place the reader fills", () => {
    const at = pooled();
    const one = propose(at);

    const verdict = checkProposal({
      ...one,
      nodes: [...one.nodes, { role: "source", type: at.needs[0] ?? "image", name: "Another" }],
      edges: [...one.edges, { fromIndex: one.nodes.length - 1, toIndex: one.nodes.length }],
      groupName: "Two empties",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("flows into") });
  });

  it("refuses a group of two the model did not name", () => {
    const at = pooled();
    const one = propose(at);

    expect(one.nodes.length).toBeGreaterThan(1);
    const verdict = checkProposal({ ...one, groupName: undefined });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("name") });
  });
});

/**
 * What each generation reads, and what the edges between them may say (#263).
 *
 * A flow carries more than one thing that generates, so "the material this
 * proposal offers" stops being a property of the whole group: each generation
 * reads what its own incoming edges bring it, and an upstream generation
 * supplies a picture as surely as an empty node the reader fills does.
 *
 * The edges themselves are held to the whitelist the canvas holds a reader's
 * own drag to -- one ratified rule, one answer, whoever drew the line.
 */
describe("edges the canvas itself would refuse", () => {
  /** A mode on one node type that asks the reader for nothing. */
  const sourcelessOn = (nodeType: GenerationNodeType): Reachable =>
    pick(
      (at) => at.nodeType === nodeType && at.needs.length === 0,
      `mode on a ${nodeType} node needing no source`,
    );

  /** One generation node, configured, with the prompt a sound one carries. */
  function generation(at: Reachable, marks = 0): ProposalNode {
    return {
      role: "generate",
      type: at.nodeType,
      name: `A ${at.mode} result`,
      mode: at.mode,
      model: at.model,
      params: {},
      prompt: [
        { text: "white ground, centred" },
        ...Array.from({ length: marks }, (_, i) => ({
          slot: {
            kind: "asset" as const,
            label: `your material ${String(i + 1)}`,
            note: "Put it in the empty node",
          },
        })),
        ...Array.from({ length: at.choices.length > 0 ? 1 : 0 }, () => ({
          slot: { kind: "tweak" as const, label: "the voice", note: "Pick one in the panel" },
        })),
      ],
    };
  }

  it("refuses a pair the reader could not have wired by hand", () => {
    const sound = pooled();
    const other = pick(
      (at) => !canConnect(at.nodeType, sound.nodeType),
      `mode the whitelist keeps out of a ${sound.nodeType} node`,
    );

    const verdict = checkProposal({
      nodes: [generation(other), generation(sound, 1)],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "",
      groupName: "A pair the canvas refuses",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("does not let") });
  });

  it("refuses a node that says it holds words and holds none", () => {
    const verdict = checkProposal({
      nodes: [{ role: "written", type: "text", name: "Your copy" }],
      edges: [],
      rationale: "",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("no words") });
  });

  it("refuses an empty node nothing in the group reads", () => {
    const at = pooled();
    const one = propose(at);

    const verdict = checkProposal({ ...one, edges: [] });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("reads") });
  });

  it("places one generation feeding another, with no empty node at all", () => {
    const at = pooled();
    const first = sourcelessOn(at.nodeType);

    const verdict = checkProposal({
      nodes: [generation(first), generation(at)],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "The second works on what the first made.",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("places two generations that each read their own empty node", () => {
    const at = pooled();
    const kind = at.needs[0];
    if (!kind) throw new Error("the fixture found a pooled mode needing nothing");

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: kind, name: "Your first" },
        { role: "source", type: kind, name: "Your second" },
        generation(at, 1),
        generation(at, 1),
      ],
      edges: [
        { fromIndex: 0, toIndex: 2 },
        { fromIndex: 1, toIndex: 3 },
      ],
      modelNote: "",
      rationale: "One each.",
      groupName: "Two of them",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("places a generation asking for nothing beside one that asks for material", () => {
    const at = pooled();
    const kind = at.needs[0];
    if (!kind) throw new Error("the fixture found a pooled mode needing nothing");
    const first = sourcelessOn(at.nodeType);

    const verdict = checkProposal({
      nodes: [generation(first), { role: "source", type: kind, name: "Your own" }, generation(at, 1)],
      edges: [
        { fromIndex: 0, toIndex: 2 },
        { fromIndex: 1, toIndex: 2 },
      ],
      modelNote: "",
      rationale: "One we make, one they bring.",
      groupName: "Both at once",
    });

    expect(verdict).toEqual({ ok: true });
  });
});
