// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The slash menu in the body (inner#1125 A1-A8, design 5.1-5.10): when it
 * opens, what it lists, how the keyboard and the mouse drive it, and what a
 * pick leaves in the document and on the undo stack.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent, setLocale, t } from '@breatic/shared';

import { isMac } from '@web/lib/is-mac';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { pendingBlock, type FileUploads } from '@web/spaces/document/document-uploads';
import { DocumentMediaPicker } from '@web/spaces/document/DocumentMediaPicker';
import { DocumentSlashMenu } from '@web/spaces/document/DocumentSlashMenu';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

vi.mock('@web/lib/is-mac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/lib/is-mac')>()),
  isMac: vi.fn(() => false),
}));

type Editor = ReturnType<typeof buildDocumentEditor>;

interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
}

const mounted: Editor[] = [];

// The extension stores the anchor with `getBoundingClientRect().toJSON()`;
// jsdom's rect has no `toJSON`.
const rectDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');

beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      const rect = original.call(this);
      return { ...rect, toJSON: () => ({}) };
    },
  });
});

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
  setLocale('en');
  vi.mocked(isMac).mockReturnValue(false);
  if (rectDescriptor) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDescriptor);
});

/**
 * A focused editor holding the given blocks, with undo tracking on, and the
 * slash menu mounted on it.
 * @param blocks - What the document starts with.
 * @param files - What admits picked files; left out, no media entries.
 * @returns The editor and its undo manager.
 */
function open(blocks: readonly unknown[], files?: FileUploads): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.stopCapturing();
  editor.prosemirrorView!.focus();
  render(
    <DocumentMediaPicker files={files ?? null}>
      <DocumentSlashMenu editor={editor as never} />
    </DocumentMediaPicker>,
  );
  return { editor, manager };
}

function read(editor: Editor): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

/** The text of the row whose block id is given. */
function textOf(editor: Editor, id: string): string {
  let text = '';
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (node.attrs.id !== id) return true;
    text = node.firstChild?.textContent ?? '';
    return false;
  });
  return text;
}

function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (found !== undefined) return false;
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs.id);
      return false;
    }
    return true;
  });
  if (found === undefined) throw new Error(`no block reads "${words}"`);
  return found;
}

/** Puts the caret at the end of a row. */
function caretAtEnd(editor: Editor, blockId: string): void {
  editor.setTextCursorPosition(blockId, 'end');
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from)));
}

/** Types text at the caret, one character at a time, the way keystrokes reach ProseMirror. */
function type(editor: Editor, text: string): void {
  const view = editor.prosemirrorView!;
  for (const char of text) {
    act(() => {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
      );
      if (handled !== true) view.dispatch(view.state.tr.insertText(char, from, to));
    });
  }
}

/** Presses a key on the body. */
function press(editor: Editor, key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(editor.prosemirrorView!.dom, { key, ...init });
}

function menu(): HTMLElement | null {
  return screen.queryByTestId('doc-slash-menu');
}

/** The ids of the rows the menu lists, top to bottom. */
function rows(): string[] {
  return screen
    .queryAllByTestId(/^doc-slash-row-/u)
    .map((row) => row.getAttribute('data-testid')!.slice('doc-slash-row-'.length));
}

