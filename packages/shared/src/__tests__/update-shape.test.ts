// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `updateShape` read against a real yjs struct store, the one function collab's
 * gate and web's undo trial both judge an update with (inner#1790 v2 spec
 * SH-01 to SH-16, R6-03 and R6-29).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DOC_SIZE_EVENT_BYTES, updateShape, type UpdateShape } from "@shared/doc-size.js";

/**
 * Design 4.1 cost: the message length plus 32 per split endpoint
 * and beyond-clock range; 0 for a pure delete covering no live item, with
 * neither.
 * @param update - The update.
 * @param shape - Its shape.
 * @returns Bytes.
 */
function costOf(update: Uint8Array, shape: UpdateShape): number {
  if (shape.pureDelete && shape.coversLive === false && shape.splitEndpoints === 0 && shape.beyondClockRanges === 0) return 0;
  return update.byteLength + DOC_SIZE_EVENT_BYTES * (shape.splitEndpoints + shape.beyondClockRanges);
}

/** A client document and a server copy kept in step by applying every update. */
function pair(clientID: number): { client: Y.Doc; server: Y.Doc } {
  const client = new Y.Doc();
  client.clientID = clientID;
  const server = new Y.Doc();
  client.on("update", (u: Uint8Array) => Y.applyUpdate(server, u));
  return { client, server };
}

/**
 * Run one change on the client and return its update with the server store as
 * it was before the update arrived.
 */
function capture(client: Y.Doc, server: Y.Doc, change: () => void): { update: Uint8Array; store: Y.Doc["store"]; doc: Y.Doc } {
  const before = new Y.Doc();
  Y.applyUpdate(before, Y.encodeStateAsUpdate(server));
  let update: Uint8Array | null = null;
  const take = (u: Uint8Array): void => { update = u; };
  client.on("update", take);
  client.transact(change);
  client.off("update", take);
  if (update === null) throw new Error("the change wrote nothing");
  return { update, store: before.store, doc: before };
}

/** The node fixture of spec 0.3: data map, body fragment, renamed twice. */
function nodeDoc(): { client: Y.Doc; server: Y.Doc; node: Y.Map<unknown>; data: Y.Map<unknown>; focus: Y.Array<string>; text: Y.XmlText; paragraph: Y.XmlElement } {
  const { client, server } = pair(7);
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  const focus = new Y.Array<string>();
  const body = new Y.XmlFragment();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  client.transact(() => {
    nodes.set("n1", node);
    node.set("data", data);
    data.set("locked", true);
    data.set("color", "red");
    data.set("focus", focus);
    node.set("body", body);
    body.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, "hello world");
  });
  focus.push(["a"]);
  focus.push(["b"]);
  focus.push(["c"]);
  node.set("name", "x1");
  node.set("name", "x2");
  return { client, server, node, data, focus, text, paragraph };
}

/** lib0 varuint: seven bits per byte, low bits first. */
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

/** A pure-delete update written by hand in the v1 encoding: no structs, one client, one range. */
function beyondDs(client: number, clock: number, len: number): Uint8Array {
  return new Uint8Array([0, 1, ...varUint(client), 1, ...varUint(clock), ...varUint(len)]);
}

/**
 * A pure-delete update written by hand: no structs, one client, the given ranges in the given order.
 * @param client - The client the ranges name.
 * @param ranges - `[clock, len]` pairs.
 * @returns The V1 update.
 */
function dsUpdate(client: number, ranges: ReadonlyArray<readonly [number, number]>): Uint8Array {
  return new Uint8Array([0, 1, ...varUint(client), ...varUint(ranges.length), ...ranges.flatMap(([clock, len]) => [...varUint(clock), ...varUint(len)])]);
}

/** The alt2000 fixture of spec 0.3: one root text holding 2000 characters inserted at once. */
function alt2000(clientID: number): { client: Y.Doc; server: Y.Doc; t: Y.Text } {
  const { client, server } = pair(clientID);
  const t = client.getText("t");
  t.insert(0, "x".repeat(2000));
  return { client, server, t };
}

