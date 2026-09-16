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
 * A mode that needs material is proposed as a pair: an empty node to put it
 * in, the generation node, and the edge between them. The prompt then has to
 * say, in the place it belongs, what goes in that node -- without it the
 * reader is handed a group whose generate button refuses.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  GENERATION_NODE_MODES,
  type CanvasProposal,
  type GenerationNodeType,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import { entriesForNode, modelsForMode } from "@domain/model-catalog/mode-catalog.js";

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
          kind: z.enum(["asset", "tweak"]),
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
    params: z.record(z.string(), z.unknown()).optional(),
    prompt: z.array(promptSegment).optional(),
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
 * The source types a mode needs, according to the models that can reach it.
 * @param nodeType - The node the mode belongs to.
 * @param mode - The mode being proposed.
 * @returns Every source type any reachable model asks for in that mode.
 * @throws {never} Never.
 */
function sourcesNeeded(nodeType: GenerationNodeType, mode: string): string[] {
  const needed = new Set<string>();
  for (const entry of entriesForNode(nodeType)) {
    for (const source of entry.sourcesByMode[mode] ?? []) needed.add(source);
  }
  return [...needed];
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
  if (!reachable.models.some((m) => m.name === model)) {
    return {
      ok: false,
      reason: `"${model}" does not back "${mode}". Those that do: ${reachable.models.map((m) => m.name).join(", ")}.`,
    };
  }

  const needed = sourcesNeeded(node.type, mode);
  if (needed.length === 0) return { ok: true };

  // The reader is the only one who has this material, so the group has to
  // carry somewhere to put it and a wire that feeds it in. Without both, the
  // generate button refuses and nothing on screen says why.
  const fed = proposal.edges.filter((e) => e.toIndex === index);
  const sources = fed.filter((e) => proposal.nodes[e.fromIndex]?.role === "source");
  if (sources.length < needed.length) {
    return {
      ok: false,
      reason: `"${mode}" needs ${needed.join(", ")} from the reader, so propose ${needed.length} empty node(s) wired into node ${index}.`,
    };
  }

  const saysWhereItGoes = (node.prompt ?? []).some((s) => s.slot?.kind === "asset");
  if (!saysWhereItGoes) {
    return {
      ok: false,
      reason: `"${mode}" needs material from the reader, so the prompt needs an asset slot saying what goes in the empty node.`,
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
  if (generates.length === 0) {
    return { ok: false, reason: "A proposal needs at least one node that generates." };
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
    "an empty node for any material only the reader has, wired together. Ask " +
    "get_canvas_capabilities and list_generation_models first, and propose " +
    "only a mode and model they returned.",
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
