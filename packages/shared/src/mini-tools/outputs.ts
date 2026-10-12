// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The results a tool makes for a given set of params. Every reader that needs
 * the count (node creation, the request's `node_ids`, a container job's write
 * grants, the batch ticket cap) reads `outputsOf`; a reader that only needs the
 * kind or the name prefix reads `outputTemplateOf`.
 */

import type { MiniToolOutput, MiniToolParam, MiniToolSpec } from "@shared/mini-tools/types.js";

/**
 * A number param's value, falling back to its default.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param key - The param.
 * @returns The value.
 */
function numberParam(spec: MiniToolSpec, params: Readonly<Record<string, unknown>>, key: string): number {
  const value = params[key];
  if (typeof value === "number") return value;
  const declared = (spec.params as readonly MiniToolParam[]).find((param) => param.key === key);
  return declared?.kind === "number" ? declared.default : 0;
}

/**
 * The results the tool makes with these params.
 * @param spec - The tool.
 * @param params - The run's params.
 * @returns One entry per result node, in order.
 */
export function outputsOf(spec: MiniToolSpec, params: Readonly<Record<string, unknown>>): readonly MiniToolOutput[] {
  if (spec.outputs !== undefined) return spec.outputs;
  const count = spec.outputCount;
  const n =
    count.kind === "product"
      ? count.params.reduce((total, key) => total * numberParam(spec, params, key), 1)
      : (Array.isArray(params[count.param]) ? (params[count.param] as unknown[]).length : 0) + count.plus;
  return Array.from({ length: n }, () => spec.output);
}

/**
 * The most results the tool can make: every number param at its max, every
 * list full. Bounds what one run may ask for at once.
 * @param spec - The tool.
 * @returns The result count at those params.
 */
export function mostOutputsOf(spec: MiniToolSpec): number {
  const params: Record<string, unknown> = {};
  for (const param of spec.params) {
    if (!("kind" in param)) continue;
    if (param.kind === "number") params[param.key] = param.max;
    if (param.kind === "list") params[param.key] = Array.from({ length: param.maxItems }, () => param.item.min);
  }
  return outputsOf(spec, params).length;
}

/**
 * The result kind and name prefix, for a reader that needs no count.
 * @param spec - The tool.
 * @returns The first fixed output, or the variable tool's template.
 * @throws {Error} When a fixed tool declares no output.
 */
export function outputTemplateOf(spec: MiniToolSpec): MiniToolOutput {
  const template = spec.outputs !== undefined ? spec.outputs[0] : spec.output;
  if (template === undefined) throw new Error(`mini-tool ${spec.id} declares no output`);
  return template;
}
