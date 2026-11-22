// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read one generation template in full (inner#1807).
 *
 * The proposal tool's description indexes every template in one line: what
 * it makes, its goal and when to offer it. The full text -- nodes, wiring,
 * inputs, steps and each generate node's prompt in the user's language --
 * is read here when the agent means to propose one, so a turn does not carry
 * every template's prompts whether it uses them or not.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { formatCredits, GENERATION_TEMPLATES, keyStanding, t, templateAnchor, templateSkeleton, templateStyleKey, templateStylesOf, type GenerationTemplate } from "@breatic/shared";

import { templateCraft } from "@domain/agent/tools/template-craft.js";
import { modelsForMode } from "@domain/model-catalog/mode-catalog.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";
import { lowestValues, payerKeyRun, payerKeyWords, studioToolContextSchema, type StudioToolContext } from "@domain/agent/tools/generation-models.js";
import { templateSegmentsText } from "@domain/agent/tools/template-expansion.js";
import { payerKeyPlan } from "@domain/provider/provider-keys.js";
import { PROPOSE_CANVAS_ACTION } from "@domain/agent/tools/tool-names.js";

/** How to send a template once read, in the words the agent reads. */
const HOW_TO_SEND =
  `To use one, send each of its nodes as a node in ${PROPOSE_CANVAS_ACTION}: { id } in template on the anchor, { id, key } on each other node, ` +
  "and wire them as its edges say. A node not wired stands beside the anchor with no edge and carries { id, key, anchor }, anchor being the anchor's index. " +
  "Give each input a node of your own wired into the nodes it feeds; " +
  "{ id, input } on that node is optional unless the input is. An optional input's node is placed empty when the user has no material for it; do not ask them for it. An input into a slot (its line says by which) whose node holds material goes in the fed node's fills under that slot, with no edge; " +
  "an empty one is wired with into that slot. A resource node lands holding the template's file: send it with no material. " +
  "Leave out the mode and model you keep; while you keep them, a value you write in a node's params wins over the template's. Send each generate node's prompt as its own, rewritten in the language " +
  "the user writes in with their story or detail in it: fill every tweak segment with words before you send it: from what the user said, or, for one their words leave open, after asking them, making takes first, or choosing, as your working rules say. A template's tweak segment is never sent as it is. " +
  "A node sent in multi_shot sends shots and no prompt, their durations adding up to the node's duration: the one you " +
  "write in its params, else the template's while the node keeps the template's mode and model; on another mode or model, write one. " +
  "A node sent in any other mode sends a prompt, a template's shots written as one. " +
  "A template node with lines is a dialogue: send it lines, one per turn, each { speaker, prompt } with the speaker the template gives and only the words said, " +
  "no name or colon in front, and no prompt. " +
  "A template with steps gets a text node listing them when it is placed, so write no node for them. " +
  "For several takes of one template, each take is an anchor carrying { id } with its own words; an input they share is one node wired or filled into every take.";

/**
 * One template written out for the agent: its nodes, wiring, inputs,
 * resources and follow-up steps, what it makes, and each generate node's
 * prompt in the user's language, so the agent can rewrite that prompt
 * rather than write one from nothing.
 *
 * A prompt is shown as the segments a proposal sends, not as the box shows
 * it: the box adds words to a reference mark, and a model copying what it
 * reads would send those words back inside the label, or a bracket as text.
 * A styled template (inner#1817) given no style first lists its set's styles;
 * given one, each node that takes a part of it shows that part after its own words.
 * @param template - The template.
 * @param style - The picked style, if any.
 * @returns Its paragraph.
 * @throws {never} Never.
 */
export function describeTemplate(template: GenerationTemplate, style?: string): string {
  const skeleton = templateSkeleton(template);
  const anchor = templateAnchor(template);
  const nodes = template.nodes.map((node) => {
    const shots = node.role === "generate" && node.shots !== undefined ? `, ${String(node.shots.length)} shots` : "";
    const params = node.role === "generate" && node.params !== undefined && Object.keys(node.params).length > 0 ? `, params ${JSON.stringify(node.params)}` : "";
    const what = node.role === "generate" ? `generate ${node.type}, ${node.mode}, ${node.model}${shots}${params}` : `source ${node.type} holding ${node.resource}`;
    // A downstream node is said so, and one no edge touches is told how its tag ties it to the anchor (inner#1825).
    const standing = node.key === anchor.key ? "" : keyStanding(template, node.key);
    const where =
      standing === "standalone"
        ? ", not wired: no edge goes into or out of it, and its tag carries the anchor's index"
        : standing === "downstream"
          ? ", downstream of the anchor"
          : "";
    return `"${node.key}"${node.key === anchor.key ? " (anchor)" : ""}: ${what}${where}`;
  });
  const edges = skeleton.edges.map((edge) => `"${edge.from}" into "${edge.to}" by "${edge.into ?? "pool"}"`);
  const optional = new Set(template.inputs.flatMap((input) => (input.optional === true ? [input.key] : [])));
  const inputs = skeleton.inputs.map((input) => {
    const fed = `"${input.key}" (${input.type}${optional.has(input.key) ? ", optional" : ""}) into ${input.feeds.map((one) => `"${one}"`).join(", ")}${input.into === undefined ? "" : ` by "${input.into}"`}`;
    // inner#1811, CAP-9: the panel leaves the paragraph out while the node is empty.
    return optional.has(input.key)
      ? `${fed} (its ref stands in a paragraph of its own, which is not sent while its node is empty; its node carries { id, input }; its note: "${t(`canvas.template.${template.id}.input.${input.key}.note`)}")`
      : fed;
  });
  const steps = skeleton.steps.map((step) => t(`canvas.template.${template.id}.step.${step}`));
  const prompts = template.nodes.flatMap((node) => (node.role === "generate" ? [`"${node.key}": ${templateSegmentsText(template, node.key, style)}`] : []));
  return (
    styleLead(template, style) +
    `${template.id}: ${template.agentNote}. Nodes: ${nodes.join("; ")}. ` +
    `Edges: ${edges.length === 0 ? "none" : edges.join("; ")}. Inputs: ${inputs.length === 0 ? "none" : inputs.join("; ")}. ` +
    `Steps after it generates: ${steps.length === 0 ? "none" : steps.join(" / ")}. Prompts, as segments: ${prompts.join("; ")}`
  );
}

