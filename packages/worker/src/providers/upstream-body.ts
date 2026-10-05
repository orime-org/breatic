// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request body one WaveSpeed endpoint receives, built from the model's own
 * declarations: the yaml names each param's upstream field, so this is the one
 * place our names become the endpoint's.
 */

import type { FullModelEntry } from "@breatic/domain";
import { completeEntries, isPresent, joinSlotFiles } from "@breatic/shared";

/**
 * Whether a value is one a choice can hold, and so one `upstream_values` can name.
 * @param value - The run's value for a param.
 * @returns True for a string, number or boolean.
 */
function isChoice(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Builds the upstream request body for one run.
 * @param entry - The model's catalog entry.
 * @param given - The run's params under our names, validated and defaulted.
 * @param written - The prompt as the model's family formatted it.
 * @param consumed - Params the model's family reads itself and keeps off the wire.
 * @returns The body, keyed by the endpoint's field names.
 */
export function upstreamBody(
  entry: FullModelEntry,
  given: Readonly<Record<string, unknown>>,
  written: string,
  consumed: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  // A slot the upstream has no field for travels inside the pool it joins,
  // named by the prompt (inner#826).
  const { params, prompt } = joinSlotFiles(entry.params ?? {}, given, written);
  const sent = new Map<string, unknown>();
  for (const [name, spec] of Object.entries(entry.params ?? {})) {
    if (consumed.has(name)) continue;
    const value = spec.type === "items" ? completeEntries(params[name], spec.fields ?? {}) : params[name];
    // The declared "send nothing" value hands the choice back to the upstream.
    if (isPresent(value) && value !== spec.absent_value) sent.set(name, value);
  }
  // A param that stands in for another says the same thing a second way, and
  // the endpoint ignores one of them; only the one the reader filled goes.
  const replaced = new Set(
    [...sent.keys()].map((name) => entry.params?.[name]?.replaces).filter((name) => typeof name === "string"),
  );
  const body: Record<string, unknown> = {};
  for (const [name, value] of sent) {
    if (replaced.has(name)) continue;
    const spec = entry.params?.[name];
    // An upstream taking objects gets each URL under the key it names.
    const itemKey = typeof spec?.item_key === "string" ? spec.item_key : undefined;
    // A value the endpoint spells differently goes under its spelling.
    const spelled = isChoice(value) ? (spec?.upstream_values?.[String(value)] ?? value) : value;
    body[spec?.upstream ?? name] =
      itemKey !== undefined && Array.isArray(spelled) ? spelled.map((url: unknown) => ({ [itemKey]: url })) : spelled;
  }
  if (entry.takes_prompt === true && prompt !== "") {
    body[entry.prompt_upstream ?? "prompt"] = prompt;
  }
  return body;
}
