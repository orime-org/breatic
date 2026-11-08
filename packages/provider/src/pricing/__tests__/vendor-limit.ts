// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";

// The model vendor's audio limit the routing, estimate-order and accepts properties generate, written once.

/** The longest audio clip the model's vendor takes, in seconds, or none. */
export const vendorMaxArb = fc.option(fc.integer({ min: 1, max: 30 }), { nil: null });

/** The audio clip a run carries, in seconds, or none. */
export const clipArb = fc.option(fc.integer({ min: 1, max: 40 }), { nil: null });

/**
 * The model vendor's audio limit as a model-level reject, or none.
 * @param max - The longest clip the vendor takes, in seconds; null for no limit.
 * @returns The model's `rejects`, to spread into its entry.
 */
export const vendorAudioLimit = (max: number | null): { rejects?: { when: string; reason: string; source: string }[] } =>
  max === null ? {} : { rejects: [{ when: `get_duration(audio) > ${max}`, reason: "vendor audio limit", source: "https://vendor.example/limits" }] };

/**
 * Whether the vendor's limit refuses a run's clip.
 * @param max - The vendor's limit, or null.
 * @param clip - The run's clip, or null.
 * @returns True when the clip is over the limit.
 */
export const overVendorLimit = (max: number | null, clip: number | null): boolean => max !== null && clip !== null && clip > max;
