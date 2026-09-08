// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reference-count gate rule (#1735). Pins `violatesReferenceCount` — the pure
 * predicate the execute gate runs to reject a submission that carries MORE
 * items in a capped list param than the model's `max_items` allows. It mirrors
 * exactly the condition the worker silently truncates on
 * (`spec.max_items && Array.isArray(value) && value.length > spec.max_items`,
 * providers/shared.ts) but rejects before enqueue instead of truncating, so the
 * user gets told rather than silently getting a degraded result. Critical path
 * (AI-tool-call input guard), so every branch is pinned.
 */

import { describe, it, expect } from "vitest";
import type { ParamDescriptor } from "@breatic/shared";
import { violatesReferenceCount } from "@domain/model-catalog/reference-count.js";

/**
 * Builds a param descriptor carrying an optional `max_items` cap.
 * @param over - Field overrides (e.g. `{ max_items: 14 }`).
 * @returns A ParamDescriptor fixture.
 */
function descriptor(over: Partial<ParamDescriptor> = {}): ParamDescriptor {
  return { description: "", default: null, ...over };
}

describe("violatesReferenceCount (#1735 reference-count gate)", () => {
  it("returns null when a capped list param is under its limit", () => {
    const params = { images: descriptor({ max_items: 14 }) };
    expect(violatesReferenceCount(params, { images: ["a", "b"] })).toBeNull();
  });

  it("returns null when a capped list param is exactly at its limit", () => {
    const params = { images: descriptor({ max_items: 2 }) };
    expect(violatesReferenceCount(params, { images: ["a", "b"] })).toBeNull();
  });

  it("flags the field, limit, and actual count when over the limit", () => {
    const params = { images: descriptor({ max_items: 2 }) };
    expect(violatesReferenceCount(params, { images: ["a", "b", "c"] })).toEqual({
      field: "images",
      limit: 2,
      actual: 3,
    });
  });

  it("returns null for a param with no max_items (uncapped)", () => {
    const params = { images: descriptor() };
    expect(
      violatesReferenceCount(params, { images: ["a", "b", "c", "d", "e"] }),
    ).toBeNull();
  });

  it("returns null when the submitted value is not an array (shape is the presence gate's job, not count)", () => {
    const params = { images: descriptor({ max_items: 1 }) };
    expect(violatesReferenceCount(params, { images: "not-an-array" })).toBeNull();
    expect(violatesReferenceCount(params, {})).toBeNull();
  });

  it("treats a non-positive / non-finite max_items as no limit (mirrors the worker's truthy `spec.max_items` guard)", () => {
    expect(
      violatesReferenceCount({ images: descriptor({ max_items: 0 }) }, { images: ["a"] }),
    ).toBeNull();
  });

  it("checks every capped param and reports the first that overflows", () => {
    const params = {
      images: descriptor({ max_items: 5 }),
      style_images: descriptor({ max_items: 1 }),
    };
    // images is within 5, style_images (limit 1) has 2 → violation on style_images
    const result = violatesReferenceCount(params, {
      images: ["a", "b"],
      style_images: ["x", "y"],
    });
    expect(result).toEqual({ field: "style_images", limit: 1, actual: 2 });
  });
});

describe("a cap that moves with another param (#1928)", () => {
  /** `images` as `kling-o3-pro-ref` declares it: 7 alone, 4 with a video. */
  const conditional = {
    images: descriptor({
      max_items: 7,
      max_items_when_present: { video: 4 },
    }),
    video: descriptor({}),
  };

  it("allows the plain cap when the conditional param carries nothing", () => {
    expect(
      violatesReferenceCount(conditional, {
        images: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).toBeNull();
  });

  it("rejects at the lower cap once the conditional param carries a value", () => {
    expect(
      violatesReferenceCount(conditional, {
        images: ["a", "b", "c", "d", "e"],
        video: "https://cdn.example/clip.mp4",
      }),
    ).toEqual({ field: "images", limit: 4, actual: 5 });
  });

  it("reports the lower cap as the limit, so the message names the real number", () => {
    const violation = violatesReferenceCount(conditional, {
      images: ["a", "b", "c", "d", "e", "f", "g"],
      video: "https://cdn.example/clip.mp4",
    });
    expect(violation?.limit).toBe(4);
  });

  it("keeps the plain cap when the conditional param is null", () => {
    // A model declaring `video` with a null default puts the key in every
    // payload; presence is a value, not a key.
    expect(
      violatesReferenceCount(conditional, {
        images: ["a", "b", "c", "d", "e"],
        video: null,
      }),
    ).toBeNull();
  });
});
