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

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { pendingBlock, type FileUploads } from '@web/spaces/document/document-uploads';
import { DocumentMediaPicker } from '@web/spaces/document/DocumentMediaPicker';
import { DocumentSlashMenu } from '@web/spaces/document/DocumentSlashMenu';
import { para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

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
    fireEvent.mouseMove(screen.getByTestId('doc-slash-row-heading-3'), { movementX: 1 });
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

    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'));
    fireEvent.mouseDown(screen.getByTestId('doc-slash-table-size-2-2'), { button: 2 });
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
  });

  it('picks nothing on a press with Control held, the secondary click on a Mac', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-heading-3'), { button: 0, ctrlKey: true });
    expect(read(editor)[0]?.type).toBe('paragraph');
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'));
    fireEvent.mouseDown(screen.getByTestId('doc-slash-table-size-2-2'), { button: 0, ctrlKey: true });
    expect(read(editor).some((block) => block.type === 'docTable')).toBe(false);
  });

  it('leaves the page taking the pointer when a grid opened by hover is reopened from the keyboard', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/tab');
    fireEvent.mouseMove(screen.getByTestId('doc-slash-row-table'), { movementX: 1 });
    expect(screen.queryByTestId('doc-slash-table-grid')).not.toBeNull();
    press(editor, 'Escape');
    expect(screen.queryByTestId('doc-slash-table-grid')).toBeNull();
    press(editor, 'ArrowRight');
    expect(screen.queryByTestId('doc-slash-table-grid')).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
  });

  it('lights Table when the pointer moving on it opens the grid', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    const table = screen.getByTestId('doc-slash-row-table');
    fireEvent.mouseMove(table, { movementX: 1 });
    expect(screen.queryByTestId('doc-slash-table-grid')).not.toBeNull();
    press(editor, 'Escape');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    expect(table.hasAttribute('data-highlighted')).toBe(false);
    fireEvent.mouseMove(table, { movementX: 1 });
    expect(screen.queryByTestId('doc-slash-table-grid')).not.toBeNull();
    expect(table.hasAttribute('data-highlighted')).toBe(true);
  });

  it('lights nothing when a row only comes under a pointer that has not moved', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseEnter(screen.getByTestId('doc-slash-row-quote'));
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
    fireEvent.mouseEnter(screen.getByTestId('doc-slash-row-table'));
    expect(screen.queryByTestId('doc-slash-table-grid')).toBeNull();
  });

  it('keeps the lit size when Table is pressed with the grid open', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/tab');
    press(editor, 'Enter');
    press(editor, 'ArrowRight');
    expect(screen.getByTestId('doc-slash-table-size-1-2').hasAttribute('data-on')).toBe(true);
    fireEvent.mouseDown(screen.getByTestId('doc-slash-row-table'));
    expect(screen.getByTestId('doc-slash-table-size-1-2').hasAttribute('data-on')).toBe(true);
  });

  it('ignores a pointer move that stays where the pointer was', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    fireEvent.mouseMove(screen.getByTestId('doc-slash-row-heading-3'), { clientX: 10, clientY: 10, movementX: 1 });
    press(editor, 'ArrowDown');
    const lit = document.querySelector('[data-testid^="doc-slash-row-"][data-highlighted]');
    expect(lit?.getAttribute('data-testid')).not.toBe('doc-slash-row-heading-3');
    // WebKit sends this when the list scrolls under a pointer at rest.
    fireEvent.mouseMove(screen.getByTestId('doc-slash-row-heading-3'), { clientX: 10, clientY: 10 });
    expect(lit?.hasAttribute('data-highlighted')).toBe(true);
  });

  it('starts a menu opened by a second trigger on its first row', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    type(editor, ' /');
    expect(screen.getByTestId('doc-slash-row-heading-1').hasAttribute('data-highlighted')).toBe(true);
  });

  it('marks Table as opening a grid, as the insert menu does', () => {
    const { editor } = open([para('')]);
    caretAtEnd(editor, read(editor)[0]!.id);
    type(editor, '/');
    expect(screen.getByTestId('doc-slash-row-table').querySelector('.lucide-chevron-right')).not.toBeNull();
    expect(screen.getByTestId('doc-slash-row-heading-1').querySelector('.lucide-chevron-right')).toBeNull();
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
    expect(screen.queryByTestId('doc-slash-table-grid')).toBeNull();
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

describe('the table entry (A4, design 5.8)', () => {
  it('opens the size grid, moves across it with the arrows and inserts the size picked', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/table');
    press(editor, 'Enter');
    expect(screen.getByTestId('doc-slash-table-grid')).not.toBeNull();
    expect(textOf(editor, id)).toBe('/table');
    press(editor, 'ArrowRight');
    press(editor, 'ArrowDown');
    press(editor, 'Enter');
    const table = read(editor).find((block) => block.type !== 'paragraph') as
      | (ReadBlock & { children: { children: unknown[] }[] })
      | undefined;
    expect(table?.children).toHaveLength(2);
    expect(table?.children[0]?.children).toHaveLength(2);
  });

  it('goes back to the list on Escape and keeps what was typed', () => {
    const { editor } = open([para('')]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    type(editor, '/table');
    press(editor, 'Enter');
    press(editor, 'Escape');
    expect(screen.queryByTestId('doc-slash-table-grid')).toBeNull();
    expect(menu()).not.toBeNull();
    expect(textOf(editor, id)).toBe('/table');
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
});
