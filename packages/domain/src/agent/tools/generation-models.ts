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
  // A model that bills by usage states the flat number as its balance floor,
  // so quoting that as the price contradicts what the panel shows the user.
  const price = model.rate
    ? `${model.rate.credits} credits per ${model.rate.per} ${model.rate.unit}`
    : `${model.credits} credits`;
  const prompt = model.takesPrompt ? "" : " Takes no prompt: its words come from its sources.";
  const cap =
    model.maxInputChars !== undefined
      ? `, takes at most ${model.maxInputChars} characters of prompt`
      : "";
  const head = `- ${model.displayName} (${model.name}) (${price}, about ${model.seconds}s${cap}): ${model.what}${prompt}`;
  const params = Object.entries(model.params).map(([name, spec]) => {
    // Shape and cap belong to the parameter, so they are stated whatever else
    // it says about itself -- including for a slot, where together they are
    // how many nodes may be pointed at this one. Every param in the catalog
    // that declares a type today is a slot, so stating it only for a settable
    // field would state it nowhere.
    const shape = spec.type !== undefined ? ` a ${spec.type};` : "";
    const howMany = spec.maxItems !== undefined ? ` at most ${spec.maxItems};` : "";
    // A slot is filled by pointing this node at another one, which is a
    // different gesture from drawing an edge: told to wire one, a reader
    // draws the edge and the slot stays empty.
    if (spec.filledBySource) {
      return `    ${name}:${shape}${howMany} filled from another node on the canvas, not typed here; leave it unset. ${spec.what}`;
    }
    // Nothing on screen sets it, so what the run uses is the default and the
    // only useful thing to say is that asking for another value goes nowhere.
    if (spec.noControl) {
      return `    ${name}: this panel draws no control for it; the run takes ${JSON.stringify(spec.default)}. ${spec.what}`;
    }
    const domain = spec.options
      ? ` one of ${spec.options.join(" | ")};`
      : spec.valuesFrom
        ? ` chosen from this model's ${spec.valuesFrom} list, not free text;`
        : spec.min !== undefined && spec.max !== undefined
          ? ` ${spec.min} to ${spec.max}${spec.step !== undefined ? ` in steps of ${spec.step}` : ""};`
          : shape;
    return `    ${name}:${domain}${howMany} defaults to ${JSON.stringify(spec.default)}. ${spec.what}`;
  });
  return params.length > 0 ? [head, "  parameters:", ...params].join("\n") : head;
}

/**
 * The answer as the model reads it.
 *
 * The unavailable case renders as a sentence naming what the node does offer,
 * so a wrong guess costs one more call rather than reading as "this
 * deployment has nothing".
 * @param answer - The tool's answer.
 * @returns The models and their parameters, or what to ask for instead.
 */
export function renderGenerationModelsForModel(answer: ModelsForMode): string {
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
  metadata: { runningLine: "chat.tool.checkingModels" },
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