/**
 * The first sentence of a style's introducing words.
 * @param text - The words.
 * @returns Its first sentence.
 */
function firstSentence(text: string): string {
  return /^.*?(?:[.!?](?=\s|$)|[\u3002\uFF01\uFF1F])/su.exec(text)?.[0] ?? text;
}

/**
 * What a styled template's reading opens with: its set's styles when none
 * is picked, or that the picked one is not among them.
 * @param template - The template.
 * @param style - The picked style, if any.
 * @returns The lead, empty for an unstyled template or a style of its set.
 */
function styleLead(template: GenerationTemplate, style: string | undefined): string {
  const set = templateStylesOf(template);
  if (set === undefined) return "";
  if (style !== undefined && set.styles.some((one) => one.id === style)) return "";
  const intro = set.parts[0] ?? "";
  const listed = set.styles.map(
    (one) => `${one.id} ("${t(templateStyleKey(set.id, one.id, "name"))}"): ${firstSentence(t(templateStyleKey(set.id, one.id, intro)))}`,
  );
  const lead = style === undefined ? "" : `Style "${style}" is not one of this template's. `;
  return `${lead}Its styles (pass style to read the words for one): ${listed.join("; ")}\n\n`;
}

/** A template's generate nodes priced together, and whether every one was priced exactly. */
interface TemplatePrice {
  credits: number;
  exact: boolean;
}

/** One generate node of a template, with the settings a take of it changes. */
interface NodeSettings {
  key: string;
  model: string;
  own: Record<string, unknown>;
  /** Each setting that moves the model's price, at the value lowestValues finds cheapest on its own where that differs from the final's; never the length. */
  cheaper: Record<string, unknown>;
  /** The value each of those settings has on the final: the template's, else the model's default. */
  final: Record<string, unknown>;
}

/**
 * Each generate node of a template with the settings a take of it changes:
 * every setting that moves its model's price, at the value lowestValues
 * finds cheapest on its own where that differs from the template's or the
 * model's default, but the length, which the template's timed
 * parts are written for, and the value each has on the final, so a take the
 * user brings up to those values is known to be the final (inner#1811).
 * @param template - The template.
 * @returns Its generate nodes.
 */
async function nodeSettings(template: GenerationTemplate): Promise<NodeSettings[]> {
  return Promise.all(
    template.nodes.flatMap((node) => (node.role === "generate" ? [node] : [])).map(async (node): Promise<NodeSettings> => {
      const own = node.params ?? {};
      const answer = modelsForMode(node.type, node.mode);
      const model = answer.available ? answer.models.find((one) => one.name === node.model) : undefined;
      const { duration: _length, ...lowest } = model === undefined ? {} : await lowestValues(model);
      /**
       * A setting's value on the final.
       * @param name - The setting.
       * @returns The template's value, else the model's default.
       */
      const atFinal = (name: string): unknown => own[name] ?? model?.params[name]?.default;
      const cheaper = Object.fromEntries(Object.entries(lowest).filter(([name, value]) => value !== atFinal(name)));
      const final = Object.fromEntries(Object.keys(cheaper).map((name) => [name, atFinal(name)]));
      return { key: node.key, model: node.model, own, cheaper, final };
    }),
  );
}

/**
 * Generate nodes priced together.
 * @param nodes - Each node's model and the settings it is priced at.
 * @returns The credits and whether every node was priced exactly, or undefined when none is priced.
 */
async function priceOf(nodes: ReadonlyArray<{ model: string; params: Record<string, unknown> }>): Promise<TemplatePrice | undefined> {
  const prices = await Promise.all(nodes.map((node) => estimateModelCredits(node.model, { params: node.params })));
  const priced = prices.filter((price) => price !== undefined);
  if (priced.length === 0) return undefined;
  return { credits: priced.reduce((total, price) => total + price.credits, 0), exact: priced.length === prices.length && priced.every((price) => price.bound === "exact") };
}

