// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A table opened full screen (#1427, design §5.3-§5.5): the state the
 * full-screen plugin keeps, how the caret and every local write stay inside
 * the table, and the ways full screen ends on its own.
 *
 * TDD: red because there is no full-screen plugin yet.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import { selectedThreadsIn } from '@web/spaces/document/document-comment-selection';
import { deleteRowAt } from '@web/spaces/document/document-table-run';
import { pressTargetOf } from '@web/spaces/document/document-body-press';
import { insertAiAnswer, replaceAiAnswer } from '@web/spaces/document/document-ai-text';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import { aiCapture } from '@web/spaces/document/document-ai-launch';
import { setLinkToolbarUp } from '@web/spaces/document/document-bars';
import {
  clearFullscreenReturn,
  leaveFullscreenForWrite,
  setTableFullscreen,
  tableFullscreenIn,
} from '@web/spaces/document/document-table-fullscreen';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const managers = new Map<Editor, Y.UndoManager>();

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * Mounts an editor on a document.
 * @param doc - The document.
 * @param onFiles - Where dropped files go.
 * @returns The editor.
 */
function mount(doc: Y.Doc, onFiles?: (arrival: unknown) => void): Editor {
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
    ...(onFiles === undefined ? {} : { onFiles: onFiles as never }),
  });
  managers.set(editor, manager);
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

/**
 * Opens an editor holding these blocks.
 * @param blocks - The body.
 * @param onFiles - Where dropped files go.
 * @returns The editor and its document.
 */
function open(blocks: readonly unknown[], onFiles?: (arrival: unknown) => void): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc();
  const editor = mount(doc, onFiles);
  editor.replaceBlocks(editor.document, blocks as never);
  // Close the undo unit the body was built in, or undo takes it back too.
  managers.get(editor)!.stopCapturing();
  return { editor, doc };
}

/** A two by two table between two paragraphs. */
const BETWEEN = [
  { type: 'paragraph', content: 'Before' },
  tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
  { type: 'paragraph', content: 'After' },
];

/** A two by two table that ends the body. */
const LAST = [
  { type: 'paragraph', content: 'Before' },
  tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
];

/**
 * The first table in the body.
 * @param doc - The document.
 * @returns Its position, node and block id.
 */
function tableIn(doc: PMNode): { pos: number; node: PMNode; id: string } {
  let found: { pos: number; node: PMNode; id: string } | undefined;
  doc.descendants((node, pos) => {
    if (found === undefined && node.type.name === 'docTable') found = { pos, node, id: String(node.attrs['id']) };
    return found === undefined;
  });
  if (found === undefined) throw new Error('no table in the body');
  return found;
}

/**
 * Where the words of a text block start.
 * @param doc - The document.
 * @param words - The block's text.
 * @returns The position.
 */
