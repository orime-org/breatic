// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Generation models tool — which models back one mode of one node, and how.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  CAMERA_COMMANDS_PER_BRACKET,
  cameraCommandBracket,
  formatCredits,
  GENERATION_NODE_MODES,
  STATIC_SHOT,
  type GenerationNodeType,
} from "@breatic/shared";
import type { CreditEstimate } from "@breatic/shared/pricing";

import {
  modelsForMode,
  poolParams,
  requiredSlotKinds,
  type ModelInfo,
  type ModelsForMode,
} from "@domain/model-catalog/mode-catalog.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";
import { GET_PRODUCT_GUIDE } from "@domain/agent/tools/tool-names.js";

/** One model with what a run at its defaults costs, when the catalog prices it. */
export type PricedModelInfo = ModelInfo & { price?: CreditEstimate };

/** The tool's answer: the mode's models, each priced at its defaults. */
export type PricedModelsForMode = ModelsForMode<PricedModelInfo>;

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
 * A run's estimate in the words the panel shows it in.
 * @param price - The estimate at the model's defaults.
 * @returns The credits, with how they bound the charge.
 */
function renderPrice(price: CreditEstimate): string {
  const credits = formatCredits(price.credits, "en-US");
  switch (price.bound) {
    case "exact":
      return `${credits} credits at its defaults`;
    case "at_least":
      return `at least ${credits} credits at its defaults, more with more or longer sources or more text`;
    case "at_most":
      return `up to ${credits} credits at its defaults, less when a source was used before`;
    case "per_thousand_chars":
      return `${credits} credits per 1000 characters of prompt`;
  }
}

/**
 * What the multi-shot mode asks of a proposal on this model, in that mode.
 * @param model - The model to describe.
 * @returns A sentence to append to its line, or the empty string outside the multi-shot mode.
 */
function renderStoryboard(model: PricedModelInfo): string {
  const board = model.storyboard;
  if (!board) return "";
  const chars = board.maxChars !== undefined ? `, each at most ${board.maxChars} characters` : "";
  const total = board.totalParam !== undefined ? `, whole seconds adding up to ${board.totalParam}` : "";
  return ` Give shots (at most ${board.maxShots} shots${chars}${total}), each written out, and leave prompt out.`;
}

/**
 * Which camera commands this model reads out of its prompt and how to write
 * them, as MiniMax documents the syntax.
 * @param model - The model to describe.
 * @returns A sentence to append to its line, or the empty string when it reads none.
 */
function renderCameraCommands(model: PricedModelInfo): string {
  const commands = model.cameraCommands;
  if (!commands || commands.length === 0) return "";
  const where = model.storyboard ? " into the shot it belongs to" : " into the prompt";
  return (
    ` Reads camera commands written${where}: ${commands.map((c) => cameraCommandBracket([c])).join(" ")}.` +
    ` Commands inside one bracket, comma-separated with no space, as in ${cameraCommandBracket(["Truck left", "Push in"])}, run at the same time, at most ${CAMERA_COMMANDS_PER_BRACKET} in one bracket;` +
    ` separate brackets run in the order they appear; never put the opposite directions of one axis, or ${cameraCommandBracket([STATIC_SHOT])} with a movement, in one bracket.`
  );
}

/**
 * One model rendered for the model to read.
 * @param model - The model to describe.
 * @returns Its name, what it is for, what it costs, and its parameters.
 */
