// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T8, design 5.8: a stored table becomes a table whose cells hold
 * blocks when collab loads the document, losing nothing: words, marks,
 * comments, cell and table attributes, the table's id, the blocks nested
 * under it, and rows with no cells of their own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { documentBodyFragment } from "@breatic/shared/document-body";

import {
  convertLegacyTables,
  convertStoredTablesOnLoad,
  conversionLockKey,
  hasLegacyTable,
} from "@collab/services/legacy-table-conversion.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A cell as cases write a stored one. */
interface StoredCell {
  readonly header?: boolean;
  readonly lines: readonly (readonly [string, Record<string, unknown>?])[];
  readonly attrs?: Record<string, unknown>;
}

/**
 * A stored table's block, the way documents from before hold one.
 * @param id - The block's id.
 * @param rows - Each row's cells; an empty row has none.
 * @param tableAttrs - The table's attributes.
 * @param nested - Blocks nested under the table.
 * @returns The `blockContainer`.
 */
function storedTable(
  id: string,
  rows: readonly (readonly StoredCell[])[],
  tableAttrs: Record<string, unknown> = { textColor: "default" },
  nested: readonly Y.XmlElement[] = [],
): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const table = new Y.XmlElement("table");
  for (const [name, value] of Object.entries(tableAttrs)) table.setAttribute(name, value as never);
  table.insert(
    0,
    rows.map((cells) => {
      const row = new Y.XmlElement("tableRow");
      row.insert(
        0,
        cells.map((cell) => {
          const element = new Y.XmlElement(cell.header === true ? "tableHeader" : "tableCell");
          const attrs = { colspan: 1, rowspan: 1, backgroundColor: "default", textColor: "default", textAlignment: "left", ...cell.attrs };
          for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value as never);
          element.insert(
            0,
            cell.lines.map(([words, marks]) => {
              const line = new Y.XmlElement("tableParagraph");
              const text = new Y.XmlText();
              text.insert(0, words, marks ?? {});
              line.insert(0, [text]);
              return line;
            }),
          );
          return element;
        }),
      );
      return row;
    }),
  );
  container.insert(0, [table]);
  if (nested.length > 0) {
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, [...nested]);
    container.insert(1, [group]);
  }
  return container;
}

/**
 * A paragraph block.
 * @param id - Its id.
 * @param words - Its words.
 * @param nested - Blocks nested under it.
 * @returns The `blockContainer`.
 */
function paragraphBlock(id: string, words: string, nested: readonly Y.XmlElement[] = []): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, words);
  paragraph.insert(0, [text]);
  container.insert(0, [paragraph]);
  if (nested.length > 0) {
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, [...nested]);
    container.insert(1, [group]);
  }
  return container;
}

/**
 * A document whose body holds the given blocks.
 * @param blocks - The blocks.
 * @returns The document.
 */
function docWith(blocks: readonly Y.XmlElement[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, [...blocks]);
  documentBodyFragment(doc).insert(0, [group]);
  return doc;
}

/**
 * The body's top-level blocks.
 * @param doc - The document.
 * @returns Them.
 */
function topBlocks(doc: Y.Doc): Y.XmlElement[] {
  return (documentBodyFragment(doc).get(0) as Y.XmlElement).toArray() as Y.XmlElement[];
}

/**
 * A converted table's cells.
 * @param table - The `docTable`.
 * @returns Per row, its cells.
 */
function cellsOf(table: Y.XmlElement): Y.XmlElement[][] {
  return (table.toArray() as Y.XmlElement[]).map((row) => row.toArray() as Y.XmlElement[]);
}

/**
 * The paragraphs a converted cell holds.
 * @param cell - The cell.
 * @returns Them.
 */
function linesOf(cell: Y.XmlElement): Y.XmlElement[] {
  return (cell.toArray() as Y.XmlElement[]).map((container) => container.get(0) as Y.XmlElement);
}