describe('opening the slash menu (A1)', () => {
  it('opens on a slash at the start of a line, listing every entry', () => {
    const { editor } = open([para('')], { prepare: vi.fn(() => null) });
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    expect(menu()).not.toBeNull();
    expect(rows()).toEqual([
      'heading-1', 'heading-2', 'heading-3', 'code-block', 'bullet-list', 'task-list', 'ordered-list', 'quote',
      'divider', 'table', 'columns', 'formula', 'image', 'audio', 'video',
    ]);
  });

  it('stays shut on a slash in the middle of a word', () => {
    const { editor } = open([para('ab')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    expect(menu()).toBeNull();
  });
});

describe('narrowing the menu (A2)', () => {
  it('finds an entry by its English name', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/he');
    expect(rows()).toEqual(['heading-1', 'heading-2', 'heading-3']);
  });

  it('finds an entry by its name in the interface language and by its English name', () => {
    setLocale('zh-CN');
    const { editor } = open([para(''), para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/表格');
    expect(rows()).toEqual(['table']);
    press(editor, 'Escape');
    caretAtEnd(editor, read(editor)[1]!.id);
    type(editor, '/table');
    expect(rows()).toEqual(['table']);
  });

  it('says nothing matches, and closes three characters past the last match', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/zzz');
    expect(screen.getByTestId('doc-slash-empty').textContent).toBe(t('spaces.document.slashMenu.empty'));
    type(editor, 'z');
    expect(menu()).toBeNull();
    expect(textOf(editor, id)).toBe('/zzzz');
  });
});

describe('the keyboard in the menu (A3)', () => {
  it('moves down, wraps at the ends, and picks with Enter', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/he');
    press(editor, 'ArrowUp');
    expect(screen.getByTestId('doc-slash-row-heading-3').hasAttribute('data-highlighted')).toBe(true);
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    press(editor, 'Enter');
    const [block] = read(editor);
    expect(block?.type).toBe('heading');
    expect(block?.props?.['level']).toBe(2);
    expect(menu()).toBeNull();
  });

  it('closes on Escape and leaves what was typed', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/he');
    press(editor, 'Escape');
    expect(menu()).toBeNull();
    expect(textOf(editor, id)).toBe('/he');
    expect(read(editor)[0]?.type).toBe('paragraph');
  });

  it('keeps filtering by the query from before a composition until it ends', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    const all = rows();
    const view = editor.prosemirrorView!;
    act(() => {
      view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    type(editor, 'biao');
    expect(rows()).toEqual(all);
  });

  it('closes when the trigger is deleted', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    expect(menu()).not.toBeNull();
    const view = editor.prosemirrorView!;
    act(() => {
      const { from } = view.state.selection;
      view.dispatch(view.state.tr.delete(from - 1, from));
    });
    expect(menu()).toBeNull();
  });

  it('leaves an Enter the input method sends as 229 alone', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/he');
    press(editor, 'Enter', { keyCode: 229 });
    expect(read(editor)[0]?.type).toBe('paragraph');
    expect(textOf(editor, id)).toBe('/he');
  });

  it('leaves the Enter right after a composition ends alone', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/he');
    fireEvent(editor.prosemirrorView!.dom, new CompositionEvent('compositionend', { bubbles: true, data: 'he' }));
    press(editor, 'Enter', { keyCode: 13 });
    expect(read(editor)[0]?.type).toBe('paragraph');
    expect(textOf(editor, id)).toBe('/he');
  });
});

describe('the mouse on the menu (A3)', () => {
  it('keeps the editor focused: a press anywhere on the menu is cancelled', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/zzz');
    expect(fireEvent.mouseDown(screen.getByTestId('doc-slash-empty'))).toBe(false);
    expect(fireEvent.mouseDown(menu()!)).toBe(false);
  });

  it('lights the row under the pointer and picks the row pressed', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/he');
    fireEvent.mouseMove(screen.getByTestId('doc-slash-row-heading-3'));
    expect(screen.getByTestId('doc-slash-row-heading-3').hasAttribute('data-highlighted')).toBe(true);
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'));
    expect(read(editor)[0]?.props?.['level']).toBe(3);
  });

  it('picks nothing on a press of another mouse button', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'), { button: 2 });
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'), { button: 1 });
    expect(read(editor)[0]?.type).toBe('paragraph');
    expect(menu()).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'), { button: 2 });
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
  });

  it('picks nothing on a press with Control held, the secondary click on a Mac', () => {
    vi.mocked(isMac).mockReturnValue(true);
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'), { button: 0, ctrlKey: true });
    expect(read(editor)[0]?.type).toBe('paragraph');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'), { button: 0, ctrlKey: true });
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
  });

  it('picks on a press with Ctrl held off a Mac, where it is no secondary click', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'), { button: 0, ctrlKey: true });
    expect(read(editor)[0]?.props?.['level']).toBe(3);
  });

  it('lights nothing when a row only comes under a pointer that has not moved', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseEnter(screen.getByTestId('doc-slash-row-quote'));
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
  });

  it('ignores a move where the pointer already was, and lights on the next real move', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    // The pointer comes to rest where the menu is about to open.
    fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
    type(editor, '/');
    press(editor, 'ArrowDown');
    const lit = screen.getByTestId('doc-slash-row-heading-2');
    expect(lit.hasAttribute('data-highlighted')).toBe(true);
    // WebKit sends this when the list scrolls under a pointer at rest.
    const under = screen.getByTestId('doc-slash-row-heading-3');
    fireEvent.mouseMove(under, { clientX: 10, clientY: 10 });
    expect(lit.hasAttribute('data-highlighted')).toBe(true);
    fireEvent.mouseMove(under, { clientX: 11, clientY: 10 });
    expect(under.hasAttribute('data-highlighted')).toBe(true);
  });

  it('starts a menu opened by a second trigger on its first row', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    // A query with a space in it that still matches keeps the first menu open.
    type(editor, '/heading ');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    type(editor, '/');
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
  });

  it('counts the no-match characters of a menu opened by a second trigger from its empty query', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/heading ');
    type(editor, '/zzz');
    expect(screen.getByTestId('doc-slash-empty')).not.toBeNull();
    type(editor, 'z');
    expect(menu()).toBeNull();
  });

  it('starts on the first row again when the query changes and comes back', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(false);
    type(editor, 'h');
    const view = editor.prosemirrorView!;
    act(() => {
      const { from } = view.state.selection;
      view.dispatch(view.state.tr.delete(from - 1, from));
    });
    expect(textOf(editor, id)).toBe('/');
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
  });

});

