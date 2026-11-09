// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How `scripts/provider-config-migration.ts` merges what it generates into
 * the `config/provider/` files already there: it owns only each model's
 * WaveSpeed binding and its own upstream and LLM entries, so reseller
 * bindings and prices written since survive a rerun (inner#1775).
 */

const OWNED = "wavespeed";

/**
 * Whether a value is a plain object.
 * @param {unknown} value - The value.
 * @returns {boolean} True for a non-null, non-array object.
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge the generated WaveSpeed bindings into the existing media models: each
 * model's WaveSpeed binding is replaced in place (or added first), every other
 * binding, the model's own entries (its vendor's `rejects`) and every model the
 * catalog no longer generates are kept.
 * @param {Record<string, { upstreams: Record<string, unknown>[] }> | undefined} existing - The models in the file now.
 * @param {Record<string, { upstreams: Record<string, unknown>[] }>} generated - The models generated from the catalog.
 * @returns {Record<string, { upstreams: Record<string, unknown>[] }>} The merged models.
 */
export function mergeMediaModels(existing, generated) {
  const out = { ...existing };
  for (const [model, { upstreams: own }] of Object.entries(generated)) {
    const kept = out[model]?.upstreams ?? [];
    const at = kept.findIndex((b) => b.upstream === OWNED);
    // The generator writes only WaveSpeed bindings.
    const others = kept.filter((b) => b.upstream !== OWNED);
    out[model] = { ...out[model], upstreams: at < 0 ? [...own, ...others] : [...kept.slice(0, at), ...own, ...kept.slice(at + 1)] };
  }
  return out;
}

/**
 * Merge the generated upstreams into the existing ones, by name.
 * @param {Record<string, unknown> | undefined} existing - The upstreams in the file now.
 * @param {Record<string, unknown>} generated - The generated upstreams.
 * @returns {Record<string, unknown>} The merged upstreams.
 */
export function mergeUpstreams(existing, generated) {
  return { ...existing, ...generated };
}

/**
 * Merge two lists of routes by prefix: a generated route replaces the one with its prefix in place, a new one is added at the end.
 * @param {{ prefix: string }[]} existing - The routes now.
 * @param {{ prefix: string }[]} generated - The generated routes.
 * @returns {{ prefix: string }[]} The merged routes.
 */
function mergeRoutes(existing, generated) {
  const out = existing.map((route) => generated.find((g) => g.prefix === route.prefix) ?? route);
  return [...out, ...generated.filter((g) => !existing.some((route) => route.prefix === g.prefix))];
}

/**
 * Merge the generated LLM file into the existing one: route lists by prefix, tables
 * (prices, vendor ids, backends) by key, single settings replaced; what the generator
 * does not write is kept.
 * @param {Record<string, unknown> | undefined} existing - The file now.
 * @param {Record<string, unknown>} generated - The generated file.
 * @returns {Record<string, unknown>} The merged file.
 */
export function mergeLlm(existing, generated) {
  const out = { ...existing };
  for (const [key, value] of Object.entries(generated)) {
    const now = out[key];
    if (Array.isArray(now) && Array.isArray(value)) out[key] = mergeRoutes(now, value);
    else if (isObject(now) && isObject(value)) out[key] = { ...now, ...value };
    else out[key] = value;
  }
  return out;
}
