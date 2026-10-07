// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a generation template in a panel writes to the node (inner#977).
 *
 * The same kind of write as the reader setting the panel by hand: the
 * template's model gets the template params laid over what the node already
 * remembers for it, and every other model keeps its own record (#1948).
 */

import { templatePrompt, type GenerationTemplate, type PromptSegment } from '@breatic/shared';

/** The mode, model, per-model params and prompt a template puts on a node. */
export interface TemplateWrites {
  mode: string;
  model: string;
  paramsByModel: Record<string, Record<string, unknown>>;
  prompt: readonly PromptSegment[];
}

/**
 * What a template writes to a node.
 * @param template - The template picked.
 * @param remembered - The node's per-model params as they are now.
 * @param locale - The reader's interface language.
 * @returns The writes.
 */
export function templateWrites(
  template: GenerationTemplate,
  remembered: Readonly<Record<string, Record<string, unknown>>> | undefined,
  locale: string,
): TemplateWrites {
  return {
    mode: template.mode,
    model: template.model,
    paramsByModel: {
      ...remembered,
      [template.model]: { ...remembered?.[template.model], ...template.params },
    },
    prompt: templatePrompt(template, locale),
  };
}
