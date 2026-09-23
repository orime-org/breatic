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
  MAX_NODE_NAME_LEN,
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

import {
  answerFor,
  checkProposal,
  inputSchema,
  theirsToFill,
} from "../propose-canvas-action.js";

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
          // Asked of the check rather than restated here: a fixture that
          // spells the rule out a second time is one the two halves of it
          // can part company behind.
          choices: Object.entries(model.params)
            .filter(([name, p]) => theirsToFill(name, p))
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

/** A mode on one node type that asks the reader for nothing. */
const sourcelessOn = (nodeType: GenerationNodeType): Reachable =>
  pick(
    (at) => at.nodeType === nodeType && at.needs.length === 0,
    `mode on a ${nodeType} node needing no source`,
  );

/**
 * One generation node, configured, with as many marks of each kind as asked.
 * @param at - The node type, mode and model to propose.
 * @param marks - How many places say the reader puts material there.
 * @param refs - How many places point at an upstream node.
 * @returns The node.
 * @throws {never} Never.
 */
function generation(at: Reachable, marks = 0, refs = 0): ProposalNode {
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
      ...Array.from({ length: refs }, () => ({ slot: { kind: "ref" as const, label: "the step before", note: "Nothing to do" } })),
      ...Array.from({ length: at.choices.length > 0 ? 1 : 0 }, () => ({
        slot: { kind: "tweak" as const, label: "the voice", note: "Pick one in the panel" },
      })),
    ],
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

  it("is refused when the empty node cannot feed this generation at all", () => {
    const at = pooled();
    const other: GenerationNodeType = at.needs[0] === "image" ? "audio" : "image";

    expect(checkProposal(propose(at, { sources: [other] }))).toEqual({ ok: false, reason: expect.stringContaining("does not let a") });
  });

  it("stands when it asks for two pieces of material, each wired and marked", () => {
    // The table naming a mode's material speaks in TYPES: two pictures is one
    // type, so nothing in the catalog says whether this mode wants one or two.
    // What holds it together is the proposal agreeing with itself.
    const at = pooled();
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];

    expect(checkProposal(propose(at, { sources: twice }))).toEqual({ ok: true });
  });

  it("is refused when it wires in more than the pool holds", () => {
    // The pool has a ceiling as well as a floor, and the panel refuses over
    // it by name. A group past it is placed, filled, and then turned away.
    const at = pick((m) => m.byReference && m.poolCap !== undefined, "pool with a declared cap");
    const cap = at.poolCap ?? 0;
    const tooMany = Array.from({ length: cap + 1 }, () => at.needs[0] as GenerationNodeType);

    expect(checkProposal(propose(at, { sources: tooMany }))).toEqual({ ok: false, reason: expect.stringContaining("reference(s) at a time") });
  });

  it("stands at exactly what the pool holds", () => {
    const at = pick((m) => m.byReference && m.poolCap !== undefined, "pool with a declared cap");
    const full = Array.from({ length: at.poolCap ?? 0 }, () => at.needs[0] as GenerationNodeType);

    expect(checkProposal(propose(at, { sources: full }))).toEqual({ ok: true });
  });

  it("counts what the step before made against the pool ceiling too", () => {
    // What the step before made goes in the pool like anything else the
    // reader would have mentioned, so it takes one of the rows -- counting
    // only the empty nodes lets a group be placed that the panel then refuses.
    const at = pick(
      (m) => m.byReference && m.poolCap !== undefined && m.nodeType === "video",
      "video pool with a declared cap",
    );
    const kind = at.needs[0] as GenerationNodeType;
    const full = Array.from({ length: at.poolCap ?? 0 }, () => kind);
    const filled = propose(at, { sources: full });
    const generation = filled.nodes.length - 1;
    const maker = sourcelessOn(kind);
    const made = filled.nodes[generation] as ProposalNode;

    const verdict = checkProposal({
      ...filled,
      nodes: [
        ...filled.nodes.slice(0, generation),
        {
          ...made,
          // It is a row the prompt can name, so it is marked; what this case
          // is about is that it also occupies one of the pool's rows.
          prompt: [
            ...(made.prompt ?? []),
            { slot: { kind: "ref", label: "the step before", note: "Nothing to do" } },
          ],
        },
        {
          role: "generate",
          type: kind,
          name: "The first take",
          mode: maker.mode,
          model: maker.model,
          params: {},
          prompt: [{ text: "an opening shot" }],
        },
      ],
      edges: [...filled.edges, { fromIndex: filled.nodes.length, toIndex: generation }],
      groupName: "One more than it holds",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("reference(s) at a time"),
    });
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

});

