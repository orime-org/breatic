// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import { documentBodyFragment } from "@shared/document-body.js";
import { newId } from "@shared/ids.js";
import { bodyXmlAttributes, cloneBodyXmlNode } from "@shared/document-body-xml.js";

/** A stored table's own node, under its `blockContainer`. */
const LEGACY_TABLE = "table";

/** The transaction origin of a conversion, so a debugger can see who wrote it. */
export const LEGACY_TABLE_CONVERSION_ORIGIN = "doc-table-migrate";

/** The cell attributes a converted cell keeps. */
const CELL_ATTRIBUTES = ["backgroundColor", "colspan", "colwidth", "rowspan"] as const;

/** The cell attributes that move onto the paragraphs a converted cell holds. */
const LINE_ATTRIBUTES = ["textAlignment", "textColor"] as const;

/** Supplies new layout identities while preserving the original source node association. */
export type LegacyTableIdAllocator = (source: Y.XmlElement, role: string) => string;

/** A stored table found in the document, and what replaces it. */
interface Replacement {
  readonly parent: Y.XmlElement | Y.XmlFragment;
  readonly container: Y.XmlElement;
  readonly blocks: readonly Y.XmlElement[];
}

/**
 * Whether a block container holds a stored table.
 * @param node - A child of a block group.
 * @returns True for `blockContainer > table`.
 * @throws {never}
 */
function isLegacyTable(node: unknown): node is Y.XmlElement {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer") return false;
  const first = node.get(0);
  return first instanceof Y.XmlElement && first.nodeName === LEGACY_TABLE;
}

/**
 * Copies one attribute onto a new element when the old one has a value.
 * @param from - The old element.
 * @param to - The new element.
 * @param name - The attribute.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function copyAttribute(from: Y.XmlElement, to: Y.XmlElement, name: string): void {
  const value: unknown = from.getAttribute(name);
  if (value !== undefined && value !== null) to.setAttribute(name, value as never);
}

/**
 * A new element of a type with a fresh block id.
 * @param name - The element's node name.
 * @param source - The original native XML element used by a stable allocator.
 * @param allocate - Optional deterministic allocation; absent retains the existing random-ID behavior.
 * @returns The element, not yet in a document.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function withId(name: string, source: Y.XmlElement, allocate?: LegacyTableIdAllocator): Y.XmlElement {
  const element = new Y.XmlElement(name);
  element.setAttribute("id", allocate === undefined ? newId() : allocate(source, name));
  return element;
}

/**
 * One line of a stored cell as a block: a paragraph holding copies of its
 * words and inline nodes, with the cell's alignment and text colour.
 * @param line - The `tableParagraph`.
 * @param cell - The stored cell.
 * @param allocate - Optional deterministic layout identity allocator.
 * @returns The `blockContainer`.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function lineBlock(line: Y.XmlElement | null, cell: Y.XmlElement, allocate?: LegacyTableIdAllocator): Y.XmlElement {
  const paragraph = new Y.XmlElement("paragraph");
  for (const name of LINE_ATTRIBUTES) copyAttribute(cell, paragraph, name);
  if (line !== null) {
    paragraph.insert(
      0,
      line.toArray().map((child) => cloneBodyXmlNode(child)),
    );
  }
  const container = withId("blockContainer", line ?? cell, allocate);
  container.insert(0, [paragraph]);
  return container;
}

/**
 * A stored cell as a cell holding blocks.
 * @param cell - The `tableCell` or `tableHeader`.
 * @param allocate - Optional deterministic layout identity allocator.
 * @returns The `docTableCell` or `docTableHeader`.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function convertCell(cell: Y.XmlElement, allocate?: LegacyTableIdAllocator): Y.XmlElement {
  const next = withId(cell.nodeName === "tableHeader" ? "docTableHeader" : "docTableCell", cell, allocate);
  for (const name of CELL_ATTRIBUTES) copyAttribute(cell, next, name);
  const lines = cell.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
  // A cell holds at least one block.
  next.insert(0, lines.length === 0 ? [lineBlock(null, cell, allocate)] : lines.map((line) => lineBlock(line, cell, allocate)));
  return next;
}

/**
 * A stored table's block as the blocks that replace it: the new table, then
 * the blocks that were nested under it, each converted in turn.
 * @param container - The `blockContainer` holding the stored table.
 * @param allocate - Optional deterministic layout identity allocator.
 * @returns The replacement blocks, not yet in a document.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function convertTableBlock(container: Y.XmlElement, allocate?: LegacyTableIdAllocator): Y.XmlElement[] {
  const stored = container.get(0) as Y.XmlElement;
  const table = new Y.XmlElement("docTable");
  copyAttribute(container, table, "id");
  copyAttribute(stored, table, "quoted");
  copyAttribute(stored, table, "textColor");
  table.insert(
    0,
    stored
      .toArray()
      .filter((row): row is Y.XmlElement => row instanceof Y.XmlElement)
      .map((row) => {
        const next = withId("docTableRow", row, allocate);
        next.insert(
          0,
          row
            .toArray()
            .filter((cell): cell is Y.XmlElement => cell instanceof Y.XmlElement)
            .map((cell) => convertCell(cell, allocate)),
        );
        return next;
      }),
  );
  const nested = container.get(1);
  const lifted = nested instanceof Y.XmlElement ? convertBlocks(nested.toArray(), allocate) : [];
  return [table, ...lifted];
}

/**
 * Copies of blocks with every stored table among them, or nested under them,
 * converted.
 * @param blocks - The children of a block group.
 * @param allocate - Optional deterministic layout identity allocator.
 * @returns The copies.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function convertBlocks(blocks: readonly unknown[], allocate?: LegacyTableIdAllocator): Y.XmlElement[] {
  return blocks.flatMap((block) => {
    if (!(block instanceof Y.XmlElement)) return [];
    if (isLegacyTable(block)) return convertTableBlock(block, allocate);
    const copy = new Y.XmlElement(block.nodeName);
    for (const [name, value] of Object.entries(bodyXmlAttributes(block))) copy.setAttribute(name, value as never);
    copy.insert(
      0,
      block.toArray().map((child) => {
        if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
          const group = new Y.XmlElement("blockGroup");
          for (const [name, value] of Object.entries(bodyXmlAttributes(child))) group.setAttribute(name, value as never);
          group.insert(0, convertBlocks(child.toArray(), allocate));
          return group;
        }
        return cloneBodyXmlNode(child);
      }),
    );
    return [copy];
  });
}

/**
 * The block groups under a block: where blocks nested under it sit.
 * @param block - A block's element.
 * @returns Its child groups.
 * @throws {never}
 */
