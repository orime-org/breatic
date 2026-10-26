// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import fc from "fast-check";

import {
  assertBodySourceBoundary,
  BODY_REGISTRATION_ORIGIN,
  documentBodyRecords,
  documentBodySource,
  DocumentBodyFormatError,
  readDocumentBodyRecords,
  registerBodyCut,
  registerDocumentBodyRecords,
  seedDocumentBodyRecords,
} from "@shared/document-body-records.js";
import type {
  BodyFact,
  BodyJsonObject,
  BodyRecord,
  BodyRegistration,
} from "@shared/document-body-records-types.js";

const documents: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];

const RECORDS: readonly BodyRecord[] = [
  { id: "root", kind: "root", attrs: {} },
  { id: "group", kind: "container", type: "blockGroup", attrs: {}, parent: "root", order: "a" },
  {
    id: "block", kind: "owner", type: "paragraph", attrs: { textAlignment: "left" },
    wrapperAttrs: { id: "block" }, parent: "group", order: "a", facet: "facet", base: true,
  },
  { id: "facet", kind: "facet", owner: "block", parent: "block", order: "a" },
];

afterEach(() => {
  for (const history of histories.splice(0)) history.destroy();
  for (const doc of documents.splice(0)) doc.destroy();
});

/** Allocates a finite native document for a protocol case. @throws {never} */
function fresh(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  return doc;
}

/** Publishes a test fixture through the production registration boundary. @throws {DocumentBodyFormatError} On an invalid descriptor. */
function body(): Y.Doc {
  const doc = fresh();
  registerDocumentBodyRecords(doc, {
    records: RECORDS,
    sources: [{ id: "source", facet: "facet", head: "head", tail: "tail" }],
    contexts: [{ id: "base", dependencies: [] }],
  });
  const { metadata } = documentBodyRecords(doc);
  doc.transact(() => {
    metadata.set("format", "breatic.document.records");
    metadata.set("version", 1);
    metadata.set("seedRoot", "root");
  }, BODY_REGISTRATION_ORIGIN);
  return doc;
}

/** Registers one complete user fact group for decoder tests. @throws {DocumentBodyFormatError} On an invalid registration. */
function registerFact(doc: Y.Doc, fact: BodyFact): void {
  registerDocumentBodyRecords(doc, {
    facts: [fact],
    groups: [{ id: fact.group, facts: [fact.id], history: "user" }],
  });
}