describe('entries out of reach (A7)', () => {
  it('greys the table inside a table cell, and picking it does nothing', () => {
    const { editor } = open([tableBlock({ rows: [{ cells: ['cell', 'b'] }] })]);
    const id = idOf(editor, 'cell');
    caretAtEnd(editor, id);
    type(editor, ' /ta');
    const table = screen.getByTestId('doc-slash-row-table');
    expect(table.getAttribute('aria-disabled')).toBe('true');
    press(editor, 'Enter');
    expect(read(editor).filter((block) => block.type === 'docTable')).toHaveLength(1);
    expect(textOf(editor, id)).toBe('cell /ta');
  });

  it('greys the table on an empty row with blocks under it, and they stay', () => {
    const { editor } = open([{ ...para(''), children: [para('child one'), para('child two')] }, para('after')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/table');
    expect(screen.getByTestId('doc-slash-row-table').getAttribute('aria-disabled')).toBe('true');
    press(editor, 'Enter');
    press(editor, 'Enter');
    expect(idOf(editor, 'child one')).toBeTruthy();
    expect(idOf(editor, 'child two')).toBeTruthy();
  });
});

/** The rows of the first table in the document, each as its cells. */
function firstTable(editor: Editor): unknown[][] | undefined {
  const table = read(editor).find((block) => block.type === 'docTable') as
    | (ReadBlock & { children: { children: unknown[] }[] })
    | undefined;
  return table?.children.map((row) => row.children);
}

describe('the table entry (A4, design 5.8)', () => {
  it('turns an empty line into an empty 3x3 table on Enter', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/table');
    press(editor, 'Enter');
    expect(read(editor)[0]?.type).toBe('docTable');
    expect(firstTable(editor)?.map((cells) => cells.length)).toEqual([3, 3, 3]);
    expect(menu()).toBeNull();
  });

  it('puts an empty 3x3 table below a line with text, and keeps the text', () => {
    const { editor } = open([para('ab')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, ' /tab');
    press(editor, 'Enter');
    expect(textOf(editor, id)).toBe('ab ');
    expect(read(editor)[1]?.type).toBe('docTable');
    expect(firstTable(editor)?.map((cells) => cells.length)).toEqual([3, 3, 3]);
  });

  it('puts the 3x3 table in on a press of the Table row', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'));
    expect(firstTable(editor)?.map((cells) => cells.length)).toEqual([3, 3, 3]);
  });

  it('draws Table as a plain row: no arrow, and nothing opens beside the menu', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/tab');
    const table = screen.getByTestId('doc-slash-row-table');
    expect(table.querySelector('.lucide-chevron-right')).toBeNull();
    fireEvent.mouseMove(table, { clientX: 10, clientY: 10 });
    expect(table.hasAttribute('data-highlighted')).toBe(true);
    expect(screen.queryAllByTestId(/^doc-slash-/u).filter((el) => !menu()!.contains(el))).toEqual([]);
  });

  it('leaves ArrowRight on Table to the body', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/tab');
    const seen = vi.fn();
    // Above the body: a key the menu claims stops at the body.
    document.addEventListener('keydown', seen);
    press(editor, 'ArrowRight');
    document.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId(/^doc-slash-/u).filter((el) => !menu()!.contains(el))).toEqual([]);
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
    expect(textOf(editor, id)).toBe('/tab');
  });
});

