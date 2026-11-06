// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The body's own content as a slice, and a slice as the lines it puts
 * (inner#1351 design §5.4.1 reading table, §5.4.3 "slice read as lines").
 *
 * A copy of the body is read back by ProseMirror's own clipboard read, which
 * restores the slice's open ends and context from `data-pm-slice`; it is read
 * through a stand-in view with no plugins, so no paste transform runs while
 * the selection is still where the reader left it, and against a context of
 * its own, so the read is the same wherever the content lands. The transforms
 * run once the content is on its target (`document-put.ts`).
 */

import { type ContentMatch, DOMParser as SchemaParser, Fragment, type Node as PMNode, type NodeType, type ResolvedPos, type Schema, Slice } from '@tiptap/pm/model';
import * as pmView from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

/**
 * ProseMirror's own clipboard read, which prosemirror-view exports for its
 * tests (`dist/index.js` `__parseFromClipboard`) and leaves out of its typings.
 */
const parseFromClipboard = (pmView as unknown as {
  __parseFromClipboard: (view: EditorView, text: string, html: string | null, plainText: boolean, $context: ResolvedPos) => Slice | null;
}).__parseFromClipboard;

/** Block types whose content is words, which join a line they are put in. */
export const WORDS = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem']);

/**
 * How one end of the content lands: its words join the line it lands in, its
 * line lands as a block of its own, or the end only bounds the content (a copy
 * starting at a line's end or ending at a line's start), joining a line it
 * lands in and nothing where there is no line to join.
 */
export type Edge = 'joins' | 'apart' | 'boundary';

/** The lines content puts, top-level blocks of the body, and how each end lands. */
export interface Rows {
  readonly rows: readonly PMNode[];
  readonly start: Edge;
  readonly end: Edge;
}

/**
 * Reads the body's own clipboard HTML back into the slice that was copied.
 * @param schema - The body's schema.
 * @param clipboard - The clipboard's HTML.
 * @param text - The clipboard's plain text.
 * @returns The slice.
 */
export function readClipboardSlice(schema: Schema, clipboard: string, text: string): Slice {
  const html = storedTablesAsTables(clipboard);
  // HTML BlockNote writes out whole (`blocksToFullHTML`), with no slice
  // recorded, is whole blocks: closed at both ends.
  if (!html.includes('data-pm-slice')) return wholeBlocks(schema, html);
  const line = schema.nodes['blockContainer']!.create(null, schema.nodes['paragraph']!.create());
  const doc = schema.nodes['doc']!.create(null, schema.nodes['blockGroup']!.create(null, line));
  const view = { state: { schema }, someProp: (): undefined => undefined } as unknown as EditorView;
  // Inside the one paragraph: a context that is neither code nor a cell.
  const slice = parseFromClipboard(view, text, html, false, doc.resolve(3)) ?? Slice.empty;
  // The recorded context is rebuilt as written, its content unchecked: a copy
  // the schema does not take (another editor's copy inside a stored cell)
  // reads as the whole blocks its HTML holds.
  return closedValid(slice.content, slice.openStart, slice.openEnd) ? slice : wholeBlocks(schema, html);
}

/**
 * HTML read as whole blocks, closed at both ends, the slice it records left
 * unread. It is parsed in a document with no browsing context, so nothing in
 * it loads.
 * @param schema - The body's schema.
 * @param html - The HTML.
 * @returns The slice.
 */
function wholeBlocks(schema: Schema, html: string): Slice {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  return new Slice(SchemaParser.fromSchema(schema).parse(body, { topNode: schema.nodes['blockGroup']!.create() }).content, 0, 0);
}

/** A stored table's own attributes, which the table of blocks keeps (`legacy-table-conversion.ts` `TABLE_ATTRIBUTES`). */
const STORED_TABLE_ATTRIBUTES = ['data-quoted', 'data-text-color'];

/** A stored cell's attributes, which the lines in it take (`legacy-table-conversion.ts` `LINE_ATTRIBUTES`). */
const STORED_CELL_LINE_ATTRIBUTES = ['data-text-alignment', 'data-text-color'];

/**
 * Clipboard HTML with each stored (legacy) table taken out of its block as a
 * table of its own, which reads back as a table whose cells hold blocks, as a
 * copy of one does; the block around it would read as an empty line. As the
 * conversion of a stored document does (`legacy-table-conversion.ts`), the
 * table keeps its quote and colour, each line of a cell becomes a block
 * holding the cell's alignment and colour, written as a copy of a table of
 * blocks writes its lines, and the lines nested under the table follow it at
 * its level.
 * Temporary, with #1362's conversion of stored tables: it goes once no stored
 * document holds a `table` node.
 * @param html - The clipboard's HTML.
 * @returns The HTML, parsed in a document with no browsing context.
 */
function storedTablesAsTables(html: string): string {
  if (!html.includes('data-content-type="table"')) return html;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  for (const content of body.querySelectorAll('.bn-block-content[data-content-type="table"]')) {
    const outer = content.closest('.bn-block-outer');
    const table = content.querySelector('table');
    if (outer === null || table === null) continue;
    copyAttributes(content, [table], STORED_TABLE_ATTRIBUTES);
    for (const cell of table.querySelectorAll('td, th')) for (const line of cell.querySelectorAll(':scope > p')) lineAsBlock(line, cell);
    // An end in the lines lifted out keeps the depth recorded through the
    // table's block: ProseMirror's read closes an end only to a depth less
    // than the content's own (`closeSlice`), which is the end's.
    const recorded = outer.getAttribute('data-pm-slice');
    if (recorded !== null) table.setAttribute('data-pm-slice', recorded);
    const nested = outer.querySelector(':scope > .bn-block > .bn-block-group');
    outer.replaceWith(table, ...(nested === null ? [] : [...nested.children]));
  }
  return body.innerHTML;
}

/**
 * Rewrites a stored cell's line as the block a copy of a table of blocks
 * writes for a line of a cell, the cell's alignment and colour on it.
 * @param line - The line, a `<p>` in the cell.
 * @param cell - The cell.
 */
function lineAsBlock(line: Element, cell: Element): void {
  /**
   * A `div` of the line's document.
   * @param className - Its class.
   * @param attributes - Its other attributes.
   * @returns It.
   */
  const div = (className: string, attributes: Record<string, string>): HTMLElement => {
    const element = line.ownerDocument.createElement('div');
    element.className = className;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const content = div('bn-block-content', { 'data-content-type': 'paragraph' });
  copyAttributes(cell, [content], STORED_CELL_LINE_ATTRIBUTES);
  const block = div('bn-block', { 'data-node-type': 'blockContainer' });
  const outer = div('bn-block-outer', { 'data-node-type': 'blockOuter' });
  line.replaceWith(outer);
  line.classList.add('bn-inline-content');
  content.append(line);
  block.append(content);
  outer.append(block);
}

/**
 * Copies the attributes an element has onto other elements.
 * @param from - The element.
 * @param to - The elements.
 * @param names - The attributes' names.
 */
function copyAttributes(from: Element, to: readonly Element[], names: readonly string[]): void {
  for (const name of names) {
    const value = from.getAttribute(name);
    if (value !== null) for (const element of to) element.setAttribute(name, value);
  }
}

/**
 * The node types a node's content may hold anywhere in it.
 * @param type - The node's type.
 * @returns They.
 */
function heldTypes(type: NodeType): Set<NodeType> {
  const held = new Set<NodeType>();
  const seen = new Set<ContentMatch>();
  /**
   * Takes down the types a content match and every state after it accept.
   * @param match - The content match.
   */
  const walk =(match: ContentMatch): void => {
    if (seen.has(match)) return;
    seen.add(match);
    for (let i = 0; i < match.edgeCount; i += 1) {
      const edge = match.edge(i);
      held.add(edge.type);
      walk(edge.next);
    }
  };
  walk(type.contentMatch);
  return held;
}

/**
 * Whether every node a slice closes is one the schema takes; an open node
 * lacks what lies outside the copy, so it is held only to the types it may
 * hold, and what it holds is checked the same way.
 * @param content - The content.
 * @param openStart - How deep its start opens.
 * @param openEnd - How deep its end opens.
 * @returns True when the schema takes it.
 */
function closedValid(content: Fragment, openStart: number, openEnd: number): boolean {
  let valid = true;
  content.forEach((node, _offset, index) => {
    const start = index === 0 ? openStart : 0;
    const end = index === content.childCount - 1 ? openEnd : 0;
    if (start === 0 && end === 0) {
      try {
        node.check();
      } catch {
        valid = false;
      }
    } else {
      const held = heldTypes(node.type);
      node.content.forEach((child) => {
        if (!held.has(child.type)) valid = false;
      });
      if (!closedValid(node.content, Math.max(0, start - 1), Math.max(0, end - 1))) valid = false;
    }
  });
  return valid;
}

/**
 * Whether a block is a line of words with nothing nested: what joins the line
 * it is put in at an end of the content.
 * @param node - A top-level block.
 * @returns True for such a line.
 */
export function isWordsLine(node: PMNode | undefined): boolean {
  return node !== undefined && node.type.name === 'blockContainer' && node.childCount === 1 && WORDS.has(node.firstChild!.type.name);
}

/**
 * A line's nested lines.
 * @param node - A block container.
 * @returns They, none for a line with none.
 */
function nestedOf(node: PMNode): PMNode[] {
  const group = node.lastChild?.type.name === 'blockGroup' ? node.lastChild : null;
  const out: PMNode[] = [];
  group?.forEach((child) => out.push(child));
  return out;
}

/**
 * A line without its nested lines.
 * @param node - A block container.
 * @returns It.
 */
function alone(node: PMNode): PMNode {
  return node.childCount > 1 ? node.type.create(node.attrs, node.firstChild!, node.marks) : node;
}

/**
 * The lines a slice's ends open into, taken out to the top level: the parents
 * the start opens through, whose own words lie before the copy, give way to
 * their nested lines; the nested line the end opens into is taken out of its
 * parent, which stays with the rest of what it holds. Each step goes two
 * levels, a container and its block group.
 * @param top - The top-level blocks.
 * @param open - How deep the start and the end open into the first and last of them.
 * @param open.start - The start's depth.
 * @param open.end - The end's depth.
 * @returns The lines and how deep each end opens into its line.
 */
function lifted(top: PMNode[], open: { start: number; end: number }): { rows: PMNode[]; start: number; end: number } {
  let rows = top;
  let { start, end } = open;
  // A parent cut before its nested lines keeps its block group alone.
  while (start >= 2 && rows[0]?.type.name === 'blockContainer' && rows[0].firstChild!.type.name === 'blockGroup') {
    if (rows.length === 1) end -= 2;
    rows = [...nestedOf(rows[0]), ...rows.slice(1)];
    start -= 2;
  }
  while (end >= 2 && rows[rows.length - 1]?.type.name === 'blockContainer' && nestedOf(rows[rows.length - 1]!).length > 0) {
    const last = rows[rows.length - 1]!;
    const nested = nestedOf(last);
    const rest = nested.slice(0, -1);
    const parent = rest.length > 0 ? last.type.create(last.attrs, [last.firstChild!, last.lastChild!.copy(Fragment.from(rest))], last.marks) : alone(last);
    rows = [...rows.slice(0, -1), parent, nested[nested.length - 1]!];
    end -= 2;
  }
  return { rows, start, end };
}

/**
 * How one end lands, by how deep it opens into its line.
 * @param line - The first or last line.
 * @param open - How deep the end opens into it: 0 closed, 1 into the container, 2 into its words.
 * @returns How it lands.
 */
function edgeOf(line: PMNode | undefined, open: number): Edge {
  if (line === undefined) return 'apart';
  if (open >= 2 && line.type.name === 'blockContainer' && line.firstChild!.isTextblock && line.firstChild!.content.size === 0) return 'boundary';
  return isWordsLine(line) ? 'joins' : 'apart';
}

/**
 * Reads a slice as the top-level lines it puts and how each end lands
 * (§5.4.3 "slice read as lines"). Whatever the slice was copied from, the
 * same lines read the same: nested or at the top.
 * @param slice - The slice.
 * @returns The lines and both ends.
 */
export function rowsOf(slice: Slice): Rows {
  let content = slice.content;
  let start = slice.openStart;
  let end = slice.openEnd;
  // Into the line level: a lone block group is the lines it holds, an end
  // closed at the group closed at its lines (a copy of the whole body).
  while (content.childCount === 1 && content.firstChild!.type.name === 'blockGroup') {
    content = content.firstChild!.content;
    start = Math.max(0, start - 1);
    end = Math.max(0, end - 1);
  }
  const top: PMNode[] = [];
  content.forEach((node) => top.push(node));
  // Rows of a table's cells, as a selection of some of its cells holds them,
  // are a table of those cells (BlockNote `wrapTableRows`).
  const first = top[0];
  if (first !== undefined && first.type.spec['tableRole'] === 'row') {
    const table = Object.values(first.type.schema.nodes).find((type) => type.spec['tableRole'] === 'table' && type.validContent(content));
    if (table !== undefined) return { rows: [table.create(null, content)], start: 'apart', end: 'apart' };
  }
  const lines = lifted(top, { start, end });
  let rows = lines.rows;
  // A wordless start bounds the content: the lines nested under it follow it.
  const startEdge = edgeOf(rows[0], lines.start);
  if (startEdge === 'boundary' && rows.length > 1) rows = [...nestedOf(rows[0]!), ...rows.slice(1)];
  else if (startEdge === 'boundary' && nestedOf(rows[0]!).length > 0) rows = nestedOf(rows[0]!);
  const endEdge = rows.length === 0 ? 'apart' : edgeOf(rows[rows.length - 1], lines.end);
  if (endEdge === 'boundary' && rows.length > 1 && nestedOf(rows[rows.length - 1]!).length === 0) rows = rows.slice(0, -1);
  return { rows, start: startEdge, end: endEdge };
}
