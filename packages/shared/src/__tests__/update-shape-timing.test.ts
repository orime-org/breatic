// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How long `updateShape` takes on delete sets built to make a naive walk slow
 * (inner#1790 v2 collab spec section 14a.7, R6-24 to R6-28): copies of one
 * range, nested ranges, zero-length ranges and per-character ranges. Design
 * 4.1 sorts and merges each client's ranges first, so the walk visits every
 * struct once; the bound is 100 ms for K = 2000 ranges (design 8).
 *
 * Kept apart from `update-shape.test.ts` because the current walk takes
 * seconds on these inputs; each case carries a long vitest timeout.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { updateShape, type UpdateShape } from "@shared/doc-size.js";

/** Design 8: the time bound for one call. */
const BOUND_MS = 100;

/**
 * lib0 varuint: seven bits per byte, low bits first.
 * @param n - A non-negative integer.
 * @returns The encoded bytes.
 */
function varUint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/**
 * A pure-delete V1 update of one client, its ranges written in the given order.
 * @param client - The client the ranges name.
 * @param ranges - `[clock, len]` pairs.
 * @returns The update.
 */
function dsUpdate(client: number, ranges: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const bytes = [0, 1, ...varUint(client), ...varUint(ranges.length)];
  for (const [clock, len] of ranges) bytes.push(...varUint(clock), ...varUint(len));
  return new Uint8Array(bytes);
}

/**
 * Spec 14a.7 "array document": client 7's `nodes.n.items`, 2000 values each
 * inserted at index 0 (structs do not merge), clocks 2-2001, state 2002.
 * @returns A server copy of it.
 */
function arrayDoc(): Y.Doc {
  const src = new Y.Doc();
  src.clientID = 7;
  const node = new Y.Map<unknown>();
  src.getMap<Y.Map<unknown>>("nodes").set("n", node);
  const items = new Y.Array<string>();
  node.set("items", items);
  for (let i = 0; i < 2000; i++) items.insert(0, ["x"]);
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(src));
  return server;
}

/**
 * Spec R6-27: client 21's `nodes.m.body` XmlText, 4000 characters each
 * inserted at index 0, and one transaction deleting indices 3998, 3996, ..., 0.
 * @returns The server copy before the delete and the delete's update.
 */
function perCharDoc(): { server: Y.Doc; update: Uint8Array } {
  const client = new Y.Doc();
  client.clientID = 21;
  const m = new Y.Map<unknown>();
  client.getMap<Y.Map<unknown>>("nodes").set("m", m);
  const body = new Y.XmlText();
  m.set("body", body);
  for (let i = 0; i < 4000; i++) body.insert(0, "x");
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
  let update: Uint8Array | null = null;
  client.on("update", (u: Uint8Array) => {
    update = u;
  });
  client.transact(() => {
    for (let i = 3998; i >= 0; i -= 2) body.delete(i, 1);
  });
  if (update === null) throw new Error("the delete wrote nothing");
  return { server, update };
}

/**
 * Call `updateShape` once and time it.
 * @param update - The update.
 * @param store - The store it is read against.
 * @returns The result and the milliseconds it took.
 */
function timed(update: Uint8Array, store: Y.Doc["store"]): { shape: UpdateShape; ms: number } {
  const t0 = performance.now();
  const shape = updateShape(update, store);
  return { shape, ms: performance.now() - t0 };
}

/**
 * The split and whole-type facts of a result, the part R6-28 compares.
 * @param shape - A result.
 * @returns The two facts.
 */
function facts(shape: UpdateShape): { splitEndpoints: number; wholeTypesOnly: boolean } {
  return { splitEndpoints: shape.splitEndpoints, wholeTypesOnly: shape.wholeTypesOnly };
}

/**
 * The same update with its delete set merged by yjs (`Y.mergeDeleteSets`).
 * @param update - A pure-delete update.
 * @returns The update rewritten with the merged ranges.
 */
function mergedUpdate(update: Uint8Array): Uint8Array {
  const merged = Y.mergeDeleteSets([Y.decodeUpdate(update).ds]);
  const bytes = [0, ...varUint(merged.clients.size)];
  merged.clients.forEach((items, client) => {
    bytes.push(...varUint(client), ...varUint(items.length));
    for (const item of items) bytes.push(...varUint(item.clock), ...varUint(item.len));
  });
  return new Uint8Array(bytes);
}

/** Warm the function up so the first timed call does not pay for compilation. */
function warmUp(): void {
  const doc = arrayDoc();
  updateShape(dsUpdate(7, [[2, 2000]]), doc.store);
}