describe("updateShape", () => {
  it("SH-01 deleting a whole node is a pure delete of whole types, with no structBytes key", () => {
    const { client, server } = nodeDoc();
    const { update, store } = capture(client, server, () => client.getMap("nodes").delete("n1"));
    expect(updateShape(update, store)).toEqual({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true, coversLive: true });
  });

  it("SH-02 deleting one Map entry holding a plain value counts as a whole entry", () => {
    const { client, server, data } = nodeDoc();
    const { update, store } = capture(client, server, () => data.delete("locked"));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-03 deleting part of a text splits the item at both ends and is not a whole type", () => {
    const { client, server, text } = nodeDoc();
    const { update, store } = capture(client, server, () => text.delete(2, 3));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 2, beyondClockRanges: 0, wholeTypesOnly: false });
  });

  it("SH-04 deleting the middle item of a plain-value array is not a whole type", () => {
    const { client, server, focus } = nodeDoc();
    const { update, store } = capture(client, server, () => focus.delete(1, 1));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 2, wholeTypesOnly: false });
  });

  it("SH-05 deleting every other character of 2000 counts 1999 split endpoints", () => {
    const { client, server, t } = alt2000(11);
    const { update, store } = capture(client, server, () => {
      for (let i = 1999; i >= 1; i -= 2) t.delete(i, 1);
    });
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 1999, wholeTypesOnly: false });
  });

  it("SH-06 a range starting at the item start splits only at its end", () => {
    const { client, server, t } = alt2000(11);
    const inner = capture(client, server, () => {
      for (let i = 1024; i >= 2; i -= 2) t.delete(i, 1);
    });
    expect(updateShape(inner.update, inner.store).splitEndpoints).toBe(1024);
    const { client: c2, server: s2, t: t2 } = alt2000(11);
    const withStart = capture(c2, s2, () => {
      for (let i = 1024; i >= 2; i -= 2) t2.delete(i, 1);
      t2.delete(0, 1);
    });
    expect(updateShape(withStart.update, withStart.store).splitEndpoints).toBe(1025);
  });

  it("SH-07 deleting all the text of a root text is not a whole type", () => {
    const { client, server, t } = alt2000(11);
    const { update, store } = capture(client, server, () => t.delete(0, 2000));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, wholeTypesOnly: false });
  });

  it("SH-08 a delete range of an unknown client is beyond the clock", () => {
    const server = new Y.Doc();
    expect(updateShape(beyondDs(4242, 100, 1), server.store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 1 });
  });

  it("SH-09 a range ending past the server's clock of that client is beyond the clock", () => {
    const { server } = nodeDoc();
    const state = Y.getState(server.store, 7);
    expect(updateShape(beyondDs(7, state - 2, 5), server.store).beyondClockRanges).toBe(1);
  });

  it("SH-10 a handshake delete set covering only deleted content is whole-types-only", () => {
    const { client, server } = nodeDoc();
    client.getMap("nodes").delete("n1");
    const step2 = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(step2.byteLength).toBe(6);
    const shape = updateShape(step2, server.store);
    expect(shape).toEqual({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true, coversLive: false });
    expect(costOf(step2, shape)).toBe(0);
  });

  it("SH-11 a delete together with a write is not a pure delete", () => {
    const { client, server, data, node } = nodeDoc();
    const { update, store } = capture(client, server, () => {
      data.delete("color");
      node.set("name", "x3");
    });
    expect(updateShape(update, store).pureDelete).toBe(false);
  });

  it("SH-12 an insert-only update is not a pure delete and counts no split or beyond-clock range", () => {
    const { client, server } = pair(7);
    const { update, store } = capture(client, server, () => {
      const n2 = new Y.Map<unknown>();
      client.getMap("nodes").set("n2", n2);
      n2.set("name", "abc");
    });
    expect(update.byteLength).toBe(32);
    expect(updateShape(update, store)).toEqual({ pureDelete: false, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true, coversLive: false });
  });

  it("SH-13 removing an XML attribute counts as deleting a Map entry", () => {
    const { client, server, paragraph } = nodeDoc();
    paragraph.setAttribute("id", "b1");
    const { update, store } = capture(client, server, () => paragraph.removeAttribute("id"));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, wholeTypesOnly: true });
  });

  it("SH-14 already-deleted items in the delete set take no part in the judgement", () => {
    const { client, server, data } = nodeDoc();
    const { store } = capture(client, server, () => data.delete("color"));
    // The client's whole delete set now covers the overwritten "x1" name item and the live "color" entry.
    const withOld = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(updateShape(withOld, store)).toEqual({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true, coversLive: true });
  });

  it("SH-15 a malformed update throws", () => {
    expect(() => updateShape(new Uint8Array([1]), new Y.Doc().store)).toThrow(/Unexpected end of array/);
    expect(() => updateShape(new Uint8Array([0, 1, 5]), new Y.Doc().store)).toThrow(/Unexpected end of array/);
  });

  it("SH-16 reading leaves the store unchanged and gives the same answer twice", () => {
    const { client, server, text } = nodeDoc();
    const { update, store, doc } = capture(client, server, () => text.delete(2, 3));
    const snapshot = Y.encodeStateAsUpdate(doc);
    const first = updateShape(update, store);
    const second = updateShape(update, store);
    expect(second).toEqual(first);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(snapshot);
    expect(store.pendingStructs).toBeNull();
    expect(store.pendingDs).toBeNull();
  });

  it("R6-03 the result has exactly five keys and no structBytes", () => {
    const keys = ["beyondClockRanges", "coversLive", "pureDelete", "splitEndpoints", "wholeTypesOnly"];
    const ins = pair(7);
    const insert = capture(ins.client, ins.server, () => {
      const n2 = new Y.Map<unknown>();
      ins.client.getMap("nodes").set("n2", n2);
      n2.set("name", "abc");
    });
    expect(Object.keys(updateShape(insert.update, insert.store)).sort()).toEqual(keys);
    const { client, server } = nodeDoc();
    const del = capture(client, server, () => client.getMap("nodes").delete("n1"));
    expect(Object.keys(updateShape(del.update, del.store)).sort()).toEqual(keys);
  });

  it("R6-29 adjacent and duplicate ranges are merged before split endpoints are counted; beyond-clock ranges count as sent", () => {
    const { server } = alt2000(11);
    const adjacent = dsUpdate(11, [[10, 1], [11, 1]]);
    const duplicate = dsUpdate(11, [[10, 2], [10, 2]]);
    const single = dsUpdate(11, [[10, 2]]);
    expect([adjacent.byteLength, duplicate.byteLength, single.byteLength]).toEqual([8, 8, 6]);
    expect(updateShape(adjacent, server.store).splitEndpoints).toBe(2);
    expect(updateShape(duplicate, server.store).splitEndpoints).toBe(2);
    expect(updateShape(single, server.store).splitEndpoints).toBe(2);
    const repeated = dsUpdate(4242, Array.from({ length: 1000 }, () => [100, 1] as const));
    expect(repeated.byteLength).toBe(2006);
    expect(updateShape(repeated, server.store).beyondClockRanges).toBe(1000);
  });
});

