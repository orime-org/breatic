// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many items a capped list param may carry for one submission — the
 * arithmetic all three gates read (#1928).
 *
 * A model states a list's cap on {@link ParamDescriptor.max_items}, and may
 * state a lower one that takes over while another param carries a value
 * ({@link ParamDescriptor.max_items_when_present}): `kling-o3-pro-ref` takes
 * up to 7 reference images on its own and up to 4 alongside a reference
 * video. Three places enforce the number — the generate panel while picking,
 * the server before enqueue, the worker before mapping params to vendor
 * names — and a submission the panel allowed but the worker truncates is the
 * degraded result the pre-enqueue gate exists to prevent, so they read one
 * function rather than each reaching for `max_items`.
 *
 * "Uncapped" is 0 / negative / non-finite / absent, matching the worker's
 * truthy `spec.max_items` guard and the server rule's `limit >= 1`.
 */

import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/**
 * Whether a number can serve as a cap.
 * @param value - The candidate, straight off a descriptor.
 * @returns True for a finite number of at least 1.
 */
function usableCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

/**
 * Whether a param carries a value, for the presence condition.
 *
 * Presence, never the value itself: a slot writes a URL and clears by
 * deleting the key, while a model's own declared default puts the key there
 * holding null whatever the user picked, so an empty string and null both
 * read as absent.
 * @param value - The submitted param value.
 * @returns True when something was actually supplied.
 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The cap in force for one capped list param, given what the submission carries.
 *
 * The lowest applicable cap wins when several conditional params are present —
 * every one of them is a limit the vendor stated, so the submission has to be
 * inside all of them.
 * @param descriptor - The param's descriptor from the model catalog entry.
 * @param params - The submitted task params, read for the presence conditions.
 * @returns The cap, or undefined when this param is uncapped.
 */
export function effectiveItemCap(
  descriptor: ParamDescriptor,
  params: Readonly<Record<string, unknown>>,
): number | undefined {
  const base = descriptor.max_items;
  if (!usableCap(base)) return undefined;

  const conditional = descriptor.max_items_when_present;
  if (!conditional) return base;

  let cap = base;
  for (const [name, limit] of Object.entries(conditional)) {
    if (usableCap(limit) && isPresent(params[name])) {
      cap = Math.min(cap, limit);
    }
  }
  return cap;
}
