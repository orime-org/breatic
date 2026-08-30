// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { dedupeTabOrder, sortSpaceIdsForTabOrder } from "@shared/tab-order.js";

describe("dedupeTabOrder", () => {
  it("keeps the first occurrence of a repeated id and drops the rest", () => {
    expect(dedupeTabOrder(["b", "a", "c", "d", "a"])).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("leaves an already unique list untouched", () => {
    expect(dedupeTabOrder(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("collapses three copies of the same id into one", () => {
    expect(dedupeTabOrder(["a", "a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(dedupeTabOrder([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = ["a", "b", "a"];
    dedupeTabOrder(input);
    expect(input).toEqual(["a", "b", "a"]);
  });
});

describe("sortSpaceIdsForTabOrder", () => {
  it("orders by createdAt ascending", () => {
    const out = sortSpaceIdsForTabOrder([
      { id: "third", createdAt: 300 },
      { id: "first", createdAt: 100 },
      { id: "second", createdAt: 200 },
    ]);
    expect(out).toEqual(["first", "second", "third"]);
  });

  it("breaks a createdAt tie by id so two replicas agree", () => {
    const sameMillisecond = [
      { id: "zulu", createdAt: 100 },
      { id: "alpha", createdAt: 100 },
      { id: "mike", createdAt: 100 },
    ];
    const forwards = sortSpaceIdsForTabOrder(sameMillisecond);
    const backwards = sortSpaceIdsForTabOrder([...sameMillisecond].reverse());
    expect(forwards).toEqual(["alpha", "mike", "zulu"]);
    expect(backwards).toEqual(forwards);
  });

  it("puts an entry with no createdAt before every timestamped one, ordered by id", () => {
    // Entries written before `createdAt` existed read back as undefined. They
    // are the oldest Spaces in the project, so they belong at the front.
    const out = sortSpaceIdsForTabOrder([
      { id: "b", createdAt: 100 },
      { id: "z", createdAt: undefined },
      { id: "a", createdAt: undefined },
    ]);
    expect(out).toEqual(["a", "z", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [
      { id: "b", createdAt: 200 },
      { id: "a", createdAt: 100 },
    ];
    sortSpaceIdsForTabOrder(input);
    expect(input.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(sortSpaceIdsForTabOrder([])).toEqual([]);
  });
});