describe("updateShape coversLive and the zero cost of deletes covering only deleted content (spec 14b.2)", () => {
  it("R7-07 truth table of coversLive and the design 4.1 cost", () => {
    // (a) SH-10: the handshake delete set covers only the deleted n1.
    const a = nodeDoc();
    a.client.getMap("nodes").delete("n1");
    const step2 = Y.encodeStateAsUpdate(a.client, Y.encodeStateVector(a.server));
    const sa: UpdateShape = updateShape(step2, a.server.store);
    expect(sa).toMatchObject({ pureDelete: true, coversLive: false, splitEndpoints: 0, beyondClockRanges: 0 });
    expect(costOf(step2, sa)).toBe(0);

    // (b) SH-02: deleting the live `locked` entry.
    const b = nodeDoc();
    const sh02 = capture(b.client, b.server, () => b.data.delete("locked"));
    const sb: UpdateShape = updateShape(sh02.update, sh02.store);
    expect(sb.coversLive).toBe(true);
    expect(costOf(sh02.update, sb)).toBe(6);

    // (c) SH-14: covers the overwritten name and the live `color` entry.
    const c = nodeDoc();
    const sh14 = capture(c.client, c.server, () => c.data.delete("color"));
    const withOld = Y.encodeStateAsUpdate(c.client, Y.encodeStateVector(c.server));
    expect(updateShape(withOld, sh14.store).coversLive).toBe(true);

    // (d) SH-03: deleting inside a text.
    const d = nodeDoc();
    const sh03 = capture(d.client, d.server, () => d.text.delete(2, 3));
    const sd: UpdateShape = updateShape(sh03.update, sh03.store);
    expect(sd.coversLive).toBe(true);
    expect(costOf(sh03.update, sd)).toBe(70);

    // (e) SH-08: a beyond-clock range is not free.
    const beyond = beyondDs(4242, 100, 1);
    const se: UpdateShape = updateShape(beyond, new Y.Doc().store);
    expect(se).toMatchObject({ coversLive: false, beyondClockRanges: 1 });
    expect(costOf(beyond, se)).toBe(7 + 32);

    // (f) SH-12: insert only.
    const f = pair(7);
    const sh12 = capture(f.client, f.server, () => {
      const n2 = new Y.Map<unknown>();
      f.client.getMap("nodes").set("n2", n2);
      n2.set("name", "abc");
    });
    const sf: UpdateShape = updateShape(sh12.update, sh12.store);
    expect(sf).toMatchObject({ pureDelete: false, coversLive: false });
    expect(costOf(sh12.update, sf)).toBe(32);

    // (g) structs plus a delete set covering only deleted content.
    const g = nodeDoc();
    const svBefore = Y.encodeStateVector(g.server);
    g.client.getMap("nodes").delete("n1");
    g.client.getMap("nodes").set("n2", new Y.Map<unknown>());
    const mixed = Y.encodeStateAsUpdate(g.client, svBefore);
    const sg: UpdateShape = updateShape(mixed, g.server.store);
    expect(g.server.getMap("nodes").has("n1")).toBe(false);
    expect(sg.pureDelete).toBe(false);
    expect(costOf(mixed, sg)).toBe(mixed.byteLength);

    // (h) a pure delete with an empty delete set.
    const empty = new Uint8Array([0, 0]);
    const sh: UpdateShape = updateShape(empty, new Y.Doc().store);
    expect(sh.coversLive).toBe(false);
    expect(costOf(empty, sh)).toBe(0);
  });

  it("R7-08 a delete covering only characters already deleted covers nothing live, splits nothing and costs 0", () => {
    const { client, server, t } = alt2000(11);
    t.delete(10, 10);
    const again = dsUpdate(11, [[10, 10]]);
    const shape: UpdateShape = updateShape(again, server.store);
    expect(shape).toMatchObject({ coversLive: false, splitEndpoints: 0 });
    expect(costOf(again, shape)).toBe(0);
    const before = Y.encodeStateAsUpdate(server).byteLength;
    Y.applyUpdate(server, again);
    expect(Y.encodeStateAsUpdate(server).byteLength).toBe(before);
    client.destroy();
  });

  it("R7-09 a range from a deleted item into a live one covers live content and splits once", () => {
    const { client, server, t } = alt2000(11);
    t.delete(10, 10);
    const across = dsUpdate(11, [[15, 10]]);
    const shape: UpdateShape = updateShape(across, server.store);
    expect(shape).toMatchObject({ coversLive: true, splitEndpoints: 1 });
    expect(costOf(across, shape)).toBe(across.byteLength + 32);
    client.destroy();
  });
});