/**
 * A price as the agent reads it.
 * @param price - The price.
 * @returns Its credits, marked a floor when not every node was priced exactly.
 */
function amount(price: TemplatePrice): string {
  return `${price.exact ? "" : "at least "}${formatCredits(price.credits, "en-US")}`;
}

/**
 * What a template costs on this deployment at its settings and how a take of
 * it runs: at the cheaper settings and what that costs when some make it
 * cheaper, else at its own settings as its final (inner#1811). Priced live:
 * the price list and its multiplier belong to the deployment,
 * so a number written into the template would be wrong elsewhere. A generate
 * node on the Studio payer's own key (inner#1953) costs no credits: it is left
 * out of the credits and named apart, and still takes the cheaper settings.
 * @param template - The template.
 * @param studioId - The studio the turn runs in; our keys when absent.
 * @returns The sentences, or "" when none of its generate nodes is priced or on the payer's key.
 */
async function applyCost(template: GenerationTemplate, studioId: string | undefined): Promise<string> {
  const nodes = await nodeSettings(template);
  const plan = await payerKeyPlan(studioId);
  const payer = new Map(nodes.map((node) => [node.key, payerKeyRun(plan, node.model, node.own)] as const));
  const onCredits = nodes.filter((node) => payer.get(node.key) === undefined);
  const final = await priceOf(onCredits.map((node) => ({ model: node.model, params: node.own })));
  const onPayer = nodes.flatMap((node) => {
    const run = payer.get(node.key);
    return run === undefined ? [] : [`"${node.key}" (${node.model}): ${payerKeyWords(run.describedOnCredits)}.`];
  });
  if (final === undefined && onPayer.length === 0) return "";
  const head = [...(final === undefined ? [] : [`At its settings this template costs ${amount(final)} credits.`]), ...onPayer].join(" ");
  const changed = nodes.filter((node) => Object.keys(node.cheaper).length > 0);
  const take = changed.length === 0 || final === undefined ? undefined : await priceOf(onCredits.map((node) => ({ model: node.model, params: { ...node.own, ...node.cheaper } })));
  // A take on the payer's key costs the payer less at the cheaper settings, though no credits show it.
  const cheaperOnPayer = changed.some((node) => payer.get(node.key) !== undefined);
  if (changed.length === 0 || (!cheaperOnPayer && (take === undefined || final === undefined || take.credits >= final.credits))) {
    return `${head} A take of it is made keeping its mode, model and length, at these settings, which are already its cheapest, so a take of it is already its final.`;
  }
  const cheaper = JSON.stringify(Object.fromEntries(changed.map((node) => [node.key, node.cheaper])));
  const atFinal = JSON.stringify(Object.fromEntries(changed.map((node) => [node.key, node.final])));
  return (
    `${head} A take of it is made this way, and comes before its final: apply it keeping its mode, model and length, which its prompts and wiring are written for, ` +
    "even once its prompts are in the user's words and its tweak segments filled, " +
    `and write these cheaper settings in its generate nodes' params: ${cheaper}; its final runs them at ${atFinal}. ${take === undefined ? "" : `A take costs ${amount(take)} credits; `}` +
    "the final is made at its settings from the take they pick, keeping it as it is, or straight away when they ask for a final."
  );
}

/** The tool that reads one template; it renders in the turn's language when called, so one object serves every turn. */
export const getGenerationTemplate: Tool<{ id: string; style?: string }, string, StudioToolContext> = tool({
  description:
    `Read one generation template in full before proposing it with ${PROPOSE_CANVAS_ACTION}: its nodes and wiring, ` +
    "the inputs the user supplies, each generate node's prompt in the user's language as the segments to send, " +
    "how to send it, and the craft for writing its prompts. The templates, and when to offer each, are listed in " +
    `${PROPOSE_CANVAS_ACTION}'s description.`,
  inputSchema: z.object({
    id: z.enum(GENERATION_TEMPLATES.map((template) => template.id)).describe("The template's id, as the proposal tool's description lists it."),
    style: z
      .string()
      .optional()
      .describe("For a template that takes a style: the style's id. Left out, the reading lists the template's styles."),
  }),
  contextSchema: studioToolContextSchema,
  metadata: { runningLine: "chat.tool.readingTemplate" },
  execute: async (
    { id, style }: { id: string; style?: string },
    // The signal is unused: builds text and returns, so there is nothing to abandon.
    { context }: { abortSignal?: AbortSignal; context?: StudioToolContext },
  ): Promise<string> => {
    const template = GENERATION_TEMPLATES.find((one) => one.id === id);
    // The input schema admits only registered ids.
    if (template === undefined) throw new Error(`No template "${id}".`);
    const cost = await applyCost(template, context?.studioId);
    return [describeTemplate(template, style), ...(cost === "" ? [] : [cost]), HOW_TO_SEND, templateCraft(template)].join("\n\n");
  },
});
