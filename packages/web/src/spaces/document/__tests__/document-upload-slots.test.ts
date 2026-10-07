// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A2, A4: where an upload's placeholder is drawn and where its
 * block lands. Both come from `resolveSlotPosition`, so a placeholder drawn at
 * one place and a block landing at another cannot happen; what these tests
 * hold is that the one answer is right — files keep the order they came in,
 * whichever finishes first, however the anchors moved meanwhile.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import {
  addUploadBatch,
  documentUploadsExtension,
  insertSlotBlock,
  removeUploadSlot,
  slotPositions,
  uploadSlots,
} from '@web/spaces/document/document-upload-slots';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
  children?: Seen[];
}

/**
 * Opens a focused editor holding A, B, C, with undo tracking on.
 * @param blocks - What the document starts with.
 * @returns The editor and its undo manager.
 */
function open(blocks: unknown[] = ABC): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension, documentUploadsExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.stopCapturing();
  editor.prosemirrorView!.focus();
  return { editor, manager };
}

const ABC = [
  { type: 'paragraph', content: 'A' },
  { type: 'paragraph', content: 'B' },
  { type: 'paragraph', content: 'C' },
];

/**
 * The id of the top-level block holding this text.
 * @param editor - The editor.
 * @param text - The block's text.
 * @returns Its id.
 */
function idOf(editor: Editor, text: string): string {
  return (editor.document as Seen[]).find(
    (b) => (b.content ?? []).map((c) => c.text ?? '').join('') === text,
  )!.id;
}

/**
 * The document as one entry per top-level block: its text, or its name for a
 * media block.
 * @param editor - The editor.
 * @returns The entries.
 */
function shape(editor: Editor): string[] {
  return (editor.document as Seen[]).map((b) =>
    b.type === 'paragraph'
      ? (b.content ?? []).map((c) => c.text ?? '').join('')
      : String(b.props['name']),
  );
}

/**
 * Lands one slot as an image block named after its file.
 * @param editor - The editor.
 * @param slotId - Which slot.
 * @param undo - The undo manager, when the test reads undo.
 * @returns The new block's id.
 */
function land(editor: Editor, slotId: string, undo?: Y.UndoManager): string | null {
  const name = uploadSlots(editor.prosemirrorView!.state).find((s) => s.id === slotId)?.name ?? '';
  return insertSlotBlock(
    editor.prosemirrorView!,
    slotId,
    { type: 'image', props: { url: `https://cdn.example/${name}`, name } },
    undo,
  );
}

/**
 * Every order three things can finish in.
 * @returns The six permutations of 0, 1, 2.
 */
function orders(): number[][] {
  return [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
}

const FILES = ['m1', 'm2', 'm3'];

describe('a batch of three files keeps its order (A2)', () => {
  it.each(orders())('between two blocks, finishing %i %i %i', (...order) => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: idOf(editor, 'A'), after: idOf(editor, 'B') },
      FILES,
    );
    order.forEach((k) => land(editor, ids[k]!));
    expect(shape(editor)).toEqual(['A', 'm1', 'm2', 'm3', 'B', 'C']);
  });

  it.each(orders())('at the head of the document, finishing %i %i %i', (...order) => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: null, after: idOf(editor, 'A') },
      FILES,
    );
    order.forEach((k) => land(editor, ids[k]!));
    expect(shape(editor)).toEqual(['m1', 'm2', 'm3', 'A', 'B', 'C']);
  });

  it.each(orders())('after the block before them is deleted, finishing %i %i %i', (...order) => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: idOf(editor, 'A'), after: idOf(editor, 'B') },
      FILES,
    );
    editor.removeBlocks([idOf(editor, 'A')]);
    order.forEach((k) => land(editor, ids[k]!));
    expect(shape(editor)).toEqual(['m1', 'm2', 'm3', 'B', 'C']);
  });
});

