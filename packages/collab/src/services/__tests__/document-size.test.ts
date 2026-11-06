// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `measure` and `analyze` of the document size cap (inner#1790, design 4.1;
 * test spec section 3, C-30 to C-51).
 *
 * Every expectation is checked against yjs itself through the independent
 * reference in `helpers/doc-size-ref.ts`: `Δ` is the reference size change of
 * a full replica, `ref.truth` and `ref.storedReduced` compare a full replica's
 * pending content before and after. The scenarios are the design-review
 * probes the spec names, translated.
 */

import type * as CoreModule from "@breatic/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { analyze, measure, precheckMayPend } from "@collab/services/document-size.js";
import {
  C,
  S,
  capture,
  craft,
  cycle,
  deleteOnly,
  dsAdjacent,
  fill,
  formatCleanupDoc,
  freedOverlapDoc,
  imageNodes,
  liveFormatItems,
  liveItems,
  manyClientDoc,
  missingDependency,
  nestedDoc,
  overwriteUpdate,
  pendGrowth,
  pendingCounts,
  preloadPend,
  refDelta,
  refDsBytes,
  refMeasure,
  refStoredReduced,
  refTruth,
  reload,
  replicaOutcome,
  s1,
  s2,
  s3,
  s5,
  skipGap,
  storedPendingDs,
  storedPendingIntegrate,
  structsB2,
  structsCasesB,
  structsCasesC,
  syncedClient,
  textNodes,
  wouldpendOwnStructs,
} from "./helpers/doc-size-ref.js";

/**
 * The spec's opening assertion for every case: `measure` agrees with the
 * reference before anything else is read.
 * @param d - The server document.
 */
function measuresRight(d: Y.Doc): void {
  expect(measure(d)).toBe(refMeasure(d));
}

/**
 * `C-30`: `clientID 1` wrote `'hello'`, no pending content.
 * @returns The document.
 */
function hello(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 1;
  d.getText("t").insert(0, "hello");
  return d;
}

/**
 * An edit by client 2 synced with `d`.
 * @param d - The server document.
 * @param edit - The edit on client 2's text.
 * @returns The update.
 */
function client2(d: Y.Doc, edit: (t: Y.Text) => void): Uint8Array {
  const c = syncedClient(d, 2);
  return capture(c, () => edit(c.getText("t")));
}

describe("measure (C-30 to C-32)", () => {
  it("C-30 is the encoded size when nothing is pending", () => {
    const d = hello();
    measuresRight(d);
    expect(measure(d)).toBe(Y.encodeStateAsUpdate(d).byteLength);
  });

  it("C-31 adds C for one stored pending struct", () => {
    const { server: d } = structsCasesB();
    measuresRight(d);
    expect(d.store.pendingStructs).not.toBeNull();
    expect(measure(d)).toBe(Y.encodeStateAsUpdate(d).byteLength + C * 1);
  });

  it("C-32 adds 2C for one stored pending delete range", () => {
    const d = storedPendingDs();
    measuresRight(d);
    expect(d.store.pendingDs).not.toBeNull();
    expect(measure(d)).toBe(Y.encodeStateAsUpdate(d).byteLength + 2 * C * 1);
  });
});