function wordsAt(doc: PMNode, words: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === words) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no block reads ${words}`);
  return at;
}

/**
 * The positions before the table's cells, in order.
 * @param doc - The document.
 * @returns Them.
 */
function cellsIn(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') out.push(pos);
    return true;
  });
  return out;
}

/**
 * Whether both ends of the selection sit in the table's cells.
 * @param editor - The editor.
 * @returns True when the selection is inside the table.
 */
function selectionInTable(editor: Editor): boolean {
  const { doc, selection } = editor.prosemirrorState;
  const table = tableIn(doc);
  const inside = (pos: number): boolean => {
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const name = $pos.node(depth).type.name;
      if (name === 'docTableCell' || name === 'docTableHeader') return $pos.before(depth) > table.pos;
    }
    return false;
  };
  if (selection instanceof CellSelection) return inside(selection.$anchorCell.pos + 1) && inside(selection.$headCell.pos + 1);
  return inside(selection.anchor) && inside(selection.head);
}

/**
 * Opens the first table full screen.
 * @param editor - The editor.
 * @returns The table's id.
 */
function enter(editor: Editor): string {
  const { id } = tableIn(editor.prosemirrorState.doc);
  setTableFullscreen(editor, { table: id, scrollTop: 120, offset: 40 });
  return id;
}

/**
 * Presses a key in the body, the way the browser hands it over.
 * @param editor - The editor.
 * @param init - The key.
 * @returns The event, to read whether something took it.
 */
function press(editor: Editor, init: KeyboardEventInit): KeyboardEvent {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
  return event;
}

/**
 * Puts the caret at a position.
 * @param editor - The editor.
 * @param at - The position.
 */
function caretAt(editor: Editor, at: number): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

describe('entering full screen', () => {
  it('records the table and where the body was scrolled', () => {
    const { editor } = open(BETWEEN);

    const id = enter(editor);

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: id, scrollTop: 120, offset: 40 });
  });

  it('puts a caret that was outside the table at the start of its first cell', () => {
    const { editor } = open(BETWEEN);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'After'));

    enter(editor);

    expect(editor.prosemirrorState.selection.from).toBe(wordsAt(editor.prosemirrorState.doc, 'a1'));
  });

  it('keeps a caret that was already in the table', () => {
    const { editor } = open(BETWEEN);
    const inB2 = wordsAt(editor.prosemirrorState.doc, 'b2') + 1;
    caretAt(editor, inB2);

    enter(editor);

    expect(editor.prosemirrorState.selection.from).toBe(inB2);
  });

  it('leaves the document as it was', () => {
    const { editor } = open(BETWEEN);
    const before = editor.prosemirrorState.doc;

    enter(editor);

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });
});

describe('the caret in full screen', () => {
  it('goes back into the table when a local selection lands outside it', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const inA2 = wordsAt(editor.prosemirrorState.doc, 'a2') + 1;
    caretAt(editor, inA2);

    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'After'));

    expect(editor.prosemirrorState.selection.from).toBe(inA2);
  });

  it('takes every cell of the table on a select-all', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    const { selection } = editor.prosemirrorState;
    expect(selection).toBeInstanceOf(CellSelection);
    const cells = cellsIn(editor.prosemirrorState.doc);
    const covered: number[] = [];
    (selection as CellSelection).forEachCell((_node, pos) => covered.push(pos));
    expect(covered).toEqual(cells);
  });

  it('stays in the table when ArrowDown leaves the last row of a table that ends the body', () => {
    const { editor } = open(LAST);
    enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a2') + 2);
    const before = editor.prosemirrorState.doc;

    press(editor, { key: 'ArrowDown' });
    press(editor, { key: 'ArrowDown' });

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
    expect(selectionInTable(editor)).toBe(true);
  });

  it('stays in the table on Shift-ArrowDown out of the last row', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a2') + 2);

    press(editor, { key: 'ArrowDown', shiftKey: true });
    press(editor, { key: 'ArrowDown', shiftKey: true });

    expect(selectionInTable(editor)).toBe(true);
  });
});

describe('local writes in full screen', () => {
  it('refuses a transaction that writes outside the table', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;
    const before = view.state.doc;

    view.dispatch(view.state.tr.insertText('X', wordsAt(view.state.doc, 'After')));

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('lets typing in a cell through', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.insertText('X', wordsAt(view.state.doc, 'a1')));

    expect(tableIn(editor.prosemirrorState.doc).node.textContent).toContain('Xa1');
  });

  it('leaves the document as it was on Shift-Mod-ArrowDown over words in two cells, which moves the whole table in the body', () => {
    /**
     * Selects from a1 into b2 and presses Shift-Mod-ArrowDown.
     * @param editor - The editor.
     */
    const moveDown = (editor: Editor): void => {
      const view = editor.prosemirrorView!;
      const { doc } = view.state;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, wordsAt(doc, 'a1') + 1, wordsAt(doc, 'b2') + 1)));
      press(editor, { key: 'ArrowDown', shiftKey: true, ctrlKey: true });
    };
    const body = open(BETWEEN).editor;
    const unmoved = body.prosemirrorState.doc;
    moveDown(body);
    expect(body.prosemirrorState.doc.eq(unmoved)).toBe(false);

    const { editor } = open(BETWEEN);
    enter(editor);
    const before = editor.prosemirrorState.doc;

    moveDown(editor);

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('keeps everything outside the table, whatever keys are pressed in it', () => {
    const keys: KeyboardEventInit[] = [
      { key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'ArrowLeft' }, { key: 'ArrowRight' },
      { key: 'ArrowUp', shiftKey: true }, { key: 'ArrowDown', shiftKey: true },
      { key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'Enter' }, { key: 'Backspace' }, { key: 'Delete' },
      { key: 'a', metaKey: true }, { key: 'a', ctrlKey: true },
      { key: 'ArrowDown', shiftKey: true, metaKey: true }, { key: 'ArrowUp', shiftKey: true, metaKey: true },
      { key: 'Home', shiftKey: true }, { key: 'End', shiftKey: true },
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...keys), { minLength: 1, maxLength: 12 }), fc.boolean(), (sequence, last) => {
        const { editor } = open(last ? LAST : BETWEEN);
        enter(editor);
        caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a1') + 1);
        const outside = (doc: PMNode): string[] => {
          const out: string[] = [];
          doc.forEach((node) => {
            if (node.type.name !== 'blockGroup') out.push(node.toString());
          });
          const group = doc.firstChild!;
          group.forEach((node) => {
            if (node.type.name !== 'docTable') out.push(node.toString());
          });
          return out;
        };
        const before = outside(editor.prosemirrorState.doc);

        sequence.forEach((init) => press(editor, init));

        const result = outside(editor.prosemirrorState.doc);
        editor.unmount();
        mounted.splice(mounted.indexOf(editor), 1);
        return JSON.stringify(result) === JSON.stringify(before);
      }),
      { numRuns: 60 },
    );
  });
});

describe('drops in full screen', () => {
  /**
   * A drag event carrying these strings and files.
   * @param type - The event type.
   * @param data - Strings by type.
   * @param files - Files.
   * @returns The event.
   */
  function dragOf(type: 'dragover' | 'drop', data: Record<string, string>, files: File[] = []): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: files as unknown as FileList,
        types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
        items: [] as unknown as DataTransferItemList,
        getData: (kind: string) => data[kind] ?? '',
        dropEffect: 'none',
        effectAllowed: 'all',
      },
    });
    return event;
  }

  it('takes a file dropped on a cell and hands nothing to the uploads', () => {
    const sink = vi.fn();
    const { editor } = open(BETWEEN, sink);
    enter(editor);
    const view = editor.prosemirrorView!;
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: wordsAt(view.state.doc, 'a1') + 1, inside: -1 });
    const before = view.state.doc;
    const event = dragOf('drop', {}, [new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })]);

    view.dom.firstElementChild!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(sink).not.toHaveBeenCalled();
    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('takes a block dragged from the body onto a cell and writes nothing', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: wordsAt(view.state.doc, 'a1') + 1, inside: -1 });
    const after = wordsAt(view.state.doc, 'After');
    view.dragging = { slice: view.state.doc.slice(after - 1, after + 'After'.length + 1), move: true } as never;
    const before = view.state.doc;
    const event = dragOf('drop', { 'text/html': '<p>After</p>', 'text/plain': 'After' });

    view.dom.firstElementChild!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
    view.dragging = null;
  });

  it('takes outside content dropped on a cell and writes nothing', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: wordsAt(view.state.doc, 'a1') + 1, inside: -1 });
    const before = view.state.doc;
    const event = dragOf('drop', { 'text/html': '<p>dropped</p>', 'text/plain': 'dropped' });

    view.dom.firstElementChild!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });
});

describe('Escape in a cell', () => {
  it('ends full screen and remembers the table to return to', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a1') + 1);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    // Through the view, which marks a key its handlers take.
    editor.prosemirrorView!.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'table', id, offset: 40 } });
  });

  it('leaves full screen alone while an input method is composing', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a1') + 1);

    press(editor, { key: 'Escape', isComposing: true });
    press(editor, { key: 'Escape', keyCode: 229 });

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('leaves full screen alone for an Escape something else already took', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a1') + 1);
    const view = editor.prosemirrorView!;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();

    view.someProp('handleKeyDown', (handler) => handler(view, event));

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });
});

describe('leaving full screen by command', () => {
  it('remembers the table and its distance from the top', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);

    setTableFullscreen(editor, null);

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'table', id, offset: 40 } });
  });

  it('forgets where to return once the shell has scrolled there', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    setTableFullscreen(editor, null);
    expect(tableFullscreenIn(editor.prosemirrorState)).not.toEqual({ table: null, returnTo: null });

    clearFullscreenReturn(editor);

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: null });
  });

  it('lets writes outside the table through again', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    setTableFullscreen(editor, null);
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.insertText('X', wordsAt(view.state.doc, 'After')));

    expect(editor.prosemirrorState.doc.textContent).toContain('XAfter');
  });
});

describe('the table going away in full screen', () => {
  it('ends full screen when its last row is deleted, back to the scroll position at entry', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'Before' },
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }] }),
      { type: 'paragraph', content: 'After' },
    ]);
    enter(editor);

    deleteRowAt(editor as never, cellsIn(editor.prosemirrorState.doc)[0]!);

    expect(editor.prosemirrorState.doc.textContent).not.toContain('a1');
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });

  it('ends full screen when the last row of an indented table, alone in its group, is deleted', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'Parent', children: [tableBlock({ rows: [{ cells: ['a1', 'b1'] }] })] },
      { type: 'paragraph', content: 'After' },
    ]);
    enter(editor);

    deleteRowAt(editor as never, cellsIn(editor.prosemirrorState.doc)[0]!);

    expect(editor.prosemirrorState.doc.textContent).not.toContain('a1');
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });

  it('ends full screen when a collaborator deletes the table', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') Y.applyUpdate(b, update, 'peer');
    });
    b.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') Y.applyUpdate(a, update, 'peer');
    });
    const ours = mount(a);
    const theirs = mount(b);
    ours.replaceBlocks(ours.document, BETWEEN as never);
    const id = enter(ours);

    theirs.removeBlocks([id]);

    expect(ours.prosemirrorState.doc.textContent).not.toContain('a1');
    expect(tableFullscreenIn(ours.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });
});

describe('undo in full screen', () => {
  it('ends full screen when it takes back an edit outside the table, leaving the caret where undo put it', () => {
    const { editor } = open(BETWEEN);
    const view = editor.prosemirrorView!;
    const after = wordsAt(view.state.doc, 'After');
    caretAt(editor, after);
    view.dispatch(view.state.tr.insertText('X', after));
    managers.get(editor)!.stopCapturing();
    enter(editor);

    editor.undo();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('XAfter');
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'selection' } });
    expect(selectionInTable(editor)).toBe(false);
  });

  it('keeps full screen when it takes back an edit in the table', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('X', wordsAt(view.state.doc, 'a1')));

    editor.undo();

    expect(tableIn(editor.prosemirrorState.doc).node.textContent).not.toContain('Xa1');
    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('still records edits after full screen opens and closes', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    setTableFullscreen(editor, null);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('X', wordsAt(view.state.doc, 'b2')));

    editor.undo();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('Xb2');
  });
});

describe('a press on a comment highlight in full screen', () => {
  it('only places the caret, so the comment panel stays shut', async () => {
    const doc = new Y.Doc();
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(doc),
      comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, BETWEEN as never);
    const view = editor.prosemirrorView!;
    const a1 = wordsAt(view.state.doc, 'a1');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from: a1, to: a1 + 2 }]));
    await postComment(editor, 'said something');
    enter(editor);

    view.someProp('handleClick', (handler) => handler(view, a1 + 1, new MouseEvent('mousedown', { button: 0 })));

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([]);
  });
});

describe('a write aimed from outside the editor, such as the AI dialog\'s', () => {
  it('keeps full screen when it lands inside one cell', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const a1 = wordsAt(editor.prosemirrorState.doc, 'a1');

    leaveFullscreenForWrite(editor, { from: a1, to: a1 + 2 }, a1);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('ends full screen first when it is aimed at the whole table', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const { pos, node } = tableIn(editor.prosemirrorState.doc);

    leaveFullscreenForWrite(editor, { from: pos, to: pos + node.nodeSize }, pos);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBeNull();
  });

  it('ends full screen first when it is aimed outside the table', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const after = wordsAt(editor.prosemirrorState.doc, 'After');

    leaveFullscreenForWrite(editor, { from: after, to: after + 5 }, after);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBeNull();
  });

  it('does nothing in the body', () => {
    const { editor } = open(BETWEEN);
    const after = wordsAt(editor.prosemirrorState.doc, 'After');

    leaveFullscreenForWrite(editor, { from: after, to: after + 5 }, after);

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: null });
  });
});

describe('round 1 of the implementation review (#1427)', () => {
  it('takes every cell on a select-all when a cell merged down covers the last column', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'Before' },
      tableBlock({ rows: [{ cells: ['A', { content: 'B', props: { rowspan: 2 } }] }, { cells: ['C'] }] }),
    ]);
    enter(editor);
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    const covered: string[] = [];
    (editor.prosemirrorState.selection as CellSelection).forEachCell((node) => covered.push(node.textContent));
    expect(covered.sort()).toEqual(['A', 'B', 'C']);
  });

  it('ends full screen, without throwing, when the table is left with no cells', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;
    const tr = view.state.tr;
    [...cellsIn(view.state.doc)].reverse().forEach((pos) => {
      tr.delete(pos, pos + view.state.doc.nodeAt(pos)!.nodeSize);
    });

    expect(() => view.dispatch(tr)).not.toThrow();

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });

  it('shows a dragover as nothing to drop', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    const dataTransfer = { dropEffect: 'copy', types: ['Files'], files: [], items: [], getData: () => '' };
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });

    editor.prosemirrorView!.dom.firstElementChild!.dispatchEvent(event);

    expect(dataTransfer.dropEffect).toBe('none');
  });

  it('leaves full screen alone for the Escape that comes right after an input method ends', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    caretAt(editor, wordsAt(editor.prosemirrorState.doc, 'a1') + 1);

    editor.prosemirrorView!.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    press(editor, { key: 'Escape' });

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('lets the AI dialog and the link toolbar take an Escape typed in a cell', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const view = editor.prosemirrorView!;
    const a1 = wordsAt(view.state.doc, 'a1');
    caretAt(editor, a1 + 1);

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, { range: { from: a1, to: a1 + 2 }, firstId: null, lastId: null, insertId: 'x' }));
    press(editor, { key: 'Escape' });
    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, null));
    setLinkToolbarUp(editor, true);
    press(editor, { key: 'Escape' });
    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
    setLinkToolbarUp(editor, false);
  });

  it('keeps the caret in the table when a collaborator moves the block above it past it', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') Y.applyUpdate(b, update, 'peer');
    });
    b.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') Y.applyUpdate(a, update, 'peer');
    });
    const ours = mount(a);
    const theirs = mount(b);
    ours.replaceBlocks(ours.document, BETWEEN as never);
    const id = enter(ours);
    caretAt(ours, wordsAt(ours.prosemirrorState.doc, 'b2') + 1);

    caretAt(theirs, wordsAt(theirs.prosemirrorState.doc, 'Before'));
    press(theirs, { key: 'ArrowDown', shiftKey: true, ctrlKey: true });

    expect((ours.document as unknown as { type: string }[]).map((block) => block.type)[0]).toBe('docTable');
    expect(tableFullscreenIn(ours.prosemirrorState).table).toBe(id);
    expect(selectionInTable(ours)).toBe(true);
  });
});

describe('cases design section 6 names (#1427)', () => {
  it('ends full screen, back to the scroll position at entry, when undo takes back inserting the table', () => {
    const { editor } = open([{ type: 'paragraph', content: 'Before' }]);
    editor.insertBlocks([tableBlock({ rows: [{ cells: ['a1', 'b1'] }] })] as never, (editor.document as { id: string }[])[0]!.id, 'after');
    managers.get(editor)!.stopCapturing();
    enter(editor);

    expect(() => editor.undo()).not.toThrow();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('a1');
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });

  it('ends full screen, without throwing, when the table is the only block and its last row is deleted', () => {
    const { editor } = open([tableBlock({ rows: [{ cells: ['a1', 'b1'] }] })]);
    enter(editor);

    expect(() => deleteRowAt(editor as never, cellsIn(editor.prosemirrorState.doc)[0]!)).not.toThrow();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('a1');
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'scrollTop', value: 120 } });
  });

  it('keeps a selection running between two cells, the one Shift and a click make', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const view = editor.prosemirrorView!;
    const cells = cellsIn(view.state.doc);

    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[3]!)));

    const { selection } = editor.prosemirrorState;
    expect(selection).toBeInstanceOf(CellSelection);
    expect([(selection as CellSelection).$anchorCell.pos, (selection as CellSelection).$headCell.pos]).toEqual([cells[0], cells[3]]);
    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });
});

describe('a press in full screen (#1427)', () => {
  it('reads a press on a cell as on its words, with the blocks around the table hidden and measuring nothing', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const view = editor.prosemirrorView!;
    const words = view.dom.querySelector('td p, td [data-content-type]') ?? view.dom.querySelector('td')!;
    const event = new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 10 });
    Object.defineProperty(event, 'target', { value: words });

    expect(pressTargetOf(view, event).kind).not.toBe('edge');
  });
});

describe('a write that ends full screen (#1427)', () => {
  it('records where the write starts, to be brought into view', () => {
    const { editor } = open(BETWEEN);
    enter(editor);
    const { pos, node } = tableIn(editor.prosemirrorState.doc);

    leaveFullscreenForWrite(editor, { from: pos, to: pos + node.nodeSize }, pos + node.nodeSize);

    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'write', at: pos + node.nodeSize } });
  });

  it('keeps full screen for a write inside one cell', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const at = wordsAt(editor.prosemirrorState.doc, 'a1');

    leaveFullscreenForWrite(editor, { from: at, to: at + 2 }, at);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });
});

describe('an AI answer that writes nothing (#1427)', () => {
  it('leaves the table open full screen', () => {
    const { editor } = open(BETWEEN);
    const id = enter(editor);
    const after = (editor.document as unknown as { id: string }[]).at(-1)!.id;

    const result = insertAiAnswer({ editor } as never, after, { preview: [], leftOut: 0 } as never, () => ({ available: true, writeAccess: 'granted' }));

    expect(result.outcome).toBe('nothingWritten');
    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });
});

describe('an AI answer written over words outside a full-screen table (#1427)', () => {
  it('ends full screen, recording where the answer starts', () => {
    const { editor } = open(BETWEEN);
    const view = editor.prosemirrorView!;
    let before = -1;
    view.state.doc.descendants((node, pos) => {
      if (before === -1 && node.isText && node.text === 'Before') before = pos;
      return before === -1;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, before, before + 6)));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, aiCapture(view.state)));
    enter(editor);

    replaceAiAnswer({ editor } as never, { preview: [{ type: 'paragraph', content: [{ type: 'text', text: 'Written', styles: {} }] }], leftOut: 0 } as never, () => ({ available: true, writeAccess: 'granted' }));

    let written = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (written === -1 && node.isText && node.text?.startsWith('Written') === true) written = pos;
      return written === -1;
    });
    expect(written).toBeGreaterThan(-1);
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'write', at: written } });
  });
});

describe('an AI answer written below a full-screen table (#1427)', () => {
  it('ends full screen, recording where the answer starts', () => {
    const { editor } = open(BETWEEN);
    const tableId = (editor.document as unknown as { id: string; type: string }[]).find((block) => block.type === 'docTable')!.id;
    enter(editor);

    insertAiAnswer({ editor } as never, tableId, { preview: [{ type: 'paragraph', content: [{ type: 'text', text: 'Written', styles: {} }] }], leftOut: 0 } as never, () => ({ available: true, writeAccess: 'granted' }));

    const doc = editor.prosemirrorState.doc;
    let written = -1;
    doc.descendants((child, at) => {
      if (written === -1 && child.type.isInGroup('bnBlock') && child.textContent === 'Written') written = at;
      return written === -1;
    });
    expect(written).toBeGreaterThan(-1);
    expect(tableFullscreenIn(editor.prosemirrorState)).toEqual({ table: null, returnTo: { kind: 'write', at: written } });
  });
});

