// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

/** What {@link paramsStoreOf} reads off a node to build its per-model records. */
export interface ParamsStoreSource {
  /** The node's currently selected model id. */
  model?: string;
  /** The params in effect right now (the pre-#1948 single set on old nodes). */
  params?: Record<string, unknown>;
  /** Per-model records, absent on nodes that predate #1948. */
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
 * from a stale declaration (a param we removed from the catalog) or from the
 * one-time migration of a pre-#1948 node — neither is worth carrying, and
 * both would ride into the request payload, where the worker drops them and
 * logs `unknown_param_dropped`.
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
    next[key] = resolveParamValue(descriptor, current[key]);
  }
  return next;
}

/**
 * The node's per-model param records, migrating a pre-#1948 node on the way.
 *
 * A node that already has `paramsByModel` is returned as-is, INCLUDING an
 * empty one: the field's presence is what says "this node has been through
 * the new code path", so migrating on top of it would be a second migration.
 * No path writes an empty one today — every write goes through
 * {@link resolveModelSwitch} or {@link resolveParamsEdit}, and both persist at
 * least the current model's record — so this reads as a guard for a shape we
 * do not produce rather than as a case anyone can reach.
 *
 * A node without it predates #1948 and carries a single `params` set. That set
 * belongs to the ONE model it was last on, so it is handed to that model and
 * to no other — handing it to every model the user later picks is precisely
 * the defect this slice fixes. It is passed through
 * {@link resolveParamsForModel} on the way, which strips the keys belonging to
 * models the node visited before (`end_image` / `video` / `images` on the
 * video side) so they never reach a request payload.
 *
 * Nothing to migrate (no content, no model yet, or a model that has left the
 * catalog and therefore has no declaration to filter against) yields empty
 * records: every model then starts from its own defaults, which is the correct
 * reading of "we cannot tell which of these values the user chose".
 * @param content - The node's model / params / per-model records.
 * @param models - The catalog models this panel offers, used to find the current model's declaration.
 * @returns The per-model records to read from and write back.
 */
export function paramsStoreOf(
  content: ParamsStoreSource | undefined,
  models: readonly ModelEntry[],
): Record<string, Record<string, unknown>> {
  if (content?.paramsByModel) return content.paramsByModel;
  const current = content?.model;
  if (!current) return {};
  const entry = models.find((m) => m.name === current);
  if (!entry) return {};
  return { [current]: resolveParamsForModel(entry, content?.params ?? {}) };
}

/** What a model switch resolves to: the live params plus every record to persist. */
export interface ModelSwitchResult {
  /** The params now in effect — the picked model's declared set. */
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
 * whole thing: the store it was built from may hold a record migrated out of
 * a pre-#1948 node (see {@link paramsStoreOf}), and that record only survives
 * if this write carries it along.
 * @param content - The node's model / params / per-model records.
 * @param picked - The model becoming the selected one.
 * @param models - The catalog models this panel offers.
 * @returns The params in effect and every per-model record to persist.
 */
export function resolveModelSwitch(
  content: ParamsStoreSource | undefined,
  picked: ModelEntry,
  models: readonly ModelEntry[],
): ModelSwitchResult {
  const store = paramsStoreOf(content, models);
  const params = resolveParamsForModel(picked, store[picked.name] ?? {});
  return { params, paramsByModel: { ...store, [picked.name]: params } };
}

/**
 * Resolves what to persist when the user changes a param.
 *
 * The edit lands on the record of the model it was made on, so coming back to
 * that model finds it and no OTHER model's record is disturbed — dropping the
 * rest of the store here is what would silently break "switch away and back
 * keeps the value".
 *
 * An absent model id persists no record rather than one keyed by the empty
 * string. The panels only render param controls once a model resolves, so this
 * is a guard rather than a reachable state.
 * `currentModel` is the model the panel is SHOWING, which is not the same as
 * the one the node has stored: a node created moments ago has stored none at
 * all (`node-factory` writes neither `model` nor `params`), and a node whose
 * stored model is no longer offered under the active mode falls back to
 * another one. Keying the record on the stored id in either case writes the
 * edit somewhere the panel will never read it back from, and the control
 * snaps to the default on the next render.
 *
 * Takes the change as an OBJECT rather than a `Record`: each panel's control
 * hands over its own shaped value (`VideoParamsValue`, the image ratio /
 * camera pair), and those interfaces have no index signature — widening them
 * at the call site would need a cast, which is exactly the kind of assertion
 * that stops the compiler from checking what is being written.
 * @param content - The node's model / params / per-model records.
 * @param partial - The params the control changed, merged over the current set.
 * @param models - The catalog models this panel offers.
 * @param currentModel - The model the panel resolved and is rendering controls for.
 * @returns The params in effect and every per-model record to persist.
 */
export function resolveParamsEdit(
  content: ParamsStoreSource | undefined,
  partial: object,
  models: readonly ModelEntry[],
  currentModel: string,
): ModelSwitchResult {
  const store = paramsStoreOf(content, models);
  // Merged over the CURRENT MODEL'S record, not over `content.params`: those
  // two agree while the panel sits on the stored model, but not on a fresh
  // node, nor right after a migration whose set belongs to the model the user
  // has since left. Starting from the wrong one leaks that model's keys into
  // this one's record — the very mixing #1948 exists to stop.
  const params = { ...(store[currentModel] ?? {}), ...partial };
  return {
    params,
    paramsByModel: currentModel ? { ...store, [currentModel]: params } : store,
  };
}
