// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A2, A3, A11: files arriving by drop or paste, and the gap they
 * are handed over with.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { guardStrayFileDrops } from '@web/lib/stray-file-drop';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  gapAtCaret,
  gapAtDrop,
  fileDropPosition,
  pastedFiles,
  type FilesArrival,
} from '@web/spaces/document/document-file-input';
import { gapAfter, gapBefore } from './textblocks';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding the given blocks, with files handed to `sink`.
 * @param blocks - What the document starts with.
 * @param sink - Where arriving files go.
 * @returns The editor.
 */
function open(blocks: unknown[], sink?: (arrival: FilesArrival) => void): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    ...(sink !== undefined && { onFiles: sink }),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  // A press, a paste or a key in the body lands while it holds the focus.
  editor.prosemirrorView!.focus();
  return editor;
}

/** A block as this file reads it. */
interface Seen {
  id: string;
  content?: { text?: string }[];
}

/**
 * The id of the block holding this text.
 * @param editor - The editor.
 * @param text - Its text.
 * @returns Its id.
 */
function idOf(editor: Editor, text: string): string {
  return (editor.document as Seen[]).find(
    (b) => (b.content ?? []).map((c) => c.text ?? '').join('') === text,
  )!.id;
}

/**
 * A clipboard as the paste event carries it.
 * @param files - Its files.
 * @param data - Its strings by type.
 * @returns The clipboard.
 */
function clipboard(files: File[], data: Record<string, string> = {}): DataTransfer {
  return {
    files: files as unknown as FileList,
    types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    items: [] as unknown as DataTransferItemList,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

const PNG = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' });

describe('which pastes are files (A3)', () => {
  it('takes files that come alone', () => {
    expect(pastedFiles(clipboard([PNG]))).toEqual([PNG]);
  });

  it('takes the file when the HTML beside it is just that one image', () => {
    const data = clipboard([PNG], { 'text/html': '<meta charset="utf-8"><img src="https://x.example/a.png">' });
    expect(pastedFiles(data)).toEqual([PNG]);
  });

  it('leaves a table with a rendered picture of it to the HTML paste', () => {
    const data = clipboard([PNG], {
      'text/html': '<table><tr><td>1</td></tr></table>',
    });
    expect(pastedFiles(data)).toBeNull();
  });

  it('leaves cells copied from Excel, which come with a picture of them, to the HTML paste', () => {
    // The shape Excel writes, from a copy measured on 2026-10-09: an Office
    // head with its own styles, then the table, beside a PNG of the cells.
    const html = [
      '<html xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">',
      '<head><meta http-equiv=Content-Type content="text/html; charset=utf-8">',
      '<meta name=Generator content="Microsoft Excel"><style>.font0 {color:#000000;}</style></head>',
      '<body><table><col><tr><td>1</td><td>2</td></tr></table></body></html>',
    ].join('\r\n');
    expect(pastedFiles(clipboard([PNG], { 'text/plain': '1\t2', 'text/html': html }))).toBeNull();
  });

  it('leaves words around an image to the HTML paste', () => {
    const data = clipboard([PNG], { 'text/html': '<p>caption</p><img src="a.png">' });
    expect(pastedFiles(data)).toBeNull();
  });

  it('has nothing to take from a paste with no files', () => {
    expect(pastedFiles(clipboard([], { 'text/plain': 'hi' }))).toBeNull();
  });
});

describe('the gap a paste goes into (A3)', () => {
  it('is after the block the caret is in', () => {
    const editor = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', props: { quoted: true }, content: 'B' },
      { type: 'paragraph', content: 'C' },
    ]);
    editor.setTextCursorPosition(idOf(editor, 'B'), 'end');

    const { doc } = editor.prosemirrorView!.state;
    expect(gapAtCaret(editor.prosemirrorView!.state)).toBe(gapBefore(doc, idOf(editor, 'C')));
  });

  it('is above an empty line the caret is on, which keeps the caret', () => {
    const editor = open([{ type: 'paragraph', content: 'A' }, { type: 'paragraph' }]);
    const empty = (editor.document as Seen[])[1]!.id;
    editor.setTextCursorPosition(empty, 'start');

    const { doc } = editor.prosemirrorView!.state;
    expect(gapAtCaret(editor.prosemirrorView!.state)).toBe(gapBefore(doc, empty));
  });
});

