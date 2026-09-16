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
  GENERATION_NODE_MODES,
  MODE_SOURCE_FIELDS,
  REFERENCE_POOL_PARAM,
  type CanvasProposal,
  type GenerationNodeType,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import {
  entriesForNode,
  modelsForMode,
  type ModelInfo,
} from "@domain/model-catalog/mode-catalog.js";

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

/** Whether a proposal holds together, and what is missing when it does not. */
export type ProposalVerdict = { ok: true } | { ok: false; reason: string };

const promptSegment = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      slot: z
        .object({
          kind: z
            .enum(["asset", "tweak"])
            .describe(
              "asset: one empty node's worth of material the reader supplies. " +
                "tweak: a choice only they can make in the panel",
            ),
          label: z.string().min(1),
          note: z.string(),
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
        "Generation nodes only. Each value has to be one the control offers: " +
          "a listed option, or a number inside the declared range. Leave out " +
          "anything the panel fetches from the vendor",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "Generation nodes only. Say what to generate, and mark exactly one " +
          "place per empty node in the group for what goes in it",
      ),
  })
  .strict();

const inputSchema = z
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
    modelNote: z.string().describe("What this model is for, and what it costs"),
    rationale: z.string().describe("Why this shape, in a sentence or two"),
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
  // A model driven by its prompt generates from whatever is in that box, so a
  // proposal leaving it empty hands the reader a configured node and nothing
  // to press it for. A model not driven by one takes nothing there either way.
  if (chosen.takesPrompt && !prompt.some((s) => (s.text ?? "").trim() !== "")) {
    return {
      ok: false,
      reason: `"${model}" generates from what the prompt says, and this proposal writes nothing in it.`,
    };
  }

  // A value fetched from the vendor is one nobody here has seen: the picker
  // lists it for the reader, and the only sound proposal is one that says so.
  const fetched = Object.entries(chosen.params)
    .filter(([, info]) => info.valuesFrom !== undefined)
    .map(([name]) => name);
  if (fetched.length > 0 && !prompt.some((s) => s.slot?.kind === "tweak")) {
    return {
      ok: false,
      reason: `"${model}" has the reader pick its ${fetched.join(", ")} from a list the panel fetches, so mark that place in the prompt.`,
    };
  }

  const sources = proposal.nodes
    .map((n, at) => ({ node: n, at }))
    .filter(({ node: n }) => n.role === "source");
  const marks = prompt.filter((s) => s.slot?.kind === "asset");
  const needed = sourceKinds(node.type, mode);
  if (needed.length === 0) {
    // Nothing goes in an empty node here, and nothing on screen would say so.
    return sources.length === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `"${mode}" asks nothing of the reader, so the group has no use for an empty node.`,
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

  for (const { node, index } of generates) {
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
    "Propose a group of canvas nodes for the reader to place with one press: " +
    "the generation node with its mode, model and parameters filled in, plus " +
    "an empty node for each piece of material only the reader has, wired " +
    "together. Ask get_canvas_capabilities and list_generation_models first, " +
    "and propose only a mode and model they returned. Mark one place in the " +
    "prompt per empty node, and one for any choice the panel fetches from " +
    "the vendor.",
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
