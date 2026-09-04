// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Model-param reconciliation for the Generate panel.
 *
 * Each model in the catalog defines its own param set (aspect ratio,
 * resolution, model-specific knobs) with allowed `values` + a `default`, and
 * the node keeps ONE RECORD PER MODEL under `data.paramsByModel` (#1948).
 * Selecting a model reconciles its own record against its own declaration: a
 * still-valid value is kept, an invalid one falls back to that model's
 * default, and a key the model does not declare is dropped.
 *
 * Nothing flows between two models' records. A value the user chose on one
 * model is still there when they come back to it, because it never left that
 * model's record — not because it was carried along. That is what makes a
 * mode switch safe: the mode's model brings its own record, and the model the
 * user is leaving keeps its own.
 *
 * The records are the only place the panel's param CONTROLS write to. The node
 * has no separate "params in effect" field: what the panel renders is resolved
 * from the records on every render, so there is no second copy to keep in step.
 *
 * Not every key a model declares under `params` is one of these. `prompt`,
 * `images` (the reference rail) and `style_images` (`data.styleImageUrl`) are
 * declared params whose values live elsewhere on the node or on the prompt;
 * the execute payload spreads the records first and then overwrites those
 * three, so whatever a record holds for them does not reach the request.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

/** What {@link paramsStoreOf} reads off a node to get its per-model records. */
export interface ParamsStoreSource {
  /** Per-model records. Absent on a node that has never had a param written. */
  paramsByModel?: Record<string, Record<string, unknown>>;
}

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
 * Reconciles one model's own param record against its own declaration: for
 * every param the model defines, keep the current value if valid else use the
 * model's default. Keys the model does NOT declare are dropped, so the result
 * is exactly the model's declared param set (#1948).
 *
 * Dropping is safe now that records are per model: the input is either that
 * model's own record or nothing at all, so an undeclared key can only come
 * from a param we since removed from the catalog — not worth carrying, and it
 * would ride into the request payload, where the worker drops it and logs
 * `unknown_param_dropped`.
 * @param model - The model whose param set to reconcile against.
 * @param current - That model's stored record (empty for a model never used).
 * @returns A new params object holding exactly the model's declared params.
 */
export function resolveParamsForModel(
  model: ModelEntry,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  // model.params is trusted (the catalog is sanitized at the API boundary): it
  // is always a Record<string, ParamDescriptor>.
  for (const [key, descriptor] of Object.entries(model.params)) {
    // A param whose value can only come from a live upstream list keeps
    // nothing but what the user actually chose. Writing its yaml default into
    // the record makes "has a voice been chosen" answer yes for a picker the
    // user never opened, and the panel would go on to speak in a voice nobody
    // picked.
    if (descriptor.remote_source && current[key] === undefined) continue;
    next[key] = resolveParamValue(descriptor, current[key]);
  }
  return next;
}

/**
 * The node's per-model param records.
 *
 * A node that has never had a param written has none, and every model then
 * starts from its own declared defaults. Nothing is carried over from before
 * this slice: a node that predates it keeps whatever it kept, and no code path
 * reads that any more (user 2026-08-15 — Yjs data from before launch gets no
 * compatibility handling at all).
 *
 * One line, but it stays a function: where a node's records come from is one
 * decision, and the three write paths should not each spell it out.
 * @param content - The node's per-model records.
 * @returns The records to read from and write back.
 */
export function paramsStoreOf(
  content: ParamsStoreSource | undefined,
): Record<string, Record<string, unknown>> {
  return content?.paramsByModel ?? {};
}

/** What a model switch resolves to: the params to render plus every record to persist. */
export interface ModelSwitchResult {
  /** The picked model's declared param set — what the panel renders. */
  params: Record<string, unknown>;
  /** Every per-model record to write back, this switch's included. */
  paramsByModel: Record<string, Record<string, unknown>>;
}

/**
 * Resolves what to persist when a model becomes the selected one, whether the
 * user picked it directly or a mode switch brought it in.
 *
 * The picked model reads its OWN record and nothing else. A model being used
 * for the first time therefore starts from its own declared defaults — the
 * model being left has no way to reach it, which is the whole point of #1948.
 *
 * Every record is returned, not just this one, because the caller writes the
 * whole thing: dropping the rest here is what would silently break "switch
 * away and back keeps the value".
 * @param content - The node's per-model records.
 * @param picked - The model becoming the selected one.
 * @returns The params to render and every per-model record to persist.
 */
export function resolveModelSwitch(
  content: ParamsStoreSource | undefined,
  picked: ModelEntry,
): ModelSwitchResult {
  const store = paramsStoreOf(content);
  const params = resolveParamsForModel(picked, store[picked.name] ?? {});
  return { params, paramsByModel: { ...store, [picked.name]: params } };
}

/**
 * Resolves the records to persist when the user changes a param.
 *
 * The edit lands on the record of the model it was made on, so coming back to
 * that model finds it and no OTHER model's record is disturbed — dropping the
 * rest of the store here is what would silently break "switch away and back
 * keeps the value".
 *
 * `currentModel` is the model the panel is SHOWING, which is not the same as
 * the one the node has stored: a node created moments ago has stored none at
 * all (`node-factory` writes no model), and a node whose stored model is no
 * longer offered under the active mode falls back to another one. Keying the
 * record on the stored id in either case writes the edit somewhere the panel
 * will never read it back from, and the control snaps to the default on the
 * next render.
 *
 * An absent model id persists no record rather than one keyed by the empty
 * string. The panels only render param controls once a model resolves, so the
 * only way to reach it is an empty catalog — where no control is on screen to
 * change in the first place.
 *
 * Takes the change as an OBJECT rather than a `Record`: each panel's control
 * hands over its own shaped value (`VideoParamsValue`, the image ratio /
 * camera pair), and those interfaces have no index signature — widening them
 * at the call site would need a cast, which is exactly the kind of assertion
 * that stops the compiler from checking what is being written.
 * @param content - The node's per-model records.
 * @param partial - The params the control changed, merged over the current set.
 * @param currentModel - The model the panel resolved and is rendering controls for.
 * @returns Every per-model record to persist.
 */
export function resolveParamsEdit(
  content: ParamsStoreSource | undefined,
  partial: object,
  currentModel: string,
): Record<string, Record<string, unknown>> {
  const store = paramsStoreOf(content);
  if (!currentModel) return store;
  return {
    ...store,
    [currentModel]: { ...(store[currentModel] ?? {}), ...partial },
  };
}
