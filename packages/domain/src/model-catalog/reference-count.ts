// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reference-count gate rule (#1735). THE single source of truth for "how many
 * items may a capped list param carry". A model's `max_items` per param comes
 * from config (config/models/<modality>/*.yaml) and rides the wire on
 * {@link ParamDescriptor.max_items}, which a model may state as moving with
 * another param it carries ({@link ParamDescriptor.max_items_when_present},
 * #1928); the number in force comes from `effectiveItemCap`, the one function
 * this rule, the frontend picker gate and the worker's truncation all read.
 * The frontend reads it to gate the picker, the server calls
 * {@link violatesReferenceCount} to reject before enqueue.
 *
 * The worker judges the same number and truncates; this gate rejects first, so
 * a user who over-picks is told rather than silently handed a degraded result.
 */

import { effectiveItemCap, type ParamDescriptor } from "@breatic/shared";

/** A reference-count overflow: which capped param, its limit, and what was submitted. */
export interface ReferenceCountViolation {
  /** The param field that overflowed (e.g. `images`). */
  field: string;
  /**
   * The cap in force for this submission — what the user is told to get down
   * to. Not necessarily the descriptor's `max_items`: a model may state a
   * lower cap that takes over while another param carries a value (#1928).
   */
  limit: number;
  /** How many items the submission carried. */
  actual: number;
}

/**
 * Whether a submission exceeds any of the model's per-param item caps.
 * The cap for one param and one submission comes from `effectiveItemCap`,
 * which reads `max_items` and the conditional `max_items_when_present`, and
 * answers undefined for an uncapped param. Only array values are counted — a
 * non-array value is a shape problem the presence gate owns, not a count
 * overflow.
 * @param paramDescriptors - The model's param descriptors (from the catalog entry's `params`).
 * @param params - The submitted task params (`params.images` etc. carry the lists).
 * @returns The first overflow found, or null when every capped param is within its limit.
 */
export function violatesReferenceCount(
  paramDescriptors: Record<string, ParamDescriptor>,
  params: Record<string, unknown>,
): ReferenceCountViolation | null {
  for (const [field, descriptor] of Object.entries(paramDescriptors)) {
    // The cap this submission is judged against, which a model may state as
    // moving with another param it carries (#1928) — read through the one
    // function the panel and the worker read, so all three agree on the number
    // for one submission.
    const limit = effectiveItemCap(descriptor, params);
    if (limit === undefined) {
      continue; // uncapped param
    }
    const value = params[field];
    if (Array.isArray(value) && value.length > limit) {
      return { field, limit, actual: value.length };
    }
  }
  return null;
}
