// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import { validate as validUuid } from "uuid";

import { deriveId } from "@shared/ids.js";
import { documentBodyFragment } from "@shared/document-body.js";
import { DocumentBodyFormatError, parseBodyJsonValue } from "@shared/document-body-records-schema.js";
import type { BodyJsonObject, BodyJsonValue } from "@shared/document-body-records-types.js";
import { bodyXmlAttributes } from "@shared/document-body-xml.js";

export { bodyXmlAttributes as importXmlAttrs } from "@shared/document-body-xml.js";

/** Stable allocation state shared by original block repair and temporary table conversion. */
export interface BodyImportIdentities {
  readonly document: string;
  readonly used: Set<string>;
}

/**
 * Derives a collision-free identity without using this loading attempt's client ID.
 * @param identities - The owning document and identities already reserved.
 * @param scope - The product object being allocated.
 * @param source - The original native identity or deterministic product identity.
 * @returns A stable UUID unique within this complete snapshot.
 * @throws {never}
 */
export function importIdentity(identities: BodyImportIdentities, scope: string, source: string): string {
  let ordinal = 0;
  let id: string;
  do {
    id = deriveId(JSON.stringify(["document-body-import", identities.document, scope, source, ordinal++]));
  } while (identities.used.has(id));
  identities.used.add(id);
  return id;
}

/**
 * Reads the original integrated XML node identity.
 * @param element - A node loaded from the original stored update.
 * @returns Its native client and clock, independent of the loader.
 * @throws {DocumentBodyFormatError} If the snapshot node is not integrated.
 */
export function importNativeIdentity(element: Y.XmlElement): string {
  if (element._item === null) throw new DocumentBodyFormatError("An imported XML node must have a stored native identity");
  return `${element._item.id.client}:${element._item.id.clock}`;
}

/**
 * Finds block identities without confusing a content or inline node's own attrs with a wrapper ID.
 * @param parent - The original body or a descendant element.
 * @param output - Block elements collected in original document order.
 * @throws {never}
 */
function originalBlocks(parent: Y.XmlFragment, output: Y.XmlElement[]): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const block = child.nodeName === "blockContainer" || ["docTable", "docTableRow", "docTableCell", "docTableHeader"].includes(child.nodeName) || (parent instanceof Y.XmlElement && parent.nodeName === "blockGroup" && child.nodeName !== "blockGroup");
    if (block) output.push(child);
    originalBlocks(child, output);
  }
}

/**
 * Repairs only temporary snapshot IDs before normalizing tables or cloning nested blocks.
 * @param doc - The isolated original snapshot used solely for reading/import planning.
 * @param document - The final owning document name.
 * @returns Allocation state with every unique legitimate original block ID reserved.
 * @throws {DocumentBodyFormatError} If an original XML node has no native identity.
 */
export function identifyImportBlocks(doc: Y.Doc, document: string): BodyImportIdentities {
  const blocks: Y.XmlElement[] = [];
  originalBlocks(documentBodyFragment(doc), blocks);
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const id: unknown = block.getAttribute("id");
    if (typeof id === "string" && validUuid(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const identities = { document, used: new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id)) };
  for (const block of blocks) {
    const id: unknown = block.getAttribute("id");
    if (typeof id === "string" && validUuid(id) && counts.get(id) === 1) continue;
    block.setAttribute("id", importIdentity(identities, "block", importNativeIdentity(block)));
  }
  return identities;
}

/**
 * Validates an original dictionary while preserving all unknown own JSON keys.
 * @param value - Original attrs from an element, mark or text run.
 * @returns The complete original dictionary.
 * @throws {DocumentBodyFormatError} If the payload is not a JSON dictionary.
 */
export function importJsonObject(value: unknown): BodyJsonObject {
  const json = parseBodyJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new DocumentBodyFormatError("Imported attrs must be a JSON dictionary");
  return json as BodyJsonObject;
}

/**
 * Preserves an unknown inline node's complete original XML subtree as opaque JSON.
 * @param fragment - The original inline element whose children must be retained.
 * @returns The exact ordered child names, attrs and text deltas.
 * @throws {DocumentBodyFormatError} If a child is not part of the XML/JSON contract.
 */
export function importOpaqueChildren(fragment: Y.XmlFragment): readonly BodyJsonValue[] {
  return fragment.toArray().map((child): BodyJsonValue => {
    if (child instanceof Y.XmlText) return { type: "text", delta: parseBodyJsonValue(child.toDelta()) };
    if (!(child instanceof Y.XmlElement)) throw new DocumentBodyFormatError("Unsupported native XML child in stored body");
    return { type: "node", name: child.nodeName, attrs: bodyXmlAttributes(child), children: importOpaqueChildren(child) };
  });
}
