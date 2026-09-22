// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Propose a wired group of nodes for the reader to place (#229).
 *
 * The tool hands its input straight back: the card the reader presses is
 * drawn from it, and the placing happens on the canvas. What stands between a
 * careless proposal and that card is `checkProposal`, and every rule it
 * applies is read off the live catalog -- which modes a node offers, which
 * models a mode can reach, and whether that mode needs material only the
 * reader has.
 *
 * A mode that needs material is proposed with an empty node to put each piece
 * of it in, and the prompt has to say, in the place it belongs, what goes in
 * each one -- without that the reader is handed a group whose generate button
 * refuses. Whether an edge joins them depends on how the material reaches the
 * generation: the reference pool is fed by an edge, a slot on the panel's
 * toolbar is not, and the canvas has no legal wiring for the second.
 *
 * Every character of this tool's description and its field descriptions goes
 * out with every turn of every conversation, and is measured against the same
 * budget the messages are (`payload-size.ts`). The refusals below teach the
 * model at the moment it needs it, so the descriptions say the least that
 * gets a first attempt in the right shape.
 *
 * How MANY pieces a reader has to supply is the catalog's answer, from both
 * of its layers (#269): the model declares which of its parameters are filled
 * off the canvas and which may be left empty, and the mode declares whether
 * every one of them has to hold something or any one is enough. So a mode
 * wanting a first and a last frame asks for one type twice and the count says
 * two, which is what a proposal is held to. Which named slot a given node
 * belongs in stays the panel's to know, and its own gate says so.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  canConnect,
  effectiveItemCap,
  evaluateExecute,
  extractPromptText,
  feedersOf,
  GENERATION_NODE_MODES,
  PANEL_EDITOR_PARAM,
  promptPlainText,
  promptTextOf,
  referenceCapExceeded,
  type CanvasProposal,
  type CappedParam,
  type GenerationNodeType,
  type MaterialPath,
  type PromptSegment,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import {
  entriesForNode,
  materialNeeded,
  modelsForMode,
  type ModelInfo,
  type ParamInfo,
} from "@domain/model-catalog/mode-catalog.js";

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

/** Whether a proposal holds together, and what is missing when it does not. */
export type ProposalVerdict = { ok: true } | { ok: false; reason: string };

// Every string below that a card puts on screen is trimmed before it is
// measured: one made of spaces passes a length check and then draws a bullet
// with nothing beside it, or a mark naming nothing. The prompt's own text is
// the exception and is left alone -- a segment of one space is how two marks
// are kept apart, and trimming it would run them together.
const promptSegment = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      slot: z
        .object({
          kind: z
            .enum(["asset", "tweak", "ref"])
            .describe(
              "asset: material the reader supplies in an empty node. " +
                "tweak: something only they can pick or write in the panel. " +
                "ref: names the node upstream, not a to-do",
            ),
          label: z.string().trim().min(1),
          note: z
            .string()
            .trim()
            .min(1)
            .describe("The line this puts on the card"),
        })
        .strict(),
    })
    .strict(),
]);

const proposalNode = z
  .object({
    role: z
      .enum(["source", "generate", "written"])
      .describe("written holds finished words; source is empty for the reader to fill"),
    type: z.enum([...NODE_TYPES, "text"]),
    name: z.string().trim().min(1).describe("What the reader sees on the node"),
    mode: z.string().min(1).optional().describe("role generate only"),
    model: z.string().min(1).optional().describe("role generate only"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "role generate only. Each value has to be one its control offers. " +
          "Leave out what a wired node, the vendor's list or the panel's own " +
          "box fills",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "What to generate, or the words a written node holds. Mark one place " +
          "per empty node; the k-th mark is about the k-th empty node",
      ),
  })
  .strict();

/**
 * What the tool accepts before any of the checks below run.
 *
 * Exported for the test that pins it: what the schema turns away never
 * reaches `checkProposal`, so the two halves of "a proposal the reader can
 * press" are held by one file and read by one test.
 */
export const inputSchema = z
  .object({
    nodes: z
      .array(proposalNode)
      .min(1)
      .describe("The nodes to place, left to right"),
    edges: z
      .array(
        z.object({ fromIndex: z.number().int(), toIndex: z.number().int() }).strict(),
      )
      .describe("Wiring inside this group; indices point into nodes"),
    modelNote: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What this model is for, and what it costs"),
    rationale: z.string().trim().min(1).describe("Why this shape, in a sentence or two"),
    groupName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What the group is for"),
  })
  .strict();

/**
 * The KINDS of source material a mode needs, per the models that reach it.
 *
 * Kinds, not pieces: the catalog answers "this mode runs on pictures", never
 * "on two of them". Counting these would refuse a first-and-last-frame
 * proposal for marking two places and wave through one that marked one.
 * @param nodeType - The node the mode belongs to.
 * @param mode - The mode being proposed.
 * @returns Every source kind any reachable model asks for in that mode.
 * @throws {never} Never.
 */
