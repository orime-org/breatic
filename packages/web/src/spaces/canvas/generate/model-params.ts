// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model-param reconciliation for the Generate panel.
 *
 * Each model in the catalog defines its own param set (aspect ratio,
 * resolution, model-specific knobs) with allowed `values` + a `default`.
 * When the user switches model, the previously chosen params may no longer be
 * valid for the new model, so they are reconciled: a still-valid value is
 * kept, an invalid one falls back to the new model's default, and a param the
 * new model does not define is dropped.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

/**
 * Resolves the value for a single param against the current selection: keeps a
 * current value that is allowed (in `values`, or any value for a free param),
 * otherwise falls back to the descriptor's default.
 * @param descriptor - The param descriptor from the model.
 * @param current - The currently selected value (may be undefined).
 * @returns The reconciled value for this param.
 */
function resolveParamValue(
  descriptor: ParamDescriptor,
  current: unknown,
): unknown {
  // descriptor is trusted (the catalog is sanitized at the API boundary): it is
  // an object whose `values`, when present, is an array.
  if (current === undefined) return descriptor.default;
  if (descriptor.values && !descriptor.values.some((v) => v === current)) {
    return descriptor.default;
  }
  return current;
}

/**
 * Reconciles the current Generate params against a (possibly newly selected)
 * model: for every param the model defines, keep the current value if valid
 * else use the model's default; params the model does not define are dropped.
 * @param model - The model whose param set to reconcile against.
 * @param current - The current param selection (from `node.data.params`).
 * @returns A new params object valid for the given model.
 */
export function resolveParamsForModel(
  model: ModelEntry,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  // model.params is trusted (the catalog is sanitized at the API boundary): it
  // is always a Record<string, ParamDescriptor>. A model with no param set
  // simply yields no params.
  for (const [key, descriptor] of Object.entries(model.params)) {
    next[key] = resolveParamValue(descriptor, current[key]);
  }
  return next;
}