/** One level of the R7-05 nesting: the container kind and how many values it holds. */
interface Level {
  kind: "map" | "array" | "xml";
  values: number;
}

/**
 * Build the R7-05 nesting on client 7, one transaction per write so values
 * stay separate items, and sync it to a server copy.
 * @param levels - The levels, outermost first.
 * @returns The server copy.
 */
function nested(levels: readonly Level[]): Y.Doc {
  const src = new Y.Doc();
  src.clientID = 7;
  let parent: Y.Map<unknown> | Y.Array<unknown> | Y.XmlElement = src.getMap<unknown>("root");
  let nth = 0;
  for (const level of levels) {
    const kind: Level["kind"] = parent instanceof Y.XmlElement ? "xml" : level.kind;
    const child: Y.Map<unknown> | Y.Array<unknown> | Y.XmlElement =
      kind === "map" ? new Y.Map<unknown>() : kind === "array" ? new Y.Array<unknown>() : new Y.XmlElement("p");
    const holder = parent;
    if (holder instanceof Y.Map) holder.set(`c${nth}`, child);
    else if (holder instanceof Y.Array) holder.push([child]);
    else holder.insert(0, [child as Y.XmlElement]);
    for (let i = 0; i < level.values; i++) {
      if (child instanceof Y.Map) child.set(`v${i % 7}`, `value ${i}`);
      else if (child instanceof Y.Array) child.insert(i % 3 === 0 ? 0 : child.length, [`v${i}`]);
      else if (i % 2 === 0) child.setAttribute(`a${i % 5}`, `${i}`);
      else child.insert(0, [new Y.XmlText(`t${i}`)]);
    }
    parent = child;
    nth += 1;
  }
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(src));
  src.destroy();
  return server;
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

