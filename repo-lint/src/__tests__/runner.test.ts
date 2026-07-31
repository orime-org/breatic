// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import type { Check } from "#repo-lint/check";
import { runChecks } from "#repo-lint/runner";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const context = fakeContext({ "a.ts": "x\n" });

const clean: Check = {
  name: "clean",
  description: "finds nothing",
  run: () => [],
};

const dirty: Check = {
  name: "dirty",
  description: "finds something",
  run: () => [{ file: "a.ts", line: 1, message: "nope" }],
};

const broken: Check = {
  name: "broken",
  description: "cannot run",
  run: () => {
    throw new Error("no files matched");
  },
};

const asynchronous: Check = {
  name: "asynchronous",
  description: "resolves later",
  run: () => Promise.resolve([{ file: "b.ts", message: "later" }]),
};

describe("runChecks", () => {
  it("reports findings per check", async () => {
    const results = await runChecks([clean, dirty], context);
    expect(results.map((r) => r.findings.length)).toEqual([0, 1]);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it("records a throwing check as a failure, not as clean", async () => {
    const [result] = await runChecks([broken], context);
    expect(result?.error?.message).toBe("no files matched");
    expect(result?.findings).toEqual([]);
  });

  it("keeps running after one check throws", async () => {
    // One broken check must not hide the verdicts of the others — and must
    // not be mistaken for a pass either.
    const results = await runChecks([broken, dirty], context);
    expect(results).toHaveLength(2);
    expect(results[1]?.findings).toHaveLength(1);
  });

  it("awaits checks that return a promise", async () => {
    const [result] = await runChecks([asynchronous], context);
    expect(result?.findings).toEqual([{ file: "b.ts", message: "later" }]);
  });

  it("preserves the order it was given", async () => {
    const results = await runChecks([dirty, clean, broken], context);
    expect(results.map((r) => r.check.name)).toEqual([
      "dirty",
      "clean",
      "broken",
    ]);
  });
});
