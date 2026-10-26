// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import { documentBodyFragment, documentCommentThreads } from "@shared/document-body.js";
import type { BodyJsonObject } from "@shared/document-body-records-types.js";

/** Independently named existing blocks, all valid version-four UUIDs. */
export const IMPORT_PARAGRAPH_ID = "11111111-1111-4111-8111-111111111111";
export const IMPORT_LIST_ID = "22222222-2222-4222-8222-222222222222";
export const IMPORT_TABLE_ID = "33333333-3333-4333-8333-333333333333";

/** Native XML values whose full state is compared before and after import. */
export type ImportXmlSnapshot =
  | { readonly kind: "text"; readonly identity: string | null; readonly delta: unknown; readonly characters: readonly string[] }
  | { readonly kind: "element"; readonly name: string; readonly identity: string | null; readonly attrs: unknown; readonly children: readonly ImportXmlSnapshot[] };

/**
 * Allocates a fixture element with genuine Yjs JSON attributes.
 * @param name - The exact camel-case stored node name.
 * @param attrs - All original JSON attributes, including unknown values.
 * @param children - The original XML child order.
 * @returns An unintegrated native XML element.
 * @throws {never}
 */
export function importElement(name: string, attrs: BodyJsonObject = {}, children: readonly (Y.XmlElement | Y.XmlText)[] = []): Y.XmlElement {
  const element = new Y.XmlElement(name);
  // Yjs stores JSON here; its default XML generic only declares string attrs.
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value as never);
  element.insert(0, [...children]);
  return element;
}

/**
 * Allocates native XML text with independently specified run formatting.
 * @param text - The exact unnormalised UTF-16 content.
 * @param marks - Original y-prosemirror attribute keys and payloads.
 * @returns An unintegrated native XML text node.
 * @throws {never}
 */
export function importText(text: string, marks: BodyJsonObject = {}): Y.XmlText {
  const value = new Y.XmlText();
  if (text !== "") value.insert(0, text, marks);
  return value;
}

/**
 * Builds one BlockNote XML block without using the importer as an oracle.
 * @param id - The stored identity, or null for an identity-free block.
 * @param type - The content node's original type.
 * @param children - Original inline content and leaves.
 * @param attrs - Original content attributes.
 * @param nested - Original nested blocks.
 * @returns A real stored block wrapper.
 * @throws {never}
 */
export function importBlock(id: string | null, type: string, children: readonly (Y.XmlElement | Y.XmlText)[], attrs: BodyJsonObject = {}, nested: readonly Y.XmlElement[] = []): Y.XmlElement {
  const content = importElement(type, attrs, children);
  const blocks = nested.length === 0 ? [] : [importElement("blockGroup", {}, nested)];
  return importElement("blockContainer", id === null ? {} : { id }, [content, ...blocks]);
}

/**
 * Builds a complete current XML snapshot with actual thread data.
 * @param blocks - Original top-level blocks in document order.
 * @returns The native source document before any records exist.
 * @throws {never}
 */
export function importFixture(blocks: readonly Y.XmlElement[] = [
  importBlock(IMPORT_PARAGRAPH_ID, "paragraph", [importText("A😀e\u0301B", { bold: {}, link: { href: "https://example.com/original" }, "comment--NFvUsqy1": { orphan: false, threadId: "thread-one" } })], { textAlignment: "center", textColor: "blue", quoted: true }),
  importBlock(IMPORT_LIST_ID, "bulletListItem", [importText("CD")]),
]): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  documentBodyFragment(doc).insert(0, [importElement("blockGroup", {}, blocks)]);
  documentCommentThreads(doc).set("thread-one", {
    id: "thread-one", resolved: false, createdAt: "2026-10-25T12:00:00.000Z",
    comments: [{ id: "comment-one", userId: "author", body: [{ type: "text", text: "Published comment" }] }, { id: "reply-one", userId: "peer", body: [{ type: "text", text: "Published reply" }] }],
  });
  return doc;
}

/**
 * Reads XML values and the original native positions without stringifying markup.
 * @param fragment - The original root or element being inspected.
 * @returns Every node, attribute, delta and native unit identity in order.
 * @throws {Error} If a text unit has no native identity.
 */
export function importXmlSnapshot(fragment: Y.XmlFragment): readonly ImportXmlSnapshot[] {
  return fragment.toArray().map((node) => {
    const identity = node._item === null ? null : `${node._item.id.client}:${node._item.id.clock}`;
    if (node instanceof Y.XmlText) {
      const characters = Array.from({ length: node.length }, (_, index) => {
        const item = Y.createRelativePositionFromTypeIndex(node, index).item;
        if (item === null) throw new Error("Expected a native XML text unit");
        return `${item.client}:${item.clock}`;
      });
      return { kind: "text", identity, delta: node.toDelta(), characters };
    }
    if (!(node instanceof Y.XmlElement)) throw new Error("Expected XML text or element");
    return { kind: "element", name: node.nodeName, identity, attrs: node.getAttributes(), children: importXmlSnapshot(node) };
  });
}

/**
 * Builds an actual layout table holding a paragraph and a media block.
 * @returns Current XML using the production layout vocabulary.
 * @throws {never}
 */
export function importLayoutTable(): Y.XmlElement {
  return importElement("docTable", { id: IMPORT_TABLE_ID, quoted: true, textColor: "blue" }, [
    importElement("docTableRow", { id: "44444444-4444-4444-8444-444444444444" }, [
      importElement("docTableHeader", { id: "55555555-5555-4555-8555-555555555555", colspan: 1, rowspan: 1, colwidth: [180], backgroundColor: "blue" }, [importBlock(IMPORT_PARAGRAPH_ID, "paragraph", [importText("LEFT", { bold: {} })])]),
      importElement("docTableCell", { id: "66666666-6666-4666-8666-666666666666", colspan: 1, rowspan: 1, colwidth: null }, [importBlock(IMPORT_LIST_ID, "image", [], { url: "https://example.com/image.png", name: "original", mediaWidth: 640, mediaHeight: 480 })]),
    ]),
  ]);
}

/**
 * Builds the current stored legacy table shape, including a nested block to lift.
 * @returns A genuine legacy table wrapper with two lines in a header cell.
 * @throws {never}
 */
export function importLegacyTable(): Y.XmlElement {
  const table = importElement("table", { quoted: true, textColor: "blue" }, [
    importElement("tableRow", {}, [importElement("tableHeader", { colspan: 2, rowspan: 1, colwidth: [120, 140], textAlignment: "center", textColor: "red", backgroundColor: "blue" }, [
      importElement("tableParagraph", {}, [importText("TOP", { bold: {} })]),
      importElement("tableParagraph", {}, [importText("BOTTOM", { "comment--NFvUsqy1": { orphan: false, threadId: "thread-one" } })]),
    ])]),
  ]);
  return importElement("blockContainer", { id: IMPORT_TABLE_ID }, [table, importElement("blockGroup", {}, [importBlock(IMPORT_LIST_ID, "paragraph", [importText("AFTER")])])]);
}