describe("document body descriptor registration", () => {
  it("keeps uninitialized documents distinguishable from prepared records", () => {
    expect(readDocumentBodyRecords(fresh())).toEqual({ status: "uninitialized" });
  });

  it("registers complete roots, sources and immutable descriptions", () => {
    const doc = body();
    const result = readDocumentBodyRecords(doc);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected prepared fixture");
    expect(result.body.metadata).toEqual({ format: "breatic.document.records", version: 1, seedRoot: "root" });
    expect([...result.body.records.values()]).toEqual(RECORDS);
    expect([...result.body.sources.values()]).toEqual([{ id: "source", facet: "facet", head: "head", tail: "tail" }]);
    expect([...result.body.contexts.values()]).toEqual([{ id: "base", dependencies: [] }]);
    expect([...result.body.enabled]).toEqual([]);
    expect(documentBodySource(doc, "source").toDelta()).toEqual([
      { insert: { bodyCut: "head" } },
      { insert: { bodyCut: "tail" } },
    ]);
  });

  it("registers an identical descriptor without another native update or history item", () => {
    const doc = body();
    const history = new Y.UndoManager(doc, { trackedOrigins: new Set(["user"]) });
    histories.push(history);
    const before = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update) => updates.push(update));

    registerDocumentBodyRecords(doc, { records: RECORDS, sources: [{ id: "source", facet: "facet", head: "head", tail: "tail" }] });

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).toEqual([]);
    expect(history.undoStack).toEqual([]);
  });

  it("canonicalizes nested JSON and treats key insertion order as one description", () => {
    const doc = fresh();
    registerDocumentBodyRecords(doc, { records: [{ id: "root", kind: "root", attrs: { z: [{ y: 2, a: 1 }], a: true } }] });
    const stored = documentBodyRecords(doc).records.get("root");
    expect(stored).toBe('{"attrs":{"a":true,"z":[{"a":1,"y":2}]},"id":"root","kind":"root"}');
    const before = Y.encodeStateAsUpdate(doc);
    registerDocumentBodyRecords(doc, { records: [{ kind: "root", attrs: { a: true, z: [{ a: 1, y: 2 }] }, id: "root" }] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each<readonly [string, BodyRegistration]>([
    ["record", { records: [{ id: "root", kind: "root", attrs: { changed: true } }] }],
    ["source", { sources: [{ id: "source", facet: "different", head: "head", tail: "tail" }] }],
    ["context", { contexts: [{ id: "base", dependencies: ["different"] }] }],
  ])("rejects a conflicting %s before registering any new descriptor", (_name, conflict) => {
    const doc = body();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => registerDocumentBodyRecords(doc, {
      ...conflict,
      groups: [{ id: "new-group", facts: [], history: "user" }],
    })).toThrow(DocumentBodyFormatError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect([...documentBodyRecords(doc).groups.keys()]).toEqual([]);
  });

  it("rejects conflicts within one registration before its first write", () => {
    const doc = fresh();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => registerDocumentBodyRecords(doc, { records: [RECORDS[0]!, { id: "root", kind: "root", attrs: { changed: true } }] })).toThrow(DocumentBodyFormatError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each<BodyFact>([
    { id: "birth", kind: "birth", group: "g", dependencies: [], owner: "block" },
    { id: "structure", kind: "structure", group: "g", dependencies: [], edges: [{ child: "facet", parent: "block", counter: 1, order: "b" }] },
    { id: "attribute", kind: "attribute", group: "g", dependencies: [], owner: "block", name: "level", value: 4, counter: 1 },
    { id: "type", kind: "nodeKind", group: "g", dependencies: [], owner: "block", value: "heading", counter: 1 },
    { id: "mark", kind: "mark", group: "g", dependencies: [], payload: { type: "link", attrs: { href: "https://example.com" } } },
    { id: "delete", kind: "delete", group: "g", dependencies: [], owner: "block" },
  ])("decodes the $kind fact with its exact payload", (fact) => {
    const doc = body();
    registerFact(doc, fact);
    const result = readDocumentBodyRecords(doc);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected prepared fixture");
    expect(result.body.facts.get(fact.id)).toEqual(fact);
    expect(result.body.groups.get("g")).toEqual({ id: "g", facts: [fact.id], history: "user" });
  });

  it.each([
    ["unknown kind", { id: "bad", kind: "other" }],
    ["invalid owner attributes", { ...RECORDS[2], id: "bad", attrs: null }],
    ["invalid parent", { ...RECORDS[1], id: "bad", parent: 7 }],
  ])("rejects %s in the stored records boundary", (_name, invalid) => {
    const doc = body();
    documentBodyRecords(doc).records.set("bad", JSON.stringify(invalid));
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => readDocumentBodyRecords(doc)).toThrow(DocumentBodyFormatError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("rejects invalid JSON and unsupported format versions explicitly", () => {
    const doc = body();
    const roots = documentBodyRecords(doc);
    roots.records.set("bad", "{");
    expect(() => readDocumentBodyRecords(doc)).toThrow(DocumentBodyFormatError);
    roots.records.delete("bad");
    roots.metadata.set("version", 2);
    expect(() => readDocumentBodyRecords(doc)).toThrow(DocumentBodyFormatError);
    roots.metadata.set("version", 1);
    roots.metadata.set("format", "other-format");
    expect(() => readDocumentBodyRecords(doc)).toThrow(DocumentBodyFormatError);
  });

  it("keeps unfamiliar product node names and payloads in a valid descriptor", () => {
    const doc = body();
    const payload = { original: { nested: ["text", { marks: { future: [1, 2, 3] } }] } };
    registerDocumentBodyRecords(doc, { records: [{ id: "future", kind: "container", type: "futurePanel", attrs: payload, parent: "group", order: "b" }] });
    const result = readDocumentBodyRecords(doc);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected prepared fixture");
    expect(result.body.records.get("future")).toEqual({ id: "future", kind: "container", type: "futurePanel", attrs: payload, parent: "group", order: "b" });
  });

  it("reports missing structural facts by identity and becomes ready when they arrive", () => {
    const doc = body();
    registerDocumentBodyRecords(doc, { contexts: [{ id: "peer-context", dependencies: ["late-structure"] }] });
    expect(readDocumentBodyRecords(doc)).toEqual({ status: "pending", missing: ["fact:late-structure"] });

    registerFact(doc, { id: "late-structure", kind: "structure", group: "late-group", dependencies: [], edges: [{ child: "facet", parent: "block", counter: 1, order: "a" }] });

    expect(readDocumentBodyRecords(doc).status).toBe("ready");
  });

  it("reports a missing source cut without altering shared data", () => {
    const doc = body();
    documentBodySource(doc, "source").delete(1, 1);
    const before = Y.encodeStateAsUpdate(doc);
    expect(readDocumentBodyRecords(doc)).toEqual({ status: "pending", missing: ["cut:tail"] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reads the same complete records without a native update", () => {
    const doc = body();
    const before = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update) => updates.push(update));
    const first = readDocumentBodyRecords(doc);
    const second = readDocumentBodyRecords(doc);
    expect(second).toEqual(first);
    expect(first.status).toBe("ready");
    expect(updates).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("gives reordered JSON fields identical registrations across generated inputs", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.tuple(fc.string(), fc.integer()), { maxLength: 12, selector: ([key]) => key }),
      (entries) => {
        const doc = new Y.Doc();
        try {
          const attrs: BodyJsonObject = Object.fromEntries(entries);
          const reversed: BodyJsonObject = Object.fromEntries([...entries].reverse());
          registerDocumentBodyRecords(doc, { records: [{ id: "root", kind: "root", attrs }] });
          const before = Y.encodeStateAsUpdate(doc);
          registerDocumentBodyRecords(doc, { records: [{ id: "root", kind: "root", attrs: reversed }] });
          expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
        } finally {
          doc.destroy();
        }
      },
    ), { numRuns: 100, seed: 161926 });
  });
});

describe("native body source cuts", () => {
  it("registers a scalar-safe cut while retaining the native character identities", () => {
    const doc = body();
    const text = documentBodySource(doc, "source");
    text.insert(1, "A😀B", { ctx: "base" });
    const before = [1, 2, 3, 4].map((index) => Y.createRelativePositionFromTypeIndex(text, index).item);
    registerBodyCut(doc, "source", "middle", 4);
    expect(text.toDelta()).toEqual([
      { insert: { bodyCut: "head" } },
      { insert: "A😀", attributes: { ctx: "base" } },
      { insert: { bodyCut: "middle" } },
      { insert: "B", attributes: { ctx: "base" } },
      { insert: { bodyCut: "tail" } },
    ]);
    expect([1, 2, 3, 5].map((index) => Y.createRelativePositionFromTypeIndex(text, index).item)).toEqual(before);
    const registered = Y.encodeStateAsUpdate(doc);
    registerBodyCut(doc, "source", "middle", 4);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(registered);
  });

  it("rejects a half-surrogate cut before its native mutation", () => {
    const doc = body();
    const text = documentBodySource(doc, "source");
    text.insert(1, "A😀B");
    const before = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update) => updates.push(update));
    expect(() => registerBodyCut(doc, "source", "invalid", 3)).toThrow(DocumentBodyFormatError);
    expect(() => assertBodySourceBoundary(text, 3)).toThrow(DocumentBodyFormatError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).toEqual([]);
    for (const index of [1, 2, 4, 5]) expect(() => assertBodySourceBoundary(text, index)).not.toThrow();
  });

  it("rejects cuts outside the permanent source boundaries", () => {
    const doc = body();
    const text = documentBodySource(doc, "source");
    const before = Y.encodeStateAsUpdate(doc);
    for (const index of [-1, 0, text.length, text.length + 1]) {
      expect(() => registerBodyCut(doc, "source", `invalid-${index}`, index)).toThrow(DocumentBodyFormatError);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("seeds a complete paragraph using the caller's stable identity and attributes", () => {
    const doc = fresh();
    seedDocumentBodyRecords(doc, "paragraph-id", { backgroundColor: "default", textColor: "default", textAlignment: "left", quoted: false });
    const result = readDocumentBodyRecords(doc);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected prepared seed");
    const owner = result.body.records.get("paragraph-id");
    expect(owner).toEqual(expect.objectContaining({ kind: "owner", type: "paragraph", base: true, wrapperAttrs: { id: "paragraph-id" }, attrs: { backgroundColor: "default", textColor: "default", textAlignment: "left", quoted: false } }));
    expect([...result.body.sources.values()]).toHaveLength(1);
    expect([...result.body.records.values()].map((record) => record.kind).sort()).toEqual(["container", "facet", "owner", "root"]);
  });
});
