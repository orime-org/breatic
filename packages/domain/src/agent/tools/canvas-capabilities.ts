// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas capabilities tool — which modes each generation node can be set to.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  getCanvasCapabilities,
  type NodeCapability,
} from "@domain/model-catalog/mode-catalog.js";

const inputSchema = z.object({}).strict();

/** What the canvas can generate right now. */
export interface CanvasCapabilityAnswer {
  /** One entry per node type that has something to offer. */
  nodes: NodeCapability[];
}

/**
 * What a text node is for, and what pointing a prompt at one does.
 *
 * Carried here rather than in the tool's description because a proposal needs
 * it and an ordinary turn does not: the description is sent every turn, this
 * is read on the call a proposal makes first. The modes list leaves text nodes
 * out, since they generate nothing — which says where they are not without
 * saying what they are.
 */
const TEXT_NODE_NOTE = [
  "text node: holds words and generates nothing, so no mode applies to it.",
  "- A mention names the node rather than copying it: what goes out is whatever that node holds at the moment the reader presses Generate, so editing the node changes what every mention of it sends.",
  "- Mentioning a text node puts that node's words into the prompt, read as if they had been typed there. Mentioning a node of any other kind puts it in as reference material instead, which is what a model with a reference pool draws on.",
  "- One text node can be mentioned by several nodes downstream, so wording they share is written once and mentioned from each of them.",
  "- Three things one carries: a finished piece of writing the reader keeps, a description of what a group of nodes is for or how a script is set up, and a shared prompt fragment the nodes downstream mention.",
].join("\n");

/**
 * The answer as the model reads it.
 *
 * A list rather than the object it came from: the model picks a node type and
 * a mode out of this and hands both back to the second tool, so what it needs
 * is the codes spelled plainly next to what each one does.
 * @param answer - The tool's answer.
 * @returns One block per node type, each listing its modes, then what a text node is for.
 */
export function renderCapabilitiesForModel(answer: CanvasCapabilityAnswer): string {
  if (answer.nodes.length === 0) {
    return [
      "The canvas cannot generate anything right now: no model this deployment can reach backs any mode.",
      TEXT_NODE_NOTE,
    ].join("\n\n");
  }
  const blocks = answer.nodes.map((node) => {
    const lines = node.modes.map((mode) => `- ${mode.mode} (${mode.label}): ${mode.what}`);
    return [`${node.nodeType} node:`, ...lines].join("\n");
  });
  return [...blocks, TEXT_NODE_NOTE].join("\n\n");
}

export const canvasCapabilities: Tool<
  z.infer<typeof inputSchema>,
  CanvasCapabilityAnswer
> = tool({
  description:
    "List what the canvas can generate right now: every kind of generation " +
    "node, and the modes each one can be set to. Ask this first when the " +
    "user wants something made, then ask list_generation_models about the " +
    "one mode you settled on. What comes back is every mode the user can " +
    "select today, so propose no mode this does not list.",
  inputSchema,
  metadata: { runningLine: "chat.tool.checkingCanvas" },
  // The SDK's own conversion, which is what a running turn reaches -- the
  // model chooses out of this text, so it carries the whole answer. The same
  // renderer is registered for history replay, so both read alike.
  toModelOutput: ({ output }) => ({
    type: "text",
    value: renderCapabilitiesForModel(output),
  }),
  execute: async (
    _input: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and returns, so there is nothing to
    // abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<CanvasCapabilityAnswer> => ({ nodes: getCanvasCapabilities() }),
});
