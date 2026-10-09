// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed node naming a generation template starts from it (inner#977).
 *
 * The template is where the agent starts, not a lock: whatever the agent wrote
 * stays. The template's params belong to the template's mode and model, so
 * they come along only while the node keeps both. The prompt is the agent's
 * own (inner#1315): the template's words mark each reference for the reader
 * to mention by hand, and a proposal mentions the nodes it wires in, so the
 * agent sends those words back with a ref where each mark stood.
 */

import {
  GENERATION_TEMPLATES,
  findTemplate,
  templatePrompt,
  type GenerationTemplate,
  type ProposalNode,
} from "@breatic/shared";

import { refuse, type Refusal } from "@domain/agent/tools/proposal-refusals.js";

/** The node with its template filled in, or why the template does not apply. */
export type TemplateExpansion =
  | { ok: true; node: ProposalNode }
  | Refusal;

/**
 * A template's prompt as the segments a proposal sends: words as they are,
 * each reference mark as a ref naming the node it stands for. The number is
 * the agent's to fill: it knows which node it wired in for which reference.
 * @param template - The template.
 * @returns The segments, written out as the agent would send them.
 * @throws {never} Never.
 */
export function templateSegmentsText(template: GenerationTemplate): string {
  const parts = templatePrompt(template).map((segment) =>
    segment.slot?.kind === "asset"
      ? `{"ref": <index of the node wired in for ${segment.slot.label}>}`
      : JSON.stringify(segment.slot === undefined ? { text: segment.text } : { slot: segment.slot }),
  );
  return `[${parts.join(", ")}]`;
}

/**
 * Fills a node from the template it names.
 * @param node - The node as the agent sent it, naming a template.
 * @returns The expanded node, or a reason the agent can act on.
 * @throws {never} Never.
 */
export function expandTemplate(node: ProposalNode & { template: string }): TemplateExpansion {
  const { template: id, ...rest } = node;
  const template = findTemplate(id);
  if (!template) {
    return refuse("template-unknown", `No template "${id}". Templates: ${GENERATION_TEMPLATES.map((t) => t.id).join(", ")}.`);
  }
  if (rest.role !== "generate") {
    return refuse("template-role", `Template "${id}" goes on a generate node; "${rest.name}" is a ${rest.role} node.`);
  }
  if (rest.type !== template.nodeType) {
    return refuse("template-type", `Template "${id}" is for ${template.nodeType} nodes, not ${rest.type}.`);
  }
  if (rest.prompt === undefined) {
    return refuse("template-no-prompt", `"${rest.name}" names template "${id}" and sends no prompt. Send the template's prompt as its own, rewritten in the reader's language with their story or detail in it: ${templateSegmentsText(template)}.`);
  }
  const mode = rest.mode ?? template.mode;
  const model = rest.model ?? template.model;
  const keepsTemplate = mode === template.mode && model === template.model;
  const params = keepsTemplate ? { ...template.params, ...rest.params } : rest.params;
  return {
    ok: true,
    node: {
      ...rest,
      mode,
      model,
      ...(params === undefined ? {} : { params }),
      prompt: rest.prompt,
    },
  };
}
