// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The bearer header every vendor call carries.
 *
 * Fourteen files build their auth through this one function, and it had no
 * test: measured by mutation, it could emit a malformed `Authorization` value
 * with the whole suite green. The failure that produces is a 401 from every
 * vendor at once, which reads like an expired key rather than a code change.
 */

import { describe, it, expect } from "vitest";

import { bearerHeaders } from "@shared/http/headers.js";

describe("bearerHeaders", () => {
  it("builds the scheme, the space and the key in that order", () => {
    // Spelled out rather than compared to a template, because a template
    // written the same way as the implementation would pass against any
    // implementation — including one with the scheme misspelled.
    const headers = bearerHeaders("sk-live-123");
    expect(headers["Authorization"]).toBe("Bearer sk-live-123");
  });

  it("declares a JSON body", () => {
    expect(bearerHeaders("k")["Content-Type"]).toBe("application/json");
  });

  it("carries exactly those two headers", () => {
    // A vendor call inherits whatever this returns. An extra header added here
    // would travel to every provider at once.
    expect(Object.keys(bearerHeaders("k")).sort()).toEqual(["Authorization", "Content-Type"]);
  });

  it("does not trim, pad or otherwise edit the key it is given", () => {
    // Whoever holds the key decides its shape. A helper that "cleans it up"
    // turns a configuration mistake into a silent authentication failure.
    expect(bearerHeaders("  padded  ")["Authorization"]).toBe("Bearer   padded  ");
  });

  it("returns a fresh object each time", () => {
    // Callers spread extra headers into the result. A shared object would let
    // one vendor's extra header leak into the next vendor's request.
    const first = bearerHeaders("a");
    const second = bearerHeaders("b");
    expect(first).not.toBe(second);
    expect(first["Authorization"]).toBe("Bearer a");
  });
});
