// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasting a canvas clipboard into the body (inner#1351 + inner#1390 design
 * §5.1, §5.2; A1, A2, A3, A4, A6, A7): what lands where, in one undo step,
 * and which uploads start.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { serializeClipboard, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const OURS = 'https://cdn.example/2026-10-14/a.png';

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/** What the body hands an upload to. */
interface Sink {
  start: ReturnType<typeof vi.fn>;
  notPasted: ReturnType<typeof vi.fn>;
}

/**
 * Opens a body holding these blocks with the caret at the end of the block
 * at `caretIn`.
 * @param blocks - The document.
 * @param caretIn - Which top-level block holds the caret.
 * @returns The editor, its undo manager, and the sink.
 */
function open(blocks: unknown[], caretIn: number): { editor: Editor; manager: Y.UndoManager; sink: Sink } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const sink: Sink = { start: vi.fn(), notPasted: vi.fn() };
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
    onCanvasPaste: sink,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.clear();
  const view = editor.prosemirrorView!;
  const group = view.state.doc.firstChild!;
  let end = -1;
  group.forEach((container, offset, index) => {
    if (index !== caretIn) return;
    // The end of the first text block inside it: the line, or a table's first cell.
    container.descendants((child, at) => {
      if (end < 0 && child.isTextblock) end = 1 + offset + 1 + at + 1 + child.content.size;
      return end < 0;
    });
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  view.focus();
  return { editor, manager, sink };
}

/**
 * Pastes clipboard data the way a reader's paste delivers it.
 * @param editor - The editor.
 * @param text - The clipboard's plain text.
 */
function paste(editor: Editor, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: { types: ['text/plain'], getData: (type: string): string => (type === 'text/plain' ? text : ''), files: [], items: [] },
  });
  editor.prosemirrorView!.dom.dispatchEvent(event);
}

/**
 * A canvas clipboard of these nodes.
 * @param nodes - The nodes.
 * @returns Its text.
 */
function clipboard(...nodes: ClipboardNode[]): string {
  return serializeClipboard({ version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] } as ClipboardPayload);
}

/**
 * A text body snapshot.
 * @param lines - Its lines.
 * @returns The snapshot.
 */
function body(...lines: string[]): unknown {
  return { $y: 'xml', children: lines.map((line) => ({ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: line }] }] })) };
}

/**
 * The top-level blocks as short labels.
 * @param editor - The editor.
 * @returns `type:text` for text blocks, `type[uploadId|caption]` for media.
 */
function shape(editor: Editor): string[] {
  return (editor.document as { type: string; props: Record<string, unknown>; content?: { text?: string }[] }[]).map((b) =>
    b.type === 'image' || b.type === 'video' || b.type === 'audio'
      ? `${b.type}[${b.props['uploadId'] === '' ? 'none' : 'id'}|${String(b.props['caption'])}|${String(b.props['url'])}]`
      : `${b.type}:${Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : ''}`,
  );
}

describe('text only', () => {
  it('goes in at the caret, character for character, with nothing read as markdown', () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead ' }], 0);
    paste(editor, clipboard({ id: 't', type: 'text', position: { x: 0, y: 0 }, data: { body: body('_x_', '# y') } }));
    expect(shape(editor)).toEqual(['paragraph:lead _x_', 'paragraph:# y']);
    expect(sink.start).not.toHaveBeenCalled();
  });
});

describe('text only, in a table cell', () => {
  it('goes into the cell', () => {
    const { editor } = open(
      [{ type: 'table', content: { type: 'tableContent', rows: [{ cells: [['cell ']] }] } }],
      0,
    );
    paste(editor, clipboard({ id: 't', type: 'text', position: { x: 0, y: 0 }, data: { body: body('_x_') } }));
    const table = (editor.document as { type: string; content: { rows: { cells: { content: { text: string }[] }[] }[] } }[])[0]!;
    expect(table.content.rows[0]!.cells[0]!.content.map((c) => c.text).join('')).toBe('cell _x_');
    expect(editor.document).toHaveLength(1);
  });
});

describe('with media', () => {
  it('lands after the caret\'s line as text and pending blocks in reading order, and starts each upload', () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }], 0);
    paste(
      editor,
      clipboard(
        { id: 't', type: 'text', position: { x: 0, y: 0 }, height: 100, data: { body: body('Words') } },
        { id: 'i', type: 'image', position: { x: 0, y: 200 }, data: { name: 'Hero', content: OURS } },
      ),
    );
    expect(shape(editor)).toEqual(['paragraph:lead', 'paragraph:Words', 'image[id|Hero|]']);
    const image = (editor.document as { type: string; props: Record<string, unknown> }[])[2]!;
    expect(sink.start).toHaveBeenCalledExactlyOnceWith(image.props['uploadId'], { kind: 'ours', url: OURS });
  });

  it('is one undo step', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }], 0);
    paste(
      editor,
      clipboard(
        { id: 't', type: 'text', position: { x: 0, y: 0 }, height: 100, data: { body: body('Words') } },
        { id: 'i', type: 'image', position: { x: 0, y: 200 }, data: { name: 'Hero', content: OURS } },
      ),
    );
    manager.undo();
    expect(shape(editor)).toEqual(['paragraph:lead']);
  });

  it('carries the node\'s pixel size, so the picture keeps its shape while it loads', () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }], 0);
    paste(
      editor,
      clipboard({ id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Hero', content: OURS, mediaWidth: 320, mediaHeight: 180 } }),
    );
    const image = (editor.document as { type: string; props: Record<string, unknown> }[])[1]!;
    expect([image.props['mediaWidth'], image.props['mediaHeight']]).toEqual([320, 180]);
  });

  it('aimed at an empty line, lands above it and leaves it with the caret', () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: '' }], 1);
    paste(editor, clipboard({ id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Hero', content: OURS } }));
    expect(shape(editor)).toEqual(['paragraph:lead', 'image[id|Hero|]', 'paragraph:']);
  });

  it('an Agent picture starts an upload from its address', () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }], 0);
    paste(
      editor,
      clipboard({ id: 'x', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Found', content: 'https://imgs.example/x.jpg' }, external: true }),
    );
    expect(sink.start).toHaveBeenCalledWith(expect.any(String), { kind: 'address', url: 'https://imgs.example/x.jpg' });
  });

  it('in a table cell, the whole paste lands below the table', () => {
    const { editor } = open(
      [
        { type: 'table', content: { type: 'tableContent', rows: [{ cells: [['cell']] }] } },
        { type: 'paragraph', content: 'after' },
      ],
      0,
    );
    paste(editor, clipboard({ id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Hero', content: OURS } }));
    expect(shape(editor).slice(1)).toEqual(['image[id|Hero|]', 'paragraph:after']);
  });
});

describe('what could not be pasted', () => {
  it('is counted and told, and what could be pasted lands', () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }], 0);
    paste(
      editor,
      clipboard(
        { id: 'p', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Pending' } },
        { id: 'i', type: 'image', position: { x: 0, y: 300 }, data: { name: 'Hero', content: OURS } },
      ),
    );
    expect(shape(editor)).toEqual(['paragraph:lead', 'image[id|Hero|]']);
    expect(sink.notPasted).toHaveBeenCalledExactlyOnceWith(1);
  });
});
