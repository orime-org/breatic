// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { documentBodyRecords, documentBodySource, registerBodyCut, registerDocumentBodyRecords } from "@shared/document-body-records.js";
import type { BodyFact, BodyParentEdge, BodyRecord } from "@shared/document-body-records-types.js";
import {
  bodyTreeDependencies,
  bodyTreeSourcePoint,
  planBodyJoin,
  planBodyRangeMove,
  planBodyReparent,
  planBodySplit,
  readBodyTree,
  type BodyTreeView,
} from "@shared/document-body-tree.js";

const USER = Symbol("test-user");
const docs: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];
let sequence = 0;

afterEach(() => {
  for (const history of histories.splice(0)) history.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
});

/** Creates a native test peer with independently specified base records. @throws {Error} If a fixture is invalid. */
function fixture(words: Readonly<Record<string, string>> = { A: "ABCDEF", B: "xyz" }): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  const records: BodyRecord[] = [
    { id: "root", kind: "root", attrs: {} },
    { id: "group", kind: "container", type: "blockGroup", attrs: {}, parent: "root", order: "a" },
  ];
  const ids = [...new Set([...Object.keys(words), "H", "K"])];
  for (const [index, id] of ids.entries()) {
    records.push({ id, kind: "owner", type: "paragraph", attrs: {}, wrapperAttrs: { id }, parent: "group", order: String.fromCharCode(65 + index), facet: `F:${id}`, base: Object.hasOwn(words, id) });
    records.push({ id: `F:${id}`, kind: "facet", owner: id, parent: id, order: "z" });
  }
  registerDocumentBodyRecords(doc, {
    records,
    sources: ids.map((id) => ({ id: `S:${id}`, facet: `F:${id}`, head: `head:${id}`, tail: `tail:${id}` })),
    contexts: [{ id: "base", dependencies: [] }],
  });
  const { metadata } = documentBodyRecords(doc);
  metadata.set("format", "breatic.document.records");
  metadata.set("version", 1);
  metadata.set("seedRoot", "root");
  for (const [id, text] of Object.entries(words)) {
    if (text !== "") documentBodySource(doc, `S:${id}`).insert(1, text, { ctx: "base" });
  }
  return doc;
}

/** Reads the production projection and requires complete dependencies. @throws {Error} If the fixture is incomplete. */
function view(doc: Y.Doc): BodyTreeView {
  const result = readBodyTree(doc);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected a complete body tree");
  return result.view;
}

/** Reads exact visible owner text without using the production operation planner. @throws {Error} If projection fails. */
function texts(doc: Y.Doc): Record<string, string> {
  return Object.fromEntries(view(doc).owners.map((owner) => [owner.id, owner.units.map((unit) => typeof unit.value === "string" ? unit.value : "<inline>").join("")]));
}

/** Adds a permanent cut while proving registration has zero projection effect. @throws {Error} If the point is invalid. */
function cut(doc: Y.Doc, owner: string, offset: number): string {
  const before = view(doc);
  const point = bodyTreeSourcePoint(before, owner, offset);
  if (point === null) throw new Error("The test cut requires an existing text source");
  const id = `test-cut:${sequence++}`;
  registerBodyCut(doc, point.source, id, point.index);
  expect(view(doc).owners.map((entry) => [entry.id, entry.units.map((unit) => unit.id)])).toEqual(before.owners.map((entry) => [entry.id, entry.units.map((unit) => unit.id)]));
  return id;
}

/** Commits the tested pure plan as one real native history operation. @throws {Error} If registration is invalid. */
function apply(doc: Y.Doc, edges: readonly BodyParentEdge[], births: readonly string[] = []): string {
  const group = `test-group:${doc.clientID}:${sequence++}`;
  const structure = `${group}:structure`;
  const facts: BodyFact[] = [
    { id: structure, kind: "structure", group, dependencies: [], edges },
    ...births.map((owner, index) => ({ id: `${group}:birth:${index}`, kind: "birth" as const, group, dependencies: [], owner })),
  ];
  registerDocumentBodyRecords(doc, { facts, groups: [{ id: group, facts: facts.map((fact) => fact.id), history: "user" }] });
  doc.transact(() => documentBodyRecords(doc).enabled.set(group, true), USER);
  return structure;
}

/** Creates native user history after the shared fixture exists. @throws {never} */
function history(doc: Y.Doc): Y.UndoManager {
  const manager = new Y.UndoManager(doc, { trackedOrigins: new Set([USER]), captureTimeout: 0 });
  histories.push(manager);
  return manager;
}

