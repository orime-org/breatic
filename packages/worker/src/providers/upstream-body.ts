// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request body one WaveSpeed endpoint receives, built from the model's own
 * declarations: the yaml names each param's upstream field, so this is the one
 * place our names become the endpoint's.
 */

import type { FullModelEntry } from "@breatic/domain";

/**
 * Whether a value carries something to send.
 * @param value - A param's value after validation.
 * @returns False for nothing, an empty string and an empty list.
 */
export function carries(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

/** A list that declares no fields. */
const NO_FIELDS: Readonly<Record<string, { values?: readonly unknown[] }>> = {};

/**
 * The entries of a list param that fill every field it declares: a text field
 * with something other than spaces, a choice with one of its values. An entry
 * left half-filled in the editor names nothing the vendor can use.
 * @param value - What the run carries for the list; node data, untrusted.
 * @param fields - The fields one entry declares.
 * @returns The complete entries, each holding only its declared fields.
 */
function completeEntries(value: unknown, fields: Readonly<Record<string, { values?: readonly unknown[] }>>): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const names = Object.keys(fields);
  const complete: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const held = entry as Record<string, unknown>;
    const filled = names.every((field) => {
      const offered = fields[field]?.values;
      const v = held[field];
      return offered !== undefined
        ? offered.some((option) => option === v)
        : typeof v === "string" && v.trim() !== "";
    });
    if (filled) complete.push(Object.fromEntries(names.map((field) => [field, held[field]])));
  }
  return complete;
}

/**
 * Builds the upstream request body for one run.
 * @param entry - The model's catalog entry.
 * @param params - The run's params under our names, validated and defaulted.
 * @param prompt - The prompt as the model's family formatted it.
 * @param consumed - Params the model's family reads itself and keeps off the wire.
 * @returns The body, keyed by the endpoint's field names.
 */
export function upstreamBody(
  entry: FullModelEntry,
  params: Readonly<Record<string, unknown>>,
  prompt: string,
  consumed: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(entry.params ?? {})) {
    if (consumed.has(name)) continue;
    const value = spec.type === "items" ? completeEntries(params[name], spec.fields ?? NO_FIELDS) : params[name];
    if (!carries(value)) continue;
    body[spec.upstream ?? name] = value;
  }
  if (entry.takes_prompt === true && prompt !== "") {
    body[entry.prompt_upstream ?? "prompt"] = prompt;
  }
  return body;
}