describe('undo while the menu is open (design state table)', () => {
  it('keeps the menu open on the shorter query when an undo leaves the trigger', () => {
    const { editor, manager } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/');
    manager.stopCapturing();
    type(editor, 'he');
    expect(rows()).not.toContain('table');
    act(() => {
      manager.undo();
    });
    expect(textOf(editor, id)).toBe('/');
    expect(menu()).not.toBeNull();
    expect(rows()).toContain('table');
  });
});

describe('media entries (A4, design 5.9)', () => {
  it('opens the picker with the query in place, then lands the file over it', () => {
    const start = vi.fn();
    const files: FileUploads = { prepare: vi.fn(() => ({ blocks: [pendingBlock('image', 'u1', 'a.png', '')], start })) };
    const { editor } = open([para('')], files);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/ima');
    const input = screen.getByTestId('doc-media-file-input') as HTMLInputElement;
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    press(editor, 'Enter');
    expect(input.click).toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(textOf(editor, id)).toBe('/ima');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(read(editor).some((block) => block.type === 'image')).toBe(true);
    expect(textOf(editor, id)).toBe('');
  });
});

describe('undo after a pick (A8)', () => {
  it('takes one undo back to the line with the query on it', () => {
    const { editor, manager } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/he');
    press(editor, 'Enter');
    expect(read(editor)[0]?.type).toBe('heading');
    act(() => {
      manager.undo();
    });
    expect(read(editor)[0]?.type).toBe('paragraph');
    expect(textOf(editor, read(editor)[0]!.id)).toBe('/he');
  });

  it('takes one undo back from a table to the line with the query on it', () => {
    const { editor, manager } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/tab');
    press(editor, 'Enter');
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(true);
    act(() => {
      manager.undo();
    });
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
    expect(textOf(editor, read(editor)[0]!.id)).toBe('/tab');
  });

  it('takes one undo back from landed media to the line with the query on it', () => {
    const start = vi.fn();
    const files: FileUploads = { prepare: vi.fn(() => ({ blocks: [pendingBlock('image', 'u1', 'a.png', '')], start })) };
    const { editor, manager } = open([para('')], files);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/ima');
    const input = screen.getByTestId('doc-media-file-input') as HTMLInputElement;
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    press(editor, 'Enter');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(read(editor).some((block) => block.type === 'image')).toBe(true);
    act(() => {
      manager.undo();
    });
    expect(read(editor).some((block) => block.type === 'image')).toBe(false);
    expect(textOf(editor, id)).toBe('/ima');
  });
});

describe('a space right after the trigger (design 5.3)', () => {
  it('closes the menu and leaves what was typed', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/ ');
    expect(menu()).toBeNull();
    expect(textOf(editor, id)).toBe('/ ');
  });

  it('opens a fresh menu on a slash typed after it', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/ ');
    expect(menu()).toBeNull();
    type(editor, '/');
    expect(textOf(editor, id)).toBe('/ /');
    expect(rows()).toEqual([
      'heading-1', 'heading-2', 'heading-3', 'code-block', 'bullet-list', 'task-list', 'ordered-list', 'quote',
      'divider', 'table', 'columns', 'formula',
    ]);
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
  });

  it('lets Enter break the line after a slash typed between words', () => {
    for (const words of ['1 / 2', 'and / or']) {
      const { editor } = open([para(words.slice(0, words.indexOf('/') - 1))]);
      const id = read(editor)[0]!.id;
      caretAtEnd(editor, id);
      type(editor, words.slice(words.indexOf('/') - 1));
      expect(menu()).toBeNull();
      press(editor, 'Enter');
      expect(textOf(editor, id)).toBe(words);
      expect(read(editor)).toHaveLength(2);
      for (const editorShown of mounted.splice(0)) editorShown.unmount();
      document.body.innerHTML = '';
    }
  });
});

