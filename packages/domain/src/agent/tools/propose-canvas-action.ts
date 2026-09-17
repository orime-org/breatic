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
 * How MANY pieces a mode takes is not a question the catalog answers: the
 * table naming a mode's material speaks in types, and a mode wanting a first
 * and a last frame asks for one type twice. So the count is the proposal's
 * own to make, and what is held here is that it agrees with itself -- one
 * mark per empty node, one empty node per mark. Which named slot a given node
 * belongs in is the panel's to know, and its own gate says so.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  effectiveItemCap,
  evaluateExecute,
  extractPromptText,
  GENERATION_NODE_MODES,
  MODE_SOURCE_FIELDS,
  PANEL_EDITOR_PARAM,
  promptTextOf,
  REFERENCE_POOL_PARAM,
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
            .enum(["asset", "tweak"])
            .describe(
              "asset: material the reader supplies in an empty node. " +
                "tweak: something only they can pick or write in the panel",
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
    role: z.enum(["source", "generate"]),
    type: z.enum(NODE_TYPES),
    name: z.string().min(1).describe("What the reader sees on the node"),
    mode: z.string().min(1).optional().describe("Generation nodes only"),
    model: z.string().min(1).optional().describe("Generation nodes only"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Generation nodes only. Each value has to be one its control offers. " +
          "Leave out what a wired node, the vendor's list or the panel's own " +
          "box fills",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "Generation nodes only. Say what to generate, and mark one place per " +
          "empty node; the k-th mark is about the k-th empty node",
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
      .describe("What this model is for, and what it costs"),
    rationale: z.string().trim().min(1).describe("Why this shape, in a sentence or two"),
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
  if (!mode || !model) {
    return { ok: false, reason: `Node ${index} generates, so it needs a mode and a model.` };
  }
  // A mode this node never had and a mode no model here backs are the same
  // answer from the reader's side -- it cannot be proposed -- and
  // `modelsForMode` already names what the node does offer instead.
  const reachable = modelsForMode(node.type, mode);
  if (!reachable.available) {
    return {
      ok: false,
      reason: reachable.offered.length > 0
        ? `No model here backs "${mode}" on a ${node.type} node. It offers: ${reachable.offered.join(", ")}.`
        : `A ${node.type} node can generate nothing right now.`,
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

  const sources = proposal.nodes
    .map((n, at) => ({ node: n, at }))
    .filter(({ node: n }) => n.role === "source");
  const marks = prompt.filter((s) => s.slot?.kind === "asset");
  const needed = sourceKinds(node.type, mode);
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

  // Two ways the reader's material reaches a generation: the reference pool,
  // which an edge feeds, and a slot on the panel's toolbar, which has no edge
  // and for which the canvas has no legal wiring at all. Which one a mode uses
  // is read off the panel's own table.
  const byReference = (MODE_SOURCE_FIELDS[node.type]?.[mode] ?? []).includes(
    REFERENCE_POOL_PARAM,
  );
  const fedFrom = new Set(
    proposal.edges.filter((e) => e.toIndex === index).map((e) => e.fromIndex),
  );
  if (!byReference && fedFrom.size > 0) {
    return {
      ok: false,
      reason: `"${mode}" takes its material from a slot on the toolbar, so leave the empty node unwired and say in the prompt which slot to pick it in.`,
    };
  }
  if (byReference && !sources.every(({ at }) => fedFrom.has(at))) {
    return {
      ok: false,
      reason: `"${mode}" takes its material from the reference pool, which an edge feeds, so wire every empty node into node ${String(index)}.`,
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
  const missing = needed.filter((kind) => !sources.some(({ node: n }) => n.type === kind));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `"${mode}" needs ${needed.join(", ")} from the reader, and the group offers no empty ${missing.join(", ")} node.`,
    };
  }

  // How many pieces the reader has to supply comes from both layers of the
  // catalog: the model says which of its parameters are slots and which may be
  // left empty, and the mode says whether every slot has to hold something or
  // any one of them is enough.
  const asked = materialNeeded(node.type, mode, model);
  if (!byReference && sources.length !== asked) {
    return {
      ok: false,
      reason: `"${mode}" takes ${String(asked)} piece(s) of material from the reader, and the group carries ${String(sources.length)} empty node(s).`,
    };
  }
  // The pool has a ceiling as well, stated by the model and enforced by the
  // panel by name, so a group placed over it is filled by the reader and then
  // turned away. Read through the one function the panel, the server and the
  // worker read, so the number is the same everywhere it is judged.
  const pool = chosen.params[REFERENCE_POOL_PARAM];
  const cap = pool && effectiveItemCap(capShapeOf(pool), node.params ?? {});
  const over = byReference ? referenceCapExceeded(sources.length, cap) : null;
  if (over) {
    return {
      ok: false,
      reason: `"${model}" holds ${String(over.limit)} reference(s) at a time, and the group carries ${String(sources.length)} empty node(s).`,
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
  return { ok: true };
}

/**
 * Whether a proposal can be placed and then generated by the reader.
 *
 * Pure, so the rule it applies is the one a test can hold: the catalog goes
 * in through `entriesForNode` and `modelsForMode`, and nothing else is read.
 * @param proposal - What the model proposed.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkProposal(proposal: CanvasProposal): ProposalVerdict {
  for (const edge of proposal.edges) {
    const ends = [edge.fromIndex, edge.toIndex];
    if (ends.some((i) => i < 0 || i >= proposal.nodes.length)) {
      return { ok: false, reason: `An edge points outside the group: ${JSON.stringify(edge)}.` };
    }
    if (edge.fromIndex === edge.toIndex) {
      return { ok: false, reason: `An edge loops node ${edge.fromIndex} onto itself.` };
    }
  }

  const generates = proposal.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.role === "generate");
  if (generates.length !== 1) {
    // One press builds one thing. A chain of generations is a workflow, and
    // the empty nodes feeding the second could not be told from the first's.
    return {
      ok: false,
      reason: `A proposal builds exactly one thing that generates; this one has ${String(generates.length)}.`,
    };
  }

  const only = generates[0];
  if (!only) return { ok: false, reason: "A proposal builds one thing that generates." };

  // Every edge ends at that one node. An edge between two empty nodes would be
  // drawn on the canvas and would say the reader's two files feed each other.
  const astray = proposal.edges.find((edge) => edge.toIndex !== only.index);
  if (astray) {
    return {
      ok: false,
      reason: `An edge ends at node ${String(astray.toIndex)}, which does not generate. Wire the empty nodes into node ${String(only.index)}.`,
    };
  }

  // An empty node is a place to drop a file. Given a mode, a model or a prompt
  // it is a second generation, which is a chain rather than one press.
  const configured = proposal.nodes.find(
    (node) =>
      node.role === "source" &&
      (node.mode !== undefined ||
        node.model !== undefined ||
        node.params !== undefined ||
        node.prompt !== undefined),
  );
  if (configured) {
    return {
      ok: false,
      reason: `"${configured.name}" is an empty node for the reader to fill, so it takes no mode, model, parameters or prompt.`,
    };
  }

  return checkGenerateNode(proposal, only.node, only.index);
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
    "Propose a group of canvas nodes for the reader to place with one press: " +
    "the generation node with its mode, model and parameters filled in, plus " +
    "an empty node for each piece of material only the reader has, wired " +
    "together. Ask get_canvas_capabilities and list_generation_models first, " +
    "and propose only a mode and model they returned. Mark one place in the " +
    "prompt per empty node, and one more for anything the panel leaves to " +
    "the reader to pick or write.",
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
