// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Web content with media, pasted or dropped the way a reader does it
 * (inner#1351 + inner#1390 design §5.1, §5.4; A5, A7): HTML carrying media is
 * read as HTML even when its plain text looks like Markdown; with the caret
 * in a table cell the words go into the cell and every medium lands under
 * the table; a drop of web content is judged as a paste is.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const OURS = 'https://cdn.example/';

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/** Where the body hands pasted media. */
interface Sink {
  onLeftOut: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

/**
 * Opens a body holding these blocks, with an undo manager.
 * @param blocks - The document.
 * @returns The editor, its undo manager and its sink.
 */
function open(blocks: unknown[]): { editor: Editor; manager: Y.UndoManager; sink: Sink } {
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
 */
function caretIn(editor: Editor, index: number): void {
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.firstChild!.forEach((container, offset, i) => {
    if (i !== index) return;
    container.descendants((child, at) => {
      if (end < 0 && child.isTextblock) end = 1 + offset + 1 + at + 1 + child.content.size;
      return end < 0;
    });
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  view.focus();
}

/**
 * Pastes clipboard data the way a reader's paste delivers it.
 * @param editor - The editor.
 * @param html - The clipboard's HTML.
 * @param text - The clipboard's plain text.
 */
function paste(editor: Editor, html: string, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: ['text/html', 'text/plain'],
      files: [],
      items: [],
      getData: (type: string): string => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
  });
  editor.prosemirrorView!.dom.dispatchEvent(event);
}

/**
 * The top-level blocks as short labels.
 * @param editor - The editor.
 * @returns `type:text` for text blocks, `type[pending|url]` for media, `table` for tables.
 */
function shape(editor: Editor): string[] {
  return (editor.document as { type: string; props: Record<string, unknown>; content?: unknown }[]).map((b) => {
    if (b.type === 'image' || b.type === 'video' || b.type === 'audio') {
      return `${b.type}[${b.props['uploadId'] !== '' ? 'pending' : String(b.props['url'])}|${String(b.props['caption'])}]`;
    }
    if (b.type === 'table') return 'table';
    return `${b.type}:${Array.isArray(b.content) ? (b.content as { text?: string }[]).map((c) => c.text ?? '').join('') : ''}`;
  });
}

/**
 * The words in the first cell of the table at a top-level index.
 * @param editor - The editor.
 * @param index - The table's index.
 * @returns Its text.
 */
function firstCell(editor: Editor, index: number): string {
  const table = (editor.document as { content: { rows: { cells: { content: { text?: string }[] }[] }[] } }[])[index]!;
  return table.content.rows[0]!.cells[0]!.content.map((c) => c.text ?? '').join('');
}

const TABLE = { type: 'table', content: { type: 'tableContent', rows: [{ cells: [['cell ']] }] } };

describe('HTML carrying media', () => {
  it('is read as HTML even when its plain text looks like Markdown, so the picture is not lost', () => {
    const { editor, sink } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);

    paste(editor, '<p><b>bold</b> words</p><img src="https://elsewhere.example/a.png">', '**bold** words');

    expect(shape(editor)).toContain('image[pending|]');
    expect(sink.start).toHaveBeenCalledOnce();
  });
});

describe('with the caret in a table cell (A7)', () => {
  it('puts the words in the cell and the medium under the table, pending', () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png" alt="A">', 'words');

    expect(firstCell(editor, 0)).toBe('cell words');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    const image = (editor.document as { props: Record<string, unknown> }[])[1]!;
    expect(sink.start).toHaveBeenCalledExactlyOnceWith(image.props['uploadId'], {
      kind: 'address',
      url: 'https://elsewhere.example/a.png',
    });
  });

  it('carries a figure\'s caption, keeps a medium of ours as it is, and loses none', () => {
    const { editor } = open([TABLE]);
    caretIn(editor, 0);

    paste(
      editor,
      '<figure><img src="https://elsewhere.example/a.png"><figcaption>Cap</figcaption></figure>' +
        `<p>words</p><img src="${OURS}b.png">`,
      'Cap words',
    );

    expect(shape(editor)).toEqual(['table', 'image[pending|Cap]', `image[${OURS}b.png|]`]);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('counts a medium it cannot fetch as left out', () => {
    const { editor, sink } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="http://elsewhere.example/a.png">', 'words');

    expect(shape(editor)).toEqual(['table']);
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('is taken away by one undo', () => {
    const { editor, manager } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png">', 'words');
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('cell ');
  });
});

describe('web content dropped in (A5)', () => {
  it('turns an outside picture into a pending block, as a paste does', () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    const view = editor.prosemirrorView!;
    const at = view.state.doc.content.size - 2;
    view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 1, clientY: 1 });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['text/html', 'text/plain'],
        files: [],
        items: [],
        getData: (type: string): string =>
          type === 'text/html' ? '<p>dropped</p><img src="https://elsewhere.example/a.png">' : type === 'text/plain' ? 'dropped' : '',
      },
    });

    view.dom.dispatchEvent(event);

    expect(shape(editor)).toContain('image[pending|]');
    expect(sink.start).toHaveBeenCalledOnce();
  });
});
