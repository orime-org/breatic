// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Converting a document's stored tables into tables whose cells hold blocks
 * (inner#1619 design 5.8), when collab loads the document.
 *
 * A stored table is `blockContainer(id) > table > tableRow > tableCell |
 * tableHeader > tableParagraph > words`. It becomes `docTable(id) >
 * docTableRow > docTableCell | docTableHeader > blockContainer > paragraph >
 * the same words`: the table keeps its block id and its own attributes, each
 * cell keeps its attributes, its alignment and text colour move onto the
 * paragraphs it holds, and the words are copied with every mark on them, a
 * comment's included. A table can have blocks nested under it, which a
 * `docTable` cannot hold: they move to just after the table, at its level.
 *
 * In two steps. The first only reads: it builds every new table, nested ones
 * included, as Yjs elements not yet in the document, so anything that throws
 * throws before the document is touched. The second, one transaction, only
 * inserts what was built and deletes what it replaces.
 *
 * Several collab instances can load one document at once. The conversion runs
 * under a lock that is never released, only expires, and the instance holding
 * it first reads the stored document again: a conversion another instance
 * already stored is merged in, and no second copy of the table is made.
 */

import * as Y from "yjs";

import { documentBodyFragment, newId } from "@breatic/shared";

/** A stored table's own node, under its `blockContainer`. */
const LEGACY_TABLE = "table";

/** The transaction origin of a conversion, so a debugger can see who wrote it. */
export const LEGACY_TABLE_CONVERSION_ORIGIN = "doc-table-migrate";

/** The cell attributes a converted cell keeps. */
const CELL_ATTRIBUTES = ["backgroundColor", "colspan", "colwidth", "rowspan"] as const;

/** The cell attributes that move onto the paragraphs a converted cell holds. */
const LINE_ATTRIBUTES = ["textAlignment", "textColor"] as const;

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
 */
function copyAttribute(from: Y.XmlElement, to: Y.XmlElement, name: string): void {
  const value: unknown = from.getAttribute(name);
  if (value !== undefined && value !== null) to.setAttribute(name, value as never);
}

/**
 * A new element of a type with a fresh block id.
 * @param name - The element's node name.
 * @returns The element, not yet in a document.
 */
function withId(name: string): Y.XmlElement {
  const element = new Y.XmlElement(name);
  element.setAttribute("id", newId());
  return element;
}

/**
 * One line of a stored cell as a block: a paragraph holding copies of its
 * words and inline nodes, with the cell's alignment and text colour.
 * @param line - The `tableParagraph`.
 * @param cell - The stored cell.
 * @returns The `blockContainer`.
 */
function lineBlock(line: Y.XmlElement | null, cell: Y.XmlElement): Y.XmlElement {
  const paragraph = new Y.XmlElement("paragraph");
  for (const name of LINE_ATTRIBUTES) copyAttribute(cell, paragraph, name);
  if (line !== null) {
    paragraph.insert(
      0,
      line.toArray().map((child) => child.clone() as Y.XmlText | Y.XmlElement),
    );
  }
  const container = withId("blockContainer");
  container.insert(0, [paragraph]);
  return container;
}

/**
 * A stored cell as a cell holding blocks.
 * @param cell - The `tableCell` or `tableHeader`.
 * @returns The `docTableCell` or `docTableHeader`.
 */
function convertCell(cell: Y.XmlElement): Y.XmlElement {
  const next = withId(cell.nodeName === "tableHeader" ? "docTableHeader" : "docTableCell");
  for (const name of CELL_ATTRIBUTES) copyAttribute(cell, next, name);
  const lines = cell.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
  // A cell holds at least one block.
  next.insert(0, lines.length === 0 ? [lineBlock(null, cell)] : lines.map((line) => lineBlock(line, cell)));
  return next;
}

/**
 * A stored table's block as the blocks that replace it: the new table, then
 * the blocks that were nested under it, each converted in turn.
 * @param container - The `blockContainer` holding the stored table.
 * @returns The replacement blocks, not yet in a document.
 */
function convertTableBlock(container: Y.XmlElement): Y.XmlElement[] {
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
        const next = withId("docTableRow");
        next.insert(
          0,
          row
            .toArray()
            .filter((cell): cell is Y.XmlElement => cell instanceof Y.XmlElement)
            .map(convertCell),
        );
        return next;
      }),
  );
  const nested = container.get(1);
  const lifted = nested instanceof Y.XmlElement ? convertBlocks(nested.toArray()) : [];
  return [table, ...lifted];
}

