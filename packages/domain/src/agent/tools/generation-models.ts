// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
  PANEL_EDITOR_PARAM,
  STATIC_SHOT,
  standInOf,
  type GenerationNodeType,
  type ProposalNode,
} from "@breatic/shared";
import type { CreditEstimate } from "@breatic/shared/pricing";

import {
  modelsForMode,
  sceneModelsForMode,
  waysIn,
  type ModelInfo,
  type ModelsForMode,
  type WayKind,
} from "@domain/model-catalog/mode-catalog.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";
import { checkParams } from "@domain/agent/tools/proposal-params-check.js";
import { proposalModelEntry } from "@domain/agent/tools/proposal-dialogue.js";
import { gateWords, nodeLabel } from "@domain/agent/tools/proposal-refusals.js";
import { entriesFor, entryPhrase, holdingsOf, holdingSubject, type Entry } from "@domain/agent/tools/proposal-routing.js";
import { GET_PRODUCT_GUIDE } from "@domain/agent/tools/tool-names.js";

/**
 * A model with its price: at the params a call gave (`atParams`) or its
 * defaults, the keys it turned away, and for each setting whose value moves
 * the price, the value it is lowest at.
 */
export type PricedModelInfo = ModelInfo & { price?: CreditEstimate; atParams?: true; rejected?: string[]; lowestAt?: Record<string, unknown> };

/** The tool's answer: the mode's models, each priced. */
export type PricedModelsForMode = ModelsForMode<PricedModelInfo>;

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

