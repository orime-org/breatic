// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A document read block by block for the Agent (inner#1509).
 *
 * Each top-level block goes as its own Markdown, so the Agent can name the
 * block it proposes on, together with its plain text: the text a proposal
 * quotes, and the text the landing checks against before it writes. Both ends
 * read that text through {@link blockPlainText}, so they compare the same
 * thing.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';

/** One top-level block as the Agent is sent it. */
export interface ReadBlock {
  id: string;
  /** The BlockNote block type. */
  type: string;
  markdown: string;
  /** The words with no Markdown: paragraphs and table cells one per line. */
  text: string;
  /** Whether the block holds something Markdown cannot carry. */
  lossy: boolean;
}

/**
 * Block attributes Markdown writes out; any other one set off its default is
 * lost by a Markdown rewrite. A merged cell's spans are written: a table with
 * one is written as an HTML table (`document-table-markdown.ts`).
 */
const CARRIED_ATTRS = new Set(['id', 'level', 'checked', 'language', 'start', 'url', 'name', 'caption', 'colspan', 'rowspan']);

/** Marks Markdown writes out. */
const CARRIED_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);

/** Stand-ins for content this build cannot represent. */
const STAND_INS = new Set(['unsupportedBlock', 'unsupportedInline']);

/**
 * The words of a block and everything under it -- list items nested in it,
 * every cell of a table -- one paragraph or cell per line.
 * @param node - The block: its `blockContainer`, or a table's own node, which no container wraps.
 * @returns The plain text.
 */
export function blockPlainText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, '\n', '\n');
}

/**
 * Whether an attribute holds something other than its default.
 * @param node - The node.
 * @param key - The attribute.
 * @returns True when it is set.
 */
function attrSet(node: ProseMirrorNode, key: string): boolean {
  const fallback: unknown = node.type.spec.attrs?.[key]?.default;
  return JSON.stringify(node.attrs[key] ?? null) !== JSON.stringify(fallback ?? null);
}

/**
 * Whether a block holds a colour, an alignment, a width, a comment or any
 * other thing a Markdown rewrite would drop.
 * @param node - The block: its `blockContainer`, or a table's own node, which no container wraps.
 * @returns True when it does.
 */
function lossyBlock(node: ProseMirrorNode): boolean {
  /**
   * Whether one node holds something Markdown drops.
   * @param child - The node.
   * @returns True when it does.
   */
  const drops = (child: ProseMirrorNode): boolean =>
    STAND_INS.has(child.type.name) ||
    Object.keys(child.attrs).some((key) => !CARRIED_ATTRS.has(key) && attrSet(child, key)) ||
    child.marks.some((mark: Mark) => !CARRIED_MARKS.has(mark.type.name));
  // The node itself too: a table is a top-level node of its own, its colour
  // and quote on it (inner#1619).
  let lossy = drops(node);
  node.descendants((child) => {
    if (lossy) return false;
    lossy = drops(child);
    return !lossy;
  });
  return lossy;
}

/**
 * The top-level blocks of a document that hold something, each with the
 * number the editor shows on an ordered list item so the Markdown says it too.
 * @param editor - The document's editor.
 * @returns The blocks, in order.
 */
export function readTopBlocks(editor: BlockNoteEditor<never, never, never>): ReadBlock[] {
  const nodes = new Map<string, ProseMirrorNode>();
  editor.prosemirrorState.doc.firstChild?.forEach((node) => nodes.set(String(node.attrs.id), node));
  const out: ReadBlock[] = [];
  let listNumber = 0;
  for (const block of editor.document as Array<{ id: string; type: string; props: Record<string, unknown> }>) {
    const start = typeof block.props.start === 'number' ? block.props.start : 1;
    listNumber = block.type !== 'numberedListItem' ? 0 : listNumber === 0 ? start : listNumber + 1;
    const shown = listNumber > 1 ? { ...block, props: { ...block.props, start: listNumber } } : block;
    const markdown = blocksMarkdown(editor, [shown]);
    const node = nodes.get(block.id);
    if (markdown === '' || node === undefined) continue;
    out.push({ id: block.id, type: block.type, markdown, text: blockPlainText(node), lossy: lossyBlock(node) });
  }
  return out;
}
