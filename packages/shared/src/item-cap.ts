// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many items a capped list param may carry — the arithmetic all three
 * gates read: the generate panel while picking, the server before enqueue, the
 * worker before mapping params to vendor names.
 *
 * "Uncapped" is 0 / negative / non-finite / absent, so a yaml typo lets
 * submissions through rather than refusing every one of them.
 *
 * Also which entries of a list count at all ({@link completeEntries}), which
 * the worker and the panel both need to answer the same way.
 */

import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/**
 * The field this reads.
 *
 * Narrower than {@link ParamDescriptor} on purpose: the backend holds the same
 * param under its own yaml-side type, where every field is optional, and a
 * rule about caps has no business asking for a description as well.
 */
export type CappedParam = Pick<ParamDescriptor, "max_items">;

/**
 * Whether a number can serve as a cap.
 * @param value - The candidate, straight off a descriptor.
 * @returns True for a finite number of at least 1.
 */
function usableCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

/**
 * Whether a param carries a value: for the presence condition, the price
 * estimate and the worker's request body alike.
 *
 * Presence, never the value itself: a slot writes a URL and clears by
 * deleting the key, while a model's own declared default puts the key there
 * holding null whatever the user picked, so an empty string and null both
 * read as absent.
 * @param value - The submitted param value.
 * @returns True when something was actually supplied.
 */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The cap in force for one capped list param.
 * @param descriptor - The param's descriptor from the model catalog entry.
 * @returns The cap, or undefined when this param is uncapped.
 */
export function itemCap(descriptor: CappedParam): number | undefined {
  return usableCap(descriptor.max_items) ? descriptor.max_items : undefined;
}

/**
 * The entries of a list param that fill every field it declares: a text field
 * with something other than spaces, a choice with one of its values. An entry
 * left half-filled in the editor names nothing the vendor can use, so the
 * worker sends only these and the panel counts only these against a floor.
 * @param value - What the run carries for the list; node data, untrusted.
 * @param fields - The fields one entry declares.
 * @returns The complete entries, each holding only its declared fields.
 */
export function completeEntries(
  value: unknown,
  fields: Readonly<Record<string, { values?: readonly unknown[] }>>,
): Record<string, unknown>[] {
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