describe("converting a stored table", () => {
  it("keeps the words, their marks and their comments, cell and table attributes and the table's id", () => {
    const doc = docWith([
      storedTable(
        "t1",
        [
          [
            { header: true, lines: [["Shot"]] },
            { header: true, lines: [["Size", { bold: {} }]], attrs: { backgroundColor: "blue", colwidth: [140] } },
          ],
          [
            { lines: [["Close", { comment: { threadId: "c1", orphan: false } }]], attrs: { textAlignment: "center", colspan: 2 } },
          ],
        ],
        { textColor: "red", quoted: true },
      ),
    ]);

    expect(convertLegacyTables(doc)).toBe(1);

    const [table] = topBlocks(doc);
    expect(table!.nodeName).toBe("docTable");
    expect(table!.getAttributes()).toMatchObject({ id: "t1", quoted: true, textColor: "red" });
    const cells = cellsOf(table!);
    expect(cells.map((row) => row.map((cell) => cell.nodeName))).toEqual([
      ["docTableHeader", "docTableHeader"],
      ["docTableCell"],
    ]);
    expect(cells[0]![1]!.getAttributes()).toMatchObject({ backgroundColor: "blue", colwidth: [140] });
    expect(cells[1]![0]!.getAttributes()).toMatchObject({ colspan: 2 });
    const close = linesOf(cells[1]![0]!)[0]!;
    expect(close.nodeName).toBe("paragraph");
    expect(close.getAttribute("textAlignment")).toBe("center");
    expect((close.get(0) as Y.XmlText).toDelta()).toEqual([
      { insert: "Close", attributes: { comment: { threadId: "c1", orphan: false } } },
    ]);
    expect((linesOf(cells[0]![1]!)[0]!.get(0) as Y.XmlText).toDelta()).toEqual([
      { insert: "Size", attributes: { bold: {} } },
    ]);
    for (const row of [table!, ...(table!.toArray() as Y.XmlElement[])]) {
      expect(typeof row.getAttribute("id")).toBe("string");
    }
  });

  it("keeps a cell's lines as paragraphs, and a row with no cells of its own", () => {
    const doc = docWith([
      storedTable("t1", [[{ lines: [["one"], ["two"]], attrs: { rowspan: 2 } }, { lines: [["b"]] }], []]),
    ]);

    convertLegacyTables(doc);

    const cells = cellsOf(topBlocks(doc)[0]!);
    expect(cells).toHaveLength(2);
    expect(cells[1]).toHaveLength(0);
    expect(linesOf(cells[0]![0]!).map((line) => line.toString())).toEqual([
      "<paragraph textAlignment=\"left\" textColor=\"default\">one</paragraph>",
      "<paragraph textAlignment=\"left\" textColor=\"default\">two</paragraph>",
    ]);
  });

  it("moves the blocks nested under the table to just after it, and converts a table among them", () => {
    const doc = docWith([
      paragraphBlock("p0", "lead"),
      storedTable("t1", [[{ lines: [["a"]] }]], undefined, [
        paragraphBlock("p1", "kid"),
        storedTable("t2", [[{ lines: [["b"]] }]]),
      ]),
      paragraphBlock("p2", "after", [storedTable("t3", [[{ lines: [["c"]] }]])]),
    ]);

    expect(convertLegacyTables(doc)).toBe(2);

    expect(topBlocks(doc).map((block) => `${block.nodeName}:${String(block.getAttribute("id"))}`)).toEqual([
      "blockContainer:p0",
      "docTable:t1",
      "blockContainer:p1",
      "docTable:t2",
      "blockContainer:p2",
    ]);
    const nested = (topBlocks(doc)[4]!.get(1) as Y.XmlElement).get(0) as Y.XmlElement;
    expect(nested.nodeName).toBe("docTable");
    expect(nested.getAttribute("id")).toBe("t3");
    expect(hasLegacyTable(doc)).toBe(false);
  });

  it("does nothing the second time", () => {
    const doc = docWith([storedTable("t1", [[{ lines: [["a"]] }]])]);
    convertLegacyTables(doc);
    const once = Y.encodeStateAsUpdate(doc);

    expect(convertLegacyTables(doc)).toBe(0);

    expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
  });

  it("leaves the document as it was when building the new table throws", () => {
    const doc = docWith([paragraphBlock("p0", "lead"), storedTable("t1", [[{ lines: [["a"]] }]])]);
    const before = Y.encodeStateAsUpdate(doc);
    vi.spyOn(Y.XmlText.prototype, "clone").mockImplementation(() => {
      throw new Error("broken stored words");
    });

    expect(() => convertLegacyTables(doc)).toThrow("broken stored words");

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(topBlocks(doc).map((block) => (block.get(0) as Y.XmlElement).nodeName)).toEqual(["paragraph", "table"]);
  });
});

describe("converting on load", () => {
  it("does not take the lock for a document with no stored table", async () => {
    const takeLock = vi.fn(async () => true);
    const converted = await convertStoredTablesOnLoad({
      documentName: "project-p/document-s",
      document: docWith([paragraphBlock("p0", "lead")]),
      takeLock,
      readStored: async () => null,
    });

    expect(converted).toBe(0);
    expect(takeLock).not.toHaveBeenCalled();
  });

  it("converts under the document's lock, and leaves it to the instance holding it", async () => {
    const keys: string[] = [];
    let held = false;
    /**
     * A lock only the first taker gets.
     * @param key - The key.
     * @returns Whether this caller took it.
     */
    const takeLock = async (key: string): Promise<boolean> => {
      keys.push(key);
      if (held) return false;
      held = true;
      return true;
    };
    const first = docWith([storedTable("t1", [[{ lines: [["a"]] }]])]);
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));

    const a = await convertStoredTablesOnLoad({ documentName: "project-p/document-s", document: first, takeLock, readStored: async () => null });
    const b = await convertStoredTablesOnLoad({ documentName: "project-p/document-s", document: second, takeLock, readStored: async () => null });

    expect([a, b]).toEqual([1, 0]);
    expect(keys).toEqual([conversionLockKey("project-p/document-s"), conversionLockKey("project-p/document-s")]);
  });

  it("reads the stored document again under the lock, and makes no second table when it is converted there", async () => {
    // B loaded before A stored its conversion; A's lock has expired.
    const loadedByB = docWith([storedTable("t1", [[{ lines: [["a"]] }]])]);
    const storedByA = new Y.Doc();
    Y.applyUpdate(storedByA, Y.encodeStateAsUpdate(loadedByB));
    convertLegacyTables(storedByA);

    const converted = await convertStoredTablesOnLoad({
      documentName: "project-p/document-s",
      document: loadedByB,
      takeLock: async () => true,
      readStored: async () => Y.encodeStateAsUpdate(storedByA),
    });

    expect(converted).toBe(0);
    expect(topBlocks(loadedByB).map((block) => block.nodeName)).toEqual(["docTable"]);
  });
});
