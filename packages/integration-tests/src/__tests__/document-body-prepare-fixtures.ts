// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import { type BodyTreeView } from "@breatic/shared";
import { documentBodyFragment, documentCommentThreads, readBodyTree } from "@breatic/shared/document-body";

export const PREPARE_PARAGRAPH_ID = "16190001-1111-4111-8111-111111111111";
export const PREPARE_LIST_ID = "16190002-2222-4222-8222-222222222222";
export const PREPARE_THREAD = {
  id: "prepare-thread", resolved: false,
  comments: [{ id: "original", text: "Keep the comment" }, { id: "reply", text: "Keep the reply" }],
};

/**
 * Builds actual stored XML without the new importer as an oracle.
 * @param name - The original XML node name.
 * @param children - The original ordered native children.
 * @returns An unattached native element.
 * @throws {never}
 */
function element(name: string, children: readonly (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const node = new Y.XmlElement(name);
  node.insert(0, [...children]);
  return node;
}

/**
 * Builds a Unicode, formatted current snapshot with independent expected values.
 * @param text - Original paragraph text before preparation.
 * @returns The stored XML document, owned by the caller.
 * @throws {never}
 */
export function preparationXml(text = "A😀e\u0301B"): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraphText = new Y.XmlText();
  paragraphText.insert(0, text, { bold: {}, link: { href: "https://example.com/original" }, "comment--Abcd1234": { threadId: "prepare-thread", orphan: false } });
  const paragraph = element("paragraph", [paragraphText]);
  paragraph.setAttribute("textAlignment", "center");
  const first = element("blockContainer", [paragraph]);
  first.setAttribute("id", PREPARE_PARAGRAPH_ID);
  const listText = new Y.XmlText();
  listText.insert(0, "CD");
  const second = element("blockContainer", [element("bulletListItem", [listText])]);
  second.setAttribute("id", PREPARE_LIST_ID);
  documentBodyFragment(doc).insert(0, [element("blockGroup", [first, second])]);
  documentCommentThreads(doc).set("prepare-thread", PREPARE_THREAD);
  return doc;
}

/**
 * Opens one independent native document from stored bytes.
 * @param bytes - The exact PG or fetch result.
 * @returns A caller-owned native document.
 * @throws {Error} If the update is invalid.
 */
export function openPreparationBytes(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, bytes);
  return doc;
}

/**
 * Requires a fully readable production records frame.
 * @param doc - The independently loaded document.
 * @returns Its complete body frame.
 * @throws {Error} If loading returned XML or incomplete records.
 */
export function preparationTree(doc: Y.Doc): BodyTreeView {
  const frame = readBodyTree(doc);
  if (frame.status !== "ready") throw new Error(`Expected ready records, received ${frame.status}`);
  return frame.view;
}

/**
 * Captures original XML values, marks and native identities recursively.
 * @param fragment - The original stored root or element.
 * @returns The ordered immutable comparison values.
 * @throws {Error} If an unexpected XML node is encountered.
 */
export function preparationXmlSnapshot(fragment: Y.XmlFragment): readonly unknown[] {
  return fragment.toArray().map((node) => {
    const identity = node._item === null ? null : `${node._item.id.client}:${node._item.id.clock}`;
    if (node instanceof Y.XmlText) {
      const units = Array.from({ length: node.length }, (_, index) => Y.createRelativePositionFromTypeIndex(node, index).item);
      return { kind: "text", identity, delta: node.toDelta(), units };
    }
    if (!(node instanceof Y.XmlElement)) throw new Error("Unexpected XML node");
    return { kind: "element", name: node.nodeName, identity, attrs: node.getAttributes(), children: preparationXmlSnapshot(node) };
  });
}
