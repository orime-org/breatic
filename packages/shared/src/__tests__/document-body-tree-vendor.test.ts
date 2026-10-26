// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  computeBodyTreeCandidates,
  bodyTreeOrderBetween,
  type BodyTreeCandidates,
} from "@shared/document-body-tree-vendor.js";

/** Constructs candidate histories independently of the production planner. @throws {never} */
function candidates(rows: readonly (readonly [string, string, number, string])[]): BodyTreeCandidates {
  const result = new Map<string, Map<string, { counter: number; order: string }>>([["root", new Map()]]);
  for (const [child, parent, counter, order] of rows) {
    if (!result.has(child)) result.set(child, new Map());
    result.get(child)!.set(parent, { counter, order });
  }
  return result;
}

describe("body parent history computation", () => {
  it("uses the highest counter and parent identity to select each parent", () => {
    const tree = computeBodyTreeCandidates("root", candidates([
      ["a", "root", 0, "a"],
      ["b", "root", 0, "b"],
      ["c", "root", 0, "c"],
      ["c", "a", 1, "y"],
      ["c", "b", 1, "x"],
    ]));

    expect([...tree.parents]).toEqual([["a", "root"], ["b", "root"], ["c", "b"]]);
    expect(tree.children.get("root")).toEqual(["a", "b"]);
    expect(tree.children.get("b")).toEqual(["c"]);
  });

  it("roots a concurrent cycle by the fixed counter parent and child ordering", () => {
    const tree = computeBodyTreeCandidates("root", candidates([
      ["a", "root", 0, "a"], ["a", "b", 2, "x"],
      ["b", "root", 0, "b"], ["b", "a", 2, "y"],
      ["c", "root", 0, "c"], ["c", "a", 3, "z"],
    ]));

    expect([...tree.parents]).toEqual([["a", "root"], ["b", "a"], ["c", "a"]]);
    expect(tree.children.get("root")).toEqual(["a"]);
    expect(tree.children.get("a")).toEqual(["b", "c"]);
  });

  it("uses the higher rooted candidate before a lower cycle exit", () => {
    const tree = computeBodyTreeCandidates("root", candidates([
      ["a", "root", 0, "a"], ["a", "b", 2, "x"],
      ["b", "root", 1, "b"], ["b", "a", 2, "y"],
    ]));

    expect([...tree.parents]).toEqual([["a", "b"], ["b", "root"]]);
    expect(tree.children.get("root")).toEqual(["b"]);
  });

  it("orders siblings by their selected edge and stable node identity", () => {
    const tree = computeBodyTreeCandidates("root", candidates([
      ["z", "root", 0, "same"], ["a", "root", 0, "same"], ["m", "root", 0, "before"],
    ]));

    expect(tree.children.get("root")).toEqual(["m", "a", "z"]);
  });

  it("keeps rooted results identical under candidate and node iteration permutations", () => {
    fc.assert(fc.property(fc.array(fc.record({ parent: fc.nat(20), counter: fc.integer({ min: 1, max: 8 }) }), { maxLength: 20 }), (rows) => {
      const history = candidates(rows.flatMap((row, index) => [
        [`node-${index}`, "root", 0, `order-${index}`] as const,
        [`node-${index}`, `node-${row.parent % rows.length}`, row.counter, `order-${index}`] as const,
      ]));
      const before = [...history].map(([id, edges]) => [id, [...edges]]);
      const reversed = new Map([...history].reverse().map(([id, edges]) => [id, new Map([...edges].reverse())]));
      const forward = computeBodyTreeCandidates("root", history);
      const backward = computeBodyTreeCandidates("root", reversed);

      expect([...backward.parents]).toEqual([...forward.parents]);
      expect([...backward.children]).toEqual([...forward.children]);
      expect([...history].map(([id, edges]) => [id, [...edges]])).toEqual(before);
      for (const id of history.keys()) {
        let current = id;
        const seen = new Set<string>();
        while (current !== "root") {
          expect(seen.has(current)).toBe(false);
          seen.add(current);
          current = forward.parents.get(current)!;
        }
      }
    }), { numRuns: 200 });
  });
});

describe("body fractional sibling order", () => {
  it.each([["", ""], ["a", "b"], ["a", "a\u0001"], ["a\u00ff", "b"], ["a", "a\u0000\u0001"]])("makes unique stable values strictly inside %j and %j", (before, after) => {
    const first = bodyTreeOrderBetween(before, after, "client-1:1");
    const second = bodyTreeOrderBetween(before, after, "client-2:1");

    expect(first > before).toBe(true);
    if (after !== "") expect(first < after).toBe(true);
    expect(second > before).toBe(true);
    if (after !== "") expect(second < after).toBe(true);
    expect(first === second).toBe(false);
    expect(bodyTreeOrderBetween(before, after, "client-1:1")).toBe(first);
  });
});