function sourceKinds(nodeType: GenerationNodeType, mode: string): string[] {
  const needed = new Set<string>();
  for (const entry of entriesForNode(nodeType)) {
    for (const source of entry.sourcesByMode[mode] ?? []) needed.add(source);
  }
  return [...needed];
}

/**
 * The parameter a model fills from nodes wired into it, when it has one.
 *
 * Two gates turn on this answer -- whether an empty node has to be wired in
 * at all, and what a mark in the prompt lands as once the group is placed --
 * so it is given once.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @returns The pool parameter, or undefined when material arrives by slot.
 * @throws {never} Never.
 */
function poolParam(chosen: ModelInfo): ParamInfo | undefined {
  return Object.values(chosen.params).find((info) => info.fromReferencePool === true);
}

/**
 * Which way one proposed node takes the reader's material.
 *
 * Answered here because the catalog is the authority and this file is the
 * only place that reads it. A node the catalog cannot place -- no mode, no
 * model, a model it does not carry -- is left unanswered, and the
 * per-generation check says what is wrong with it in its own words.
 * @param node - The proposed node.
 * @returns Its path, or undefined when the node generates nothing.
 * @throws {never} Never.
 */
function materialPathOf(node: ProposalNode): MaterialPath | undefined {
  if (node.role !== "generate" || node.type === "text") return undefined;
  const { mode, model } = node;
  if (!mode || !model) return undefined;
  const reachable = modelsForMode(node.type, mode);
  if (!reachable.available) return undefined;
  const chosen = reachable.models.find((m) => m.name === model);
  if (!chosen) return undefined;
  return poolParam(chosen) ? "pool" : "slot";
}

/**
 * A capped parameter in the words the shared cap rule reads it in.
 *
 * The catalog projects a parameter into camel case and the rule is stated on
 * the wire shape, so the two names for one fact meet here rather than the rule
 * being written a second time for this caller.
 * @param info - What the catalog says about the parameter.
 * @returns The same two fields, named the way the rule asks for them.
 * @throws {never} Never.
 */
function capShapeOf(info: ParamInfo): CappedParam {
  return {
    ...(info.maxItems === undefined ? {} : { max_items: info.maxItems }),
    ...(info.maxItemsWhen === undefined ? {} : { max_items_when_present: info.maxItemsWhen }),
  };
}

/**
 * Whether a parameter is one only the reader can fill, in the panel.
 *
 * Exported because three readings turn on it and they have to agree: a value
 * set here is refused, a control left to them has to be marked in the prompt,
 * and the fixtures build their proposals to match. Answered differently, the
 * model is told to leave a value out and never told to mark its place, and
 * the group lands with a control the reader must set and nothing saying so.
 * @param name - The parameter's name.
 * @param info - What the catalog says about it.
 * @returns True when the reader fills it once the group is placed.
 * @throws {never} Never.
 */
export function theirsToFill(name: string, info: ParamInfo): boolean {
  return info.valuesFrom !== undefined || name === PANEL_EDITOR_PARAM;
}

/**
 * Whether the panel will draw this control for the proposal as it stands.
 *
 * A control can hang on a switch of the same model: the camera wheels appear
 * once the camera is enabled and their values are thrown away until it is, and
 * the lyrics box goes away the moment the track is marked instrumental. The
 * switch is part of the proposal, so whether the reader will see the control is
 * answered here rather than by asking whether the model declares it. A gate on
 * a source is already settled by the projection, which reports a control with
 * no slot behind it as having no control at all.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param params - What the proposal fills in.
 * @param info - What the catalog says about the parameter.
 * @returns True when the reader will have that control in front of them.
 * @throws {never} Never.
 */
function isDrawn(
  chosen: ModelInfo,
  params: Record<string, unknown>,
  info: ParamInfo,
): boolean {
  const gate = info.gate;
  if (gate === undefined || gate.kind === "source") return true;
  const held = params[gate.param];
  const on = typeof held === "boolean" ? held : chosen.params[gate.param]?.default === true;
  return gate.kind === "flagOn" ? on : !on;
}

/**
 * Judge the values a proposal filled in against what the model declares.
 *
 * The panel offers a control per parameter and that control is what a reader
 * would have used; a value it would not have offered is one that reaches the
 * upstream unchecked.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param node - The node being judged.
 * @returns Whether every value stands, and which one does not.
 * @throws {never} Never.
 */
