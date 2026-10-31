// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read one generation template in full (inner#1807).
 *
 * The proposal tool's description indexes every template in one line: what
 * it makes, its goal and when to offer it. The full text -- nodes, wiring,
 * inputs, steps and each generate node's prompt in the reader's language --
 * is read here when the agent means to propose one, so a turn does not carry
 * every template's prompts whether it uses them or not.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { GENERATION_TEMPLATES, t, templateAnchor, templateSkeleton, type GenerationTemplate } from "@breatic/shared";

import { templateCraft } from "@domain/agent/tools/template-craft.js";
import { templateSegmentsText } from "@domain/agent/tools/template-expansion.js";
import { PROPOSE_CANVAS_ACTION } from "@domain/agent/tools/tool-names.js";

/** How to send a template once read, in the words the agent reads. */
const HOW_TO_SEND =
  `To use one, send each of its nodes as a node in ${PROPOSE_CANVAS_ACTION}: { id } in template on the anchor, { id, key } on each other node, ` +
  "and wire them as its edges say. Give each input a node of your own wired into the nodes it feeds; " +
  "{ id, input } on that node is optional. A resource node lands holding the template's file: send it with no material. " +
  "Leave out the mode and model you keep. Send each generate node's prompt as its own, rewritten in the language " +
  "the reader writes in with their story or detail in it: fill a tweak segment with words or keep it for them. " +
  "A template with steps gets a text node listing them when it is placed, so write no node for them.";

/**
 * One template written out for the agent: its nodes, wiring, inputs,
 * resources and follow-up steps, what it makes, and each generate node's
 * prompt in the reader's language, so the agent can rewrite that prompt
 * rather than write one from nothing.
 *
 * A prompt is shown as the segments a proposal sends, not as the box shows
 * it: the box adds words to a reference mark, and a model copying what it
 * reads would send those words back inside the label, or a bracket as text.
 * @param template - The template.
 * @returns Its paragraph.
 * @throws {never} Never.
 */
export function describeTemplate(template: GenerationTemplate): string {
  const skeleton = templateSkeleton(template);
  const anchor = templateAnchor(template);
  const nodes = template.nodes.map((node) => {
    const what = node.role === "generate" ? `generate ${node.type}, ${node.mode}, ${node.model}` : `source ${node.type} holding ${node.resource}`;
    return `"${node.key}"${node.key === anchor.key ? " (anchor)" : ""}: ${what}`;
  });
  const edges = skeleton.edges.map((edge) => `"${edge.from}" into "${edge.to}" by "${edge.into ?? "pool"}"`);
  const inputs = skeleton.inputs.map((input) => `"${input.key}" (${input.type}) into ${input.feeds.map((fed) => `"${fed}"`).join(", ")}`);
  const steps = skeleton.steps.map((step) => t(`canvas.template.${template.id}.step.${step}`));
  const prompts = template.nodes.flatMap((node) => (node.role === "generate" ? [`"${node.key}": ${templateSegmentsText(template, node.key)}`] : []));
  return (
    `${template.id}: ${template.agentNote}. Nodes: ${nodes.join("; ")}. ` +
    `Edges: ${edges.length === 0 ? "none" : edges.join("; ")}. Inputs: ${inputs.length === 0 ? "none" : inputs.join("; ")}. ` +
    `Steps after it generates: ${steps.length === 0 ? "none" : steps.join(" / ")}. Prompts, as segments: ${prompts.join("; ")}`
  );
}

/** The tool that reads one template; it renders in the turn's language when called, so one object serves every turn. */
export const getGenerationTemplate: Tool<{ id: string }, string> = tool({
  description:
    `Read one generation template in full before proposing it with ${PROPOSE_CANVAS_ACTION}: its nodes and wiring, ` +
    "the inputs the reader supplies, each generate node's prompt in the reader's language as the segments to send, " +
    "how to send it, and the craft for writing its prompts. The templates, and when to offer each, are listed in " +
    `${PROPOSE_CANVAS_ACTION}'s description.`,
  inputSchema: z.object({ id: z.enum(GENERATION_TEMPLATES.map((template) => template.id)).describe("The template's id, as the proposal tool's description lists it.") }),
  metadata: { runningLine: "chat.tool.readingTemplate" },
  execute: async (
    { id }: { id: string },
    // Unused: builds text and returns, so there is nothing to abandon.
    // Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<string> => {
    const template = GENERATION_TEMPLATES.find((one) => one.id === id);
    // The input schema admits only registered ids.
    if (template === undefined) throw new Error(`No template "${id}".`);
    return [describeTemplate(template), HOW_TO_SEND, templateCraft(template)].join("\n\n");
  },
});