describe("body structure plans and native history", () => {
  it("reads base owners and permanent source identities without publishing repairs", () => {
    const doc = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update) => updates.push(update));

    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    const first = view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id));
    expect(new Set(first).size).toBe(9);
    expect(view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id))).toEqual(first);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).toEqual([]);
  });

  it("splits and joins original text through two undo and redo operations", () => {
    const doc = fixture();
    const manager = history(doc);
    const original = view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id));
    const boundary = cut(doc, "A", 2);
    apply(doc, planBodySplit(view(doc), "A", boundary, "H", "split"), ["H"]);
    expect(texts(doc)).toEqual({ A: "AB", B: "xyz", H: "CDEF" });
    const end = cut(doc, "A", 2);
    apply(doc, planBodyJoin(view(doc), "A", "H", end, "join"));
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    manager.undo();
    expect(texts(doc)).toEqual({ A: "AB", B: "xyz", H: "CDEF" });
    manager.undo();
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    manager.redo();
    expect(texts(doc)).toEqual({ A: "AB", B: "xyz", H: "CDEF" });
    manager.redo();
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    expect(view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id))).toEqual(original);
  });

  it("moves precisely the selected range and leaves its original suffix", () => {
    const doc = fixture();
    const manager = history(doc);
    const original = view(doc).owners.map((owner) => [owner.id, owner.units.map((unit) => unit.id)]);
    const start = cut(doc, "A", 1);
    const end = cut(doc, "A", 4);
    const target = cut(doc, "B", 1);
    apply(doc, planBodyRangeMove(view(doc), "A", start, end, "B", target, "range"));

    expect(texts(doc)).toEqual({ A: "AEF", B: "xBCDyz" });
    manager.undo();
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    expect(view(doc).owners.map((owner) => [owner.id, owner.units.map((unit) => unit.id)])).toEqual(original);
    manager.redo();
    expect(texts(doc)).toEqual({ A: "AEF", B: "xBCDyz" });
  });

  it("reparents a complete block without copying its native source", () => {
    const doc = fixture();
    const manager = history(doc);
    const before = view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id));
    apply(doc, planBodyReparent(view(doc), [{ child: "B", parent: "A" }], "nest"));

    expect(view(doc).tree.parents.get("B")).toBe("A");
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
    expect(view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id))).toEqual(before);
    manager.undo();
    expect(view(doc).tree.parents.get("B")).toBe("group");
    expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
  });

  it("retains the entire moved effect for late peer input and releases it on peer undo", () => {
    const author = fixture();
    const authorHistory = history(author);
    const start = cut(author, "A", 1);
    const end = cut(author, "A", 4);
    const target = cut(author, "B", 1);
    const structure = apply(author, planBodyRangeMove(view(author), "A", start, end, "B", target, "range"));
    const peer = new Y.Doc();
    docs.push(peer);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author));
    const peerHistory = history(peer);
    const point = bodyTreeSourcePoint(view(peer), "B", 3)!;
    const token = view(peer).owners.find((owner) => owner.id === "B")!.units[3]!;
    const dependencies = bodyTreeDependencies(view(peer), token.piece);
    expect(dependencies).toContain(structure);
    registerDocumentBodyRecords(peer, { contexts: [{ id: "peer-input", dependencies }] });
    peer.transact(() => documentBodySource(peer, point.source).insert(point.index, "_", { ctx: "peer-input" }), USER);
    authorHistory.undo();
    Y.applyUpdate(author, Y.encodeStateAsUpdate(peer), "peer");

    expect(texts(author)).toEqual({ A: "AEF", B: "xBC_Dyz" });
    peerHistory.undo();
    Y.applyUpdate(author, Y.encodeStateAsUpdate(peer), "peer");
    expect(texts(author)).toEqual({ A: "ABCDEF", B: "xyz" });
    peerHistory.redo();
    Y.applyUpdate(author, Y.encodeStateAsUpdate(peer), "peer");
    expect(texts(author)).toEqual({ A: "AEF", B: "xBC_Dyz" });
  });

  it("keeps native order unchanged through generated cut refinements", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 20 }), (offsets) => {
      const doc = fixture();
      const initial = view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id));
      for (const offset of offsets) cut(doc, "A", offset);
      expect(texts(doc)).toEqual({ A: "ABCDEF", B: "xyz" });
      expect(view(doc).owners.flatMap((owner) => owner.units.map((unit) => unit.id))).toEqual(initial);
      docs.splice(docs.indexOf(doc), 1);
      doc.destroy();
    }), { numRuns: 100 });
  });
});