describe('the gap a paste goes into with a block selected (A3)', () => {
  it.each(['image', 'divider'] as const)('is after a selected %s block', (type) => {
    const editor = open([
      { type: 'paragraph', content: 'A' },
      type === 'image' ? { type, props: { url: 'https://cdn.example/a.png', name: 'a.png' } } : { type },
      { type: 'paragraph', content: 'B' },
    ]);
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === type) at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    const selectedId = (editor.document as Seen[])[1]!.id;

    expect(gapAtCaret(view.state)).toBe(gapAfter(view.state.doc, selectedId));
  });
});

describe('the gap a drop goes into (A2)', () => {
  it('names the blocks on either side of it', () => {
    const editor = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B' },
    ]);
    const { doc } = editor.prosemirrorView!.state;
    // Inside A's words: the gap a block dropped there lands in is the one
    // after A, the same one a dragged row lands in.
    const insideA = 4;

    expect(gapAtDrop(doc, insideA)).toBe(gapBefore(doc, idOf(editor, 'B')));
  });
});

describe('a paste of files', () => {
  it('hands the files and the gap at the caret over, and inserts nothing itself', () => {
    const sink = vi.fn();
    const editor = open(
      [
        { type: 'paragraph', content: 'A' },
        { type: 'paragraph', content: 'B' },
      ],
      sink,
    );
    editor.setTextCursorPosition(idOf(editor, 'A'), 'end');
    const view = editor.prosemirrorView!;
    const before = view.state.doc;

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard([PNG]) });
    view.dom.dispatchEvent(event);

    expect(sink).toHaveBeenCalledWith({
      files: [PNG],
      gap: gapBefore(view.state.doc, idOf(editor, 'B')),
      aimed: false,
    });
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });

  it('hands nothing over in a read-only body', () => {
    const sink = vi.fn();
    const editor = open([{ type: 'paragraph', content: 'A' }], sink);
    editor.isEditable = false;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard([PNG]) });

    editor.prosemirrorView!.dom.dispatchEvent(event);

    expect(sink).not.toHaveBeenCalled();
  });
});

/**
 * A file drag event, as the browser fires it.
 * @param type - `dragover` or `drop`.
 * @returns The event.
 */
function fileDrag(type: 'dragover' | 'drop'): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: clipboard([PNG]) });
  return event;
}

describe('a file dragged over a read-only body (A11)', () => {
  it.each(['dragover', 'drop'] as const)('has its %s taken, so the browser does not open the file', (type) => {
    const unguard = guardStrayFileDrops(window);
    const sink = vi.fn();
    const editor = open([{ type: 'paragraph', content: 'A' }], sink);
    editor.isEditable = false;
    const event = fileDrag(type);

    editor.prosemirrorView!.dom.firstElementChild!.dispatchEvent(event);
    unguard();

    expect(event.defaultPrevented).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('a file dropped on an editable body (A1–A3)', () => {
  it('hands the files and the gap at the drop to the uploads', () => {
    const sink = vi.fn();
    const editor = open([{ type: 'paragraph', content: 'Alpha' }, { type: 'paragraph', content: 'Beta' }], sink);
    const view = editor.prosemirrorView!;
    const inAlpha = 3;
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: inAlpha, inside: -1 });
    const event = fileDrag('drop');

    view.dom.firstElementChild!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(sink).toHaveBeenCalledWith({ files: [PNG], gap: gapAtDrop(view.state.doc, inAlpha), aimed: false });
  });
});

describe('the line a file drag shows (A2)', () => {
  it('stands between the blocks the files will land between, not inside the words', () => {
    const editor = open([{ type: 'paragraph', content: 'Alpha words' }, { type: 'paragraph', content: 'Beta' }]);
    const view = editor.prosemirrorView!;
    const inWords = 5;

    const shown = fileDropPosition({
      editor: editor as never,
      view,
      event: fileDrag('dragover') as DragEvent,
      defaultPosition: { pos: inWords, orientation: 'inline' },
    });

    expect(shown?.orientation).toBe('block-horizontal');
    const $shown = view.state.doc.resolve(shown!.pos);
    expect($shown.parent.inlineContent).toBe(false);
    expect(shown!.pos).toBe(gapBefore(view.state.doc, idOf(editor, 'Alpha words')));
  });

  it('shows no line over a read-only body, where a drop does nothing', () => {
    const editor = open([{ type: 'paragraph', content: 'Alpha' }]);
    editor.isEditable = false;

    const shown = fileDropPosition({
      editor: editor as never,
      view: editor.prosemirrorView!,
      event: fileDrag('dragover') as DragEvent,
      defaultPosition: { pos: 3, orientation: 'inline' },
    });

    expect(shown).toBeNull();
  });
});
