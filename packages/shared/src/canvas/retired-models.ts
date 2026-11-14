// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Models the catalog has retired, each read as the model that replaced it
 * (#1521). A canvas node keeps the name it was saved with until collab
 * upgrades the stored document on load; until then web reads it through
 * {@link withCurrentModelNames}, and the server, the worker and a proposal
 * landing on the canvas through {@link currentModelName}.
 */

/** A retired model name to the name of its replacement; never a chain. */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  "gemini-3.1-flash-text-to-speech": "gemini-3.8-flash-text-to-speech",
};

/** The fields of a canvas node's data that name a model. */
export interface NodeModelFields {
  model?: unknown;
  modelByMode?: unknown;
  paramsByModel?: unknown;
}

/**
 * The name a model goes by now.
 * @param name - A model name, possibly retired.
 * @returns Its replacement when retired, else the name itself.
 * @throws {never} Never.
 */
export function currentModelName(name: string): string {
  return Object.hasOwn(RETIRED_MODELS, name) ? (RETIRED_MODELS[name] as string) : name;
}

/**
 * Whether a value is a plain record.
 * @param value - Untrusted collaborative data.
 * @returns True for a non-null, non-array object.
 * @throws {never} Never.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The per-model param records keyed by current names. A record kept under a
 * retired name merges under the newer one written beside it, the newer value
 * winning field by field, so what only the old record held (the speakers, the
 * dialogue switch) is kept.
 * @param records - The node's param records.
 * @returns The records under current names, or the same object when none was retired.
 * @throws {never} Never.
 */
function recordsRenamed(records: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(records).some((name) => currentModelName(name) !== name)) return records;
  const out: Record<string, unknown> = {};
  for (const [name, params] of Object.entries(records)) {
    if (currentModelName(name) !== name) continue;
    out[name] = params;
  }
  for (const [name, params] of Object.entries(records)) {
    const now = currentModelName(name);
    if (now === name) continue;
    const newer = out[now];
    out[now] = isRecord(params) && isRecord(newer) ? { ...params, ...newer } : (newer ?? params);
  }
  return out;
}

/**
 * A node's data with every model name it holds read as the current one: its
 * model, the models it remembers per mode and the keys of its param records.
 * @param node - A node's data; untrusted collaborative data.
 * @returns The data under current names, or the same object when none was retired.
 * @throws {never} Never.
 */
export function withCurrentModelNames<T extends object>(node: T): T {
  const data = node as NodeModelFields;
  const model = typeof data.model === "string" ? currentModelName(data.model) : data.model;
  const byMode = isRecord(data.modelByMode)
    ? Object.entries(data.modelByMode).some(([, name]) => typeof name === "string" && currentModelName(name) !== name)
      ? Object.fromEntries(Object.entries(data.modelByMode).map(([mode, name]) => [mode, typeof name === "string" ? currentModelName(name) : name]))
      : data.modelByMode
    : data.modelByMode;
  const records = isRecord(data.paramsByModel) ? recordsRenamed(data.paramsByModel) : data.paramsByModel;
  if (model === data.model && byMode === data.modelByMode && records === data.paramsByModel) return node;
  const out = { ...node } as T & NodeModelFields;
  if (model !== data.model) out.model = model;
  if (byMode !== data.modelByMode) out.modelByMode = byMode;
  if (records !== data.paramsByModel) out.paramsByModel = records;
  return out;
}
