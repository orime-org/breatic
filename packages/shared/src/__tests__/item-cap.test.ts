// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The effective cap on a capped list param — the one arithmetic all three
 * gates read (#1928).
 *
 * A model may state that a list's cap changes once another param carries a
 * value: `kling-o3-pro-ref` takes up to 7 reference images on its own and up
 * to 4 alongside a reference video. Three places enforce that number — the
 * panel while picking, the server before enqueue, the worker before mapping
 * params to vendor names — and they have to agree, or a submission the panel
 * allowed gets rejected by the server, or worse, silently truncated by the
 * worker.
 */

import { describe, it, expect } from "vitest";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";
import { effectiveItemCap } from "@shared/item-cap.js";

/** The reference-image descriptor as `kling-o3-pro-ref` declares it. */
const IMAGES: ParamDescriptor = {
  description: "Reference image URLs (1-7, or 1-4 with a reference video)",
  type: "list",
  max_items: 7,
  max_items_when_present: { video: 4 },
  default: null,
};

describe("the effective cap on a capped list param", () => {
  it("is the plain max_items when no conditional param carries a value", () => {
    expect(effectiveItemCap(IMAGES, { prompt: "a cat" })).toBe(7);
  });

  it("drops to the conditional cap once that param carries a value", () => {
    expect(
      effectiveItemCap(IMAGES, { video: "https://cdn.example/clip.mp4" }),
    ).toBe(4);
  });

  it("stays at max_items when the conditional param is null", () => {
    expect(effectiveItemCap(IMAGES, { video: null })).toBe(7);
  });

  it("stays at max_items when the conditional param is an empty string", () => {
    expect(effectiveItemCap(IMAGES, { video: "" })).toBe(7);
  });

  it("stays at max_items when the conditional param is absent", () => {
    expect(effectiveItemCap(IMAGES, {})).toBe(7);
  });

  it("takes the lowest cap when several conditional params carry values", () => {
    const twoWays: ParamDescriptor = {
      description: "two conditions",
      max_items: 9,
      max_items_when_present: { video: 4, audio: 6 },
      default: null,
    };
    expect(
      effectiveItemCap(twoWays, { video: "clip.mp4", audio: "track.mp3" }),
    ).toBe(4);
  });

  it("reads a descriptor with no conditional caps as plainly capped", () => {
    const plain: ParamDescriptor = {
      description: "plain",
      max_items: 3,
      default: null,
    };
    expect(effectiveItemCap(plain, { video: "clip.mp4" })).toBe(3);
  });

  it("is undefined for an uncapped param, conditional value or not", () => {
    const uncapped: ParamDescriptor = { description: "uncapped", default: null };
    expect(effectiveItemCap(uncapped, {})).toBeUndefined();
    expect(effectiveItemCap(uncapped, { video: "clip.mp4" })).toBeUndefined();
  });

  it("treats a zero, negative or non-finite max_items as uncapped", () => {
    // The worker's truthy `spec.max_items` guard and the server's `limit >= 1`
    // both read these as "no cap"; this function has to agree with them or the
    // three gates diverge on exactly the values yaml can hold by mistake.
    for (const max_items of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveItemCap({ max_items }, {})).toBeUndefined();
    }
  });

  it("ignores a conditional cap that is not a usable number", () => {
    const broken: ParamDescriptor = {
      description: "broken",
      max_items: 7,
      max_items_when_present: { video: 0 },
      default: null,
    };
    expect(effectiveItemCap(broken, { video: "clip.mp4" })).toBe(7);
  });
});