// One object root: the OpenAI-compatible endpoint the agent calls takes no
// other, so which fields a target needs is judged in `execute`.
const inputSchema = z
  .object({
    target: z
      .enum(["canvas", "3d"])
      .optional()
      .describe(
        "Where the generation runs: canvas (the default) for a generation node, or 3d for the 3D Space's " +
          "generate dialog, which only generates 3D models (t23d text-to-3D, i23d image-to-3D) and takes no nodeType",
      ),
    nodeType: z
      .enum(NODE_TYPES)
      .optional()
      .describe("The kind of generation node, from get_canvas_capabilities; required for canvas, left out for 3d"),
    mode: z
      .string()
      .min(1)
      .describe("The mode on that node, from get_canvas_capabilities; for 3d, t23d or i23d"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Settings a step will run at, to price each model at them; left out, each is priced at its defaults"),
  })
  .strict();

/**
 * A run's estimate in the words the panel shows it in.
 * @param price - The estimate.
 * @param at - What it was priced at, as words that follow the credits.
 * @returns The credits, with how they bound the charge.
 */
export function renderPrice(price: CreditEstimate, at = "at its defaults"): string {
  const credits = formatCredits(price.credits, "en-US");
  switch (price.bound) {
    case "exact":
      return `${credits} credits ${at}`;
    case "at_least":
      return `at least ${credits} credits ${at}, more with more or longer sources or more text`;
    case "at_most":
      return `up to ${credits} credits ${at}, less when a source was used before`;
    case "per_thousand_chars":
      return `${credits} credits per 1000 characters of prompt`;
  }
}

/**
 * What a dialogue asks of a proposal on a model whose speakers stand in for
 * its voice (inner#1825 design 8.5).
 * @param model - The model to describe.
 * @returns A sentence to append to its line, or the empty string for a model reading in one voice.
 */
function renderDialogue(model: PricedModelInfo): string {
  const standIn = standInOf(proposalModelEntry({ model: model.name }));
  if (standIn === null) return "";
  return ` Once params ${standIn.name} name the speakers, give lines, one per turn, each { speaker, prompt }: speaker the number of a speaker counted from 1, prompt only the words said, with no name or colon in front; leave prompt out.`;
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
 * Where this model's words are written, and so where a mention of a node
 * wired into it goes: in the multi-shot mode each shot holds its own words.
 * @param model - The model.
 * @returns "a shot" or "the prompt".
 */
function wordsBox(model: PricedModelInfo): string {
  return model.storyboard ? "a shot" : "the prompt";
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
  return (
    ` Reads camera commands written into ${wordsBox(model)}: ${commands.map((c) => cameraCommandBracket([c])).join(" ")}.` +
    ` Commands inside one bracket, comma-separated with no space, as in ${cameraCommandBracket(["Truck left", "Push in"])}, run at the same time, at most ${CAMERA_COMMANDS_PER_BRACKET} in one bracket;` +
    ` separate brackets run in the order they appear; never put the opposite directions of one axis, or ${cameraCommandBracket([STATIC_SHOT])} with a movement, in one bracket.`
  );
}

/**
 * What a run in this mode needs before it can start, as the panel holds a
 * run in this mode to it: each requirement as its one param, or one of its
 * params where any one is enough.
 * @param model - The model.
 * @returns The sentence, or the empty string for a model that needs nothing.
 */
function renderNeeds(model: PricedModelInfo): string {
  if (model.needs.length === 0) return "";
  const each = model.needs.map((need) => `${need.length === 1 ? `"${String(need[0])}"` : `one of ${need.map((param) => `"${param}"`).join(", ")}`} holds a node`);
  return ` It runs only when ${each.join(" and ")}.`;
}

/**
 * One entry, as the listing says it: where the node lands, how many it takes,
 * and how the proposal sends it, in the words the refusals use.
 * @param kind - The kind of node going this way.
 * @param entry - The entry, as the proposal check reads it.
 * @param box - Where the model's words are written.
 * @returns The phrase.
 */
function entryWords(kind: WayKind, entry: Entry, box: string): string {
  const { way } = entry;
  const where =
    way.into === "pool"
      ? kind === "text" ? box : "the reference pool"
      : way.into === PANEL_EDITOR_PARAM ? "the lyrics box" : "a slot";
  const room = Number.isFinite(way.room) ? ` (at most ${String(way.room)})` : "";
  return `${where}${room} ${entryPhrase(entry)}`;
}

/**
 * One model rendered for the model to read.
 * @param model - The model to describe.
 * @returns Its name, what it is for, what it costs, and its parameters.
 */
function renderModel(model: PricedModelInfo): string {
  const at = model.atParams ? (model.rejected === undefined ? "at the params given" : "at the params it takes") : undefined;
  const refused = model.rejected === undefined ? "" : ` (${model.rejected.map((name) => `"${name}"`).join(", ")} not priced: not a setting or value it takes)`;
  const price = model.price ? `${renderPrice(model.price, at)}${refused}, ` : "";
  const prompt = !model.takesPrompt
    ? " Takes no prompt: its words come from its sources."
    : model.promptWhen === undefined ? "" : ` Takes a prompt only while ${gateWords(model.promptWhen, false)}.`;
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
  // A user picks a model off this line. A capability its prose sells whose
  // parameter nothing can set is one they cannot have, and the per-parameter
  // line saying so is read after the choice.
  const unreachable =
    beyond.length > 0 ? ` Nothing here reaches: ${beyond.join(", ")}.` : "";
  const also =
    model.alsoServes && model.alsoServes.length > 0
      ? ` Also serves ${model.alsoServes.join(", ")} on this node, which is what parts of the line above describe.`
      : "";
  // Where a node reaching the model goes and what the prompt carries for it, read off
  // the same ways the proposal check reads (design 5.7 tables A and D).
  const ways = waysIn(model);
  const routing = [...ways.keys()]
    .map((kind) => {
      const said = holdingsOf(kind).map((holding) => ({ holding, entries: entriesFor(model, kind, holding) }));
      // A kind that only goes into the pool is @'d like any mention, and
      // needs no line of its own.
      if (said.every(({ entries }) => entries.every((entry) => entry.way.into === "pool"))) return "";
      return said
        .filter(({ entries }) => entries.length > 0)
        .map(({ holding, entries }) => ` ${holdingSubject(kind, holding)} goes into ${entries.map((entry) => entryWords(kind, entry, wordsBox(model))).join(", or into ")}.`)
        .join("");
    })
    .join("");
  // Words wired in can always be @'d into a box that is drawn, so a ref on a
  // model whose material arrives only by slot can only @ a text node.
  const mediaToAt = [...ways].some(([kind, list]) => kind !== "text" && list.some((way) => way.mark === "ref"));
  const wordsOnly =
    model.takesPrompt && !mediaToAt
      ? " Nothing wired in but a text node can be @'d here, so a ref can only @ words."
      : "";
  const head = `- ${model.displayName} (${model.name}) (${price}up to ${model.seconds}s${cap}): ${model.what}${prompt}${unreachable}${also}${routing}${renderNeeds(model)}${wordsOnly}${renderStoryboard(model)}${renderDialogue(model)}${renderCameraCommands(model)}`;
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
    // The lyrics box is a box of its own on the panel: words reach it as a
    // text node @'d there at landing, the lyrics way of the routing line.
    if (name === PANEL_EDITOR_PARAM) {
      return `    ${name}: the lyrics box on the panel, not set here; send words you wrote as a text node wired in with into: "${name}", which is @'d there for you. ${spec.what}`;
    }
    if (spec.filledBySource) {
      // Which gesture fills it is said here, since the shape a proposal takes
      // depends on it; how to click through that gesture is said once, in the
      // product guide the description points at. The pool is filled by an
      // edge and then a mention; a slot is picked on the canvas.
      const how = spec.fromReferencePool
        ? `filled on the canvas, not typed here, by an edge into this node, then a mention of it in ${wordsBox(model)}`
        : "filled from another node on the canvas through a source slot, not typed here; leave it unset";
      const drawn = spec.gate === undefined ? "" : `; it applies only while ${gateWords(spec.gate, false)}`;
      return `    ${name}:${shape}${howMany} ${how}${drawn}. ${spec.what}`;
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
    // user that "no control" does not: satisfy the gate and setting it works.
    const waits = spec.gate === undefined ? "" : ` it applies only while ${gateWords(spec.gate, false)};`;
    // Takes go out at the lowest value of every setting that moves the price,
    // which the agent cannot tell from the values alone.
    const lowest = model.lowestAt !== undefined && name in model.lowestAt ? ` sets the price, lowest at ${JSON.stringify(model.lowestAt[name])};` : "";
    // A field served from upstream stands on the first entry of that list
    // until the user picks one in the panel.
    const tail = spec.valuesFrom
      ? " defaults to the first entry of that list."
      : ` defaults to ${JSON.stringify(spec.default)}.`;
    return `    ${name}:${domain}${howMany}${waits}${lowest}${tail} ${spec.what}`;
  });
  const forces = renderForces(model);
  return params.length > 0 ? [head, "  parameters:", ...params, ...forces].join("\n") : [head, ...forces].join("\n");
}

/**
 * The values the model forces, in the order they apply, as lines under its
 * parameters: a value given against one is refused, naming its id.
 * @param model - The model.
 * @returns The lines, or none for a model that forces nothing.
 */
function renderForces(model: PricedModelInfo): string[] {
  if (model.forces === undefined || model.forces.length === 0) return [];
  return [
    "  forced values (applied in this order; a value given against one is refused):",
    ...model.forces.map((force) => {
      const sets = Object.entries(force.set).map(([name, value]) => `${name} to ${JSON.stringify(value)}`).join(" and ");
      return `    ${force.id}: while ${gateWords(force.when, false)}, ${sets}${force.lock ? ", locked in the dialog" : ""}.`;
    }),
  ];
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

/**
 * The params a model takes out of the ones a call named, judged one by one
 * the way a proposal's are, so a price is never computed from a value the
 * model's controls would not offer. A key turned away is judged again once
 * another is kept, since a setting gated by a switch counts only beside it,
 * wherever the call names the switch.
 * @param model - The model.
 * @param nodeType - The node type the call named.
 * @param mode - The mode the call named.
 * @param params - The params the call named.
 * @returns The ones it takes, and the names of the rest.
 */
function takenParams(model: ModelInfo, nodeType: GenerationNodeType, mode: string, params: Readonly<Record<string, unknown>>): { kept: Record<string, unknown>; rejected: string[] } {
  const kept: Record<string, unknown> = {};
  let waiting = Object.entries(params);
  for (let before = Number.POSITIVE_INFINITY; waiting.length < before; ) {
    before = waiting.length;
    waiting = waiting.filter(([key, value]) => {
      const node: ProposalNode = { role: "generate", type: nodeType, name: model.name, mode, model: model.name, params: { ...kept, [key]: value } };
      if (!checkParams(model, node, nodeLabel([node], 0)).ok) return true;
      kept[key] = value;
      return false;
    });
  }
  return { kept, rejected: waiting.map(([key]) => key) };
}

/**
 * For each setting whose value moves the model's price, the value it is
 * lowest at, every other setting at its default; ties go to the value listed
 * first. A setting given as a range is probed at its two ends.
 * @param model - The model.
 * @returns The settings that move the price, each with its cheapest value.
 */
async function lowestValues(model: ModelInfo): Promise<Record<string, unknown>> {
  const settable = Object.entries(model.params).filter(([, spec]) => spec.filledBySource !== true && spec.noControl !== true);
  const found = await Promise.all(
    settable.map(async ([name, spec]) => {
      // ponytail: a range is probed at its ends only, which holds while range prices only rise or fall;
      // probe every step across it if a model's price ever dips inside one.
      const options = spec.options ?? (spec.min !== undefined && spec.max !== undefined ? [spec.min, spec.max] : []);
      const credits = await Promise.all(options.map(async (value) => (await estimateModelCredits(model.name, { params: { [name]: value } }))?.credits));
      const known = credits.filter((one): one is number => one !== undefined);
      if (new Set(known).size <= 1) return [];
      return [[name, options[credits.indexOf(Math.min(...known))]] as const];
    }),
  );
  return Object.fromEntries(found.flat());
}

export const generationModels: Tool<z.infer<typeof inputSchema>, PricedModelsForMode> = tool({
  description:
    "List the models behind one mode of one generation node, with what each " +
    "is good at, what a call costs, how long it takes, and every parameter " +
    "with its default. Ask get_canvas_capabilities first for the node type " +
    "and mode to pass here. Propose only a model this returns, and only " +
    `parameters it names. How the user fills a source parameter on screen is in ${GET_PRODUCT_GUIDE}, section "Source slots". ` +
    "To price a step at the settings it will run at, pass them as params. " +
    "What a model is good at is what its line here says; a strength its line does not name, such as lettering, is not one of its strengths. " +
    "With target 3d it lists the 3D Space's models for t23d or i23d instead, with no nodeType, each with " +
    "the values it forces and why; propose those with propose_scene_generation.",
  inputSchema,
  metadata: { runningLine: "chat.tool.checkingModels" },
  // The SDK's own conversion, which is what a running turn reaches -- the
  // model names a model and fills parameters out of this text, so it carries
  // the whole answer. The turn writes the result down with the call
  // (`forModel`), and replay hands that copy back.
  toModelOutput: ({ output }) => ({
    type: "text",
    value: renderGenerationModelsForModel(output),
  }),
  execute: async (
    { target = "canvas", nodeType, mode, params }: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and prices it locally, so there is
    // nothing to abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<PricedModelsForMode> => {
    if (target === "3d" && nodeType !== undefined) {
      throw new Error(`target 3d takes no nodeType: the 3D Space has no nodes, so ask with target "3d" and mode t23d or i23d alone, not nodeType "${nodeType}".`);
    }
    if (target === "canvas" && nodeType === undefined) {
      throw new Error("target canvas needs a nodeType, from get_canvas_capabilities.");
    }
    const answer = nodeType === undefined ? sceneModelsForMode(mode) : modelsForMode(nodeType, mode);
    if (!answer.available) return answer;
    const models = await Promise.all(
      answer.models.map(async (model): Promise<PricedModelInfo> => priceModel(model, await lowestValues(model), params === undefined || nodeType === undefined ? undefined : takenParams(model, nodeType, mode, params))),
    );
    return { available: true, models };
  },
});

/**
 * A model priced at the params a call gave, or at its defaults when it gave none.
 * @param model - The model.
 * @param lowestAt - Its settings that move the price, each with its cheapest value.
 * @param taken - The params of the call it takes and the names of the rest, when the call gave params.
 * @returns The model with its price and what it was priced at.
 */
async function priceModel(model: ModelInfo, lowestAt: Record<string, unknown>, taken: { kept: Record<string, unknown>; rejected: string[] } | undefined): Promise<PricedModelInfo> {
  const marked = Object.keys(lowestAt).length === 0 ? model : { ...model, lowestAt };
  if (taken === undefined) {
    const price = await estimateModelCredits(model.name, { params: {} });
    return price === undefined ? marked : { ...marked, price };
  }
  const { kept, rejected } = taken;
  const price = await estimateModelCredits(model.name, { params: kept });
  const named = rejected.length === 0 ? {} : { rejected };
  if (price === undefined) return { ...marked, ...named };
  return Object.keys(kept).length === 0 ? { ...marked, price, ...named } : { ...marked, price, atParams: true as const, ...named };
}
