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
 * @returns The caret's position.
 */
function caretIn(editor: Editor, index: number): number {
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
  return end;
}

/**
 * Pastes clipboard data the way a reader's paste delivers it.
 * @param editor - The editor.
 * @param html - The clipboard's HTML.
 * @param text - The clipboard's plain text.
 */
function paste(editor: Editor, html: string, text: string): void {
  const data = {
    types: html === '' ? ['text/plain'] : ['text/html', 'text/plain'],
    files: [],
    items: [],
    getData: (type: string): string => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
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
 * Drops clipboard data at a document position, the way a drop from another
 * page delivers it.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param html - The dragged HTML.
 * @param text - The dragged plain text.
 */
function drop(editor: Editor, at: number, html: string, text: string): void {
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
function type(editor: Editor, words: string): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(words));
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

  it('a drop of web content puts the words in the cell and the medium under the table, pending', () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(editor, 0);

    drop(editor, at, '<p>dropped</p><img src="https://elsewhere.example/a.png">', 'dropped');

    expect(firstCell(editor, 0)).toContain('cell dropped');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('plain text carrying a Markdown picture puts the words in the cell and the picture under the table', () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '', 'words\n\n![alt](https://elsewhere.example/a.png)');

    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('web content with a picture and a ragged table lands as it does without the picture, the picture under the table', () => {
    const TABLE_HTML = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';
    const plain = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, `<p>words</p>${TABLE_HTML}`, 'words a b c');
    const withPicture = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(withPicture.editor, 0);

    paste(withPicture.editor, `<p>words</p><img src="https://elsewhere.example/a.png">${TABLE_HTML}`, 'words a b c');

    const expected = shape(plain.editor);
    expected.splice(expected.indexOf('table') + 1, 0, 'image[pending|]');
    expect(shape(withPicture.editor)).toEqual(expected);
    expect(withPicture.sink.start).toHaveBeenCalledOnce();
  });

  it('a picture alone puts nothing in the cell and the picture under the table', () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<img src="https://elsewhere.example/a.png">', '');

    expect(firstCell(editor, 0)).toBe('cell ');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
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

describe('a paste or a drop is an undo step of its own (A6)', () => {
  it('typing just before a paste of web content stays when the paste is undone', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    type(editor, ' typed');
    paste(editor, '<p>web words</p><img src="https://elsewhere.example/a.png">', 'web words');
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });

  it('typing just after a paste is undone on its own', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, '<p>web words</p><img src="https://elsewhere.example/a.png">', 'web words');
    type(editor, 'Z');
    manager.undo();

    expect(shape(editor).join(' ')).not.toContain('Z');
    expect(shape(editor)).toContain('image[pending|]');
  });

  it('typing just before a drop of web content stays when the drop is undone', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    const at = caretIn(editor, 0);

    type(editor, ' typed');
    drop(editor, at + ' typed'.length, '<p>dropped</p><img src="https://elsewhere.example/a.png">', 'dropped');
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });

  it('typing just before a paste in a table cell stays when the paste is undone', () => {
    const { editor, manager } = open([TABLE]);
    caretIn(editor, 0);

    type(editor, 'typed');
    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png">', 'words');
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('cell typed');
  });

  it('typing just before a plain text paste stays when the paste is undone', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    type(editor, ' typed');
    paste(editor, '', ' plain');
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });
});
