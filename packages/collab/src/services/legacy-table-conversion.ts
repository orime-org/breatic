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

import { convertLegacyTables, hasLegacyTable, LEGACY_TABLE_CONVERSION_ORIGIN } from "@breatic/shared/document-body";

export { convertLegacyTables, hasLegacyTable, LEGACY_TABLE_CONVERSION_ORIGIN };

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