/**
 * Design 4.1 `wholeTypesOnly`, judged naively: for every live item a merged
 * range covers, walk its whole parent chain and look for an ancestor type
 * item some range covers whole, by a fresh binary search each time.
 * @param update - A pure-delete update.
 * @param store - The store.
 * @returns Whether every covered live item is removable whole.
 */
function naiveWholeTypesOnly(update: Uint8Array, store: Y.Doc["store"]): boolean {
  const merged = Y.mergeDeleteSets([Y.decodeUpdate(update).ds]);
  /**
   * Whether one merged range covers an item whole.
   * @param item - The item.
   * @returns True when it does.
   */
  const coveredWhole = (item: Y.Item): boolean => {
    const ranges = merged.clients.get(item.id.client) ?? [];
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (r === undefined) return false;
      if (r.clock > item.id.clock) hi = mid - 1;
      else if (r.clock + r.len <= item.id.clock) lo = mid + 1;
      else return item.id.clock + item.length <= r.clock + r.len;
    }
    return false;
  };
  let all = true;
  merged.clients.forEach((ranges, client) => {
    for (const struct of store.clients.get(client) ?? []) {
      if (!(struct instanceof Y.Item) || struct.deleted) continue;
      const start = struct.id.clock;
      const end = start + struct.length;
      const range = ranges.find((r) => r.clock < end && r.clock + r.len > start);
      if (range === undefined) continue;
      const whole = range.clock <= start && range.clock + range.len >= end;
      let ok = whole && (struct.content instanceof Y.ContentType || struct.parentSub !== null);
      for (let p = struct.parent instanceof Y.AbstractType ? struct.parent._item : null; p !== null; p = p.parent instanceof Y.AbstractType ? p.parent._item : null) {
        if (coveredWhole(p)) ok = true;
      }
      if (!ok) all = false;
    }
  });
  return all;
}

describe("updateShape on random nesting (spec 14b.1 R7-05)", () => {
  it("R7-05 property: wholeTypesOnly equals a naive per-item walk, and the other facts equal those of the merged delete set", () => {
    const level = fc.record({ kind: fc.constantFrom<Level["kind"]>("map", "array", "xml"), values: fc.integer({ min: 0, max: 30 }) });
    const pick = fc.tuple(fc.constantFrom("type", "value", "span"), fc.nat(), fc.nat({ max: 60 }));
    fc.assert(
      fc.property(fc.array(level, { minLength: 1, maxLength: 40 }), fc.array(pick, { minLength: 1, maxLength: 40 }), (levels, picks) => {
        const server = nested(levels);
        const structs = (server.store.clients.get(7) ?? []).filter((st): st is Y.Item => st instanceof Y.Item);
        const types = structs.filter((it) => it.content instanceof Y.ContentType);
        const state = Y.getState(server.store, 7);
        const ranges = picks.map(([kind, a, len]): readonly [number, number] => {
          if (kind === "type" && types.length > 0) {
            const t = types[a % types.length] as Y.Item;
            return [t.id.clock, t.length];
          }
          if (kind === "value" && structs.length > 0) {
            const v = structs[a % structs.length] as Y.Item;
            return [v.id.clock, v.length];
          }
          return [a % (state + 1), len + 1];
        });
        const update = dsUpdate(7, ranges);
        const shape: UpdateShape = updateShape(update, server.store);
        const mergedShape: UpdateShape = updateShape(mergedUpdate(update), server.store);
        expect(shape.wholeTypesOnly).toBe(naiveWholeTypesOnly(update, server.store));
        expect({ pureDelete: shape.pureDelete, splitEndpoints: shape.splitEndpoints, coversLive: shape.coversLive }).toEqual({
          pureDelete: mergedShape.pureDelete,
          splitEndpoints: mergedShape.splitEndpoints,
          coversLive: mergedShape.coversLive,
        });
        server.destroy();
      }),
      { numRuns: 200 },
    );
  }, 120_000);
});

