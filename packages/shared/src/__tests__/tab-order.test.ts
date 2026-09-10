// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import {
  applyTabMove,
  dedupeTabOrder,
  initialOpenTabIds,
  sameTabOrder,
} from "@shared/tab-order.js";

describe("applyTabMove", () => {
  it("puts the moved id in front of the anchor", () => {
    expect(applyTabMove(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("moves forwards, past the anchor it used to sit in front of", () => {
    expect(applyTabMove(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("moves to the end when there is no anchor", () => {
    expect(applyTabMove(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone when the move lands where the id already is", () => {
    expect(applyTabMove(["a", "b", "c"], "a", "b")).toEqual(["a", "b", "c"]);
  });

  it("leaves the list alone when the id is not in it", () => {
    expect(applyTabMove(["a", "b"], "zz", "a")).toEqual(["a", "b"]);
  });

  it("leaves the list alone when the anchor is not in it", () => {
    expect(applyTabMove(["a", "b"], "a", "zz")).toEqual(["a", "b"]);
  });

  it("leaves the list alone when a tab is moved onto itself", () => {
    expect(applyTabMove(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });

  it("collapses copies of the moved id into the one it lands as", () => {
    expect(applyTabMove(["a", "b", "c", "a"], "a", null)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("does not mutate its input", () => {
    const input = ["a", "b", "c"];
    applyTabMove(input, "c", "a");
    expect(input).toEqual(["a", "b", "c"]);
  });
});

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

describe("initialOpenTabIds", () => {
  // The list a member starts with on their first visit to a project. Both
  // sides produce it — collab seeds it into the document, the browser shows it
  // until that write arrives — so the two have to land on the same answer for
  // any set of Spaces, including the ties.

  it("opens the newest Space and nothing else", () => {
    expect(
      initialOpenTabIds([
        { id: "middle", createdAt: 200 },
        { id: "newest", createdAt: 300 },
        { id: "oldest", createdAt: 100 },
      ]),
    ).toEqual(["newest"]);
  });

  it("breaks a createdAt tie the same way on any replica", () => {
    const sameMillisecond = [
      { id: "alpha", createdAt: 100 },
      { id: "zulu", createdAt: 100 },
      { id: "mike", createdAt: 100 },
    ];
    const forwards = initialOpenTabIds(sameMillisecond);
    const backwards = initialOpenTabIds([...sameMillisecond].reverse());
    expect(forwards).toEqual(["zulu"]);
    expect(backwards).toEqual(forwards);
  });

  it("prefers a timestamped Space over one written before the field existed", () => {
    expect(
      initialOpenTabIds([
        { id: "z", createdAt: undefined },
        { id: "a", createdAt: 100 },
      ]),
    ).toEqual(["a"]);
  });

  it("falls back to the largest id when nothing carries a timestamp", () => {
    expect(
      initialOpenTabIds([
        { id: "a", createdAt: undefined },
        { id: "c", createdAt: undefined },
        { id: "b", createdAt: undefined },
      ]),
    ).toEqual(["c"]);
  });

  it("returns an empty list when the project has no Spaces", () => {
    expect(initialOpenTabIds([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 200 },
    ];
    initialOpenTabIds(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("sameTabOrder", () => {
  it("says two orders holding the same ids in the same places are the same", () => {
    expect(sameTabOrder(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
  });

  it("says two empty orders are the same", () => {
    expect(sameTabOrder([], [])).toBe(true);
  });

  it("separates two orders holding the same ids in other places", () => {
    expect(sameTabOrder(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("separates orders of different lengths", () => {
    expect(sameTabOrder(["a"], ["a", "b"])).toBe(false);
  });

  it("counts a repeated id as its own place", () => {
    // Two collab instances that had not synced can leave the same id in the
    // list twice, so this has to tell that list from the deduped one.
    expect(sameTabOrder(["a", "a"], ["a"])).toBe(false);
  });
});