/**
 * Copies of blocks with every stored table among them, or nested under them,
 * converted.
 * @param blocks - The children of a block group.
 * @returns The copies.
 */
function convertBlocks(blocks: readonly unknown[]): Y.XmlElement[] {
  return blocks.flatMap((block) => {
    if (!(block instanceof Y.XmlElement)) return [];
    if (isLegacyTable(block)) return convertTableBlock(block);
    const copy = new Y.XmlElement(block.nodeName);
    for (const [name, value] of Object.entries(block.getAttributes())) copy.setAttribute(name, value as never);
    copy.insert(
      0,
      block.toArray().map((child) => {
        if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
          const group = new Y.XmlElement("blockGroup");
          group.insert(0, convertBlocks(child.toArray()));
          return group;
        }
        return child.clone() as Y.XmlText | Y.XmlElement;
      }),
    );
    return [copy];
  });
}

/**
 * The block groups under a block: where blocks nested under it sit.
 * @param block - A block's element.
 * @returns Its child groups.
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
 */
function findOutermost(group: Y.XmlElement | Y.XmlFragment, out: Replacement[]): void {
  for (const block of group.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    if (block.nodeName === "blockGroup") {
      findOutermost(block, out);
    } else if (isLegacyTable(block)) {
      out.push({ parent: group, container: block, blocks: convertTableBlock(block) });
    } else {
      for (const nested of groupsUnder(block)) findOutermost(nested, out);
    }
  }
}

/**
 * Whether a group holds a stored table at any depth.
 * @param group - A block group, or the body.
 * @returns True when it does.
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
 */
export function hasLegacyTable(doc: Y.Doc): boolean {
  return holdsLegacyTable(documentBodyFragment(doc));
}

/**
 * Converts every stored table in a document.
 * @param doc - The document.
 * @returns How many tables were converted, nested ones not counted.
 * @throws {Error} Whatever reading the stored tables throws, before anything
 *   in the document changed.
 */
export function convertLegacyTables(doc: Y.Doc): number {
  const replacements: Replacement[] = [];
  findOutermost(documentBodyFragment(doc), replacements);
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

/** What converting on load needs from the process around it. */
export interface ConversionOnLoad {
  /** The document's full name, which the lock is keyed by. */
  readonly documentName: string;
  /** The document, as the load hook hands it over. */
  readonly document: Y.Doc;
  /**
   * Takes the document's conversion lock if nobody holds it.
   * @param key - The lock's key.
   * @returns True when this instance took it.
   */
  readonly takeLock: (key: string) => Promise<boolean>;
  /**
   * Reads the stored document again.
   * @returns Its stored state, or null when none is stored.
   */
  readonly readStored: () => Promise<Uint8Array | null>;
}

/**
 * The lock key for one document's conversion.
 * @param documentName - The document's full name.
 * @returns The key.
 */
export function conversionLockKey(documentName: string): string {
  return `doc-table-migrate:${documentName}`;
}

/**
 * Converts a loaded document's stored tables, unless another instance is
 * doing it or already did.
 * @param load - The document and what the conversion needs.
 * @returns How many tables this instance converted.
 * @throws {Error} Whatever taking the lock, reading the stored document or
 *   the conversion throws.
 */
export async function convertStoredTablesOnLoad(load: ConversionOnLoad): Promise<number> {
  if (!hasLegacyTable(load.document)) return 0;
  if (!(await load.takeLock(conversionLockKey(load.documentName)))) return 0;
  const stored = await load.readStored();
  if (stored !== null) Y.applyUpdate(load.document, stored, LEGACY_TABLE_CONVERSION_ORIGIN);
  if (!hasLegacyTable(load.document)) return 0;
  return convertLegacyTables(load.document);
}
