// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Generation models tool — which models back one mode of one node, and how.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { GENERATION_NODE_MODES, type GenerationNodeType } from "@breatic/shared";

import {
  modelsForMode,
  type ModelInfo,
  type ModelsForMode,
} from "@domain/model-catalog/mode-catalog.js";

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

const inputSchema = z
  .object({
    nodeType: z
      .enum(NODE_TYPES)
      .describe("The kind of generation node, from get_canvas_capabilities"),
    mode: z
      .string()
      .min(1)
      .describe("The mode on that node, from get_canvas_capabilities"),
  })
  .strict();

/**
 * One model rendered for the model to read.
 * @param model - The model to describe.
 * @returns Its name, what it is for, what it costs, and its parameters.
 */
function renderModel(model: ModelInfo): string {
  const head = `- ${model.name} (${model.credits} credits, about ${model.seconds}s): ${model.what}`;
  const params = Object.entries(model.params).map(([name, spec]) => {
    const values = spec.values ? ` one of ${spec.values.join(" | ")};` : "";
    return `    ${name}:${values} defaults to ${JSON.stringify(spec.default)}. ${spec.what}`;
  });
  return params.length > 0 ? [head, "  parameters:", ...params].join("\n") : head;
}

/**
 * The answer as the model reads it.
 *
 * The unavailable case renders as a sentence naming what the node does offer,
 * so a wrong guess costs one more call rather than reading as "this
 * deployment has nothing".
 * @param output - The tool's answer.
 * @returns The models and their parameters, or what to ask for instead.
 */
export function renderGenerationModelsForModel(output: unknown): string {
  const answer = output as ModelsForMode;
  if (!answer.available) {
    return answer.offered.length > 0
      ? `That node cannot be set to that mode. It offers: ${answer.offered.join(", ")}.`
      : "That node can generate nothing right now: no model this deployment can reach backs any of its modes.";
  }
  return answer.models.map(renderModel).join("\n");
}

export const generationModels: Tool<z.infer<typeof inputSchema>, ModelsForMode> = tool({
  description:
    "List the models behind one mode of one generation node, with what each " +
    "is good at, what a call costs, how long it takes, and every parameter " +
    "with its default. Ask get_canvas_capabilities first for the node type " +
    "and mode to pass here. Propose only a model this returns, and only " +
    "parameters it names.",
  inputSchema,
  // The SDK's own conversion, which is what a running turn reaches -- the
  // model names a model and fills parameters out of this text, so it carries
  // the whole answer. The same renderer is registered for history replay.
  toModelOutput: ({ output }) => ({
    type: "text",
    value: renderGenerationModelsForModel(output),
  }),
  execute: async (
    { nodeType, mode }: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and returns, so there is nothing to
    // abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<ModelsForMode> => modelsForMode(nodeType, mode),
});
