// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed node naming a generation template starts from it (inner#977).
 *
 * The template is where the agent starts, not a lock: whatever the agent wrote
 * stays. The template's params belong to the template's mode and model, so
 * they come along only while the node keeps both.
 */

import {
  GENERATION_TEMPLATES,
  findTemplate,
  templatePrompt,
  type ProposalNode,
} from "@breatic/shared";

/** The node with its template filled in, or why the template does not apply. */
export type TemplateExpansion =
  | { ok: true; node: ProposalNode }
  | { ok: false; reason: string };

/**
 * Fills a node from the template it names.
 * @param node - The node as the agent sent it, naming a template.
 * @param locale - The reader's interface language, for the template prompt.
 * @returns The expanded node, or a reason the agent can act on.
 */
export function expandTemplate(node: ProposalNode & { template: string }, locale: string): TemplateExpansion {
  const { template: id, ...rest } = node;
  const template = findTemplate(id);
  if (!template) {
    return {
      ok: false,
      reason: `No template "${id}". Templates: ${GENERATION_TEMPLATES.map((t) => t.id).join(", ")}.`,
    };
  }
  if (rest.type !== template.nodeType) {
    return { ok: false, reason: `Template "${id}" is for ${template.nodeType} nodes, not ${rest.type}.` };
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
      prompt: rest.prompt ?? [...templatePrompt(template, locale)],
    },
  };
}
