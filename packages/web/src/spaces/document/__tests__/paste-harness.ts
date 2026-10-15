// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Opening a body and pasting or dropping into it the way a reader does, for
 * the cases on web content with media (inner#1351 + inner#1390 design §5.4).
 */

import { vi } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

/** The editor these cases open. */
export type Editor = ReturnType<typeof buildDocumentEditor>;

/** What every address of ours starts with. */
export const OURS = 'https://cdn.example/';

/** A one-cell table. */
export const TABLE = { type: 'table', content: { type: 'tableContent', rows: [{ cells: [['cell ']] }] } };

/** A one-row table of two cells. */
export const TWO_CELLS = { type: 'table', content: { type: 'tableContent', rows: [{ cells: [['c1'], ['c2']] }] } };

/** Where the body hands pasted media. */
export interface Sink {
  onLeftOut: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

const mounted: Editor[] = [];

/** Takes down every body these cases opened. Put this in `afterEach`. */
export function unmountAll(): void {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
}

/**
 * Opens a body holding these blocks, with an undo manager.
 * @param blocks - The document.
 * @returns The editor, its undo manager and its sink.
 */
export function open(blocks: unknown[]): { editor: Editor; manager: Y.UndoManager; sink: Sink } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const sink: Sink = { onLeftOut: vi.fn(), start: vi.fn() };
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
    media: { assetUrlPrefix: () => OURS, onLeftOut: sink.onLeftOut, start: sink.start },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.clear();
  return { editor, manager, sink };
}

/**
 * Puts the caret at the end of the first text block inside a top-level block.
 * @param editor - The editor.
 * @param index - Which top-level block.
 * @returns The caret's position.
 */
export function caretIn(editor: Editor, index: number): number {
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.firstChild!.forEach((container, offset, i) => {
    if (i !== index) return;
    container.descendants((child, at) => {
      if (end < 0 && child.isTextblock) end = 1 + offset + 1 + at + 1 + child.content.size;
      return end < 0;
    });
  });
  select(editor, end);
  return end;
}

/**
 * Selects a range of the document, or puts the caret at a position.
 * @param editor - The editor.
 * @param from - Where it starts.
 * @param to - Where it ends; the caret when left out.
 */
export function select(editor: Editor, from: number, to = from): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  view.focus();
}

/**
 * Where some words start in the document, plus an offset into them.
 * @param editor - The editor.
 * @param words - Words in one text node.
 * @param offset - How far into them.
 * @returns The position.
 */
export function positionOf(editor: Editor, words: string, offset: number): number {
  let found = -1;
  editor.prosemirrorView!.state.doc.descendants((node, at) => {
    if (found < 0 && node.isText && node.text!.includes(words)) found = at + node.text!.indexOf(words) + offset;
    return found < 0;
  });
  return found;
}

/**
 * Pastes a clipboard holding these formats, the way a reader's paste delivers it.
 * @param editor - The editor.
 * @param formats - Each format the clipboard holds, with its data, in the order a browser lists them.
 */
export function pasteFormats(editor: Editor, formats: Readonly<Record<string, string>>): void {
  const data = {
    types: Object.keys(formats),
    files: [],
    items: [],
    getData: (format: string): string => formats[format] ?? '',
  };
  // The clipboard read through a getter on the prototype, as a browser's
  // ClipboardEvent holds it: a hook that redefines it makes an own property.
  class PasteEvent extends Event {
    /**
     * The clipboard.
     * @returns The data.
     */
    get clipboardData(): typeof data {
      return data;
    }
  }
  editor.prosemirrorView!.dom.dispatchEvent(new PasteEvent('paste', { bubbles: true, cancelable: true }));
}

/**
 * Pastes web content, or plain text when there is no HTML.
 * @param editor - The editor.
 * @param html - The clipboard's HTML, or '' for none.
 * @param text - The clipboard's plain text.
 */
export function paste(editor: Editor, html: string, text: string): void {
  pasteFormats(editor, html === '' ? { 'text/plain': text } : { 'text/html': html, 'text/plain': text });
}

/**
 * Drops web content at a document position, the way a drop from another
 * page delivers it.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param html - The dragged HTML.
 * @param text - The dragged plain text.
 */
export function drop(editor: Editor, at: number, html: string, text: string): void {
  const view = editor.prosemirrorView!;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1 });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['text/html', 'text/plain'],
      files: [],
      items: [],
      getData: (type: string): string => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
  });
  view.dom.dispatchEvent(event);
}

/**
 * Types words at the caret, as one keystroke-sized edit.
 * @param editor - The editor.
 * @param words - The words.
 */
export function type(editor: Editor, words: string): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(words));
}

/**
 * The top-level blocks as short labels.
 * @param editor - The editor.
 * @returns `type:text` for text blocks, `type[pending|url]` for media, `table` for tables.
 */
export function shape(editor: Editor): string[] {
  return (editor.document as { type: string; props: Record<string, unknown>; content?: unknown }[]).map((b) => {
    if (b.type === 'image' || b.type === 'video' || b.type === 'audio') {
      return `${b.type}[${b.props['uploadId'] !== '' ? 'pending' : String(b.props['url'])}|${String(b.props['caption'])}]`;
    }
    if (b.type === 'table') return 'table';
    return `${b.type}:${Array.isArray(b.content) ? (b.content as { text?: string }[]).map((c) => c.text ?? '').join('') : ''}`;
  });
}

/**
 * Every block's type in document order, nested ones too; media carry their caption.
 * @param editor - The editor.
 * @returns The labels.
 */
export function blockOrder(editor: Editor): string[] {
  type Block = { type: string; props: Record<string, unknown>; children?: Block[] };
  const walk = (blocks: Block[]): string[] =>
    blocks.flatMap((block) => [
      ['image', 'video', 'audio'].includes(block.type) ? `${block.type}|${String(block.props['caption'])}` : block.type,
      ...walk(block.children ?? []),
    ]);
  return walk(editor.document as Block[]);
}

/**
 * The words in the first cell of the table at a top-level index.
 * @param editor - The editor.
 * @param index - The table's index.
 * @returns Its text.
 */
export function firstCell(editor: Editor, index: number): string {
  const table = (editor.document as { content: { rows: { cells: { content: { text?: string }[] }[] }[] } }[])[index]!;
  return table.content.rows[0]!.cells[0]!.content.map((c) => c.text ?? '').join('');
}

/**
 * Lets a paste or a drop finish: what lands after the event, and the uploads
 * that start once it is done.
 */
export async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