function renderModel(model: PricedModelInfo): string {
  const price = model.price ? `${renderPrice(model.price)}, ` : "";
  const prompt = model.takesPrompt ? "" : " Takes no prompt: its words come from its sources.";
  const cap =
    model.maxInputChars !== undefined
      ? `, takes at most ${model.maxInputChars} characters of prompt`
      : "";
  // What the model is good at is written once for the whole catalog entry, so
  // an entry serving two of this node's modes says things about the other one.
  // Ten of the catalog files head generation_time as a max (worst case) and
  // none of the rest state any other reading for it, so the ceiling is the
  // reading that promises no more than the catalog says. Under "about", a model
  // whose own prose calls itself quick reads as two timings far apart; named as
  // the ceiling, the two sit inside one another.
  const beyond = Object.entries(model.params)
    .filter(([, spec]) => spec.noControl && !spec.fromStoryboard)
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
  // A kind taken both by a required slot and by the pool is routed by the
  // order the nodes are listed (`nameableFeeders`), which the model cannot
  // see from the parameters alone.
  const pooled = poolParams(model).map((pool) => pool.kind);
  const shared = [...new Set(requiredSlotKinds(model).filter((kind) => pooled.includes(kind)))];
  const routing = shared
    .map((kind) => ` Of the ${String(kind)} nodes wired in, the first in the order the proposal lists its nodes is the one the reader picks into its ${String(kind)} slot (say so in a note); later ones go to its pool (an asset mark each).`)
    .join("");
  const head = `- ${model.displayName} (${model.name}) (${price}up to ${model.seconds}s${cap}): ${model.what}${prompt}${unreachable}${also}${routing}${renderStoryboard(model)}${renderCameraCommands(model)}`;
  const params = Object.entries(model.params).filter(([, spec]) => !spec.fromStoryboard).map(([name, spec]) => {
    // Shape and cap belong to the parameter, so they are stated whatever else
    // it says about itself -- including for a slot, where together they are
    // how many nodes may be pointed at this one. Every param in the catalog
    // that declares a type today is a slot, so stating it only for a settable
    // field would state it nowhere.
    const shape = spec.type !== undefined ? ` a ${spec.type};` : "";
    const howMany =
      spec.maxItems !== undefined ? ` at most ${spec.maxItems};` : "";
    // Two gestures reach a source: a slot is picked by clicking the slot and
    // then a node, and the reference list is the node's incoming edges. Named
    // for neither, because the reader does neither -- it is the person at the
    // canvas who fills both.
    if (spec.filledBySource) {
      // Which gesture fills it is said here, since the shape a proposal takes
      // depends on it; how to click through that gesture is said once, in the
      // product guide the description points at. The pool is filled by an
      // edge and then a mention; a slot is picked on the canvas.
      const how = spec.fromReferencePool
        ? "filled on the canvas, not typed here, by an edge into this node, then a mention of it in the prompt"
        : "filled from another node on the canvas through a source slot, not typed here; leave it unset";
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
    const waits = spec.gate === undefined ? "" : ` it applies only while ${spec.gate.param} is on;`;
    // A field served from upstream stands on the first entry of that list
    // until the reader picks one in the panel.
    const tail = spec.valuesFrom
      ? " defaults to the first entry of that list."
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
export function renderGenerationModelsForModel(answer: PricedModelsForMode): string {
  if (!answer.available) {
    return answer.offered.length > 0
      ? `That node cannot be set to that mode. It offers: ${answer.offered.join(", ")}.`
      : "That node can generate nothing right now: no model this deployment can reach backs any of its modes.";
  }
  return answer.models.map(renderModel).join("\n");
}

export const generationModels: Tool<z.infer<typeof inputSchema>, PricedModelsForMode> = tool({
  description:
    "List the models behind one mode of one generation node, with what each " +
    "is good at, what a call costs, how long it takes, and every parameter " +
    "with its default. Ask get_canvas_capabilities first for the node type " +
    "and mode to pass here. Propose only a model this returns, and only " +
    `parameters it names. How the reader fills a source parameter on screen is in ${GET_PRODUCT_GUIDE}.`,
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
    // Unused: reads a cached catalog and prices it locally, so there is
    // nothing to abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<PricedModelsForMode> => {
    const answer = modelsForMode(nodeType, mode);
    if (!answer.available) return answer;
    const models = await Promise.all(
      answer.models.map(async (model): Promise<PricedModelInfo> => {
        const price = await estimateModelCredits(model.name, { params: {} });
        return price === undefined ? model : { ...model, price };
      }),
    );
    return { available: true, models };
  },
});