describe("analyze: the rows of design 4.1 (C-33 to C-45, C-51)", () => {
  it("C-33 an echo of stored pending content adds nothing and bounds nothing", () => {
    const { server, echoStep2 } = dsAdjacent();
    measuresRight(server);
    const before = Y.encodeStateAsUpdate(server).byteLength;
    const o = replicaOutcome(server, echoStep2);
    expect(Y.encodeStateAsUpdate(o.replica).byteLength).toBe(before);
    expect(o.added).toBe(0);
    expect(o.removed).toBe(0);
    expect(o.delta).toBe(0);
    const a = analyze(echoStep2, server);
    expect(a.wouldPend).toBe(false);
    expect(a.integratesStored).toBe(false);
    expect(a.growthBound).toBe(0);
  });

  it("C-34 an append counts its struct bytes plus C and nothing else", () => {
    const d = hello();
    measuresRight(d);
    const u = client2(d, (t) => t.insert(t.length, "y".repeat(100)));
    const a = analyze(u, d);
    expect(a.structs).toBe(1);
    expect(a.structBytes).toBe(u.byteLength - refDsBytes(u));
    expect(a.growthBound).toBe(a.structBytes + C);
    expect(a.liveEndpoints).toBe(0);
    expect(a.liveRanges).toBe(0);
    expect(a.cascadeItems).toBe(0);
    expect(a.formatItems).toBe(0);
    expect(a.freedBytes).toBe(0);
    expect(a.deletesLive).toBe(false);
    expect(a.wouldPend).toBe(false);
    expect(a.integratesStored).toBe(false);
    expect(a.skeletonBuilt).toBe(false);
    expect(refDelta(d, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-35 an insert whose origin splits an item is still structBytes + C", () => {
    const d = hello();
    measuresRight(d);
    const u = client2(d, (t) => t.insert(2, "Q"));
    const a = analyze(u, d);
    expect(a.structs).toBe(1);
    expect(a.growthBound).toBe(a.structBytes + C);
    expect(refDelta(d, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-36 a delete inside one item counts two endpoints and one range", () => {
    const d = hello();
    measuresRight(d);
    const u = client2(d, (t) => t.delete(1, 3));
    const a = analyze(u, d);
    expect(a.structs).toBe(0);
    expect(a.liveEndpoints).toBe(2);
    expect(a.liveRanges).toBe(1);
    expect(a.growthBound).toBe(3 * C);
    expect(a.deletesLive).toBe(true);
    // 3 bytes of 'ell' minus the 1-byte GC length field.
    expect(a.freedBytes).toBe(2);
    const delta = refDelta(d, u);
    expect(delta).toBeLessThanOrEqual(a.growthBound);
    expect(delta).toBeLessThanOrEqual(Math.max(0, a.growthBound - a.freedBytes));
  });

  it("C-37 (a) a whole item, (b) already deleted content, (c) the 2-byte empty update", () => {
    const d = hello();
    measuresRight(d);
    const del = client2(d, (t) => t.delete(0, 5));
    const a = analyze(del, d);
    expect(a.liveEndpoints).toBe(0);
    expect(a.liveRanges).toBe(1);
    expect(a.growthBound).toBe(C);
    expect(a.freedBytes).toBe(4);

    const after = reload(d);
    Y.applyUpdate(after, del);
    measuresRight(after);
    const b = analyze(deleteOnly([[1, [[0, 5]]]]), after);
    expect(b.liveRanges).toBe(0);
    expect(b.growthBound).toBe(0);
    expect(b.deletesLive).toBe(false);
    expect(b.freedBytes).toBe(0);

    const c = analyze(new Uint8Array([0, 0]), d);
    expect(c.growthBound).toBe(0);
    expect(c.wouldPend).toBe(false);
  });

  it("C-38 a range repeated 50 times counts once (freed-overlap)", () => {
    const { doc, typeItem, x } = freedOverlapDoc(100);
    measuresRight(doc);
    const once = deleteOnly([[1, [[typeItem.id.clock, 1], [x.id.clock, x.length]]]]);
    const repeated = deleteOnly([[1, [[typeItem.id.clock, 1], ...Array.from({ length: 50 }, (): [number, number] => [x.id.clock, x.length])]]]);
    const a1 = analyze(once, doc);
    const a50 = analyze(repeated, doc);
    expect(a50.liveRanges).toBe(a1.liveRanges);
    expect(a50.liveEndpoints).toBe(a1.liveEndpoints);
    expect(a50.freedBytes).toBe(a1.freedBytes);
    expect(a50.growthBound).toBe(a1.growthBound);
    expect(refDelta(doc, repeated)).toBeLessThanOrEqual(Math.max(0, a50.growthBound - a50.freedBytes));
  });

  // Spec C-39 to C-41 write "cascadeItems === 2000" for K = 2000. The array
  // under m.x also holds the `[0]` its children are anchored to, so the
  // design 4.1 definition ("live items in the type's subtree not covered by
  // the update's ranges") counts K + 1; the expectation is the count read
  // off the document.
  it("C-39 deleting a nested type counts every sparse-clock child (nested-cascade)", () => {
    const n = nestedDoc(2000);
    measuresRight(n.doc);
    const live = liveItems(n.arr).length;
    expect(live).toBe(2001);
    const u = deleteOnly([[1, [[n.typeItem.id.clock, 1]]]]);
    const a = analyze(u, n.doc);
    expect(a.cascadeItems).toBe(live);
    expect(a.growthBound).toBeGreaterThanOrEqual(C * 2000);
    expect(refDelta(n.doc, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-40 explicit ranges over cascaded children are not counted twice", () => {
    const n = nestedDoc(2000);
    measuresRight(n.doc);
    const live = liveItems(n.arr).length;
    const u = deleteOnly([
      [1, [[n.typeItem.id.clock, 1]]],
      [2, n.childClocks.slice(0, 500).map((c): [number, number] => [c, 1])],
    ]);
    const a = analyze(u, n.doc);
    expect(a.cascadeItems).toBe(live - 500);
    expect(a.liveRanges).toBe(501);
    expect(refDelta(n.doc, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-41 a map write replacing a type value cascades its children (overwrite-cascade)", () => {
    const n = nestedDoc(2000);
    measuresRight(n.doc);
    const live = liveItems(n.arr).length;
    const u = overwriteUpdate(n);
    const a = analyze(u, n.doc);
    expect(a.structs).toBe(1);
    expect(a.liveRanges).toBe(0);
    expect(a.cascadeItems).toBe(live);
    expect(a.deletesLive).toBe(false);
    expect(refDelta(n.doc, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-42 a delete across format regions counts the format cleanup (format-cleanup-k)", () => {
    const M = 150;
    const f = formatCleanupDoc(M, 20);
    measuresRight(f.server);
    const u = deleteOnly([[f.stringClient, [[0, 2 * M]]]]);
    const replica = reload(f.server);
    const formatsBefore = liveFormatItems(f.textOf(replica));
    expect(formatsBefore.length).toBe(3000);
    Y.applyUpdate(replica, u);
    const cleaned = formatsBefore.filter((it) => it.deleted).length;
    expect(cleaned).toBeGreaterThan(0);
    const a = analyze(u, f.server);
    expect(a.formatItems).toBeGreaterThanOrEqual(cleaned);
    // Each 'xy' item: 2 content bytes minus a 1-byte GC length field; format items not counted.
    expect(a.freedBytes).toBe(M * (2 - 1));
    expect(refDelta(f.server, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it("C-43 inserting a format item counts the text's existing format items", () => {
    const d = new Y.Doc();
    d.clientID = 1;
    const t = d.getText("t");
    t.insert(0, "abcdefghij".repeat(100));
    for (let i = 0; liveFormatItems(t).length < 300; i += 2) t.format(i, 1, { bold: true });
    expect(liveFormatItems(t).length).toBe(300);
    measuresRight(d);
    const u = client2(d, (ct) => ct.format(0, 10, { italic: true }));
    const a = analyze(u, d);
    expect(a.formatItems).toBe(300);
    expect(refDelta(d, u)).toBeLessThanOrEqual(a.growthBound);
  });

  it.each([
    ["image", imageNodes],
    ["text", textNodes],
  ])("C-44 deleting one %s node frees at least its bound", (_kind, build) => {
    const d = build(200);
    measuresRight(d);
    const c = syncedClient(d, 0x7e60);
    const u = capture(c, () => c.getMap("nodes").delete("node-100"));
    const a = analyze(u, d);
    expect(a.deletesLive).toBe(true);
    expect(a.growthBound).toBeLessThanOrEqual(a.freedBytes);
    const delta = refDelta(d, u);
    expect(delta).toBeLessThanOrEqual(0);
    expect(delta).toBeLessThanOrEqual(Math.max(0, a.growthBound - a.freedBytes));
  });

  it("C-45 a delete of an existing char or of the update's own char is a live delete", () => {
    const d = new Y.Doc();
    fill(d, S.L - 1000);
    measuresRight(d);
    const existing = client2(d, (t) => {
      t.insert(t.length, "y".repeat(20_480));
      t.delete(0, 1);
    });
    const own = client2(d, (t) => {
      t.insert(t.length, "y".repeat(20_480));
      t.delete(t.length - 1, 1);
    });
    for (const u of [existing, own]) {
      const a = analyze(u, d);
      expect(a.deletesLive).toBe(true);
      expect(a.liveRanges).toBeGreaterThanOrEqual(1);
    }
  });

  it("C-51 freedBytes counts raw content, not its encoded length", () => {
    const d = new Y.Doc();
    d.clientID = 1;
    d.getText("t").insert(0, "a".repeat(300));
    measuresRight(d);
    const u = client2(d, (t) => t.delete(0, 300));
    const a = analyze(u, d);
    // 300 content bytes minus varuint(300), a 2-byte GC length field.
    expect(a.freedBytes).toBe(298);
    expect(a.liveRanges).toBe(1);
    expect(a.liveEndpoints).toBe(0);
    expect(a.growthBound).toBe(C);
  });
});

/** C-46 inputs: wouldPend must be true. */
const pending: Array<[string, () => { server: Y.Doc; update: Uint8Array }]> = [
  ["(a) pend-growth: no structs, every range beyond the clocks", () => pendGrowth(200_000)],
  ["(b) a struct whose own predecessor never arrived", missingDependency],
  ["(c) cycle.cjs: two origins pointing at each other", () => cycle()],
  ["(d) structs-cases C: echo P plus S whose origin is P", () => structsCasesC()],
  ["(e) S3: origin inside stored pendingStructs", () => s3()],
  ["(f) skip-gap.cjs: merged update with a Skip", () => skipGap()],
  ["(g) preload-pend.cjs: SyncStep2 payload beyond any clock", preloadPend],
];

/** C-47 inputs: wouldPend must be false. */
const notPending: Array<[string, () => { server: Y.Doc; update: Uint8Array }]> = [
  ["wouldpend-own-structs handshake", wouldpendOwnStructs],
  ["ds-adjacent member Z handshake", () => { const s = dsAdjacent(); return { server: s.server, update: s.zStep2 }; }],
  ["C-33 echo of stored pending", () => { const s = dsAdjacent(); return { server: s.server, update: s.echoStep2 }; }],
  ["S1 author reconnect", () => s1()],
  ["S5 author reconnect after typing in its pending text", () => s5()],
  ["structs-cases B author reconnect", () => { const s = structsCasesB(); return { server: s.server, update: s.step2 }; }],
  ["structs-b2 author reconnect", () => { const s = structsB2(); return { server: s.server, update: s.step2 }; }],
  ["wouldpend-def S2 member deletes next to stored pendingDs", () => s2()],
];

/** C-48 inputs: the precheck must say "cannot pend" and build no skeleton. */
const precheckMisses: Array<[string, () => { server: Y.Doc; update: Uint8Array }]> = [
  ["(a) node created on a 20000-client document", () => {
    const server = manyClientDoc(20_000);
    const c = syncedClient(server, 7);
    const update = capture(c, () => {
      const n = new Y.Map<unknown>();
      c.getMap("nodes").set("n1", n);
      n.set("x", 1);
      n.set("y", 2);
    });
    return { server, update };
  }],
  ["(b) Enter in a Y.Text of the same document", () => {
    const server = manyClientDoc(20_000);
    const c = syncedClient(server, 7);
    return { server, update: capture(c, () => c.getText("t").insert(5, "\n")) };
  }],
  ["(c) the C-34 append", () => {
    const server = hello();
    return { server, update: client2(server, (t) => t.insert(t.length, "y".repeat(100))) };
  }],
  ["(d) an origin pointing at the same client's earlier clock in the update", () => {
    const server = new Y.Doc();
    const x = new Y.Doc();
    x.clientID = 41;
    x.getText("t").insert(0, "abc");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(x));
    x.getText("t").insert(3, "de");
    x.getText("t").insert(4, "Q");
    return { server, update: Y.encodeStateAsUpdate(x, Y.encodeStateVector(server)) };
  }],
];

describe("analyze: pending content (C-46 to C-50)", () => {
  it.each(pending)("C-46 %s: wouldPend and the replica agree it pends", (_name, build) => {
    const { server, update } = build();
    measuresRight(server);
    expect(refTruth(server, update)).toBe(true);
    expect(analyze(update, server).wouldPend).toBe(true);
  });

  it.each(notPending)("C-47 %s: wouldPend and the replica agree it does not pend", (_name, build) => {
    const { server, update } = build();
    measuresRight(server);
    expect(refTruth(server, update)).toBe(false);
    expect(analyze(update, server).wouldPend).toBe(false);
  });

  it.each(precheckMisses)("C-48 %s: precheck false, no skeleton", (_name, build) => {
    const { server, update } = build();
    measuresRight(server);
    expect(precheckMayPend(update, server.store)).toBe(false);
    expect(analyze(update, server).skeletonBuilt).toBe(false);
  });

  it.each([pending[0]!, pending[4]!, pending[5]!])("C-48 %s: precheck true, skeleton built", (_name, build) => {
    const { server, update } = build();
    expect(precheckMayPend(update, server.store)).toBe(true);
    expect(analyze(update, server).skeletonBuilt).toBe(true);
  });

  it("C-48 skeletonBuilt equals the precheck on every C-46 to C-48 input", () => {
    for (const [, build] of [...pending, ...notPending, ...precheckMisses]) {
      const { server, update } = build();
      expect(analyze(update, server).skeletonBuilt).toBe(precheckMayPend(update, server.store));
    }
  });

  const integrating: Array<[string, () => { server: Y.Doc; update: Uint8Array }]> = [
    ["S1", () => s1()],
    ["S5", () => s5()],
    ["structs-b2", () => { const s = structsB2(); return { server: s.server, update: s.step2 }; }],
    ["ds-adjacent author X reconnect (G21)", () => { const s = dsAdjacent(); return { server: s.server, update: s.authorStep2 }; }],
    ["stored-pending-integrate K = 2000 gap filler (G20)", () => { const s = storedPendingIntegrate(2000); return { server: s.server, update: s.filler }; }],
  ];
  it.each(integrating)("C-49 %s integrates stored pending content", (_name, build) => {
    const { server, update } = build();
    measuresRight(server);
    expect(refStoredReduced(server, update)).toBeGreaterThan(0);
    const a = analyze(update, server);
    expect(a.integratesStored).toBe(true);
    expect(a.wouldPend).toBe(false);
  });

  const notIntegrating: Array<[string, () => { server: Y.Doc; update: Uint8Array }]> = [
    ["C-33 echo", () => { const s = dsAdjacent(); return { server: s.server, update: s.echoStep2 }; }],
    ["ds-adjacent Z handshake", () => { const s = dsAdjacent(); return { server: s.server, update: s.zStep2 }; }],
    ["C-34 append", () => { const server = hello(); return { server, update: client2(server, (t) => t.insert(t.length, "y".repeat(100))) }; }],
  ];
  it.each(notIntegrating)("C-49 %s does not integrate stored pending content", (_name, build) => {
    const { server, update } = build();
    measuresRight(server);
    expect(refStoredReduced(server, update)).toBe(0);
    expect(analyze(update, server).integratesStored).toBe(false);
  });

  it("C-50 (a) Skip is not a struct but its encoding is in structBytes", () => {
    const { server, update } = skipGap();
    measuresRight(server);
    expect(Y.decodeUpdate(update).structs.map((s) => s.constructor.name)).toEqual(["Item", "Skip", "Item"]);
    const a = analyze(update, server);
    expect(a.structs).toBe(2);
    expect(a.structBytes).toBe(update.byteLength - refDsBytes(update));
  });

  // Spec C-50 (b) says applying (a) and reloading leaves a Skip in
  // pendingStructs. It does not (yjs re-encodes the one pending item alone),
  // so X's next transaction, whose predecessor was also lost, is applied too;
  // that leaves Item, Skip, Item in pendingStructs, the shape (b) is about.
  it("C-50 (b) measure counts pending structs without Skip", () => {
    const { server: s0, update, ups } = skipGap();
    Y.applyUpdate(s0, update);
    Y.applyUpdate(s0, ups[5]!);
    const d = reload(s0);
    const { p, pWithSkip } = pendingCounts(d);
    expect(pWithSkip).not.toBe(p);
    measuresRight(d);
    expect(measure(d)).toBe(Y.encodeStateAsUpdate(d).byteLength + C * p);
  });
});

describe("analyze: update shape", () => {
  /**
   * A server text "hello" and a 20-char insertion written by client 50, as
   * yjs encodes it.
   * @returns The server and the insertion's structs.
   */
  function insertion(): { server: Y.Doc; structs: Y.Item[] } {
    const server = hello();
    const writer = new Y.Doc();
    writer.clientID = 50;
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(server));
    const sv = Y.encodeStateVector(writer);
    writer.getText("t").insert(5, "x".repeat(20));
    return { server, structs: Y.decodeUpdate(Y.encodeStateAsUpdate(writer, sv)).structs as Y.Item[] };
  }

  it("marks an update listing one client in two groups as malformed (yjs keeps only the last)", () => {
    const { server, structs } = insertion();
    const junk = new Y.Item(Y.createID(50, 10_000_000), null, structs[0]!.origin, null, null, null, null, new Y.ContentString("z"));
    const twice = craft([{ client: 50, clock: 10_000_000, structs: [junk] }, { client: 50, clock: 0, structs }], [[50, [[0, 1], [2, 1]]]]);
    expect(analyze(twice, server).malformed).toBe(true);
    expect(precheckMayPend(twice, server.store)).toBe(true);
  });

  it("marks two groups of one client that continue each other's clocks as malformed", () => {
    const { server, structs } = insertion();
    const head = new Y.Item(Y.createID(50, 0), null, structs[0]!.origin, null, null, null, null, new Y.ContentString("a".repeat(20)));
    const tail = new Y.Item(Y.createID(50, 20), null, Y.createID(50, 19), null, null, null, null, new Y.ContentString("b"));
    const twice = craft([{ client: 50, clock: 0, structs: [head] }, { client: 50, clock: 20, structs: [tail] }]);
    expect(analyze(twice, server).malformed).toBe(true);
  });

  it("marks a group with no structs as malformed", () => {
    const { server, structs } = insertion();
    expect(analyze(craft([{ client: 50, clock: 0, structs: [] }, { client: 50, clock: 0, structs }]), server).malformed).toBe(true);
  });

  it("reads what yjs writes as well formed", () => {
    const { server, structs } = insertion();
    expect(analyze(craft([{ client: 50, clock: 0, structs }]), server).malformed).toBe(false);
    expect(analyze(Y.encodeStateAsUpdate(server), new Y.Doc()).malformed).toBe(false);
  });
});

describe("analyze: skeleton reporting and cost", () => {
  it("reports a skeleton built on the stored-pending path, which the C-48 flag leaves false", () => {
    const writer = new Y.Doc();
    writer.clientID = 5;
    writer.getText("t").insert(0, "hello world");
    const full = Y.encodeStateAsUpdate(writer);
    const before = Y.encodeStateVector(writer);
    writer.getText("t").delete(0, 5);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(writer, before));
    expect(server.store.pendingDs).not.toBeNull();
    const a = analyze(full, server);
    expect(a.skeletonBuilt).toBe(false);
    expect(a.integratesStored).toBe(true);
    expect(a.skeletonRan).toBe(true);
  });

  it("reports no skeleton for an ordinary edit", () => {
    const server = new Y.Doc();
    server.getText("t").insert(0, "hello");
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const sv = Y.encodeStateVector(client);
    client.getText("t").insert(5, "!");
    expect(analyze(Y.encodeStateAsUpdate(client, sv), server).skeletonRan).toBe(false);
  });

  /**
   * Analyze time at size 4n over size n, each the best of three runs taken in
   * turn: about 4 when it grows linearly, 16 or more when quadratically.
   * @param build - Builds the server document and the update for a size.
   * @param n - The smaller size.
   * @returns The ratio.
   */
  function growth(build: (size: number) => { server: Y.Doc; update: Uint8Array }, n: number): number {
    const small = build(n);
    const large = build(4 * n);
    let bestSmall = Number.POSITIVE_INFINITY;
    let bestLarge = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      analyze(small.update, small.server);
      bestSmall = Math.min(bestSmall, performance.now() - started);
      started = performance.now();
      analyze(large.update, large.server);
      bestLarge = Math.min(bestLarge, performance.now() - started);
    }
    return bestLarge / Math.max(0.5, bestSmall);
  }

  it("stays near linear on one update that inserts many blocks after each other", () => {
    const blocks = (count: number): { server: Y.Doc; update: Uint8Array } => {
      const server = new Y.Doc();
      server.getXmlFragment("document-store").insert(0, [new Y.XmlElement("p")]);
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
      const sv = Y.encodeStateVector(client);
      const fragment = client.getXmlFragment("document-store");
      client.transact(() => {
        const elements = Array.from({ length: count }, () => new Y.XmlElement("paragraph"));
        fragment.insert(1, elements);
        for (const element of elements) element.insert(0, [new Y.XmlText("hello world")]);
      });
      return { server, update: Y.encodeStateAsUpdate(client, sv) };
    };
    expect(growth(blocks, 1000)).toBeLessThan(10);
  });

  it("stays near linear on one update that deletes many of its own insertions", () => {
    const own = (count: number): { server: Y.Doc; update: Uint8Array } => {
      const server = new Y.Doc();
      const client = new Y.Doc();
      const sv = Y.encodeStateVector(client);
      const map = client.getMap("m");
      client.transact(() => {
        for (let i = 0; i < count; i++) map.set(`k${i}`, i);
        for (let i = 0; i < count; i += 2) map.delete(`k${i}`);
      });
      return { server, update: Y.encodeStateAsUpdate(client, sv) };
    };
    expect(growth(own, 5000)).toBeLessThan(10);
  });

  it("stays near linear when deleting a type with many children alongside many ranges", () => {
    const cascade = (count: number): { server: Y.Doc; update: Uint8Array } => {
      const server = new Y.Doc();
      server.clientID = 5;
      const inner = new Y.Map<unknown>();
      server.getMap("root").set("big", inner);
      server.transact(() => {
        for (let i = 0; i < count; i++) inner.set(`k${i}`, i);
      });
      server.transact(() => {
        for (let i = 0; i < count; i++) inner.set(`k${i}`, -i);
      });
      // The type at clock 0, plus a one-clock range over every other overwritten child.
      const ranges: Array<[number, number]> = [[0, 1]];
      for (let clock = 2; clock < count; clock += 2) ranges.push([clock, 1]);
      return { server, update: deleteOnly([[5, ranges]]) };
    };
    expect(growth(cascade, 2500)).toBeLessThan(10);
  });

  it("stays near linear when one update writes the same map key over a type with many children", () => {
    const sameKey = (count: number): { server: Y.Doc; update: Uint8Array } => {
      const server = new Y.Doc();
      const list = new Y.Array<number>();
      server.getMap("m").set("x", list);
      // One insert each at the front, so every child is its own item.
      for (let i = 0; i < count; i++) list.insert(0, [i]);
      const current = server.getMap("m")._map.get("x")!;
      const structs = Array.from({ length: count }, (_, i) =>
        new Y.Item(Y.createID(777, i), null, i === 0 ? current.id : Y.createID(777, i - 1), null, null, null, null, new Y.ContentAny([i])));
      return { server, update: craft([{ client: 777, clock: 0, structs }]) };
    };
    expect(growth(sameKey, 2000)).toBeLessThan(10);
  });

  it("resolves a chain anchored on a GC struct about as fast as a chain anchored on a live item", () => {
    const count = 20_000;
    const server = new Y.Doc();
    server.getArray("a").insert(0, [0]);
    const seed = server.getArray("a")._start!;
    /**
     * A same-client chain of `count` items after a first struct.
     * @param first - The chain's first struct.
     * @returns The update.
     */
    const chain = (first: Y.Item | Y.GC): Uint8Array => craft([{
      client: 7,
      clock: 0,
      structs: [first, ...Array.from({ length: count }, (_, i) =>
        new Y.Item(Y.createID(7, i + 1), null, Y.createID(7, i), null, null, null, null, new Y.ContentAny([0])))],
    }]);
    const live = chain(new Y.Item(Y.createID(7, 0), null, seed.id, null, null, null, null, new Y.ContentAny([0])));
    const gcRooted = chain(new Y.GC(Y.createID(7, 0), 1));
    let bestLive = Number.POSITIVE_INFINITY;
    let bestGc = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      analyze(live, server);
      bestLive = Math.min(bestLive, performance.now() - started);
      started = performance.now();
      analyze(gcRooted, server);
      bestGc = Math.min(bestGc, performance.now() - started);
    }
    expect(bestGc / Math.max(0.5, bestLive)).toBeLessThan(3);
  });
});
