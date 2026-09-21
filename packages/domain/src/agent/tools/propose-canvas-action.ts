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
  GENERATION_NODE_MODES,
  PANEL_EDITOR_PARAM,
  promptTextOf,
  referenceCapExceeded,
  type CanvasProposal,
  type CappedParam,
  type GenerationNodeType,
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
    name: z.string().min(1).describe("What the reader sees on the node"),
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
    if (info.valuesFrom !== undefined) {
      return {
        ok: false,
        reason: `"${key}" is picked from a list only ${info.valuesFrom} holds, so it cannot be written here. Leave it out and mark the choice in the prompt.`,
      };
    }
    if (key === PANEL_EDITOR_PARAM) {
      return {
        ok: false,
        reason: `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out and mark the place in the prompt.`,
      };
    }
    if (info.filledBySource === true) {
      return {
        ok: false,
        reason: `"${key}" carries the reader's own material, which arrives by wiring an empty node in. Leave it out.`,
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
  const verdict = evaluateExecute({
    promptText: promptTextOf(prompt),
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
    const written = [...extractPromptText(promptTextOf(prompt))].length;
    return {
      ok: false,
      reason: `"${model}" takes ${String(chosen.maxInputChars)} characters and this prompt is ${String(written)}. Shorten it, or propose a model that takes it.`,
    };
  }

  // Two things a proposal cannot put in and the panel refuses to run without:
  // a value fetched from the vendor, which nobody here has seen, and the words
  // the panel keeps in a box of its own. Both are the reader's to fill once
  // the group is on the canvas, and the prompt is where they are told so.
  const theirs = Object.entries(chosen.params)
    .filter(([name, info]) => info.valuesFrom !== undefined || name === PANEL_EDITOR_PARAM)
    .filter(([, info]) => isDrawn(chosen, node.params ?? {}, info))
    .map(([name]) => name);
  if (theirs.length > 0 && !prompt.some((s) => s.slot?.kind === "tweak")) {
    return {
      ok: false,
      reason: `"${model}" leaves ${theirs.join(", ")} for the reader to fill in the panel, so mark that place in the prompt.`,
    };
  }

  // Two ways the reader's material reaches a generation: the reference pool,
  // which an edge feeds, and a slot on the panel's toolbar, which the reader
  // fills by clicking any node of that kind anywhere on the canvas. Which one
  // this model uses is what it declares, carried here by the same projection
  // the agent is answered out of.
  //
  // That difference decides what this generation is judged against. Through
  // the pool an edge says which nodes reach it, so it answers for its own
  // feeders and for nothing else -- a group carrying three generations has
  // three separate answers. Through a slot there is no edge to read, so every
  // empty node in the group is one the reader could pick here.
  const pool = Object.values(chosen.params).find((info) => info.fromReferencePool === true);
  const byReference = pool !== undefined;
  const fedFrom = new Set(
    proposal.edges.filter((e) => e.toIndex === index).map((e) => e.fromIndex),
  );
  const placed = proposal.nodes.map((n, at) => ({ node: n, at }));
  const feeders = placed.filter(({ at }) => fedFrom.has(at));
  const needed = sourceKinds(nodeType, mode);
  // A mode that asks for nothing has no intake path of either sort, so it too
  // answers for what is wired into it -- an empty node somewhere else in the
  // group belongs to whichever generation reads it, not to this one.
  const readsByEdge = byReference || needed.length === 0;
  const sources = (readsByEdge ? feeders : placed).filter(
    ({ node: n }) => n.role === "source",
  );
  // An upstream generation supplies material as surely as an empty node does:
  // the picture it makes lands in the pool the same way. A written node
  // upstream is not material at all -- it is words this generation reads --
  // so it stays out of every count below.
  const supplying = [
    ...sources,
    ...feeders.filter(({ node: n }) => n.role === "generate"),
  ];
  const marks = prompt.filter((s) => s.slot?.kind === "asset");
  // A mark pointing upstream lands as a mention, and a mention only picks from
  // what the reference pool holds. Judged before the early return below, so a
  // mode generating from its prompt alone cannot carry one and have the words
  // quietly swallowed on the way to the canvas.
  const points = prompt.filter((s) => s.slot?.kind === "ref");
  if (points.length > 0 && !byReference) {
    return {
      ok: false,
      reason: needed.length === 0
        ? `"${mode}" generates from what the prompt says and reads nothing upstream, so a mark pointing there reaches nothing. Write what you mean into the prompt.`
        : `"${mode}" takes its material from a slot on the toolbar and never reads the pool a mention picks from, so a mark pointing upstream reaches nothing. Write what you mean into the prompt, or say in your message which slot to pick it in.`,
    };
  }
  if (needed.length === 0) {
    // Nothing goes in an empty node here, and a marked place with no node
    // behind it reads as an instruction the reader cannot carry out.
    if (sources.length > 0) {
      return {
        ok: false,
        reason: `"${mode}" asks nothing of the reader, so the group has no use for an empty node.`,
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
  const stray = sources.find(({ node: n }) => !needed.includes(n.type));
  if (stray) {
    return {
      ok: false,
      reason: `"${mode}" takes ${needed.join(", ")} from the reader, and the group offers an empty ${stray.node.type} node, which nothing here reads.`,
    };
  }
  const missing = needed.filter((kind) => !supplying.some(({ node: n }) => n.type === kind));
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
  // Only a slot the reader clicks is counted here: on that path the panel
  // never reads the pool, so an upstream generation wired in supplies nothing
  // to this call however the edge reads on the canvas.
  const asked = materialNeeded(nodeType, mode, model);
  if (!byReference && sources.length !== asked) {
    return {
      ok: false,
      reason: `"${mode}" takes ${String(asked)} piece(s) of material from the reader, and the group carries ${String(sources.length)} empty node(s).`,
    };
  }
  // The pool has a ceiling as well, stated by the model and enforced by the
  // panel by name, so a group placed over it is filled by the reader and then
  // turned away. Read through the one function the panel, the server and the
  // worker read, so the number is the same everywhere it is judged. Everything
  // wired in counts against it, an upstream generation as much as an empty
  // node -- the pool holds what reaches it, not what the reader put there.
  const cap = pool && effectiveItemCap(capShapeOf(pool), node.params ?? {});
  const over = byReference ? referenceCapExceeded(supplying.length, cap) : null;
  if (over) {
    return {
      ok: false,
      reason: `"${model}" holds ${String(over.limit)} reference(s) at a time, and ${String(supplying.length)} node(s) reach node ${String(index)}.`,
    };
  }

  // One mark per empty node: the prompt says what goes in each one, in the
  // place it belongs, rather than naming one of them and leaving the rest
  // sitting there unexplained.
  if (marks.length !== sources.length) {
    return {
      ok: false,
      reason: `The group carries ${String(sources.length)} empty node(s) and the prompt marks ${String(marks.length)} place(s). Mark each one where it belongs.`,
    };
  }
  // And one mark per node upstream, for the same reason the other way round:
  // an edge only makes that node's work available, and nothing in the prompt
  // naming it means the Generate button will not move.
  const upstream = feeders.filter(({ node: n }) => n.role !== "source");
  if (points.length !== upstream.length) {
    return {
      ok: false,
      reason: `${String(upstream.length)} node(s) feed node ${String(index)} with work of their own, and the prompt points at ${String(points.length)}. Mark the place in the prompt that points at each.`,
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
 * A node whose mode or model the catalog does not know is skipped rather than
 * counted: the per-generation check says what is wrong with it, in its own
 * words, a few lines later.
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
    if (!mode || !model) return false;
    const reachable = modelsForMode(other.type, mode);
    if (!reachable.available) return false;
    const chosen = reachable.models.find((m) => m.name === model);
    if (!chosen) return false;
    return Object.values(chosen.params).some((info) => info.fromReferencePool === true)
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
    return {
      ok: false,
      reason:
        "Nothing here generates, so this is words the reader can read and take from your message. Write them in your reply instead.",
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
    "and nothing else, write them in your reply. You decide the shape: an " +
    "empty node and a generation for a picture; words beside them when the " +
    "next step reads those words; one empty node feeding several generations " +
    "for several takes on one thing. " +
    "Before proposing any shape with an empty node in it, ask_user once " +
    "whether they have that material -- you cannot see their canvas, and the " +
    "answer decides the shape. Wire an edge only where one node draws on what " +
    "another made; belonging together is said by the group, not by edges. " +
    "Ask get_canvas_capabilities and list_generation_models first, and " +
    "propose only a mode and model they returned. Mark each empty node's " +
    "place in the prompt, plus anything the panel leaves them to pick, and " +
    "say in your reply what they still have to connect by hand.",
  inputSchema,
  metadata: { runningLine: "chat.tool.proposingNodes" },
  toModelOutput: ({ output }) => ({ type: "text", value: renderProposalForModel(output) }),
  execute: async (
    proposal: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and returns, so there is nothing to
    // abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<ProposalAnswer> => {
    const verdict = checkProposal(proposal);
    return verdict.ok
      ? { ...proposal, placed: true }
      : { placed: false, reason: verdict.reason };
  },
});
