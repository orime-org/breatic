// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many items a capped list param may carry — the arithmetic all three
 * gates read: the generate panel while picking, the server before enqueue, the
 * worker before mapping params to vendor names.
 *
 * "Uncapped" is 0 / negative / non-finite / absent, so a yaml typo lets
 * submissions through rather than refusing every one of them.
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
