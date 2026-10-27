// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed node naming a template starts from it (inner#977, inner#1345).
 *
 * The node names the template and its own place in it: the anchor, one of the
 * template's other nodes by key, or one of its inputs. The template is where
 * the agent starts, not a lock: whatever the agent wrote stays, and the
 * template's params come along only while the node keeps the mode and model
 * they belong to. A generate node's prompt is the agent's own (inner#1315):
 * the template's words mark each reference for the reader to mention by hand,
 * and a proposal mentions the nodes it wires in, so the agent sends those
 * words back with a ref where each mark stood.
 */

import {
  GENERATION_TEMPLATES,
  markedSegments,
  t,
  templateNodeDefaults,
  templateSkeleton,
  type GenerationTemplate,
  type ProposalNode,
  type TemplateNodeKey,
} from "@breatic/shared";

import { fixOn, refuse, type NodeLabel, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { poolSentence } from "@domain/agent/tools/proposal-routing.js";

/** Where a node stands in the template it names, as the agent writes it. */
export type TemplateTag = { id: string; key?: string } | { id: string; input: string };

/** Where a node stands once its tag is read: the anchor, another node by key, or an input. */
export type TemplatePlace =
  | { template: GenerationTemplate; key: TemplateNodeKey; anchor: boolean }
  | { template: GenerationTemplate; input: string };

/** The node with its template filled in, or why the template does not apply. */
export type TemplateExpansion = { ok: true; node: ProposalNode } | Refusal;

/**
 * Template keys and inputs, quoted, for a sentence.
 * @param names - The names.
 * @returns They, quoted and joined.
 * @throws {never} Never.
 */
function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * A template generate node's prompt as the segments a proposal sends: words as
 * they are, each reference mark as a ref naming what is wired in there by its
 * key, the number left for the agent to fill since it knows which node it
 * wired in for each.
 * @param template - The template.
 * @param key - The generate node's key; the anchor when left out.
 * @returns The segments, written out as the agent would send them.
 * @throws {never} Never.
 */
export function templateSegmentsText(template: GenerationTemplate, key: TemplateNodeKey = template.anchor): string {
  const skeleton = templateSkeleton(template);
  /**
   * One of the template's strings in the reader's language.
   * @param rest - The key under the template's locale entry.
   * @returns The string.
   */
  const text = (rest: string): string => t(`canvas.template.${template.id}.${rest}`);
  const targets = new Map<string, string>();
  for (const input of skeleton.inputs) {
    if (input.feeds.includes(key)) targets.set(text(`input.${input.key}.name`), `input "${input.key}"`);
  }
  for (const edge of skeleton.edges) {
    if (edge.to === key && edge.into === "pool") targets.set(text(`node.${edge.from}.name`), `node "${edge.from}"`);
  }
  const words = text(key === template.anchor ? "prompt" : `node.${key}.prompt`);
  const parts = markedSegments(words).map((segment) => {
    if (segment.slot?.kind === "asset") {
      return `{"ref": <index of the node wired in for ${targets.get(segment.slot.label) ?? `"${segment.slot.label}"`}>}`;
    }
    return JSON.stringify(segment.slot === undefined ? { text: segment.text } : { slot: segment.slot });
  });
  return `[${parts.join(", ")}]`;
}

/**
 * Where a node stands in the template its tag names.
 * @param tag - The tag as the agent wrote it.
 * @param node - The node carrying it.
 * @param templates - The registry to read the tag against.
 * @returns Its place, or why the tag does not fit the node.
 * @throws {never} Never.
 */
export function templatePlace(tag: TemplateTag, node: ProposalNode, templates: readonly GenerationTemplate[] = GENERATION_TEMPLATES): TemplatePlace | Refusal {
  const template = templates.find((candidate) => candidate.id === tag.id);
  if (!template) {
    return refuse("template-unknown", `No template "${tag.id}". Templates: ${templates.map((one) => one.id).join(", ")}.`);
  }
  if ("input" in tag) {
    const input = template.inputs.find((one) => one.key === tag.input);
    if (!input) {
      return refuse("template-key-unknown", `Template "${template.id}" has no input "${tag.input}". Its inputs: ${quoted(template.inputs.map((one) => one.key)) || "none"}.`);
    }
    if (node.type !== input.type) {
      return refuse("template-key-kind", `Input "${input.key}" of template "${template.id}" takes ${input.type}; "${node.name}" is a ${node.type} node.`);
    }
    return { template, input: input.key };
  }
  const key = tag.key ?? template.anchor;
  const own = template.nodes.find((one) => one.key === key);
  if (!own) {
    return refuse("template-key-unknown", `Template "${template.id}" has no node "${key}". Its nodes: ${quoted(template.nodes.map((one) => one.key))}.`);
  }
  if (node.role !== own.role || node.type !== own.type) {
    return refuse("template-key-kind", `Node "${key}" of template "${template.id}" is a ${own.role} ${own.type} node; "${node.name}" is a ${node.role} ${node.type} node.`);
  }
  return { template, key, anchor: key === template.anchor };
}

/**
 * Reads a node's template tag and fills the node from the template.
 * @param node - The node as the agent sent it, naming a template.
 * @param at - The node, as a fix names it.
 * @param templates - The registry to read the tag against.
 * @returns The expanded node, or a reason the agent can act on.
 * @throws {never} Never.
 */
export function expandTemplate(
  node: ProposalNode & { template: TemplateTag },
  at: NodeLabel,
  templates: readonly GenerationTemplate[] = GENERATION_TEMPLATES,
): TemplateExpansion {
  const { template: tag, ...rest } = node;
  const place = templatePlace(tag, rest, templates);
  if ("ok" in place) return place;
  if ("input" in place) return { ok: true, node: rest };
  const { template, key, anchor } = place;
  if (rest.role === "source") {
    if (rest.material !== undefined) {
      return refuse("template-resource-material", `"${rest.name}" is template "${template.id}"'s "${key}", which lands holding the template's own file, so it takes no material.`);
    }
    return { ok: true, node: templateNodeDefaults(template, key, rest) };
  }
  const own = template.nodes.find((one) => one.key === key);
  const filled = templateNodeDefaults(template, anchor ? undefined : key, rest);
  if (rest.prompt === undefined && rest.shots === undefined) {
    // The pool is the template's own model's; a node settling another model
    // is told how its nodes go in once it has a prompt to check.
    const keeps = own?.role === "generate" && filled.mode === own.mode && filled.model === own.model;
    const pool = keeps ? ` Each node the prompt @s goes into the pool. ${poolSentence(rest.name)}` : "";
    return refuse("template-no-prompt", `"${rest.name}" names template "${template.id}" and sends no prompt. The template's prompt, to rewrite in the reader's language with their story or detail in it: ${templateSegmentsText(template, key)}.${pool}`, fixOn(at, "write a prompt."));
  }
  return { ok: true, node: filled };
}
