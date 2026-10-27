// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a generation template in a panel writes to each of its
 * generate nodes (inner#977, inner#1345): the anchor and every upstream
 * generation it reuses.
 *
 * The same kind of write as the reader picking the node's model by hand
 * (`resolveModelSwitch`), with the template params laid over that model's
 * record first: every other model keeps its own record (#1948). The prompts
 * come from the template's expansion.
 */

import type { GenerationTemplate, ModelEntry, TemplateGenerateNode } from '@breatic/shared';

import { paramsStoreOf, resolveModelSwitch, type ParamsStoreSource } from '@web/spaces/canvas/generate/model-params';

/** The mode, model and per-model params a template puts on one generate node. */
export interface TemplateWrites {
  mode: string;
  model: string;
  paramsByModel: Record<string, Record<string, unknown>>;
}

/**
 * What a template writes to one of its generate nodes.
 * @param node - The template's generate node.
 * @param content - The canvas node's per-model params as they are now.
 * @param picked - The catalog entry of the template node's model.
 * @returns The writes.
 */
export function templateWrites(
  node: TemplateGenerateNode,
  content: ParamsStoreSource | undefined,
  picked: ModelEntry,
): TemplateWrites {
  const store = paramsStoreOf(content);
  const { paramsByModel } = resolveModelSwitch(
    { paramsByModel: { ...store, [picked.name]: { ...store[picked.name], ...node.params } } },
    picked,
  );
  return { mode: node.mode, model: node.model, paramsByModel };
}

/**
 * Whether a template can be applied here: every one of its generate nodes runs
 * on a model this deployment serves. The menu and the apply share it.
 * @param template - The template.
 * @param served - The names of the models served, across every node type.
 * @returns Whether it can.
 */
export function templateServed(template: GenerationTemplate, served: ReadonlySet<string>): boolean {
  return template.nodes.every((node) => node.role !== 'generate' || served.has(node.model));
}
