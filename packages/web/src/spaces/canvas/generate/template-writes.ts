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

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import type { ProposalFeeders } from '@web/spaces/canvas/generate/proposal-prompt';

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

/**
 * The nodes a template's asset marks mention: the images already wired into
 * the node, in rail order. Image to image sends only the @-mentioned
 * references, so mentioning them lets the reader generate straight away;
 * marks left over stay as words for the reader to replace.
 * @param references - The node's reference rail rows.
 * @returns The feeders for `writeProposalPrompt`.
 */
export function templateFeeders(references: readonly ReferenceRailItem[]): ProposalFeeders {
  const ids = new Set(
    references.filter((r) => r.sourceNodeType === 'image' && !r.focus).map((r) => r.sourceNodeId),
  );
  return { sources: [...ids].map((id) => ({ id, kind: 'image' })), upstream: [] };
}
