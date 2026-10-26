// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import fc from "fast-check";

import { importCurrentDocumentBody } from "@shared/document-body-import.js";
import { documentBodyFragment, documentCommentThreads, encodeInitialSpaceContent } from "@shared/document-body.js";
import { BODY_MARK_ATTRIBUTE_PREFIX, bodyCutId, documentBodyRecords, documentBodySource, DocumentBodyFormatError, registerDocumentBodyRecords } from "@shared/document-body-records.js";
import { readBodyTree, type BodyTreeUnit, type BodyTreeView } from "@shared/document-body-tree.js";
import type { BodyJsonObject } from "@shared/document-body-records-types.js";
import {
  IMPORT_LIST_ID, IMPORT_PARAGRAPH_ID, IMPORT_TABLE_ID,
  importBlock, importElement, importFixture, importLayoutTable, importLegacyTable, importText, importXmlSnapshot,
} from "@shared/__tests__/document-body-import-fixtures.js";

const documents: Y.Doc[] = [];
const NAME = "project-import/document-current";

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
});

/**
 * Retains one real test document for deterministic cleanup.
 * @param doc - The test-owned document.
 * @returns The same native document.
 * @throws {never}
 */
function keep(doc: Y.Doc): Y.Doc {
  documents.push(doc);
  return doc;
}

/**
 * Opens exactly the same stored bytes as an independent loading attempt.
 * @param bytes - The original stored update.
 * @returns A native loading document with independent local client identity.
 * @throws {Error} If Yjs cannot decode the stored fixture.
 */
function open(bytes: Uint8Array): Y.Doc {
  const doc = keep(new Y.Doc({ gc: false }));
  Y.applyUpdate(doc, bytes);
  return doc;
}

/**
 * Reads the production tree, requiring every actual dependency to be present.
 * @param doc - The prepared native document.
 * @returns The complete production tree frame.
 * @throws {Error} If the importer has not produced a complete format.
 */
function tree(doc: Y.Doc): BodyTreeView {
  const result = readBodyTree(doc);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected complete imported records");
  return result.view;
}

/**
 * Reads actual mark references without asking the importer to construct expected payloads.
 * @param view - The complete decoded frame.
 * @param unit - The original inline unit being inspected.
 * @returns Original semantic mark names and their complete attributes.
 * @throws {Error} If a native mark has no valid registered payload.
 */
function marks(view: BodyTreeView, unit: BodyTreeUnit): readonly unknown[] {
  return Object.entries(unit.attributes).filter(([key]) => key.startsWith(BODY_MARK_ATTRIBUTE_PREFIX)).map(([, value]) => {
    if (typeof value !== "object" || value === null || !("factId" in value) || typeof value.factId !== "string") throw new Error("Expected an explicit native mark instance");
    const fact = view.body.facts.get(value.factId);
    if (fact?.kind !== "mark") throw new Error("Expected complete mark payload");
    return fact.payload;
  }).sort((first, second) => first.type.localeCompare(second.type) || JSON.stringify(first.attrs).localeCompare(JSON.stringify(second.attrs)));
}

/**
 * Checks source and facet reciprocity, permanent cuts, contexts and unique native units.
 * @param doc - The prepared native document.
 * @param view - The independently decoded production frame.
 * @throws {Error} If a required source run lacks attributes.
 */
function assertCompleteSources(doc: Y.Doc, view: BodyTreeView): void {
  for (const owner of view.owners) {
    const record = view.body.records.get(owner.id);
    expect(record).toMatchObject({ kind: "owner", base: true, facet: owner.facet });
    expect(view.body.records.get(owner.facet)).toMatchObject({ kind: "facet", owner: owner.id, parent: owner.id });
    const sources = [...view.body.sources.values()].filter((source) => source.facet === owner.facet);
    expect(sources).toHaveLength(1);
    const source = sources[0]!;
    const delta = documentBodySource(doc, source.id).toDelta();
    expect(bodyCutId(delta[0]!.insert)).toBe(source.head);
    expect(bodyCutId(delta.at(-1)!.insert)).toBe(source.tail);
    expect(documentBodySource(doc, source.id).length).toBe(owner.units.length + 2);
    for (const unit of owner.units) {
      const context = unit.attributes["ctx"];
      expect(typeof context).toBe("string");
      if (typeof context !== "string") throw new Error("Expected original source context");
      expect(view.body.contexts.get(context)).toMatchObject({ dependencies: [] });
    }
  }
  const identities = view.owners.flatMap((owner) => owner.units.map((unit) => unit.id));
  expect(new Set(identities).size).toBe(identities.length);
}

