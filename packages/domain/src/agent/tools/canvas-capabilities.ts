// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas capabilities tool — which modes each generation node can be set to.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  getCanvasCapabilities,
  type ModeInfo,
} from "@domain/model-catalog/mode-catalog.js";

const inputSchema = z.object({}).strict();

/** One generation node and the modes it can currently be set to. */
export interface NodeCapability {
  /** The kind of node these modes belong to. */
  nodeType: string;
  /** What it can be set to, in the order its picker shows them. */
  modes: ModeInfo[];
}

/** What the canvas can generate right now. */
export interface CanvasCapabilityAnswer {
  /** One entry per node type that has something to offer. */
  nodes: NodeCapability[];
}

/**
 * The answer as the model reads it.
 *
 * A list rather than the object it came from: the model picks a node type and
 * a mode out of this and hands both back to the second tool, so what it needs
 * is the codes spelled plainly next to what each one does.
 * @param output - The tool's answer.
 * @returns One block per node type, each listing its modes.
 */
export function renderCapabilitiesForModel(output: unknown): string {
  const answer = output as CanvasCapabilityAnswer;
  if (!answer.nodes || answer.nodes.length === 0) {
    return "The canvas cannot generate anything right now: no model this deployment can reach backs any mode.";
  }
  const blocks = answer.nodes.map((node) => {
    const lines = node.modes.map((mode) => `- ${mode.mode} (${mode.label}): ${mode.what}`);
    return [`${node.nodeType} node:`, ...lines].join("\n");
  });
  return blocks.join("\n\n");
}

export const canvasCapabilities: Tool<
  z.infer<typeof inputSchema>,
  CanvasCapabilityAnswer
> = tool({
  description:
    "List what the canvas can generate right now: every kind of generation " +
    "node, and the modes each one can be set to. Ask this first when the " +
    "user wants something made, then ask list_generation_models about the " +
    "one mode you settled on. What comes back is what the user can actually " +
    "select today, so do not offer anything this does not list.",
  inputSchema,
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
  ): Promise<CanvasCapabilityAnswer> => ({
    nodes: Object.entries(getCanvasCapabilities()).map(([nodeType, modes]) => ({
      nodeType,
      modes,
    })),
  }),
});