describe('a batch whose block after it is deleted once one file landed (A2)', () => {
  it('lands the rest after the file that landed, not at the end', () => {
    const { editor } = open();
    const ids = addUploadBatch(editor.prosemirrorView!, { before: null, after: idOf(editor, 'A') }, FILES);
    land(editor, ids[0]!);
    editor.removeBlocks([idOf(editor, 'A')]);

    land(editor, ids[2]!);
    land(editor, ids[1]!);

    expect(shape(editor)).toEqual(['m1', 'm2', 'm3', 'B', 'C']);
  });
});

describe('where the placeholder and the block go', () => {
  it('draws each placeholder exactly where its block then lands', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, FILES);
    land(editor, ids[1]!);

    const drawn = slotPositions(view.state).get(ids[0]!)!;
    const landedId = land(editor, ids[0]!)!;
    let landedAt = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.attrs['id'] === landedId) landedAt = pos;
      return landedAt < 0;
    });
    expect(landedAt).toBe(drawn);
  });

  it('goes before the block after it when a co-editor puts a block between the anchors', () => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: idOf(editor, 'A'), after: idOf(editor, 'B') },
      ['m1'],
    );
    editor.insertBlocks([{ type: 'paragraph', content: 'X' }] as never, idOf(editor, 'A'), 'after');

    land(editor, ids[0]!);

    expect(shape(editor)).toEqual(['A', 'X', 'm1', 'B', 'C']);
  });

  it('stays at its gap when the block after it is split with Enter', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B1B2' },
    ]);
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B1B2') }, ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'B1B2'), 'start');
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 2)));
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    view.someProp('handleKeyDown', (handler) => handler(view, event));
    expect(shape(editor)).toEqual(['A', 'B1', 'B2']);

    land(editor, ids[0]!);

    expect(shape(editor)).toEqual(['A', 'm1', 'B1', 'B2']);
  });

  it('goes to the end of the document when both anchors are gone', () => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: idOf(editor, 'A'), after: idOf(editor, 'B') },
      ['m1'],
    );
    editor.removeBlocks([idOf(editor, 'A'), idOf(editor, 'B')]);

    land(editor, ids[0]!);

    expect(shape(editor)).toEqual(['C', 'm1']);
  });

  it('lands as the first child when the block after it is a first child', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'R', children: [{ type: 'paragraph', content: 'C1' }] },
    ]);
    const parent = (editor.document as Seen[])[0]!;
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      { before: parent.id, after: parent.children![0]!.id },
      ['m1'],
    );

    land(editor, ids[0]!);

    const children = (editor.document as Seen[])[0]!.children!;
    expect(children.map((c) => c.type)).toEqual(['image', 'paragraph']);
  });
});

describe('landing a block leaves the reader where they are (A4)', () => {
  it('keeps the caret in the block being typed into', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');

    land(editor, ids[0]!);

    const { selection } = view.state;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.$head.parent.textContent).toBe('C');
    expect(selection.$head.parentOffset).toBe(1);
  });

  it('is one undo step of its own, apart from what was just typed', () => {
    const { editor, manager } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');
    view.dispatch(view.state.tr.insertText('!'));

    land(editor, ids[0]!, manager);
    manager.undo();

    expect(shape(editor)).toEqual(['A', 'B', 'C!']);
  });

  it('keeps what is typed straight after it out of its undo step', () => {
    const { editor, manager } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');

    land(editor, ids[0]!, manager);
    view.dispatch(view.state.tr.insertText('?'));
    manager.undo();

    expect(shape(editor)).toEqual(['A', 'm1', 'B', 'C']);
  });

  it('removes the placeholder of the file that landed, and only that one', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1', 'm2']);

    land(editor, ids[0]!);

    expect([...slotPositions(view.state).keys()]).toEqual([ids[1]]);
  });

  it('lands nothing for a slot that was removed', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1']);
    removeUploadSlot(view, ids[0]!);

    expect(land(editor, ids[0]!)).toBeNull();
    expect(shape(editor)).toEqual(['A', 'B', 'C']);
  });
});

describe('placeholders stay out of the shared document (A4)', () => {
  it('leaves the document untouched while files are uploading', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const before = view.state.doc;

    addUploadBatch(view, { before: idOf(editor, 'A'), after: idOf(editor, 'B') }, ['m1']);

    expect(view.state.doc.eq(before)).toBe(true);
  });
});
