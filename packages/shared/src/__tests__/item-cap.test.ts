// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The cap on a capped list param — the one arithmetic all three gates read.
 *
 * Three places enforce the number — the panel while picking, the server
 * before enqueue, the worker before mapping params to vendor names — and they
 * have to agree, or a submission the panel allowed gets rejected by the
 * server, or worse, silently truncated by the worker.
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { isPresent, itemCap, stepRequested } from "@shared/item-cap.js";

describe("the cap on a capped list param", () => {
  it("reads max_items", () => {
    expect(itemCap({ max_items: 7 })).toBe(7);
  });

  it("answers uncapped when there is no max_items", () => {
    expect(itemCap({})).toBeUndefined();
  });

  it("treats a zero, negative or non-finite max_items as uncapped", () => {
    // The worker's truthy `spec.max_items` guard and the server's `limit >= 1`
    // both read these as "no cap"; this function has to agree with them or the
    // three gates diverge on exactly the values yaml can hold by mistake.
    for (const max_items of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(itemCap({ max_items })).toBeUndefined();
    }
  });
});

// One answer to "is there anything here to send", read by the presence
// condition, the price estimate and the worker's request body alike.
describe("isPresent", () => {
  it("is false for nothing, an empty string and an empty list", () => {
    expect([undefined, null, "", []].map(isPresent)).toEqual([false, false, false, false]);
  });

  it("is true for any other value, falsy ones included", () => {
    expect([0, false, "a", ["a"], {}].map(isPresent)).toEqual([true, true, true, true, true]);
  });
});

// Whether a run takes an extra step its `for_param` switches (inner#1692): a
// toggle switched off holds false, which is present but asks for nothing.
describe("stepRequested", () => {
  it("is false for nothing, an empty string, an empty list and false", () => {
    expect([undefined, null, "", [], false].map(stepRequested)).toEqual([false, false, false, false, false]);
  });

  it("is true for true and for any other present value, falsy ones included", () => {
    expect([true, 0, "a", ["a"], {}].map(stepRequested)).toEqual([true, true, true, true, true]);
  });

  it("agrees with isPresent on every value except false", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(stepRequested(value)).toBe(value === false ? false : isPresent(value));
      }),
    );
  });

  it("leaves isPresent reading false as present", () => {
    expect(isPresent(false)).toBe(true);
  });
});
