// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reference-count gate rule (#1735). THE single source of truth for "how many
 * items may a capped list param carry". A model's `max_items` per param comes
 * from config (config/models/<modality>/*.yaml) and rides the wire on
 * {@link ParamDescriptor.max_items}; the frontend reads it to gate the picker,
 * the server calls {@link violatesReferenceCount} to reject before enqueue.
 *
 * This mirrors the condition the worker silently truncates on
 * (`spec.max_items && Array.isArray(value) && value.length > spec.max_items`,
 * packages/worker/src/providers/shared.ts) for every `max_items` value that can
 * occur — a positive integer authored in yaml — but rejects instead of
 * truncating, so a user who over-picks is told, not silently handed a degraded
 * result. (The worker's truthy `spec.max_items` and this rule's `limit >= 1`
 * both treat 0 / undefined / NaN as uncapped, so they agree for every reachable
 * value; they would only diverge for a truthy non-number, which the numeric
 * `max_items` wire type + integer yaml convention never produce.)
 */

import type { ParamDescriptor } from "@breatic/shared";

/** A reference-count overflow: which capped param, its limit, and what was submitted. */
export interface ReferenceCountViolation {
  /** The param field that overflowed (e.g. `images`). */
  field: string;
  /** The model's configured `max_items` for that field. */
  limit: number;
  /** How many items the submission carried. */
  actual: number;
}

/**
 * Whether a submission exceeds any of the model's per-param `max_items` caps.
 * A param is capped only when its descriptor carries a positive, finite
 * `max_items` (matching the worker's truthy `spec.max_items` guard, so 0 /
 * undefined / NaN mean "uncapped"). Only array values are counted — a non-array
 * value is a shape problem the presence gate owns, not a count overflow.
 * @param paramDescriptors - The model's param descriptors (from the catalog entry's `params`).
 * @param params - The submitted task params (`params.images` etc. carry the lists).
 * @returns The first overflow found, or null when every capped param is within its limit.
 */
export function violatesReferenceCount(
  paramDescriptors: Record<string, ParamDescriptor>,
  params: Record<string, unknown>,
): ReferenceCountViolation | null {
  for (const [field, descriptor] of Object.entries(paramDescriptors)) {
    const limit = descriptor.max_items;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
      continue; // uncapped param
    }
    const value = params[field];
    if (Array.isArray(value) && value.length > limit) {
      return { field, limit, actual: value.length };
    }
  }
  return null;
}