describe("updateShape time bound (design 4.1 walk, design 8)", () => {
  it("R6-24 K copies of one covering range take under 100 ms for K up to 2000 and count as one", () => {
    warmUp();
    const doc = arrayDoc();
    expect(Y.getState(doc.store, 7)).toBe(2002);
    for (const k of [1, 200, 1000, 2000]) {
      const update = dsUpdate(7, Array.from({ length: k }, () => [2, 2000] as const));
      if (k === 2000) expect(update.byteLength).toBe(6005);
      const { shape, ms } = timed(update, doc.store);
      expect(shape).toMatchObject({ splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: false });
      expect(ms, `K = ${k}`).toBeLessThan(BOUND_MS);
    }
  }, 120_000);

  it("R6-25 2000 nested ranges take under 100 ms", () => {
    warmUp();
    const doc = arrayDoc();
    const update = dsUpdate(7, Array.from({ length: 2000 }, (_, k) => [2001 - k, k + 1] as const));
    expect(update.byteLength).toBe(7752);
    const { shape, ms } = timed(update, doc.store);
    expect(shape).toMatchObject({ splitEndpoints: 0, wholeTypesOnly: false });
    expect(ms).toBeLessThan(BOUND_MS);
  }, 120_000);

  it("R6-26 100 000 zero-length ranges, alone and after one covering range, take under 100 ms", () => {
    warmUp();
    const doc = arrayDoc();
    const zero = Array.from({ length: 100_000 }, (_, k) => [5 + (k % 1990), 0] as const);
    const alone = dsUpdate(7, zero);
    expect(alone.byteLength).toBe(293_733);
    const first = timed(alone, doc.store);
    expect(first.shape).toMatchObject({ splitEndpoints: 0, wholeTypesOnly: true });
    expect(first.ms).toBeLessThan(BOUND_MS);
    const withCover = dsUpdate(7, [[2, 2000], ...zero]);
    const second = timed(withCover, doc.store);
    expect(second.shape).toMatchObject({ wholeTypesOnly: false });
    expect(second.ms).toBeLessThan(BOUND_MS);
  }, 120_000);

  it("R6-27 2000 per-character delete ranges over unmerged structs take under 100 ms", () => {
    warmUp();
    const { server, update } = perCharDoc();
    expect(Y.decodeUpdate(update).ds.clients.get(21)?.length).toBe(2000);
    expect(update.byteLength).toBe(5942);
    const { shape, ms } = timed(update, server.store);
    expect(shape).toMatchObject({ splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: false });
    expect(ms).toBeLessThan(BOUND_MS);
  }, 120_000);

  it("R6-28 property: any mix of copies, nested, zero-length and per-character ranges stays under 100 ms and counts as its merged delete set", () => {
    warmUp();
    const docs = {
      array: { store: arrayDoc().store, client: 7, from: 2, count: 2000 },
      text: { store: perCharDoc().server.store, client: 21, from: 2, count: 4000 },
    };
    /** One range kind of R6-28. */
    type Kind = "copy" | "nested" | "zero" | "char";
    const kinds: Kind[] = ["copy", "nested", "zero", "char"];
    fc.assert(
      fc.property(
        fc.constantFrom<keyof typeof docs>("array", "text"),
        fc.array(fc.tuple(fc.constantFrom(...kinds), fc.nat(), fc.nat()), { minLength: 1, maxLength: 2000, size: "max" }),
        fc.tuple(fc.nat(), fc.nat()),
        (which, picks, [coverA, coverB]) => {
          const d = docs[which];
          const end = d.from + d.count;
          // The one range every "copy" repeats.
          const lo = d.from + (Math.min(coverA, coverB) % d.count);
          const hi = lo + 1 + (Math.max(coverA, coverB) % (end - lo));
          const ranges = picks.map(([kind, a, b], k): readonly [number, number] => {
            const at = d.from + (a % d.count);
            switch (kind) {
              case "copy":
                return [lo, Math.min(hi, end) - lo];
              case "nested": {
                const len = 1 + ((k + b) % d.count);
                return [end - len, len];
              }
              case "zero":
                return [at, 0];
              case "char":
                return [at, 1];
            }
          });
          const update = dsUpdate(d.client, ranges);
          const { shape, ms } = timed(update, d.store);
          expect(ms).toBeLessThan(BOUND_MS);
          expect(facts(shape)).toEqual(facts(updateShape(mergedUpdate(update), d.store)));
        },
      ),
      { numRuns: 30, endOnFailure: true },
    );
  }, 600_000);
});
