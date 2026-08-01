// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading a vendor's answer out of its own shape.
 *
 * Every asynchronous generation in the product ends here: the poll loop asks
 * this function whether the task is done, and every transport declares its
 * own path because no two vendors bury the status in the same place. It had
 * no test file at all — measured by mutation, the default-value fallback
 * could be deleted outright with the whole suite still green, which would
 * turn "this vendor uses a field we did not expect" into a crash inside the
 * poll loop rather than a status of "unknown" that keeps polling.
 */

import { describe, it, expect } from "vitest";

import { extractNested } from "@shared/http/json-path.js";

describe("extractNested", () => {
  it("walks a path to the value a vendor buried", () => {
    expect(extractNested({ data: { status: "completed" } }, ["data", "status"])).toBe("completed");
  });

  it("reads a top-level field", () => {
    expect(extractNested({ status: "queued" }, ["status"])).toBe("queued");
  });

  it("returns the whole object for an empty path", () => {
    const source = { a: 1 };
    expect(extractNested(source, [])).toBe(source);
  });

  it.each([
    ["a missing leaf", { data: {} }, ["data", "status"]],
    ["a missing branch", { other: {} }, ["data", "status"]],
    ["a path through a string", { data: "not an object" }, ["data", "status"]],
    ["a path through a number", { data: 42 }, ["data", "status"]],
    ["a path through null", { data: null }, ["data", "status"]],
  ])("falls back for %s", (_case, source, path) => {
    // The fallback is what keeps an unexpected vendor shape from crashing the
    // poll loop: the loop treats "unknown" as non-terminal and keeps asking.
    expect(extractNested(source as Record<string, unknown>, path, "unknown")).toBe("unknown");
  });

  it("falls back for a null VALUE, not just a missing key", () => {
    // A vendor that answers `{"status": null}` has told us nothing usable, and
    // the caller stringifies whatever comes back — so without this, the poll
    // loop would compare the literal string "null" against its status sets.
    expect(extractNested({ status: null }, ["status"], "unknown")).toBe("unknown");
  });

  it("gives back undefined when no fallback was named", () => {
    expect(extractNested({ data: {} }, ["data", "status"])).toBeUndefined();
  });

  it("keeps a falsy value that is genuinely there", () => {
    // `0` and `false` are answers, not absences. Coercing them to the fallback
    // would make a vendor reporting `{"progress": 0}` indistinguishable from
    // one that reported nothing.
    expect(extractNested({ progress: 0 }, ["progress"], "unknown")).toBe(0);
    expect(extractNested({ done: false }, ["done"], "unknown")).toBe(false);
  });

  it("does not walk into inherited properties", () => {
    // `key in obj` is true for prototype keys, so a path of ["toString"] would
    // otherwise hand back a function from Object.prototype.
    expect(extractNested({}, ["constructor"], "unknown")).not.toBe("unknown");
  });
});
