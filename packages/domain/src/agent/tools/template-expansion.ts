// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A proposed node naming a template starts from it (inner#977, inner#1345).
 *
 * The node names the template and its own place in it: the anchor, one of the
 * template's other nodes by key, or one of its inputs. The template is where
 * the agent starts, not a lock: whatever the agent wrote stays, and the
 * template's params come along only while the node keeps the mode and model
 * they belong to. A generate node's prompt is the agent's own (inner#1315):
 * the template's words mark each reference for the user to mention by hand,
 * and a proposal mentions the nodes it wires in, so the agent sends those
 * words back with a ref where each mark stood.
 */

import {
  GENERATION_TEMPLATES,
  markedSegments,
  storyboardSpec,
  t,
  templateMarkTargets,
  templateNodeDefaults,
  templateNodeWords,
  type GenerationTemplate,
  type ProposalNode,
  type TemplateNodeKey,
} from "@breatic/shared";

import { onDialogueSide, proposalModelEntry } from "@domain/agent/tools/proposal-dialogue.js";
import { fixOn, refuse, type NodeLabel, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { poolSentence } from "@domain/agent/tools/proposal-routing.js";
import { GET_GENERATION_TEMPLATE } from "@domain/agent/tools/tool-names.js";

/**
 * Where a node stands in the template it names, as the agent writes it;
 * `anchor` is the index of its instance's anchor (inner#1825).
 */
export type TemplateTag = { id: string; key?: string; anchor?: number } | { id: string; input: string; anchor?: number };

/**
 * Where a node stands once its tag is read: the anchor, another node by key,
 * or an input; `tagAnchor` is the anchor index its tag names, if any.
 */
export type TemplatePlace =
  | { template: GenerationTemplate; key: TemplateNodeKey; anchor: boolean; tagAnchor?: number }
  | { template: GenerationTemplate; input: string; tagAnchor?: number };

/** The node with its template filled in, or why the template does not apply. */
export type TemplateExpansion = { ok: true; node: ProposalNode } | Refusal;

/** The words a generate node takes in the mode it is sent in, as refusals and fixes name them. */
export type SentWords = { name: "shots" | "lines" | "prompt"; mentions: string; write: string; placed: string };

/**
 * The words a generate node takes as it is sent: shots on a node that carries them, lines on
 * the dialogue side of a model whose speakers stand in for its voice
 * (inner#1825 design 8.5), a prompt otherwise, whatever form the template's
 * own words have.
 * @param node - The node, with the mode, model and params it is sent with.
 * @returns How refusals and fixes name those words.
 * @throws {never} Never.
 */
export function sentWords(node: Pick<ProposalNode, "mode" | "model" | "params"> & { readonly shots?: unknown }): SentWords {
  if (node.shots !== undefined) return { name: "shots", mentions: "the shots @", write: "write the shots.", placed: " in a shot" };
  if (onDialogueSide(node)) return { name: "lines", mentions: "the lines @", write: "write the lines.", placed: " in a line" };
  return { name: "prompt", mentions: "the prompt @s", write: "write a prompt.", placed: "" };
}

/**
 * Template keys and inputs, quoted, for a sentence.
 * @param names - The names.
 * @returns They, quoted and joined.
 * @throws {never} Never.
 */
export function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * A template generate node's prompt, or its shots or lines when it has them,
 * or a text node's words (inner#1824, CAP-3), as the segments a proposal sends: words as they are, each reference mark as a ref
 * naming what is wired in there by its key, the number left for the agent to
 * fill since it knows which node it wired in for each.
 * @param template - The template.
 * @param key - The node's key; the anchor when left out.
 * @param style - The picked style, whose paragraph follows a node that takes one (inner#1817).
 * @returns The segments, written out as the agent would send them.
 * @throws {never} Never.
 */
export function templateSegmentsText(template: GenerationTemplate, key: TemplateNodeKey = template.anchor, style?: string): string {
  const targets = templateMarkTargets(template, key);
  /**
   * One locale string written out as segments.
   * @param rest - The key under the template's locale entry.
   * @returns The segments as JSON-like text.
   */
  const segments = (rest: string): string => {
    const parts = markedSegments(t(`canvas.template.${template.id}.${rest}`)).map((segment) => {
      if (segment.slot?.kind === "asset") {
        const target = targets.get(segment.slot.label);
        const named = target === undefined ? `"${segment.slot.label}"` : "input" in target ? `input "${target.input}"` : `node "${target.node}"`;
        return `{"ref": <index of the node wired in for ${named}>}`;
      }
      return JSON.stringify(segment.slot === undefined ? { text: segment.text } : { slot: segment.slot });
    });
    return `[${parts.join(", ")}]`;
  };
  const words = templateNodeWords(template, key, style);
  if ("prompt" in words) {
    const own = segments(words.prompt);
    return words.styleKey === undefined ? own : `${own.slice(0, -1)}, ${JSON.stringify({ text: `\n${t(words.styleKey)}` })}]`;
  }
  if ("lines" in words) return `lines: [${words.lines.map((line) => `{"speaker": ${String(line.speaker)}, "prompt": ${segments(line.key)}}`).join(", ")}]`;
  return `shots: [${words.shots.map((shot) => `{"duration": ${String(shot.seconds)}, "prompt": ${segments(shot.key)}}`).join(", ")}]`;
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
    return { template, input: input.key, ...(tag.anchor === undefined ? {} : { tagAnchor: tag.anchor }) };
  }
  const key = tag.key ?? template.anchor;
  const own = template.nodes.find((one) => one.key === key);
  if (!own) {
    return refuse("template-key-unknown", `Template "${template.id}" has no node "${key}". Its nodes: ${quoted(template.nodes.map((one) => one.key))}.`);
  }
  if (node.role !== own.role || node.type !== own.type) {
    return refuse("template-key-kind", `Node "${key}" of template "${template.id}" is a ${own.role} ${own.type} node; "${node.name}" is a ${node.role} ${node.type} node.`);
  }
  return { template, key, anchor: key === template.anchor, ...(tag.anchor === undefined ? {} : { tagAnchor: tag.anchor }) };
}

/**
 * Fills a node from the template its tag has been read into.
 * @param place - Where the node stands in its template.
 * @param rest - The node, without its tag.
 * @param at - The node, as a fix names it.
 * @returns The expanded node, or a reason the agent can act on.
 * @throws {never} Never.
 */
export function expandAt(place: TemplatePlace, rest: ProposalNode, at: NodeLabel): TemplateExpansion {
  if ("input" in place) return { ok: true, node: rest };
  const { template, key, anchor } = place;
  if (rest.role === "source") {
    if (rest.material !== undefined) {
      return refuse("template-resource-material", `"${rest.name}" is template "${template.id}"'s "${key}", which lands holding the template's own file, so it takes no material.`);
    }
    return { ok: true, node: templateNodeDefaults(template, key, rest) };
  }
  if (rest.role === "written") {
    // A text node is sent holding its words (inner#1824, CAP-3).
    if (rest.prompt === undefined || rest.prompt.length === 0) {
      return refuse(
        "template-no-text",
        `"${rest.name}" names template "${template.id}" and sends no words. The template's text, to rewrite in the user's language with their story in it: ${templateSegmentsText(template, key)}.`,
        fixOn(at, "write its words."),
      );
    }
    return { ok: true, node: templateNodeDefaults(template, key, rest) };
  }
  const own = template.nodes.find((one) => one.key === key);
  const filled = templateNodeDefaults(template, anchor ? undefined : key, rest);
  if (rest.prompt === undefined && rest.shots === undefined && rest.lines === undefined) {
    // The pool is the template's own model's; a node settling another model
    // is told how its nodes go in once it has a prompt to check.
    const keeps = own?.role === "generate" && filled.mode === own.mode && filled.model === own.model;
    // A shot-list node goes on writing its shots wherever its model takes shots, as HOW_TO_SEND says,
    // unless the model plans its own shots from a prompt (auto_shots, refused beside shots).
    const board = own?.role === "generate" && own.shots !== undefined ? storyboardSpec(proposalModelEntry(filled)?.params ?? {}, filled.mode ?? "") : undefined;
    const shotsHere = board !== undefined && !(board.autoParam !== undefined && filled.params?.[board.autoParam] === true);
    const words = sentWords(shotsHere && own?.role === "generate" ? { ...filled, shots: own.shots } : filled);
    const pool = keeps ? ` Each node ${words.mentions} goes into the pool. ${poolSentence(rest.name)}` : "";
    const form = own?.role !== "generate" ? "prompt" : own.shots !== undefined ? "shots" : own.lines !== undefined ? "lines" : "prompt";
    const styled = template.styles !== undefined && own?.role === "generate" && own.styleWords !== undefined
      ? ` These words are followed by one style's paragraph: read it with ${GET_GENERATION_TEMPLATE} and style.`
      : "";
    return refuse("template-no-prompt", `"${rest.name}" names template "${template.id}" and sends no ${words.name}. The template's ${form}, to rewrite in the user's language with their story or detail in it: ${templateSegmentsText(template, key)}.${styled}${pool}`, fixOn(at, words.write));
  }
  return { ok: true, node: filled };
}
