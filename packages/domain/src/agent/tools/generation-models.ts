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
  // What the model is good at is written once for the whole catalog entry, so
  // an entry serving two of this node's modes says things about the other one.
  // Every catalog file heads generation_time "worst case", so a model whose own
  // prose calls itself quick reads as two timings far apart under "about".
  // Named as the ceiling, the two sit inside one another.
  const beyond = Object.entries(model.params)
    .filter(([, spec]) => spec.noControl)
    .map(([name]) => name);
  // A reader picks a model off this line. A capability its prose sells whose
  // parameter nothing can set is one they cannot have, and the per-parameter
  // line saying so is read after the choice.
  const unreachable =
    beyond.length > 0 ? ` Nothing here reaches: ${beyond.join(", ")}.` : "";
  const also =
    model.alsoServes && model.alsoServes.length > 0
      ? ` Also serves ${model.alsoServes.join(", ")} on this node, which is what parts of the line above describe.`
      : "";
  const head = `- ${model.displayName} (${model.name}) (${price}, up to ${model.seconds}s${cap}): ${model.what}${prompt}${unreachable}${also}`;
  const params = Object.entries(model.params).map(([name, spec]) => {
    // Shape and cap belong to the parameter, so they are stated whatever else
    // it says about itself -- including for a slot, where together they are
    // how many nodes may be pointed at this one. Every param in the catalog
    // that declares a type today is a slot, so stating it only for a settable
    // field would state it nowhere.
    const shape = spec.type !== undefined ? ` a ${spec.type};` : "";
    const tighter = Object.entries(spec.maxItemsWhen ?? {})
      .map(([field, cap]) => `, ${cap} when ${field} is set`)
      .join("");
    const howMany =
      spec.maxItems !== undefined ? ` at most ${spec.maxItems}${tighter};` : "";
    // Two gestures reach a source: a slot is picked by clicking the slot and
    // then a node, and the reference list is the node's incoming edges. Named
    // for neither, because the reader does neither -- it is the person at the
    // canvas who fills both.
    if (spec.filledBySource) {
      // The pool takes a second gesture the slots do not: the edge offers an
      // image, the mention picks it. Said as one step, a reader wires and
      // submits, and the run carries no source.
      const how = spec.fromReferencePool
        ? "drawn from the canvas and then picked by writing @ and the node's name in the prompt; both steps, and neither is typed here"
        : "filled from another node on the canvas, not typed here; leave it unset";
      return `    ${name}:${shape}${howMany} ${how}. ${spec.what}`;
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
    // The control exists but does not count yet, which asks something of the
    // reader that "no control" does not: satisfy the gate and setting it works.
    const gate = spec.gate;
    const waits =
      gate === undefined
        ? ""
        : gate.kind === "source"
          ? ` the panel offers it once ${gate.param} is filled;`
          : gate.kind === "flagOn"
            ? ` it applies only while ${gate.param} is on;`
            : ` the panel drops it while ${gate.param} is on;`;
    // A field served from upstream has no default a run ever takes: the panel
    // refuses the submit until one is picked, so whatever the catalog declares
    // for it is a value nothing reaches.
    const tail = spec.valuesFrom
      ? " pick one in the panel before generating."
      : ` defaults to ${JSON.stringify(spec.default)}.`;
    return `    ${name}:${domain}${howMany}${waits}${tail} ${spec.what}`;
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
