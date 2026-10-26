// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentBodyFragment } from "@shared/document-body.js";
import { importCurrentDocumentBody } from "@shared/document-body-import.js";
import { readBodyTree } from "@shared/document-body-tree.js";
import type { BodyJsonObject } from "@shared/document-body-records-types.js";
import { IMPORT_LIST_ID, importBlock, importFixture, importLegacyTable, importText, importXmlSnapshot } from "@shared/__tests__/document-body-import-fixtures.js";

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

/**
 * Opens actual stored bytes before traversing the importer and its temporary normalization path.
 * @param bytes - The full original XML snapshot.
 * @returns A native document representing the real loading boundary.
 * @throws {Error} If Yjs rejects the encoded snapshot.
 */
function loaded(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  docs.push(doc);
  Y.applyUpdate(doc, bytes);
  return doc;
}

describe("opaque descendants lifted during current legacy table snapshot preparation", () => {
  it("preserves a reachable own XML attribute on an unknown block after a full stored-byte roundtrip", () => {
    const original = importFixture([importLegacyTable()]);
    docs.push(original);
    const group = documentBodyFragment(original).get(0) as Y.XmlElement;
    const table = group.get(0) as Y.XmlElement;
    const nested = table.get(1) as Y.XmlElement;
    const attrs = JSON.parse('{"__proto__":{"retained":true},"config":{"items":[1,null,"future"]}}') as BodyJsonObject;
    nested.delete(0, nested.length);
    nested.insert(0, [importBlock(IMPORT_LIST_ID, "futurePanel", [importText("OPAQUE", { futureTone: { mode: "original", values: [1, false] } })], attrs)]);

    const current = loaded(Y.encodeStateAsUpdate(original));
    const loadedGroup = documentBodyFragment(current).get(0) as Y.XmlElement;
    const loadedTable = loadedGroup.get(0) as Y.XmlElement;
    const loadedNested = loadedTable.get(1) as Y.XmlElement;
    const originalWrapper = loadedNested.get(0) as Y.XmlElement;
    const originalContent = originalWrapper.get(0) as Y.XmlElement;
    expect(originalContent.hasAttribute("__proto__")).toBe(true);
    expect(originalContent.getAttribute("__proto__")).toEqual({ retained: true });
    expect(originalContent.getAttribute("config")).toEqual({ items: [1, null, "future"] });
    const before = importXmlSnapshot(documentBodyFragment(current));

    expect(importCurrentDocumentBody(current, "project-opaque/document-current")).toEqual({ status: "ready", changed: true });
    const result = readBodyTree(current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("The actual snapshot importer must complete");
    expect(result.view.owners.map((owner) => owner.units.map((unit) => unit.value).join(""))).toEqual(["TOP", "BOTTOM", "OPAQUE"]);
    const owner = result.view.owners.find((entry) => entry.id === IMPORT_LIST_ID)!;
    expect(owner.type).toBe("futurePanel");
    expect(owner.attrs).toEqual(attrs);
    expect(Object.hasOwn(owner.attrs, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(owner.attrs)).toBe(Object.prototype);
    const mark = Object.entries(owner.units[0]!.attributes).find(([key]) => key.startsWith("mark:"))![1] as { readonly factId: string };
    expect(result.view.body.facts.get(mark.factId)).toMatchObject({ kind: "mark", payload: { type: "futureTone", attrs: { mode: "original", values: [1, false] } } });
    expect(importXmlSnapshot(documentBodyFragment(current))).toEqual(before);
    expect(originalContent.hasAttribute("__proto__")).toBe(true);
    expect(originalContent.getAttribute("__proto__")).toEqual({ retained: true });
  });
});