function checkParams(chosen: ModelInfo, node: ProposalNode): ProposalVerdict {
  const declared = Object.keys(chosen.params);
  for (const [key, value] of Object.entries(node.params ?? {})) {
    const info = chosen.params[key];
    if (!info) {
      return {
        ok: false,
        reason: `"${chosen.name}" declares no ${key}. It takes: ${declared.join(", ") || "no parameters"}.`,
      };
    }
    if (theirsToFill(key, info)) {
      return {
        ok: false,
        reason: info.valuesFrom !== undefined
          ? `"${key}" is picked from a list only ${info.valuesFrom} holds, so it cannot be written here. Leave it out and mark the choice in the prompt.`
          : `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out and mark the place in the prompt.`,
      };
    }
    if (info.filledBySource === true) {
      // Two ways that material arrives, and the sentence names the one this
      // model uses: through the pool an edge carries it, through a slot the
      // reader clicks a node on the canvas. Said the other way round, it
      // sends the model off to wire an edge the panel never reads.
      return {
        ok: false,
        reason: info.fromReferencePool === true
          ? `"${key}" carries the reader's own material, which arrives by wiring an empty node in. Leave it out.`
          : `"${key}" carries the reader's own material, which they put in a slot on the panel. Leave it out.`,
      };
    }
    if (info.noControl === true) {
      return {
        ok: false,
        reason: `The panel draws no control for "${key}", so the reader can neither see it nor change it. Leave it out.`,
      };
    }
    if (!isDrawn(chosen, node.params ?? {}, info)) {
      const gate = info.gate as { kind: "flagOn" | "flagOff"; param: string };
      return {
        ok: false,
        reason: `"${key}" only counts while "${gate.param}" is ${gate.kind === "flagOn" ? "on" : "off"}, and this proposal leaves it the other way. Set that switch or leave "${key}" out.`,
      };
    }
    const options = info.options ?? [];
    if (options.length > 0 && !options.some((offered) => offered === value)) {
      return {
        ok: false,
        reason: `The control for "${key}" offers ${options.map((o) => JSON.stringify(o)).join(", ")}, not ${JSON.stringify(value)}.`,
      };
    }
    if (info.min === undefined && info.max === undefined) continue;
    if (typeof value !== "number") {
      return { ok: false, reason: `"${key}" takes a number, not ${JSON.stringify(value)}.` };
    }
    if ((info.min !== undefined && value < info.min) || (info.max !== undefined && value > info.max)) {
      return {
        ok: false,
        reason: `"${key}" runs from ${String(info.min ?? "?")} to ${String(info.max ?? "?")}, and this one is ${String(value)}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * The prompt as the panel will measure it once the group is placed.
 *
 * A mark pointing upstream writes no text of its own, and at Generate time
 * the body of the text node it names takes its place in the string the panel
 * measures (`serializePromptText`). Measured as nothing, a script past the
 * model's cap is placed and the reader meets the refusal at a button they
 * cannot fix from -- the words are in another node.
 *
 * A mark naming anything else substitutes nothing there either, so it counts
 * for nothing here.
 * @param prompt - The proposed prompt.
 * @param named - The nodes its marks point at, in the order they are marked.
 * @returns The text to measure against the model's cap.
 * @throws {never} Never.
 */
function measuredPrompt(
  prompt: readonly PromptSegment[],
  named: readonly ProposalNode[],
): string {
  let seen = 0;
  return prompt
    .map((segment) => {
      if (segment.slot?.kind !== "ref") return promptTextOf([segment]);
      const node = named[seen];
      seen += 1;
      return node?.role === "written" ? promptPlainText(node.prompt ?? []) : "";
    })
    .join("");
}

/**
 * Judge one generation node against the catalog and its own group.
 * @param proposal - The whole proposal, for reading the group around it.
 * @param node - The node being judged.
 * @param index - Where it sits, for naming it in a refusal.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkGenerateNode(
  proposal: CanvasProposal,
  node: ProposalNode,
  index: number,
): ProposalVerdict {
  const { mode, model } = node;
  if (node.type === "text") {
    return {
      ok: false,
      reason: `"${node.name}" is a text node, and nothing is generated into one. Write the words yourself and send it as a written node.`,
    };
  }
  const nodeType: GenerationNodeType = node.type;
  if (!mode || !model) {
    return { ok: false, reason: `Node ${index} generates, so it needs a mode and a model.` };
  }
  // A mode this node never had and a mode no model here backs are the same
  // answer from the reader's side -- it cannot be proposed -- and
  // `modelsForMode` already names what the node does offer instead.
  const reachable = modelsForMode(nodeType, mode);
  if (!reachable.available) {
    return {
      ok: false,
      reason: reachable.offered.length > 0
        ? `No model here backs "${mode}" on a ${nodeType} node. It offers: ${reachable.offered.join(", ")}.`
        : `A ${nodeType} node can generate nothing right now.`,
    };
  }
  const chosen = reachable.models.find((m) => m.name === model);
  if (!chosen) {
    return {
      ok: false,
      reason: `"${model}" does not back "${mode}". Those that do: ${reachable.models.map((m) => m.name).join(", ")}.`,
    };
  }
  const values = checkParams(chosen, node);
  if (!values.ok) return values;

  const prompt = node.prompt ?? [];
  // Two ways the reader's material reaches a generation: the reference pool,
  // which an edge feeds, and a slot on the panel's toolbar, which the reader
  // fills by clicking any node of that kind anywhere on the canvas. Which one
  // this model uses is what it declares, carried here by the same projection
  // the agent is answered out of.
  //
  // Read before the prompt gate below, because what that gate measures
  // depends on which nodes this prompt can name.
  const pool = poolParam(chosen);
  const byReference = pool !== undefined;
  // The one reading of what feeds a node, shared with the card that files its
  // to-dos by it and the canvas that writes its mentions from it. A second
  // walk over the edges here is how the three come to disagree about which
  // node the k-th mark is about.
  const held = feedersOf(proposal, index);
  /**
   * The nodes behind a run of feeder indices, in the proposal's own order.
   * @param list - The indices to resolve.
   * @returns One node per index.
   * @throws {never} Never.
   */
  const nodesAt = (list: readonly number[]): ProposalNode[] =>
    list.flatMap((i) => proposal.nodes[i] ?? []);
  const fed = nodesAt(held.sources);
  // One mark per node upstream this prompt can name, and no more: an edge
  // makes that node's work available, and nothing in the prompt naming it
  // means the Generate button will not move.
  //
  // Which of them can be named is not the same on the two paths. Through the
  // pool a mention picks anything wired in. Through a slot the reader picks
  // their material by clicking and the panel turns a mention of it away
  // (`insertRefusal`) -- what stays nameable there is a node holding words,
  // whose body substitutes into the prompt and asks the pool for nothing.
  const upstream = nodesAt(held.upstream);
  const nameable = byReference ? upstream : upstream.filter((n) => n.role === "written");
  // What the panel's own gate would say about the box this proposal fills in.
  // It is asked with the text the box will hold (`promptTextOf`), so the two
  // judge the same string; the sentences differ because this one is read by
  // the model that sent the proposal rather than by the reader.
  //
  // Imprecise in one direction, and only after this group is on the canvas: a
  // reference the reader @-mentions writes nothing into the text, so the
  // spaces around it collapse to one and the box holds a character less than
  // it looks. A prompt proposed at exactly the cap can therefore be refused
  // by a character once the reader mentions something in it (#268).
  // Measured once and reported from the same string: a sentence quoting the
  // unsubstituted length names a number below the cap it just refused on, and
  // tells the model to shorten a prompt that holds none of those characters.
  const measured = measuredPrompt(prompt, nameable);
  const verdict = evaluateExecute({
    promptText: measured,
    model,
    nodeStatus: "idle",
    isSubmitting: false,
    promptRequired: chosen.takesPrompt,
    ...(chosen.maxInputChars === undefined ? {} : { maxInputChars: chosen.maxInputChars }),
  });
  if (verdict?.refusal === "prompt-missing" || verdict?.refusal === "style-missing") {
    return {
      ok: false,
      reason: `"${model}" generates from what the prompt says, and this proposal writes nothing in it.`,
    };
  }
  if (verdict?.refusal === "prompt-too-long") {
    const written = [...extractPromptText(measured)].length;
    // The words are often in another node, and "shorten it" is not something
    // the model can act on until it knows which one.
    const holding = nameable.filter((n) => n.role === "written").map((n) => `"${n.name}"`);
    return {
      ok: false,
      reason: `"${model}" takes ${String(chosen.maxInputChars)} characters and this prompt is ${String(written)}${holding.length > 0 ? `, counting the words in ${holding.join(", ")}` : ""}. Shorten it, or propose a model that takes it.`,
    };
  }

  // Two things a proposal cannot put in and the panel refuses to run without:
  // a value fetched from the vendor, which nobody here has seen, and the words
  // the panel keeps in a box of its own. Both are the reader's to fill once
  // the group is on the canvas, and the prompt is where they are told so.
  const theirs = Object.entries(chosen.params)
    .filter(([name, info]) => theirsToFill(name, info))
    .filter(([, info]) => isDrawn(chosen, node.params ?? {}, info))
    .map(([name]) => name);
  if (theirs.length > 0 && !prompt.some((s) => s.slot?.kind === "tweak")) {
    return {
      ok: false,
      reason: `"${model}" leaves ${theirs.join(", ")} for the reader to fill in the panel, so mark that place in the prompt.`,
    };
  }

  // That difference decides what this generation is judged against. Through
  // the pool an edge says which nodes reach it, so it answers for its own
  // feeders and for nothing else -- a group carrying three generations has
  // three separate answers. Through a slot there is no edge to read, so every
  // empty node in the group is one the reader could pick here.
  const needed = sourceKinds(nodeType, mode);
  // A mode that asks for nothing has no intake path of either sort, so it too
  // answers for what is wired into it -- an empty node somewhere else in the
  // group belongs to whichever generation reads it, not to this one.
  //
  // Counted over the edges that carry material, not over every edge: a node
  // holding words is wired in to be read, and taking that edge for a hand on
  // the material turns away a group whose empty node the reader was going to
  // fill in the panel.
  // What reaches here already carrying work of its own. A node holding words
  // is not that -- it is words this generation reads.
  const madeUpstream = upstream.filter((n) => n.role === "generate");
  // Three readings, three names. They answer different questions and two of
  // them want opposite things, so one list serving all three is how a rule
  // ends up charging this generation for another's material.
  //
  // `mine`: the empty nodes this generation answers for. Through the pool an
  // edge is how material gets in at all, so it answers for its feeders and
  // nothing else. Through a slot the reader fills by clicking any node of
  // that kind on the canvas, so an edge says "this one is for you" without
  // taking the group's others away: a mode wanting a picture and a clip is
  // given the picture by the step before it and finds the clip sitting in the
  // group, unwired because it has made nothing to draw on.
  const mine = byReference
    ? fed
    : [
        ...fed,
        ...proposal.nodes.filter(
          (n) => n.role === "source" && needed.includes(n.type) && !fed.includes(n),
        ),
      ];
  // `reaching`: everything arriving here that carries work, whoever made it.
  // An upstream generation supplies material as surely as an empty node does.
  // The pool's ceiling counts this one whole, because the pool holds what
  // reaches it, of every kind.
  const reaching = [...mine, ...madeUpstream];
  // `usable`: of what reaches here, the kinds this mode actually reads. Every
  // question about whether the material is there and whether there is enough
  // of it is asked of this one.
  const usable = reaching.filter((n) => needed.includes(n.type));
  const marks = prompt.filter((s) => s.slot?.kind === "asset");
  const points = prompt.filter((s) => s.slot?.kind === "ref");
  // Judged before the early return below, so a mode generating from its
  // prompt alone cannot carry a mark whose words are quietly swallowed on the
  // way to the canvas.
  if (points.length !== nameable.length) {
    // Where there is nothing to name at all, say why rather than counting:
    // the count alone sends the model off to wire something the panel would
    // not read either.
    if (!byReference && nameable.length === 0) {
      return {
        ok: false,
        reason: needed.length === 0
          ? `"${mode}" generates from what the prompt says and reads nothing upstream, so a mark pointing there reaches nothing. Write what you mean into the prompt.`
          : `"${mode}" takes its material from a slot on the toolbar, and only a node carrying words can be named in its prompt. Write what you mean into the prompt, or say in your message which slot to pick the material in.`,
      };
    }
    return {
      ok: false,
      reason: points.length > nameable.length
        ? `The prompt points at ${String(points.length)} node(s) upstream and ${String(nameable.length)} feed${nameable.length === 1 ? "s" : ""} node ${String(index)} with work it can name. Take the extra mark(s) out.`
        : `${String(nameable.length)} node(s) feed node ${String(index)} with work this prompt can name, and it points at ${String(points.length)}. Mark the place in the prompt that points at each.`,
    };
  }
  if (needed.length === 0) {
    // Nothing goes in an empty node here, and a marked place with no node
    // behind it reads as an instruction the reader cannot carry out.
    if (mine.length > 0) {
      return {
        ok: false,
        reason: `"${mode}" asks nothing of the reader, and an empty node is wired into it. Wire that one to whatever reads it.`,
      };
    }
    return marks.length === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `"${mode}" asks nothing of the reader, and the prompt marks ${String(marks.length)} place(s) for material. Take the marks out.`,
        };
  }

  // The reader is the only one who has this material, so the group has to
  // carry somewhere to put it -- of the kind that holds it, and nothing else.
  // Without that the generate button refuses and nothing on screen says why.
  const stray = mine.find((n) => !needed.includes(n.type));
  if (stray) {
    return {
      ok: false,
      reason: `"${mode}" reads ${needed.join(", ")}, and an empty ${stray.type} node is wired into it, which it cannot take. Wire that one to whatever reads it.`,
    };
  }
  const missing = needed.filter((kind) => !usable.some((n) => n.type === kind));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `"${mode}" needs ${needed.join(", ")}, and nothing reaching node ${String(index)} carries ${missing.join(", ")}.`,
    };
  }

  // How many pieces the reader has to supply comes from both layers of the
  // catalog: the model says which of its parameters are slots and which may be
  // left empty, and the mode says whether every slot has to hold something or
  // any one of them is enough.
  // Counted over everything that carries a kind this mode reads, whoever made
  // it: a slot is filled by clicking any node of that kind on the canvas, and
  // the picture the step before it made is one of those. So "draw the shoe,
  // then animate it" is a flow of two generations and nothing for the reader
  // to find.
  const asked = materialNeeded(nodeType, mode, model);
  // Through a slot, the group has to offer somewhere to put each piece, and
  // it may offer more: the reader fills a slot by clicking, so two empty
  // nodes beside two generations that take one piece each is one of them
  // apiece, not two reaching either. Counting the group's empty nodes as
  // what reaches one generation turns that group away with a number no
  // legal edge can change -- an empty audio node cannot even be wired to an
  // audio generation (`canConnect`).
  if (!byReference && usable.length < asked) {
    return {
      ok: false,
      reason: `"${mode}" takes ${String(asked)} piece(s) of ${needed.join(", ")}, and the group offers ${String(usable.length)} place(s) to put ${asked === 1 ? "it" : "them"}.`,
    };
  }
  // The pool has a ceiling as well, stated by the model and enforced by the
  // panel by name, so a group placed over it is filled by the reader and then
  // turned away. Read through the one function the panel, the server and the
  // worker read, so the number is the same everywhere it is judged. Everything
  // wired in counts against it, an upstream generation as much as an empty
  // node -- the pool holds what reaches it, not what the reader put there.
  const cap = pool && effectiveItemCap(capShapeOf(pool), node.params ?? {});
  const over = byReference ? referenceCapExceeded(reaching.length, cap) : null;
  if (over) {
    return {
      ok: false,
      reason: `"${model}" holds ${String(over.limit)} reference(s) at a time, and ${String(reaching.length)} node(s) reach node ${String(index)}.`,
    };
  }

  // One mark per piece the reader supplies, in the place it belongs, rather
  // than naming one of them and leaving the rest sitting there unexplained.
  //
  // Which number that is differs by path, because the mark says a different
  // thing on each. Through the pool it names an empty node wired in, so the
  // count is those. Through a slot it says which slot the reader picks this
  // kind of thing in, so the count is what the model asks for less what the
  // step before it already made -- the group's other empty nodes belong to
  // whatever else reads them.
  const supplied = madeUpstream.filter((n) => needed.includes(n.type)).length;
  const wanted = byReference ? mine.length : Math.max(0, asked - supplied);
  if (marks.length !== wanted) {
    return {
      ok: false,
      reason: byReference
        ? `The group carries ${String(mine.length)} empty node(s) and the prompt marks ${String(marks.length)} place(s). Mark each one where it belongs.`
        : `"${mode}" takes ${String(wanted)} piece(s) from the reader and the prompt marks ${String(marks.length)} place(s). Mark each one, saying which slot to pick it in.`,
    };
  }
  return { ok: true };
}

/**
 * Whether one node is the thing its role says it is.
 *
 * The three roles differ in what they carry, not only in what they are called:
 * an empty node holds nothing, a written one holds finished words and so can
 * only be a text node, and a generation is configured. A node whose role and
 * contents disagree lands on the canvas as something the reader cannot use.
 * @param node - The node being judged.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
function checkNodeRole(node: ProposalNode): ProposalVerdict {
  const configured =
    node.mode !== undefined || node.model !== undefined || node.params !== undefined;
  if (node.role === "source") {
    // Words are the one kind of material nobody has to go and find: an empty
    // text node is a click away, so proposing one asks for work rather than
    // saving any. Write the words instead, as a written node.
    if (node.type === "text") {
      return {
        ok: false,
        reason: `"${node.name}" is an empty text node, which the reader makes in one click. Write the words yourself and send it as a written node, or leave it out.`,
      };
    }
    if (configured || node.prompt !== undefined) {
      return {
        ok: false,
        reason: `"${node.name}" is an empty node for the reader to fill, so it takes no mode, model, parameters or prompt.`,
      };
    }
    return { ok: true };
  }
  if (node.role !== "written") return { ok: true };

  if (node.type !== "text") {
    return {
      ok: false,
      reason: `"${node.name}" carries words, and a text node is the only one that holds those.`,
    };
  }
  if (configured) {
    return {
      ok: false,
      reason: `"${node.name}" already holds its words, so it takes no mode and no model -- nothing is generated there.`,
    };
  }
  // Without them it lands as an empty text node, which is the thing a reader
  // makes in a click and has no use for in a proposal.
  if ((node.prompt ?? []).length === 0) {
    return { ok: false, reason: `"${node.name}" says it holds words and carries no words.` };
  }
  // Both marks that reach outside the words land as a mention, and a text
  // node's body holds none: one would ask for material nothing here reads,
  // the other would name a node nothing here looks at. Whatever they say
  // belongs in the message this proposal travels with.
  const reaching = (node.prompt ?? []).find(
    (segment) => segment.slot?.kind === "asset" || segment.slot?.kind === "ref",
  );
  if (reaching) {
    return {
      ok: false,
      reason: `"${node.name}" holds words the reader keeps as they are, and nothing there reaches another node. Take the mark out and mention what you meant in your own message.`,
    };
  }
  return { ok: true };
}

/**
 * Whether the edges lead anywhere, or run in a circle.
 *
 * An edge stands for one node drawing on another, so a ring of them says every
 * node waits on the next and the reader has nowhere to start.
 * @param proposal - What the model proposed.
 * @returns True when some edge leads back to where it started.
 * @throws {never} Never.
 */
function hasRing(proposal: CanvasProposal): boolean {
  const leadsTo = proposal.nodes.map<number[]>(() => []);
  for (const edge of proposal.edges) leadsTo[edge.fromIndex]?.push(edge.toIndex);
  // 0 not walked, 1 on the path being walked now, 2 walked and left behind.
  const state = proposal.nodes.map(() => 0);
  /**
   * Follow every edge out of one node, looking for the way back to it.
   * @param at - The node to walk from.
   * @returns True when this walk meets a node already on its own path.
   * @throws {never} Never.
   */
  const walk = (at: number): boolean => {
    if (state[at] === 1) return true;
    if (state[at] === 2) return false;
    state[at] = 1;
    for (const next of leadsTo[at] ?? []) {
      if (walk(next)) return true;
    }
    state[at] = 2;
    return false;
  };
  return proposal.nodes.some((_, at) => walk(at));
}

/**
 * Whether anything in the group would read what the reader puts in this node.
 *
 * The two paths ask different questions, because they are answered at
 * different moments. A generation fed by the reference pool takes what its
 * edges bring it, so the empty node has to be wired into one. A generation fed
 * by a slot on the toolbar is filled by the reader clicking any node of that
 * kind anywhere on the canvas -- there is no edge to look for, so it is enough
 * that some generation here asks for that kind.
 *
 * A node whose mode or model the catalog does not know answers yes and is
 * skipped: the per-generation check refuses it by name a few lines later, and
 * a no here would speak first, about a different node and a different fault.
 * @param proposal - The whole proposal.
 * @param node - The empty node being asked about.
 * @param at - Where it sits, for reading the edges into it.
 * @returns True when some generation in the group would read it.
 * @throws {never} Never.
 */
function isReadBySomething(
  proposal: CanvasProposal,
  node: ProposalNode,
  at: number,
): boolean {
  return proposal.nodes.some((other, into) => {
    if (other.role !== "generate" || other.type === "text") return false;
    const { mode, model } = other;
    if (!mode || !model) return true;
    const reachable = modelsForMode(other.type, mode);
    if (!reachable.available) return true;
    const chosen = reachable.models.find((m) => m.name === model);
    if (!chosen) return true;
    return poolParam(chosen)
      ? proposal.edges.some((e) => e.fromIndex === at && e.toIndex === into)
      : sourceKinds(other.type, mode).includes(node.type);
  });
}

/**
 * Whether a proposal states a flow the reader can carry out.
 *
 * Pure, so the rule it applies is the one a test can hold: the catalog goes
 * in through `entriesForNode` and `modelsForMode`, and nothing else is read.
 *
 * Shape is the model's to decide -- one generation, one empty node feeding
 * three of them, words standing beside them -- within one bound: something
 * here generates. What is asked of every shape is that it states itself: each
 * node is what its role says, each edge stands for one node drawing on
 * another, and a group of two or more says what it is for.
 * @param proposal - What the model proposed.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkProposal(proposal: CanvasProposal): ProposalVerdict {
  for (const node of proposal.nodes) {
    const verdict = checkNodeRole(node);
    if (!verdict.ok) return verdict;
  }

  // A node earns its place on the canvas one of two ways: something generates
  // there, or it stands in a relation the reader would otherwise have to keep
  // in their head. Words with neither are words, and a reply carries those --
  // the reader reads them, takes them, and asks for another version in the
  // same breath, where placing, pressing and undoing buys them nothing.
  if (!proposal.nodes.some((node) => node.role === "generate")) {
    // The second sentence is about words, so it is said only where there are
    // words to say it about. On a group of empty nodes it would send the
    // model off to write copy nobody asked for.
    const words = proposal.nodes.some((node) => node.role === "written");
    return {
      ok: false,
      reason: words
        ? "Nothing here generates, so this is words the reader can read and take from your message. Write them in your reply instead."
        : "Nothing here generates, so a card placed from this leaves the reader nothing to press. Propose what gets made, or say in your reply what they should do.",
    };
  }

  for (const edge of proposal.edges) {
    const ends = [edge.fromIndex, edge.toIndex];
    if (ends.some((i) => i < 0 || i >= proposal.nodes.length)) {
      return { ok: false, reason: `An edge points outside the group: ${JSON.stringify(edge)}.` };
    }
    if (edge.fromIndex === edge.toIndex) {
      return { ok: false, reason: `An edge loops node ${edge.fromIndex} onto itself.` };
    }
    // An edge is how one node draws on another's material, so it can only end
    // where something reads it. Ending anywhere else, it is drawn on the canvas
    // saying a relation that nothing acts on.
    const into = proposal.nodes[edge.toIndex];
    const outOf = proposal.nodes[edge.fromIndex];
    if (into && into.role !== "generate") {
      return {
        ok: false,
        reason: `An edge flows into "${into.name}", which generates nothing, so nothing there reads what it carries.`,
      };
    }
    // The same whitelist the canvas holds a reader's own drag to. A line they
    // could not draw by hand is one the agent may not draw for them.
    if (into && outOf && !canConnect(outOf.type, into.type)) {
      return {
        ok: false,
        reason: `The canvas does not let a ${outOf.type} node feed a ${into.type} node, by your hand or theirs.`,
      };
    }
  }
  if (hasRing(proposal)) {
    return {
      ok: false,
      reason: "Those edges make a ring, and a ring says nothing about what the reader presses first.",
    };
  }

  // Two or more nodes land inside a group, which the reader sees as one thing
  // on a ground of its own. Only the model knows what that thing is for -- it
  // just decided -- so the name comes with the proposal.
  if (proposal.nodes.length > 1 && (proposal.groupName ?? "").trim() === "") {
    return {
      ok: false,
      reason: "Two or more nodes land together in a group, so give the group a name saying what it is for.",
    };
  }

  // An empty node is where the reader puts material for something to read, so
  // one nothing reads leaves them filling a box that goes nowhere.
  const unread = proposal.nodes.findIndex(
    (node, at) => node.role === "source" && !isReadBySomething(proposal, node, at),
  );
  if (unread >= 0) {
    return {
      ok: false,
      reason: `"${proposal.nodes[unread]?.name ?? ""}" waits for the reader's material, and nothing in the group reads it.`,
    };
  }

  for (const [index, node] of proposal.nodes.entries()) {
    if (node.role !== "generate") continue;
    const verdict = checkGenerateNode(proposal, node, index);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * What the tool answers with: the proposal as it will be placed, or a refusal.
 *
 * Exported so a test can read the answer without standing up a tool call:
 * everything below `execute` is this function, and a test that reached it
 * through the SDK would be pinning the SDK's calling convention.
 * @param proposal - What the model sent.
 * @returns The answer the card and the canvas read.
 * @throws {never} Never.
 */
export function answerFor(proposal: CanvasProposal): ProposalAnswer {
  const verdict = checkProposal(proposal);
  if (!verdict.ok) return { placed: false, reason: verdict.reason };
  // The catalog answer the canvas needs, given once by the side that has
  // just read it. Asked again over there it could be absent -- the reader
  // may press Use before the catalog loads -- and a guess either writes a
  // mention the panel refuses or drops one the pool needs.
  return {
    ...proposal,
    nodes: proposal.nodes.map((node) => {
      const takesFrom = materialPathOf(node);
      return takesFrom === undefined ? node : { ...node, takesFrom };
    }),
    placed: true,
  };
}

/**
 * The one line the model reads back.
 *
 * The proposal itself is for the reader, not for the model -- it sent the
 * thing, and repeating it into every later turn costs the whole payload again.
 * @param answer - What the tool answered.
 * @returns A sentence saying it is on screen, or why it is not.
 */
export function renderProposalForModel(answer: ProposalAnswer): string {
  return answer.placed
    ? "The proposal is on screen as a card. The reader decides whether to place it."
    : `That proposal was refused, so nothing is on screen. ${answer.reason}`;
}

export const proposeCanvasAction: Tool<z.infer<typeof inputSchema>, ProposalAnswer> = tool({
  description:
    "Propose the canvas nodes for what the reader asked for, as a card they " +
    "place with one press. Something has to generate here: asked for words " +
    "and nothing else, write them in your reply instead. You decide the " +
    "shape: an empty node and a generation for a picture; the copy for the " +
    "same job as a written node beside them, rather than in your reply; one " +
    "empty node feeding several generations for several takes on one thing. " +
    "Before proposing any shape with an empty node in it, ask_user once " +
    "whether they have that material -- you cannot see their canvas, and the " +
    "answer decides the shape. Wire an edge only where one node draws on what " +
    "another made; belonging together is said by the group, not by edges. " +
    "Ask get_canvas_capabilities and list_generation_models first, and " +
    "propose only a mode and model they returned. Mark in the prompt each " +
    "piece of material they supply and where it goes -- for most modes a " +
    "slot on the panel -- plus anything the panel leaves them to pick, and " +
    "say in your reply what is left to do by hand.",
  inputSchema,
  metadata: { runningLine: "chat.tool.proposingNodes" },
  toModelOutput: ({ output }) => ({ type: "text", value: renderProposalForModel(output) }),
  execute: async (
    proposal: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and returns, so there is nothing to
    // abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<ProposalAnswer> => {
    return answerFor(proposal);
  },
});