describe("current stored XML snapshot import", () => {
  it("imports exact current text attrs marks and published threads while retaining original XML identities", () => {
    const doc = keep(importFixture());
    const original = importXmlSnapshot(documentBodyFragment(doc));
    const comments = documentCommentThreads(doc).toJSON();
    expect(importCurrentDocumentBody(doc, NAME)).toEqual({ status: "ready", changed: true });
    const view = tree(doc);

    expect(view.body.metadata).toEqual({ format: "breatic.document.records", version: 1, seedRoot: view.root });
    expect(view.owners.map((owner) => ({ id: owner.id, type: owner.type, attrs: owner.attrs, text: owner.units.map((unit) => unit.value).join("") }))).toEqual([
      { id: IMPORT_PARAGRAPH_ID, type: "paragraph", attrs: { textAlignment: "center", textColor: "blue", quoted: true }, text: "A😀e\u0301B" },
      { id: IMPORT_LIST_ID, type: "bulletListItem", attrs: {}, text: "CD" },
    ]);
    const first = view.owners[0]!;
    expect(first.wrapperAttrs).toEqual({ id: IMPORT_PARAGRAPH_ID });
    expect(first.units.map((unit) => unit.value)).toEqual(["A", "\ud83d", "\ude00", "e", "\u0301", "B"]);
    for (const unit of first.units) expect(marks(view, unit)).toEqual([
      { type: "bold", attrs: {} }, { type: "comment", attrs: { threadId: "thread-one", orphan: false } }, { type: "link", attrs: { href: "https://example.com/original" } },
    ]);
    assertCompleteSources(doc, view);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(original);
    expect(documentCommentThreads(doc).toJSON()).toEqual(comments);
  });

  it("returns complete records as authoritative without updating or rereading stale XML", () => {
    const doc = open(encodeInitialSpaceContent("document"));
    const initial = tree(doc);
    const source = [...initial.body.sources.values()][0]!;
    registerDocumentBodyRecords(doc, {
      contexts: [{ id: "current", dependencies: [] }],
      facts: [{ id: "bold-current", kind: "mark", group: "current-marks", dependencies: [], payload: { type: "bold", attrs: {} } }],
      groups: [{ id: "current-marks", facts: ["bold-current"], history: "user" }],
    });
    documentBodySource(doc, source.id).insert(1, "AB", { ctx: "current", "mark:bold": { factId: "bold-current" } });
    documentCommentThreads(doc).set("current-thread", { text: "Keep me", replies: ["reply"] });
    const before = Y.encodeStateAsUpdate(doc);
    const oldXml = importXmlSnapshot(documentBodyFragment(doc));
    let updates = 0;
    doc.on("update", () => { updates += 1; });

    expect(importCurrentDocumentBody(doc, NAME)).toEqual({ status: "ready", changed: false });
    expect(importCurrentDocumentBody(doc, NAME)).toEqual({ status: "ready", changed: false });
    expect(tree(doc).owners[0]!.units.map((unit) => unit.value).join("")).toBe("AB");
    expect(tree(doc).body.facts.get("bold-current")).toEqual({ id: "bold-current", kind: "mark", group: "current-marks", dependencies: [], payload: { type: "bold", attrs: {} } });
    expect(documentCommentThreads(doc).get("current-thread")).toEqual({ text: "Keep me", replies: ["reply"] });
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(oldXml);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("publishes format only in frames whose complete dependencies are already readable", () => {
    const doc = keep(importFixture());
    const peer = open(Y.encodeStateAsUpdate(doc));
    let published = 0;
    doc.on("update", (update: Uint8Array) => {
      Y.applyUpdate(peer, update);
      if (documentBodyRecords(peer).metadata.get("format") !== "breatic.document.records") return;
      const frame = tree(peer);
      expect(frame.owners.map((owner) => owner.units.map((unit) => unit.value).join(""))).toEqual(["A😀e\u0301B", "CD"]);
      assertCompleteSources(peer, frame);
      published += 1;
    });
    importCurrentDocumentBody(doc, NAME);
    expect(published).toBeGreaterThan(0);
    expect(tree(peer).owners.map((owner) => owner.units.map((unit) => unit.id))).toEqual(tree(doc).owners.map((owner) => owner.units.map((unit) => unit.id)));
    expect(Y.encodeStateAsUpdate(peer)).toEqual(Y.encodeStateAsUpdate(doc));
  });

  it("preserves unknown nodes attrs nested blocks inline payloads and unknown marks", () => {
    const unknownAttrs = JSON.parse('{"__proto__":{"retained":true},"config":{"items":[1,null,"future"]}}') as BodyJsonObject;
    const doc = keep(importFixture([importBlock(IMPORT_PARAGRAPH_ID, "futurePanel", [importText("OPAQUE", { futureTone: unknownAttrs })], unknownAttrs, [
      importBlock(IMPORT_LIST_ID, "paragraph", [importText("A"), importElement("futureChip", { config: { values: [1, false, null] }, label: "original" }), importText("B")]),
    ])]));
    const original = importXmlSnapshot(documentBodyFragment(doc));
    const comments = documentCommentThreads(doc).toJSON();
    importCurrentDocumentBody(doc, NAME);
    const view = tree(doc);
    expect(view.owners.map((owner) => [owner.id, owner.type])).toEqual([[IMPORT_PARAGRAPH_ID, "futurePanel"], [IMPORT_LIST_ID, "paragraph"]]);
    expect(view.owners[0]!.attrs).toEqual(unknownAttrs);
    expect(Object.hasOwn(view.owners[0]!.attrs, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(view.owners[0]!.attrs)).toBe(Object.prototype);
    expect(view.owners[0]!.units.map((unit) => unit.value).join("")).toBe("OPAQUE");
    expect(marks(view, view.owners[0]!.units[0]!)).toEqual([{ type: "futureTone", attrs: unknownAttrs }]);
    expect(view.owners[1]!.units.map((unit) => unit.value)).toEqual(["A", { bodyInline: { type: "futureChip", attrs: { config: { values: [1, false, null] }, label: "original" } } }, "B"]);
    const nestedParent = view.tree.parents.get(IMPORT_LIST_ID)!;
    expect(view.body.records.get(nestedParent)).toMatchObject({ kind: "container", type: "blockGroup" });
    expect(view.tree.parents.get(nestedParent)).toBe(IMPORT_PARAGRAPH_ID);
    assertCompleteSources(doc, view);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(original);
    expect(documentCommentThreads(doc).toJSON()).toEqual(comments);
  });

  it("derives deterministic distinct identities for duplicate missing and invalid original IDs", () => {
    const originalDoc = keep(importFixture([
      importBlock(IMPORT_PARAGRAPH_ID, "paragraph", [importText("UNIQUE")]),
      importBlock(IMPORT_TABLE_ID, "paragraph", [importText("D1")]),
      importBlock(IMPORT_TABLE_ID, "paragraph", [importText("D2")]),
      importBlock(null, "paragraph", [importText("MISSING")]),
      importBlock("invalid-id", "paragraph", [importText("INVALID")]),
    ]));
    const bytes = Y.encodeStateAsUpdate(originalDoc);
    const first = open(bytes);
    const second = open(bytes);
    const elsewhere = open(bytes);
    const before = importXmlSnapshot(documentBodyFragment(first));
    importCurrentDocumentBody(first, NAME);
    importCurrentDocumentBody(second, NAME);
    importCurrentDocumentBody(elsewhere, "project-other/document-current");
    const a = tree(first).owners;
    expect(a.map((owner) => owner.units.map((unit) => unit.value).join(""))).toEqual(["UNIQUE", "D1", "D2", "MISSING", "INVALID"]);
    expect(a[0]!.id).toBe(IMPORT_PARAGRAPH_ID);
    expect(new Set(a.map((owner) => owner.id)).size).toBe(5);
    expect(a.map((owner) => owner.id)).not.toContain(IMPORT_TABLE_ID);
    expect(a.map((owner) => owner.id)).not.toContain("invalid-id");
    expect(tree(second).owners.map((owner) => owner.id)).toEqual(a.map((owner) => owner.id));
    expect(tree(elsewhere).owners[0]!.id).toBe(IMPORT_PARAGRAPH_ID);
    expect(tree(elsewhere).owners.slice(1).map((owner) => owner.id)).not.toEqual(a.slice(1).map((owner) => owner.id));
    expect(importXmlSnapshot(documentBodyFragment(first))).toEqual(before);
    expect(importXmlSnapshot(documentBodyFragment(second))).toEqual(before);
  });

  it("imports layout table ancestry media attrs and source marks without changing XML", () => {
    const doc = keep(importFixture([importLayoutTable()]));
    const original = importXmlSnapshot(documentBodyFragment(doc));
    importCurrentDocumentBody(doc, NAME);
    const view = tree(doc);
    const table = view.body.records.get(IMPORT_TABLE_ID)!;
    expect(table).toMatchObject({ kind: "container", type: "docTable", attrs: { quoted: true, textColor: "blue" } });
    const row = view.tree.children.get(IMPORT_TABLE_ID)![0]!;
    const cells = view.tree.children.get(row)!;
    expect(view.body.records.get(row)).toMatchObject({ kind: "container", type: "docTableRow", parent: IMPORT_TABLE_ID });
    expect(cells.map((id) => view.body.records.get(id))).toMatchObject([
      { kind: "container", type: "docTableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: [180], backgroundColor: "blue" } },
      { kind: "container", type: "docTableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null } },
    ]);
    expect(view.tree.parents.get(IMPORT_PARAGRAPH_ID)).toBe(cells[0]);
    expect(view.tree.parents.get(IMPORT_LIST_ID)).toBe(cells[1]);
    expect(view.owners.map((owner) => [owner.id, owner.type])).toEqual([[IMPORT_PARAGRAPH_ID, "paragraph"], [IMPORT_LIST_ID, "image"]]);
    expect(view.owners[0]!.units.map((unit) => unit.value).join("")).toBe("LEFT");
    expect(marks(view, view.owners[0]!.units[0]!)).toEqual([{ type: "bold", attrs: {} }]);
    expect(view.owners[1]!.attrs).toEqual({ url: "https://example.com/image.png", name: "original", mediaWidth: 640, mediaHeight: 480 });
    expect(view.owners[1]!.units).toEqual([]);
    assertCompleteSources(doc, view);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(original);
  });

  it("normalizes a legacy table on a temporary snapshot and preserves its original native XML", () => {
    const original = keep(importFixture([importLegacyTable()]));
    const bytes = Y.encodeStateAsUpdate(original);
    const doc = open(bytes);
    const again = open(bytes);
    const before = importXmlSnapshot(documentBodyFragment(doc));
    importCurrentDocumentBody(doc, NAME);
    importCurrentDocumentBody(again, NAME);
    const view = tree(doc);
    expect(view.body.records.get(IMPORT_TABLE_ID)).toMatchObject({ kind: "container", type: "docTable", attrs: { quoted: true, textColor: "blue" } });
    expect(view.owners.map((owner) => owner.units.map((unit) => unit.value).join(""))).toEqual(["TOP", "BOTTOM", "AFTER"]);
    expect(view.owners.slice(0, 2).map((owner) => owner.attrs)).toEqual([{ textAlignment: "center", textColor: "red" }, { textAlignment: "center", textColor: "red" }]);
    expect(marks(view, view.owners[0]!.units[0]!)).toEqual([{ type: "bold", attrs: {} }]);
    expect(marks(view, view.owners[1]!.units[0]!)).toEqual([{ type: "comment", attrs: { threadId: "thread-one", orphan: false } }]);
    expect(view.owners[2]!.id).toBe(IMPORT_LIST_ID);
    expect(view.tree.parents.get(IMPORT_LIST_ID)).toBe(view.tree.parents.get(IMPORT_TABLE_ID));
    expect([...view.body.records.values()].filter((record) => record.kind === "container" && record.type === "docTableHeader")).toMatchObject([{ attrs: { colspan: 2, rowspan: 1, colwidth: [120, 140], backgroundColor: "blue" } }]);
    expect(tree(again).owners.map((owner) => owner.id)).toEqual(view.owners.map((owner) => owner.id));
    assertCompleteSources(doc, view);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(before);
    expect(documentCommentThreads(doc).toJSON()).toEqual(documentCommentThreads(original).toJSON());
  });

  it("keeps hard breaks and overlapping comment instances as distinct native units and marks", () => {
    const doc = keep(importFixture([importBlock(IMPORT_PARAGRAPH_ID, "paragraph", [
      importText("A", { "comment--0tK2JLks": { orphan: false, threadId: "one" }, "comment--RBvU5tt3": { orphan: true, threadId: "two" }, bold: {} }),
      importElement("hardBreak"), importText("😀"),
    ])]));
    const original = importXmlSnapshot(documentBodyFragment(doc));
    importCurrentDocumentBody(doc, NAME);
    const view = tree(doc);
    expect(view.owners[0]!.units.map((unit) => unit.value)).toEqual(["A", { bodyInline: { type: "hardBreak", attrs: {} } }, "\ud83d", "\ude00"]);
    expect(marks(view, view.owners[0]!.units[0]!)).toEqual([
      { type: "bold", attrs: {} }, { type: "comment", attrs: { threadId: "one", orphan: false } }, { type: "comment", attrs: { threadId: "two", orphan: true } },
    ]);
    assertCompleteSources(doc, view);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(original);
  });

  it("imports a complete empty snapshot without creating a synthetic persisted owner", () => {
    const doc = keep(importFixture([]));
    const original = importXmlSnapshot(documentBodyFragment(doc));
    expect(importCurrentDocumentBody(doc, NAME)).toEqual({ status: "ready", changed: true });
    const view = tree(doc);
    expect(view.owners).toEqual([]);
    expect(view.body.sources.size).toBe(0);
    expect([...view.body.records.values()].filter((record) => record.kind === "root")).toHaveLength(1);
    expect([...view.body.records.values()].filter((record) => record.kind === "container" && record.type === "blockGroup")).toHaveLength(1);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(original);
  });

  it.each(["unknown-format", "unknown-version", "missing-version", "malformed-description", "invalid-structure", "missing-source"] as const)("rejects %s without changing authoritative bytes", (kind) => {
    const doc = open(encodeInitialSpaceContent("document"));
    const roots = documentBodyRecords(doc);
    if (kind === "unknown-format") roots.metadata.set("format", "future.body.format");
    if (kind === "unknown-version") roots.metadata.set("version", 999);
    if (kind === "missing-version") roots.metadata.delete("version");
    if (kind === "malformed-description") roots.records.set(String(roots.metadata.get("seedRoot")), "not-json");
    if (kind === "invalid-structure") {
      roots.facts.set("broken", JSON.stringify({ id: "broken", kind: "structure", group: "broken-group", dependencies: [], edges: [{ child: "x", parent: "y", counter: -1, order: "A" }] }));
      roots.groups.set("broken-group", JSON.stringify({ id: "broken-group", facts: ["broken"], history: "user" }));
    }
    if (kind === "missing-source") {
      const source = [...tree(doc).body.sources.values()][0]!;
      roots.sources.set("absent-source", JSON.stringify({ id: "absent-source", facet: source.facet, head: "absent-head", tail: "absent-tail" }));
    }
    const before = Y.encodeStateAsUpdate(doc);
    const xml = importXmlSnapshot(documentBodyFragment(doc));
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => importCurrentDocumentBody(doc, NAME)).toThrow(DocumentBodyFormatError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(xml);
    expect(updates).toBe(0);
  });

  it("rejects an invalid unmarked XML structure before publishing records", () => {
    const doc = keep(new Y.Doc());
    documentBodyFragment(doc).insert(0, [importText("orphan root text")]);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => importCurrentDocumentBody(doc, NAME)).toThrow(DocumentBodyFormatError);
    expect(documentBodyRecords(doc).metadata.has("format")).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("preserves arbitrary scalar sequences without Unicode normalization or XML replacement", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("A", "B", "😀", "e", "\u0301"), { maxLength: 20 }), (parts) => {
      const text = parts.join("");
      const doc = keep(importFixture([importBlock(IMPORT_PARAGRAPH_ID, "paragraph", [importText(text)])]));
      const before = importXmlSnapshot(documentBodyFragment(doc));
      importCurrentDocumentBody(doc, NAME);
      const view = tree(doc);
      expect(view.owners.map((owner) => owner.id)).toEqual([IMPORT_PARAGRAPH_ID]);
      expect(view.owners[0]!.units.map((unit) => unit.value).join("")).toBe(text);
      expect(view.owners[0]!.units).toHaveLength(text.length);
      assertCompleteSources(doc, view);
      expect(importXmlSnapshot(documentBodyFragment(doc))).toEqual(before);
    }), { seed: 1619, numRuns: 25 });
  });
});
