// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a generation template in a panel writes to the node (inner#977).
 *
 * The same kind of write as the reader picking the template's model by hand
 * (`resolveModelSwitch`), with the template params laid over that model's
 * record first: every other model keeps its own record (#1948).
 */

import { templatePrompt, type GenerationTemplate, type ModelEntry, type PromptSegment } from '@breatic/shared';

import { paramsStoreOf, resolveModelSwitch, type ParamsStoreSource } from '@web/spaces/canvas/generate/model-params';

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
 * @param content - The node's per-model params as they are now.
 * @param picked - The catalog entry of the template's model.
 * @returns The writes.
 */
export function templateWrites(
  template: GenerationTemplate,
  content: ParamsStoreSource | undefined,
  picked: ModelEntry,
): TemplateWrites {
  const store = paramsStoreOf(content);
  const { paramsByModel } = resolveModelSwitch(
    { paramsByModel: { ...store, [picked.name]: { ...store[picked.name], ...template.params } } },
    picked,
  );
  return { mode: template.mode, model: template.model, paramsByModel, prompt: templatePrompt(template) };
}