describe("a mode whose material arrives through a panel slot", () => {
  it("stands with the empty node and no edge at all", () => {
    // The reader picks the node in the toolbar slot, clicking any node of that
    // kind anywhere on the canvas, so no edge carries the material here.
    expect(checkProposal(propose(slotted()))).toEqual({ ok: true });
  });

  it("stands when it fills every slot the panel offers", () => {
    const at = manySlotted();
    const each = Array.from(
      { length: at.pieces },
      (_, i) => at.needs[i] ?? (at.needs[0] as GenerationNodeType),
    );

    expect(checkProposal(propose(at, { sources: each }))).toEqual({ ok: true });
  });

  it("is refused when the empty nodes leave one of the kinds this mode needs unfilled", () => {
    // Slot material is picked in the panel rather than wired, so no edge is
    // drawn and the rule holding the pool path to its kinds never runs here.
    // A talking head takes a portrait and a voice; two portraits is a group
    // the reader fills and then cannot generate from.
    const at = pick(
      (m) => !m.byReference && m.needs.length > 1,
      "mode needing two kinds through panel slots",
    );
    const twiceTheFirst = [
      at.needs[0] as GenerationNodeType,
      at.needs[0] as GenerationNodeType,
    ];

    expect(checkProposal(propose(at, { sources: twiceTheFirst }))).toEqual({
      ok: false,
      reason: expect.stringContaining(String(at.needs[1])),
    });
  });
});

describe("a mode that needs nothing of the reader", () => {
  it("stands as one node with no edges", () => {
    expect(checkProposal(propose(sourceless(), { sources: [], marks: 0 }))).toEqual({
      ok: true,
    });
  });

});

describe("what the generation is driven by", () => {
  it("refuses a prompt-driven model with nothing written in the prompt", () => {
    const at = pick((m) => m.takesPrompt, "prompt-driven model");

    expect(checkProposal(propose(at, { text: "" }))).toEqual({ ok: false, reason: expect.stringContaining("generates from what the prompt says") });
  });

  it("stands without a prompt when the model is not driven by one", () => {
    const at = pick((m) => !m.takesPrompt, "model that takes no prompt");

    expect(checkProposal(propose(at, { text: "" }))).toEqual({ ok: true });
  });
});

describe("what only the reader can fill in", () => {
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

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("a-value-no-control-offers") });
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

    expect(checkProposal(propose(at, { text: lines }))).toEqual({ ok: false, reason: expect.stringContaining(`and this prompt is ${String(cap + 1)}`) });
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

    expect(checkProposal(propose(at, { text: "a".repeat(at.maxInputChars ?? 0) }))).toEqual({ ok: false, reason: expect.stringContaining(`takes ${String(at.maxInputChars)} characters`) });
  });

  it("stands at exactly the cap, counting what the box will hold", () => {
    // Every marked place is text in that box too, so the count is of the
    // written prompt rather than of the words alone.
    const at = pick((m) => m.maxInputChars !== undefined, "model stating an input cap");
    const marks = markTextOf(propose(at, { text: "" }));
    const room = (at.maxInputChars ?? 0) - [...marks].length;

    expect(checkProposal(propose(at, { text: "a".repeat(room) }))).toEqual({ ok: true });
  });

  it("counts the words a mark pointing upstream will substitute in", () => {
    // A ref mark writes no text of its own, and at Generate time the body of
    // the text node it names takes its place in the string the panel measures
    // (`serializePromptText`). Measured as nothing, a script past the cap is
    // placed, and the reader meets the refusal at a button they cannot fix
    // from -- the words are in another node.
    const at = pick(
      (m) => m.maxInputChars !== undefined && m.needs.length === 0 && m.takesPrompt,
      "model stating an input cap and needing no material",
    );
    const script = "x".repeat((at.maxInputChars ?? 0) + 1);

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "The script", prompt: [{ text: script }] },
        { role: "generate", type: at.nodeType, name: "The read", mode: at.mode,
          model: at.model, params: {}, prompt: [
            { text: "read " },
            { slot: { kind: "ref", label: "the step before", note: "Nothing to do" } },
            ...(at.choices.length > 0
              ? [{ slot: { kind: "tweak" as const, label: "the voice", note: "Pick one in the panel" } }]
              : []),
          ] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "x", groupName: "g",
    });

    if (verdict.ok) throw new Error("expected a refusal");
    // The number in the sentence is the one it refused on, and it names the
    // node holding the words: told the prompt is nineteen characters and to
    // shorten it, the model has nothing it can shorten and no idea where the
    // rest of them are.
    const said = /and this prompt is (\d+)/.exec(verdict.reason)?.[1];
    expect(Number(said)).toBeGreaterThan(at.maxInputChars ?? 0);
    expect(verdict.reason).toContain("The script");
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

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining(`"${found.name}" runs from`) });
  });
});

describe("wiring that could not be placed", () => {
  it("refuses an edge pointing outside the group", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    wrong.edges = [{ fromIndex: 0, toIndex: 7 }];

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("points outside the group") });
  });

  it("refuses an edge looping a node onto itself", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    wrong.edges = [{ fromIndex: 0, toIndex: 0 }];

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("loops node 0 onto itself") });
  });

  it("refuses an edge that does not end at the node that generates", () => {
    // The canvas would draw it, and it says the reader's two files feed each
    // other rather than the generation.
    const at = pooled();
    const twice = [at.needs[0] as GenerationNodeType, at.needs[0] as GenerationNodeType];
    const wrong = propose(at, { sources: twice });
    wrong.edges = [...wrong.edges, { fromIndex: 0, toIndex: 1 }];

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("generates nothing, so nothing there reads") });
  });

  it("refuses an empty node that arrives configured", () => {
    // An empty node is a place to drop a file. Given a mode and a model it is
    // a second generation, which is a chain this does not build.
    const at = pooled();
    const wrong = propose(at);
    const source = wrong.nodes[0] as ProposalNode;
    source.mode = at.mode;
    source.model = at.model;

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("takes no mode, model, parameters or prompt") });
  });

  it("refuses a group with nothing in it that generates", () => {
    const wrong = propose(pooled());
    wrong.nodes = wrong.nodes.slice(0, 1);
    wrong.edges = [];

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("Nothing here generates") });
  });

});