function groupsUnder(block: Y.XmlElement): Y.XmlElement[] {
  return block
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.nodeName === "blockGroup");
}

/**
 * Every stored table not inside another one, with what replaces it.
 * @param group - A block group, or the body.
 * @param out - The replacements found so far, appended to in place.
 * @param allocate - Optional deterministic layout identity allocator.
 * @throws {Error} If reading the source or allocating an identity fails.
 */
function findOutermost(group: Y.XmlElement | Y.XmlFragment, out: Replacement[], allocate?: LegacyTableIdAllocator): void {
  for (const block of group.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    if (block.nodeName === "blockGroup") {
      findOutermost(block, out, allocate);
    } else if (isLegacyTable(block)) {
      out.push({ parent: group, container: block, blocks: convertTableBlock(block, allocate) });
    } else {
      for (const nested of groupsUnder(block)) findOutermost(nested, out, allocate);
    }
  }
}

/**
 * Whether a group holds a stored table at any depth.
 * @param group - A block group, or the body.
 * @returns True when it does.
 * @throws {never}
 */
function holdsLegacyTable(group: Y.XmlElement | Y.XmlFragment): boolean {
  return group.toArray().some((block) => {
    if (!(block instanceof Y.XmlElement)) return false;
    if (block.nodeName === "blockGroup") return holdsLegacyTable(block);
    return isLegacyTable(block) || groupsUnder(block).some(holdsLegacyTable);
  });
}

/**
 * Whether a document still holds a stored table anywhere.
 * @param doc - The document.
 * @returns True when one is left.
 * @throws {never}
 */
export function hasLegacyTable(doc: Y.Doc): boolean {
  return holdsLegacyTable(documentBodyFragment(doc));
}

/**
 * Converts every stored table in a document.
 * @param doc - The document.
 * @param allocate - Optional deterministic layout identity allocator.
 * @returns How many tables were converted, nested ones not counted.
 * @throws {Error} Whatever reading the stored tables throws, before anything
 *   in the document changed.
 */
export function convertLegacyTables(doc: Y.Doc, allocate?: LegacyTableIdAllocator): number {
  const replacements: Replacement[] = [];
  findOutermost(documentBodyFragment(doc), replacements, allocate);
  if (replacements.length === 0) return 0;
  doc.transact(() => {
    // From the last, so the places of the ones before stay where they were.
    for (const { parent, container, blocks } of [...replacements].reverse()) {
      const index = parent.toArray().indexOf(container);
      if (index < 0) continue;
      parent.insert(index, [...blocks]);
      parent.delete(index + blocks.length, 1);
    }
  }, LEGACY_TABLE_CONVERSION_ORIGIN);
  return replacements.length;
}