describe('a line break made by Shift+Enter (design 5.7)', () => {
  it('closes the menu once the caret crosses it, and Enter breaks the line again', () => {
    const { editor } = open([para('abc ')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const view = editor.prosemirrorView!;
    act(() => {
      const end = view.state.selection.from;
      const tr = view.state.tr.insert(end, [view.state.schema.nodes['hardBreak']!.create(), view.state.schema.text('tail')]);
      tr.setSelection(TextSelection.create(tr.doc, end));
      view.dispatch(tr);
    });
    type(editor, '/');
    expect(menu()).not.toBeNull();
    act(() => {
      const at = view.state.selection.from + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    });
    expect(menu()).toBeNull();
    press(editor, 'Enter');
    expect(read(editor)).toHaveLength(2);
  });
});

/** The position `offset` characters into the text node that reads `words`. */
function textAt(editor: Editor, words: string, offset: number): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node: PMNode, pos: number) => {
    if (found < 0 && node.isText && node.text === words) found = pos + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no text reads "${words}"`);
  return found;
}

/** Selects from one position to another, as a drag does. */
function selectBetween(editor: Editor, anchor: number, head: number): void {
  const view = editor.prosemirrorView!;
  act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  });
}

describe('a trigger typed over a selection (design 5.1)', () => {
  it('opens the menu over a selection run across columns from a line start', () => {
    const { editor } = open([columnsBlock(['hello'], ['world'])]);
    selectBetween(editor, textAt(editor, 'hello', 0), textAt(editor, 'world', 3));
    type(editor, '/');
    expect(menu()).not.toBeNull();
  });

  it('types the slash over a selection run across columns from inside a word, with no menu', () => {
    const { editor } = open([columnsBlock(['hello'], ['world'])]);
    selectBetween(editor, textAt(editor, 'hello', 2), textAt(editor, 'world', 3));
    type(editor, '/');
    expect(menu()).toBeNull();
    let typed = '';
    editor.prosemirrorState.doc.descendants((node: PMNode) => {
      if (node.isText) typed += node.text;
      return true;
    });
    expect(typed).toBe('he/ld');
  });

  it('opens the menu over a selection that takes a table whole, from a line start', () => {
    const { editor } = open([para('lead'), tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }), para('below')]);
    selectBetween(editor, textAt(editor, 'lead', 0), textAt(editor, 'a2', 1));
    type(editor, '/');
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
    expect(menu()).not.toBeNull();
  });

  it('opens the menu where the replaced words began after a space', () => {
    const { editor } = open([para('say hello')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const view = editor.prosemirrorView!;
    act(() => {
      const end = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 5, end)));
    });
    type(editor, '/');
    expect(textOf(editor, id)).toBe('say /');
    expect(menu()).not.toBeNull();
  });
});

describe('a trigger an input method commits (design 5.1)', () => {
  it('opens the menu once the composition ends, with one trigger in the line', async () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.insertText('、'));
    });
    expect(menu()).toBeNull();
    await act(async () => {
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '、' }));
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
    expect(menu()).not.toBeNull();
    expect(textOf(editor, id)).toBe('、');
  });
  it('writes nothing to the line when it opens, so one undo takes the committed trigger out', async () => {
    const { editor, manager } = open([para('ab ')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.insertText('、'));
    });
    // The user paused while the input method still showed the trigger.
    manager.stopCapturing();
    const steps = manager.undoStack.length;
    await act(async () => {
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '、' }));
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
    expect(menu()).not.toBeNull();
    expect(manager.undoStack.length).toBe(steps);
    act(() => {
      manager.undo();
    });
    expect(textOf(editor, id)).toBe('ab ');
  });

  it('opens a new menu for a trigger committed while another menu is open', async () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const view = editor.prosemirrorView!;
    const commit = async (): Promise<void> => {
      act(() => {
        view.dispatch(view.state.tr.insertText('、'));
      });
      await act(async () => {
        view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '、' }));
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      });
    };
    await commit();
    // A query with a space in it that still matches keeps this menu open.
    type(editor, 'heading ');
    expect(rows()).toContain('heading-1');
    await commit();
    expect(textOf(editor, id)).toBe('、heading 、');
    expect(screen.queryByTestId('doc-slash-empty')).toBeNull();
    expect(rows()).toContain('table');
  });
});