describe("what the catalog does not offer", () => {
  it("refuses a mode the proposed node does not have", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    (wrong.nodes[0] as ProposalNode).mode = "a_mode_no_node_offers";

    expect(checkProposal(wrong)).toEqual({ ok: false, reason: expect.stringContaining("No model here backs") });
  });

  it("names the model when the model is what it does not carry", () => {
    // The refusal is the whole of what the model has to act on. Told instead
    // that nothing reads the empty node, the sensible next move is to drop
    // the empty node -- and the reader who said they had the photo gets a
    // flow that does not use it.
    const at = pooled();
    const verdict = checkProposal({
      nodes: [
        { role: "source", type: at.needs[0] as GenerationNodeType, name: "Your photo" },
        { role: "generate", type: at.nodeType, name: "Result", mode: at.mode,
          model: "a-model-the-catalog-never-had", params: {},
          prompt: [{ text: "make it" },
            { slot: { kind: "asset", label: "yours", note: "Put it in" } }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "x", groupName: "g",
    });

    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("a-model-the-catalog-never-had");
  });

  it("refuses a model that mode cannot reach", () => {
    const wrong = propose(sourceless(), { sources: [], marks: 0 });
    (wrong.nodes[0] as ProposalNode).model = "a-model-the-catalog-never-had";

    expect(checkProposal(wrong).ok).toBe(false);
  });
});

describe("what the answer tells the canvas", () => {
  /**
   * The answer the tool hands back for a sound proposal.
   * @param proposal - What the model sent.
   * @returns The nodes of the answer.
   * @throws {Error} When the proposal was refused.
   */
  function answered(proposal: CanvasProposal): ProposalNode[] {
    const answer = answerFor(proposal);
    if (!answer.placed) throw new Error(`refused: ${answer.reason}`);
    return answer.nodes;
  }

  it("says how each generation takes the reader's material", () => {
    // The canvas writes an @-mention for a mark only where a mention is what
    // picks the material, and the reader may press Use before the model
    // catalog has loaded. So the answer carries what the check just read off
    // the catalog rather than leaving the canvas to ask again.
    const pool = pooled();
    const slot = slotted();

    expect(answered(propose(pool)).map((n) => n.takesFrom)).toEqual([undefined, "pool"]);
    expect(answered(propose(slot)).map((n) => n.takesFrom)).toEqual([undefined, "slot"]);
  });

  it("refuses a proposal that says it itself", () => {
    // The path a model's material takes is the catalog's answer. A proposal
    // carrying one would be a second copy of it, free to disagree.
    const at = pooled();
    const said = propose(at);
    const generate = said.nodes[said.nodes.length - 1] as ProposalNode;

    expect(
      inputSchema.safeParse({ ...said, nodes: [...said.nodes.slice(0, -1), { ...generate, takesFrom: "pool" }] })
        .success,
    ).toBe(false);
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

  /**
   * A one-node proposal carrying the given node name.
   * @param name - What to call the node.
   * @returns The call.
   * @throws {never} Never.
   */
  function named(name: string): unknown {
    const at = pick((m) => m.takesPrompt, "model driven by its prompt");
    return {
      nodes: [
        {
          role: "generate",
          type: at.nodeType,
          name,
          mode: at.mode,
          model: at.model,
          params: {},
          prompt: [{ text: "something" }],
        },
      ],
      edges: [],
      rationale: "why this shape",
    };
  }

  it("refuses a node name that is nothing but space", () => {
    // The name is what the reader sees on the node once it is placed, and on
    // the card before that. A blank one leaves both unlabelled, the same way
    // a blank label or note does.
    expect(accepted(named("Result"))).toBe(true);
    expect(accepted(named(" "))).toBe(false);
  });

  it("refuses a node name longer than a reader could type", () => {
    // The rename input stops at this and the commit clips to it, so a longer
    // name is one nobody at the canvas could have given -- and the first time
    // the reader opens the name to edit it, committing shortens it without
    // saying so.
    expect(accepted(named("a".repeat(MAX_NODE_NAME_LEN)))).toBe(true);
    expect(accepted(named("a".repeat(MAX_NODE_NAME_LEN + 1)))).toBe(false);
  });

  it("refuses a group name longer than a reader could type", () => {
    // The group's name lands on a group node and is renamed through the same
    // editor, under the same cap, so it is the same name rule as the nodes it
    // holds rather than a second one.
    /**
     * A two-node proposal under the given group name.
     * @param groupName - What to call the group.
     * @returns The call.
     * @throws {never} Never.
     */
    const grouped = (groupName: string): unknown => ({
      ...(named("Result") as { nodes: unknown[]; edges: unknown[]; rationale: string }),
      nodes: [
        { role: "source", type: "image", name: "Your picture" },
        ...(named("Result") as { nodes: unknown[] }).nodes,
      ],
      groupName,
    });

    expect(accepted(grouped("a".repeat(MAX_NODE_NAME_LEN)))).toBe(true);
    expect(accepted(grouped("a".repeat(MAX_NODE_NAME_LEN + 1)))).toBe(false);
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

  it("refuses words alone, which the reader can read in the reply", () => {
    // Asked for a line of copy and nothing else, the answer is the copy, in
    // the message. A node carrying it gives the reader something to place,
    // press and undo for words they could already read and take.
    const verdict = checkProposal({
      nodes: [written()],
      edges: [],
      rationale: "Copy you can use as it stands.",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("Write them in your reply"),
    });
  });

  it("tells a proposal carrying no words that nothing generates, and stops there", () => {
    // Refused for the same reason -- nothing here generates -- but the line
    // about writing the words in the reply is about words, and this payload
    // has none. Sent it anyway, the model goes off to write copy nobody
    // asked for.
    const verdict = checkProposal({
      nodes: [
        { role: "source", type: "image", name: "Your photo" },
        { role: "source", type: "image", name: "Your logo" },
      ],
      edges: [],
      rationale: "Two things to fill in.",
      groupName: "Your material",
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("Nothing here generates");
    expect(verdict.reason).not.toContain("words");
  });

  it("places words beside a generation, where they are part of the flow", () => {
    const at = pooled();
    const one = propose(at);

    const verdict = checkProposal({
      ...one,
      nodes: [written(), ...one.nodes],
      edges: one.edges.map((edge) => ({
        fromIndex: edge.fromIndex + 1,
        toIndex: edge.toIndex + 1,
      })),
      groupName: "Copy and a photo on white",
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

  it("places a generation the step before it feeds, through a panel slot", () => {
    // "Draw the shoe, then animate it." The reader picks the picture in the
    // panel's slot, and what they pick is the node upstream -- a slot is
    // filled by clicking any node of that kind on the canvas, and a generated
    // one is one of those. That click is theirs, so the prompt marks it.
    const maker = sourcelessOn("image");
    const taker = pick(
      (at) => !at.byReference && at.needs.length === 1 && at.needs[0] === "image",
      "mode fed by a panel slot that takes one picture",
    );

    const verdict = checkProposal({
      nodes: [
        { role: "generate", type: "image", name: "The shoe", mode: maker.mode,
          model: maker.model, params: {}, prompt: [{ text: "a running shoe on white" }] },
        { role: "generate", type: taker.nodeType, name: "It turns", mode: taker.mode,
          model: taker.model, params: {}, prompt: [
            { text: "slow turntable" },
            { slot: { kind: "asset", label: "the shoe", note: "Pick it in the first slot" } },
          ] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "Draw it, then animate it.",
      groupName: "Shoe spot",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("lets words upstream be named in a slot-fed prompt", () => {
    // A mention of a text node substitutes its words into the prompt; it
    // never asks the reference pool for anything, and the panel lets it
    // through for any model that takes a prompt. The reader can make this
    // mention by hand, so the proposal may make it for them.
    const at = slotted();
    const kind = at.needs[0] as GenerationNodeType;

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "The slogan",
          prompt: [{ text: "slow and warm" }] },
        { role: "source", type: kind, name: "Yours" },
        { role: "generate", type: at.nodeType, name: "The clip", mode: at.mode,
          model: at.model, params: {}, prompt: [
            { text: "in the words of " },
            { slot: { kind: "ref", label: "the step before", note: "Nothing to do" } },
            { text: ", using " },
            { slot: { kind: "asset", label: "yours", note: "Put it in" } },
          ] },
      ],
      edges: [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2 }],
      rationale: "The slogan, spoken over your material.",
      groupName: "One spot",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("leaves the panel slot fed while words are wired in", () => {
    // On the slot path the reader fills the material by clicking, so an
    // empty node need not be wired at all. An edge carrying words says
    // nothing about where the material comes from, and reading it as one
    // turns away a group the panel would have run.
    const at = slotted();
    const kind = at.needs[0] as GenerationNodeType;

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "The slogan",
          prompt: [{ text: "slow and warm" }] },
        { role: "source", type: kind, name: "Yours" },
        { role: "generate", type: at.nodeType, name: "The clip", mode: at.mode,
          model: at.model, params: {}, prompt: [
            { text: "in the words of " },
            { slot: { kind: "ref", label: "the step before", note: "Nothing to do" } },
            { text: ", using " },
            { slot: { kind: "asset", label: "yours", note: "Put it in" } },
          ] },
      ],
      edges: [{ fromIndex: 0, toIndex: 2 }],
      rationale: "The slogan, spoken over material you pick in the panel.",
      groupName: "One spot",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("places two slot-fed generations that each take their own material", () => {
    // Clone both of these voices: two empty nodes, two generations, each
    // taking one piece. The reader opens the first panel and picks one node
    // into its slot, opens the second and picks the other. How many empty
    // nodes the group carries says nothing about how many pieces reach any
    // one generation -- on this path the reader decides that by clicking.
    const at = slotted();
    const kind = at.needs[0] as GenerationNodeType;
    const one = (name: string): ProposalNode => ({
      role: "generate", type: at.nodeType, name, mode: at.mode, model: at.model,
      params: {}, prompt: [{ text: "make it" },
        { slot: { kind: "asset", label: "yours", note: "Pick it in the panel" } }],
    });

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: kind, name: "Yours A" },
        { role: "source", type: kind, name: "Yours B" },
        one("From A"), one("From B"),
      ],
      edges: [],
      rationale: "One each, picked in the panel.",
      groupName: "Both of them",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("keeps the group's other empty nodes when one feeder is wired in", () => {
    // Make the character, and I will give you the dance clip. One kind comes
    // from the step before and is wired; the other sits in the group as an
    // empty node, unwired because it has made nothing to draw on. Reading the
    // edge as the whole answer turns away a group whose missing kind is right
    // there -- and `checkProposal` has already counted that node as read by
    // this very generation.
    const at = pick(
      (m) => !m.byReference && m.needs.length > 1,
      "mode fed by panel slots needing two kinds",
    );
    const made = at.needs[0] as GenerationNodeType;
    const theirs = at.needs[1] as GenerationNodeType;
    const maker = pick(
      (m) => m.nodeType === made && m.needs.length === 0,
      `mode making a ${made} out of nothing`,
    );

    const verdict = checkProposal({
      nodes: [
        generation(maker),
        { role: "source", type: theirs, name: "Yours" },
        { role: "generate", type: at.nodeType, name: "The result", mode: at.mode,
          model: at.model, params: {}, prompt: [{ text: "put them together" },
            { slot: { kind: "asset", label: "the one made", note: "Pick it in the panel" } },
            { slot: { kind: "asset", label: "yours", note: "Pick it in the panel" } }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 2 }],
      rationale: "Make one, you bring the other.",
      groupName: "Both halves",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("counts the group's places even when one of them is wired in", () => {
    // Two frames for a tween, and the model wired one of the two empty nodes
    // to the generation it feeds. The group offers both; a count that reads
    // only the wire says it offers one, and no third empty node would fix it.
    const at = manySlotted();
    const kind = at.needs[0] as GenerationNodeType;

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: kind, name: "First frame" },
        { role: "source", type: kind, name: "Last frame" },
        { role: "generate", type: at.nodeType, name: "The tween", mode: at.mode,
          model: at.model, params: {}, prompt: [{ text: "morph" },
            ...Array.from({ length: at.pieces }, (_, i) => ({
              slot: { kind: "asset" as const, label: `frame ${String(i + 1)}`, note: "Pick it" },
            }))] },
      ],
      edges: [{ fromIndex: 0, toIndex: 2 }],
      rationale: "x", groupName: "g",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("names the panel slot when that is where the material goes", () => {
    // Two ways the reader's material reaches a generation, and the sentence
    // about a parameter carrying it has to name the one this model uses.
    const at = slotted();
    const key = Object.keys(at.params).find((name) => at.params[name]?.filledBySource);
    if (key === undefined) throw new Error("the catalog offers no slot parameter");

    const verdict = checkProposal(propose(at, { params: { [key]: "https://example.com/a.png" } }));

    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("slot on the panel");
    expect(verdict.reason).not.toContain("wiring an empty node in");
  });

  it("names the pool when that is where the reader's material goes", () => {
    const at = pooled();
    const key = Object.keys(at.params).find((name) => at.params[name]?.fromReferencePool);
    if (key === undefined) throw new Error("the catalog offers no pooled parameter");

    const verdict = checkProposal(propose(at, { params: { [key]: ["https://example.com/a.png"] } }));

    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("wiring an empty node in");
  });

  it("places two slot-fed generations wired one empty node each", () => {
    // Two photos, two clips, one edge apiece. What the edge settles here is
    // which photo a mark is about; how many pieces reach either generation is
    // the reader's, since a slot is filled by clicking. The case that tells
    // the two readings apart is the one below, where the edge carries a kind
    // the generation cannot take.
    const at = slotted();
    const kind = at.needs[0] as GenerationNodeType;
    const one = (name: string): ProposalNode => ({
      role: "generate", type: at.nodeType, name, mode: at.mode, model: at.model,
      params: {}, prompt: [{ text: "make it" },
        { slot: { kind: "asset", label: "yours", note: "Put it in" } }],
    });

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: kind, name: "The first" },
        { role: "source", type: kind, name: "The second" },
        one("From the first"),
        one("From the second"),
      ],
      edges: [
        { fromIndex: 0, toIndex: 2 },
        { fromIndex: 1, toIndex: 3 },
      ],
      rationale: "One each.",
      groupName: "Two of them",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("judges each slot-fed generation on the material of its own kind", () => {
    // One job, two generations, each bringing its own empty node. Neither is
    // answerable for the other's: the reader fills the picture slot from the
    // picture node and the sound slot from the sound node.
    const one = slotted();
    const two = pick(
      (at) =>
        !at.byReference &&
        at.needs.length === 1 &&
        at.needs.every((kind) => !one.needs.includes(kind)),
      "second slot-fed mode taking a kind the first does not",
    );
    const kindOf = (at: Reachable): GenerationNodeType => at.needs[0] as GenerationNodeType;

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: kindOf(one), name: "Yours for the first" },
        { role: "source", type: kindOf(two), name: "Yours for the second" },
        { role: "generate", type: one.nodeType, name: "First", mode: one.mode, model: one.model,
          params: {}, prompt: [{ text: "make it" },
            { slot: { kind: "asset", label: "yours", note: "Put it in" } }] },
        { role: "generate", type: two.nodeType, name: "Second", mode: two.mode, model: two.model,
          params: {}, prompt: [{ text: "make it" },
            { slot: { kind: "asset", label: "yours", note: "Put it in" } }] },
      ],
      edges: [],
      rationale: "Both halves of one listing.",
      groupName: "One listing",
    });

    expect(verdict).toEqual({ ok: true });
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

  it("places one generation feeding another, with no empty node at all", () => {
    const at = pooled();
    const first = sourcelessOn(at.nodeType);

    const verdict = checkProposal({
      nodes: [generation(first), generation(at, 0, 1)],
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
      nodes: [
        generation(first),
        { role: "source", type: kind, name: "Your own" },
        generation(at, 1, 1),
      ],
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

/**
 * A mark that points at an upstream node rather than asking for anything.
 *
 * A connection makes material AVAILABLE to a generation; an `@`-mention picks
 * which of what is available this call actually uses. Nothing writes a mention
 * today except an asset mark, so a generation fed by another generation lands
 * with an edge drawn, a prompt naming nothing, and a Generate button that does
 * not move -- with no words on screen saying why.
 *
 * A `ref` mark is how the proposal says which upstream node a sentence means.
 * It asks the reader for nothing, so it is not one of the things left to do,
 * and it writes no bracket of its own -- the mention it lands as is the text.
 */
describe("a mark pointing at an upstream node", () => {
  it("places the same pair once the prompt points at the step before", () => {
    const at = pooled();
    const first = sourcelessOn(at.nodeType);

    const verdict = checkProposal({
      nodes: [generation(first), generation(at, 0, 1)],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "The second works on what the first made.",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("refuses a written node whose words are all whitespace", () => {
    // It lands as a text node with nothing readable in it, which is the thing
    // a reader makes in one click.
    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "Your copy", prompt: [{ text: "   \n  " }] },
        generation(sourceless(), 0, 0),
      ],
      edges: [],
      rationale: "",
      groupName: "Copy and a picture",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("carries no words"),
    });
  });

  it("refuses a written node whose words point at something upstream", () => {
    const verdict = checkProposal({
      nodes: [
        {
          role: "written",
          type: "text",
          name: "Your copy",
          prompt: [
            { text: "After " },
            { slot: { kind: "ref", label: "the step before", note: "Nothing to do" } },
          ],
        },
      ],
      edges: [],
      rationale: "",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("mention") });
  });

  it("refuses a prompt whose only words are the marks pointing upstream", () => {
    // A mark pointing upstream writes no bracket of its own -- it lands as the
    // mention and nothing else -- so a prompt made of nothing but those is an
    // empty box the reader is handed with a Generate button that refuses.
    const at = pooled();
    const first = sourcelessOn(at.nodeType);
    const second = generation(at, 0, 1);

    const verdict = checkProposal({
      nodes: [
        generation(first),
        { ...second, prompt: (second.prompt ?? []).filter((s) => s.slot) },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("writes nothing") });
  });

  it("refuses a prompt pointing upstream more times than there are nodes to point at", () => {
    // How many marks go in a prompt is the agent's to decide, and a mark
    // pointing at a node that is not there is not that decision: the k-th
    // mark is about the k-th node wired in, so the later ones land on
    // nothing. A ref mark's mention IS its text, so one landing on nothing
    // writes nothing -- there is no bracket left on screen for the reader to
    // take out, only a sentence closed up over what it was about.
    const at = pooled();
    const first = sourcelessOn(at.nodeType);
    const second = generation(at, 0, 3);

    const verdict = checkProposal({
      nodes: [generation(first), second],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "The second works on what the first made.",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("node(s) are wired into it"),
    });
  });

  it("tells a written node carrying one upstream mark to take the mark out", () => {
    // Such a mark writes no characters, so a body made of one measures empty.
    // Answered for what it is rather than for how long it is, the model takes
    // the mark out instead of padding the node with words.
    const verdict = checkProposal({
      nodes: [
        {
          role: "written",
          type: "text",
          name: "Your copy",
          prompt: [{ slot: { kind: "ref", label: "the picture", note: "Nothing to do" } }],
        },
        generation(sourceless(), 0, 0),
      ],
      edges: [],
      rationale: "",
      groupName: "Copy and a picture",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("Take the mark out"),
    });
  });

  it("measures a mark landing on an unmentionable feeder as the nothing it writes", () => {
    // The canvas writes no mention where the feeder cannot carry one, so the
    // characters it would have carried never reach the box. Read off a list
    // with that place dropped, the mark would be paired with the node next
    // along and the check would judge a string the reader never receives.
    const at = pick(
      (m) => !m.byReference && m.takesPrompt && m.needs.length > 0,
      "mode fed by a panel slot that still takes a prompt",
    );
    const feeder = sourcelessOn(at.needs[0] as GenerationNodeType);
    const pointing = generation(at, 0, 1);

    const verdict = checkProposal({
      nodes: [
        generation(feeder),
        { role: "written", type: "text", name: "The caption", prompt: [{ text: "slow and warm" }] },
        { ...pointing, prompt: (pointing.prompt ?? []).filter((seg) => seg.slot) },
      ],
      edges: [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2 }],
      modelNote: "",
      rationale: "",
      groupName: "Two steps",
    });

    // The one mark lands on the unmentionable feeder, and it is named.
    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("cannot carry a mention of"),
    });
  });

  it("refuses a second mark when only one node is wired in to carry it", () => {
    // The k-th mark is about the k-th node wired in, so a run with more marks
    // than feeders leaves the last ones pointing at nothing. A ref mark lands
    // as a mention and nothing else, so one that resolves to nothing closes
    // the words up over the gap and hands the reader a sentence missing what
    // it was about.
    const at = pick(
      (m) => m.takesPrompt && m.needs.length === 0,
      "prompt-driven mode needing no material",
    );
    const pointing = generation(at, 0, 2);

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "The script", prompt: [{ text: "hello there" }] },
        pointing,
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("node(s) are wired into it"),
    });
  });

  it("tells a mark pointing upstream that what is wired in is material, not upstream work", () => {
    // An empty node is the place the reader drops their own material into, so
    // it reaches the generation through the panel's material slots rather than
    // as upstream work. A mark pointing upstream finds nothing there, and the
    // way out is the other mark -- saying the model cannot mention it would
    // send the model to rewrite words that are not the problem.
    const at = slotted();
    const pointing = generation(at, 0, 1);

    const verdict = checkProposal({
      nodes: [
        { role: "source", type: at.needs[0] as GenerationNodeType, name: "Yours to fill" },
        pointing,
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("material"),
    });
  });

  it("names in a too-long refusal only the nodes whose words were counted", () => {
    // A written node reaches the count through a mark that points at it. One
    // wired in with no mark pointing at it contributes nothing, so naming it
    // sends the model to shorten a node that is not in the number -- and the
    // number does not move, which leaves the refusal with no way out.
    const at = pick(
      (m) => m.takesPrompt && m.needs.length === 0 && m.maxInputChars !== undefined,
      "prompt-driven mode declaring an input cap",
    );
    const cap = at.maxInputChars ?? 0;
    const overlong = generation(at, 0, 0);

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "Pronunciation notes", prompt: [{ text: "soft" }] },
        { ...overlong, prompt: [{ text: "x".repeat(cap + 1) }] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({ ok: false, reason: expect.any(String) });
    expect(verdict.ok ? "" : verdict.reason).not.toContain("Pronunciation notes");
  });

  it("refuses a mark pointing at a node this panel would not take a mention of", () => {
    // A mark pointing upstream lands as a mention and nothing else, and a
    // mention this panel refuses lands as nothing at all: the words on either
    // side close up and the sentence loses what it was about. Which feeders
    // can be mentioned is the catalog's answer, so the check has it.
    const at = pick(
      (m) => !m.byReference && m.takesPrompt && m.needs.length > 0,
      "mode fed by a panel slot that still takes a prompt",
    );
    const first = sourcelessOn(at.needs[0] as GenerationNodeType);
    const second = generation(at, 0, 1);

    const verdict = checkProposal({
      nodes: [generation(first), second],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: "",
      rationale: "The second works on what the first made.",
      groupName: "Two steps",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("cannot carry a mention of"),
    });
  });
});

describe("what the model itself settles", () => {
  it("counts against the pool only what a mention of it puts there", () => {
    // The panel's own ceiling counts the reference IMAGES the prompt mentions
    // (`mentionedReferenceUrls`). A node of words is mentioned too, and its
    // body substitutes into the prompt string rather than going in the pool,
    // so it cannot be the node that puts the group over.
    const at = pick(
      (m) => m.byReference && m.poolCap !== undefined && m.needs[0] === "image",
      "capped pooled mode running on images",
    );
    const cap = at.poolCap ?? 0;

    const verdict = checkProposal({
      nodes: [
        { role: "written", type: "text", name: "The brief", prompt: [{ text: "warm and quiet" }] },
        ...Array.from({ length: cap }, (_, i) => ({
          role: "source" as const,
          type: "image" as const,
          name: `Your material ${String(i + 1)}`,
        })),
        {
          role: "generate",
          type: at.nodeType,
          name: "The result",
          mode: at.mode,
          model: at.model,
          params: {},
          prompt: [
            { text: "follow " },
            { slot: { kind: "ref" as const, label: "the step before", note: "Nothing to do" } },
            ...Array.from({ length: cap }, (_, i) => ({
              slot: {
                kind: "asset" as const,
                label: `your material ${String(i + 1)}`,
                note: "Put it in the empty node",
              },
            })),
          ],
        },
      ],
      edges: [
        { fromIndex: 0, toIndex: cap + 1 },
        ...Array.from({ length: cap }, (_, i) => ({ fromIndex: i + 1, toIndex: cap + 1 })),
      ],
      rationale: "x",
      groupName: "g",
    });

    expect(verdict).toEqual({ ok: true });
  });

  it("tells the model which node upstream each mark pointing there is about", () => {
    const prompt = inputSchema.shape.nodes.element.shape.prompt;

    expect(prompt.description).toMatch(/node wired in/);
    expect(prompt.description).toMatch(/in the order the nodes are listed/);
  });
});

describe("what an edge into a generation is worth", () => {
  /** A mode whose material arrives by slot, with a mode that can make it. */
  const chain = (): { at: Reachable; maker: Reachable } => {
    const at = pick(
      (m) => !m.byReference && m.needs.length > 0 && canConnect(m.needs[0] as string, m.nodeType),
      "slot-fed mode a generation of its own material kind can be wired into",
    );
    const maker = pick(
      (m) => m.nodeType === (at.needs[0] as GenerationNodeType) && m.needs.length === 0 && m.choices.length === 0,
      `mode making a ${String(at.needs[0])} out of nothing`,
    );
    return { at, maker };
  };

  it("stands when that mark is there", () => {
    const { at, maker } = chain();

    const verdict = checkProposal({
      nodes: [
        generation(maker),
        { role: "generate", type: at.nodeType, name: "The result", mode: at.mode, model: at.model,
          params: {}, prompt: [
            { text: "make it move" },
            ...Array.from({ length: at.pieces }, (_, i) => ({
              slot: { kind: "asset" as const, label: `piece ${String(i + 1)}`, note: "Pick it in the slot" },
            })),
            ...Array.from({ length: at.choices.length > 0 ? 1 : 0 }, () => ({
              slot: { kind: "tweak" as const, label: "the voice", note: "Pick one in the panel" },
            })),
          ] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "x", groupName: "g",
    });

    expect(verdict).toEqual({ ok: true });
  });
});

describe("a model the panel draws no prompt box for", () => {
  /** A model the panel draws no prompt editor for. */
  const promptless = (): Reachable =>
    pick((at) => !at.takesPrompt, "model that takes no prompt");

  /** One generation node of a mode that makes a kind out of nothing. */
  const makerOf = (kind: GenerationNodeType): Reachable =>
    pick(
      (m) => m.nodeType === kind && m.needs.length === 0 && m.choices.length === 0,
      `mode making a ${kind} out of nothing`,
    );

  it("refuses words written where no box will hold them", () => {
    // Every mark this proposal owes is there, so the words are the one thing
    // left to judge.
    const at = promptless();

    const verdict = checkProposal({
      nodes: [
        ...at.needs.map((kind) => generation(makerOf(kind))),
        { role: "generate", type: at.nodeType, name: "The result", mode: at.mode, model: at.model,
          params: {}, prompt: [
            { text: "Pick each piece in its slot" },
            ...Array.from({ length: at.pieces }, (_, i) => ({
              slot: { kind: "asset" as const, label: `piece ${String(i + 1)}`, note: "Pick it in the slot" },
            })),
          ] },
      ],
      edges: at.needs.map((_, i) => ({ fromIndex: i, toIndex: at.needs.length })),
      rationale: "x", groupName: "g",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("reach nobody"),
    });
  });

  it("refuses a mark pointing upstream for the same reason, in one sentence", () => {
    // With no editor mounted there is no box for a mention either, so both
    // are turned away together. Answered as "this panel cannot carry a
    // mention of that node" instead, the way out it names is words -- and
    // words are what the clause above refuses for this same model, which
    // leaves the two refusals pointing at each other.
    const at = promptless();
    const upstream = makerOf(at.needs[0] as GenerationNodeType);

    const verdict = checkProposal({
      nodes: [
        generation(upstream),
        ...at.needs.slice(1).map((kind) => generation(makerOf(kind))),
        { role: "generate", type: at.nodeType, name: "The result", mode: at.mode, model: at.model,
          params: {}, prompt: [
            ...Array.from({ length: at.pieces }, (_, i) => ({
              slot: { kind: "asset" as const, label: `piece ${String(i + 1)}`, note: "Pick it in the slot" },
            })),
            { slot: { kind: "ref" as const, label: "the step before", note: "Nothing to do" } },
          ] },
      ],
      edges: at.needs.map((_, i) => ({ fromIndex: i, toIndex: at.needs.length })),
      rationale: "x", groupName: "g",
    });

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("reach nobody"),
    });
    expect(verdict.ok ? "" : verdict.reason).not.toContain("in the words themselves");
  });
});

// What `get_canvas_capabilities` now tells the model a text node is for: one
// holding wording several nodes share, mentioned from each of them rather than
// retyped into every prompt. Pinned here because that sentence is a promise
// about this check -- a rule that started turning the shape away would leave
// the tool describing something a proposal can no longer carry.
describe("a written node several generations draw on", () => {
  it("stands when three nodes each mention the one text node wired into them", () => {
    const at = sourceless();
    const nodes: ProposalNode[] = [
      {
        role: "written",
        type: "text",
        name: "Shared brief",
        prompt: [{ text: "A quiet room at dawn." }],
      },
      { ...generation(at, 0, 1), name: "First result" },
      { ...generation(at, 0, 1), name: "Second result" },
      { ...generation(at, 0, 1), name: "Third result" },
    ];
    expect(
      checkProposal({
        nodes,
        edges: [1, 2, 3].map((toIndex) => ({ fromIndex: 0, toIndex })),
        modelNote: "",
        rationale: "",
        groupName: "Three from one brief",
      }),
    ).toEqual({ ok: true });
  });
});
