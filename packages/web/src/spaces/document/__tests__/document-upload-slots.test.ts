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
import { TextSelection, type EditorState } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { mediaGapBelow } from '@web/spaces/document/document-insert-row';
import { textblocks, gapBefore } from './textblocks';
import {
  addUploadBatch,
  documentUploadsExtension,
  insertSlotBlock,
  patchUploadSlot,
  removeUploadSlot,
  documentUploadsKey,
  uploadSlots,
} from '@web/spaces/document/document-upload-slots';

type Editor = ReturnType<typeof buildDocumentEditor>;

/**
 * Where each waiting slot's placeholder is drawn, read off the decorations
 * the plugin hands the view.
 * @param state - The editor state.
 * @returns Slot id to position.
 */
function drawnAt(state: EditorState): Map<string, number> {
  const drawn = new Map<string, number>();
  documentUploadsKey.getState(state)!.decorations.find().forEach((widget) => {
    drawn.set((widget.spec as { key: string }).key, widget.from);
  });
  return drawn;
}

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
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'B')),
      FILES,
    );
    order.forEach((k) => land(editor, ids[k]!));
    expect(shape(editor)).toEqual(['A', 'm1', 'm2', 'm3', 'B', 'C']);
  });

  it.each(orders())('at the head of the document, finishing %i %i %i', (...order) => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'A')),
      FILES,
    );
    order.forEach((k) => land(editor, ids[k]!));
    expect(shape(editor)).toEqual(['m1', 'm2', 'm3', 'A', 'B', 'C']);
  });

  it.each(orders())('after the block before them is deleted, finishing %i %i %i', (...order) => {
    const { editor } = open();
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'B')),
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
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'A')), FILES);
    land(editor, ids[0]!);
    editor.removeBlocks([idOf(editor, 'A')]);

    land(editor, ids[2]!);
    land(editor, ids[1]!);

    expect(shape(editor)).toEqual(['m1', 'm2', 'm3', 'B', 'C']);
  });
});

/**
 * Two editors on two Yjs documents that relay every update to each other; only
 * the first carries the uploads.
 * @param blocks - What the document starts with.
 * @returns Mine and theirs.
 */
function pair(blocks: unknown[]): { mine: Editor; theirs: Editor } {
  const docs = [new Y.Doc(), new Y.Doc()];
  Y.applyUpdate(docs[0]!, encodeInitialSpaceContent('document'));
  docs.forEach((doc, i) => {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') Y.applyUpdate(docs[1 - i]!, update, 'relay');
    });
  });
  Y.applyUpdate(docs[1]!, Y.encodeStateAsUpdate(docs[0]!), 'relay');
  const [mine, theirs] = docs.map((doc, i) => {
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(doc),
      extensions: i === 0 ? [documentUploadsExtension()] : [],
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    return editor;
  });
  mine!.replaceBlocks(mine!.document, blocks as never);
  return { mine: mine!, theirs: theirs! };
}

describe('where the placeholder and the block go', () => {
  it('draws each placeholder exactly where its block then lands', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), FILES);
    land(editor, ids[1]!);

    const drawn = drawnAt(view.state).get(ids[0]!)!;
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
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'B')),
      ['m1'],
    );
    editor.insertBlocks([{ type: 'paragraph', content: 'X' }] as never, idOf(editor, 'A'), 'after');

    land(editor, ids[0]!);

    expect(shape(editor)).toEqual(['A', 'X', 'm1', 'B', 'C']);
  });

  it('stays at its gap when an edit by a co-editor arrives through Yjs', () => {
    const docs = [new Y.Doc(), new Y.Doc()];
    Y.applyUpdate(docs[0]!, encodeInitialSpaceContent('document'));
    docs.forEach((doc, i) => {
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'relay') Y.applyUpdate(docs[1 - i]!, update, 'relay');
      });
    });
    Y.applyUpdate(docs[1]!, Y.encodeStateAsUpdate(docs[0]!), 'relay');
    const [mine, theirs] = docs.map((doc, i) => {
      const editor = buildDocumentEditor({
        fragment: documentBodyFragment(doc),
        extensions: i === 0 ? [documentUploadsExtension()] : [],
      });
      const root = document.createElement('div');
      document.body.appendChild(root);
      editor.mount(root);
      mounted.push(editor);
      return editor;
    });
    mine!.replaceBlocks(mine!.document, ABC as never);
    const view = mine!.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(mine!, 'B')), ['m1']);

    theirs!.insertBlocks([{ type: 'paragraph', content: 'X' }] as never, idOf(theirs!, 'A'), 'before');
    theirs!.updateBlock(idOf(theirs!, 'B'), { content: 'B2' } as never);

    expect(shape(mine!)).toEqual(['X', 'A', 'B2', 'C']);
    let afterA = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.attrs['id'] === idOf(mine!, 'A')) afterA = pos + node.nodeSize;
      return afterA < 0;
    });
    expect(drawnAt(view.state).get(ids[0]!)).toBe(afterA);
    land(mine!, ids[0]!);
    expect(shape(mine!)).toEqual(['X', 'A', 'm1', 'B2', 'C']);
  });

  it('stays at its gap when the block after it is split with Enter', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B1B2' },
    ]);
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B1B2')), ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'B1B2'), 'start');
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 2)));
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    view.someProp('handleKeyDown', (handler) => handler(view, event));
    expect(shape(editor)).toEqual(['A', 'B1', 'B2']);

    land(editor, ids[0]!);

    expect(shape(editor)).toEqual(['A', 'm1', 'B1', 'B2']);
  });

  it('goes under the row, before its children, when a text delete merges a child into it', () => {
    const { editor } = open([
      {
        type: 'paragraph',
        content: 'Qqq',
        children: [
          { type: 'paragraph', content: 'C1' },
          { type: 'paragraph', content: 'C2c' },
          { type: 'paragraph', content: 'C3' },
        ],
      },
    ]);
    const kids = (editor.document as Seen[])[0]!.children!;
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, kids[1]!.id),
      ['m1'],
    );
    const view = editor.prosemirrorView!;
    const blocks = textblocks(view.state.doc);
    // From inside "Qqq" to inside "C2c".
    view.dispatch(view.state.tr.delete(blocks[0]!.start + 1, blocks[2]!.start + 2));

    land(editor, slot!);

    const top = editor.document as Seen[];
    expect(top[0]!.children!.map((c) => c.type)).toEqual(['image', 'paragraph']);
  });

  it('stays at the drop when the row below the gap is moved away', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'P1' },
      { type: 'paragraph', content: 'P2' },
      { type: 'paragraph', content: 'P3' },
      { type: 'paragraph', content: 'P4' },
    ]);
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'P2')),
      ['m1'],
    );
    editor.setTextCursorPosition(idOf(editor, 'P2'), 'end');
    editor.moveBlocksDown();
    editor.moveBlocksDown();

    land(editor, slot!);

    expect(shape(editor)).toEqual(['P1', 'm1', 'P3', 'P4', 'P2']);
  });

  it('comes back between the rows when their deletion is undone', () => {
    const { editor, manager } = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B' },
      { type: 'paragraph', content: 'C' },
      { type: 'paragraph', content: 'D' },
    ]);
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'C')),
      ['m1'],
    );
    editor.removeBlocks([idOf(editor, 'B'), idOf(editor, 'C')]);
    manager.stopCapturing();
    manager.undo();

    land(editor, slot!);

    expect(shape(editor)).toEqual(['A', 'B', 'm1', 'C', 'D']);
  });

  it('stays at its gap when an edit made before it started is undone', () => {
    const { editor, manager } = open();
    editor.updateBlock(idOf(editor, 'C'), { content: 'Cxyz' } as never);
    manager.stopCapturing();
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'B')),
      ['m1'],
    );
    manager.undo();
    expect(shape(editor)).toEqual(['A', 'B', 'C']);

    land(editor, slot!);

    expect(shape(editor)).toEqual(['A', 'm1', 'B', 'C']);
  });

  it('stays at its gap when an edit undone before it started is redone', () => {
    const { editor, manager } = open();
    editor.updateBlock(idOf(editor, 'C'), { content: 'Cxyz' } as never);
    manager.stopCapturing();
    manager.undo();
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'B')),
      ['m1'],
    );
    manager.redo();
    expect(shape(editor)).toEqual(['A', 'B', 'Cxyz']);

    land(editor, slot!);

    expect(shape(editor)).toEqual(['A', 'm1', 'B', 'Cxyz']);
  });

  it('stays where the rows were when a co-editor deletes both rows beside it', () => {
    const { mine, theirs } = pair([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B' },
      { type: 'paragraph', content: 'C' },
      { type: 'paragraph', content: 'D' },
    ]);
    const view = mine.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(mine, 'C')), ['m1']);

    theirs.removeBlocks([idOf(theirs, 'B'), idOf(theirs, 'C')]);
    land(mine, slot!);

    expect(shape(mine)).toEqual(['A', 'm1', 'D']);
  });

  it('goes under the new empty line when Enter is pressed at the end of the row above it', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'A'), 'end');
    editor.insertBlocks([{ type: 'paragraph' }] as never, idOf(editor, 'A'), 'after');

    land(editor, slot!);

    expect(shape(editor)).toEqual(['A', '', 'm1', 'B', 'C']);
  });

  it('stays between the rows when the row below it changes type', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    const b = idOf(editor, 'B');
    editor.updateBlock(b, { type: 'heading' } as never);

    land(editor, slot!);

    const order = (editor.document as Seen[]).map((block) => (block.type === 'image' ? 'm1' : block.id));
    expect(order).toEqual([idOf(editor, 'A'), 'm1', b, idOf(editor, 'C')]);
  });

  it('stays just before the row below it when that row is indented under the row above', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'B'), 'start');
    editor.nestBlock();

    land(editor, slot!);

    const order: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'image') order.push('m1');
      else if (node.isTextblock) order.push(node.textContent);
      return true;
    });
    expect(order).toEqual(['A', 'm1', 'B', 'C']);
  });

  it('goes under the only line left when the rest of the body is deleted', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(editor, 'C')), ['m1']);
    editor.removeBlocks([idOf(editor, 'A'), idOf(editor, 'B')]);
    editor.replaceBlocks([idOf(editor, 'C')], [{ type: 'paragraph' }] as never);

    land(editor, slot!);

    expect((editor.document as Seen[]).map((b) => b.type)).toEqual(['paragraph', 'image']);
  });

  it('takes its quoting from the rows beside it when it lands, not from where it was dropped', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', props: { quoted: true }, content: 'Q1' },
      { type: 'paragraph', props: { quoted: true }, content: 'Q2' },
      { type: 'paragraph', content: 'D' },
    ]);
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(view, gapBefore(view.state.doc, idOf(editor, 'Q2')), ['m1']);
    editor.removeBlocks([idOf(editor, 'Q1'), idOf(editor, 'Q2')]);

    land(editor, slot!);

    const media = (editor.document as Seen[]).find((b) => b.type === 'image')!;
    expect(media.props['quoted']).toBe(false);
  });

  it('stays where the gap was when both rows beside it are deleted', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'A' },
      { type: 'paragraph', content: 'B' },
      { type: 'paragraph', content: 'C' },
      { type: 'paragraph', content: 'D' },
    ]);
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'C')),
      ['m1'],
    );
    editor.removeBlocks([idOf(editor, 'B'), idOf(editor, 'C')]);

    land(editor, slot!);

    expect(shape(editor)).toEqual(['A', 'm1', 'D']);
  });

  it('stays at the head of a nested level when the row made for it is deleted', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'R', children: [{ type: 'paragraph', content: 'C1' }] },
      { type: 'paragraph', content: 'D' },
    ]);
    const gap = mediaGapBelow(editor as never, (editor.document as Seen[])[0] as never);
    const [slot] = addUploadBatch(editor.prosemirrorView!, gap, ['m1']);
    editor.removeBlocks([(editor.document as Seen[])[0]!.children![0]!.id]);

    land(editor, slot!);

    expect(shape(editor)).toEqual(['R', 'D']);
    const children = (editor.document as Seen[])[0]!.children!;
    expect(children.map((c) => c.type)).toEqual(['image', 'paragraph']);
  });

  it('stays at the head of the document when the first row it was dropped above is deleted', () => {
    const { editor } = open();
    const [slot] = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, idOf(editor, 'A')), ['m1']);
    editor.removeBlocks([idOf(editor, 'A')]);

    land(editor, slot!);

    expect(shape(editor)).toEqual(['m1', 'B', 'C']);
  });

  it('lands as the first child when the block after it is a first child', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'R', children: [{ type: 'paragraph', content: 'C1' }] },
    ]);
    const parent = (editor.document as Seen[])[0]!;
    const ids = addUploadBatch(
      editor.prosemirrorView!,
      gapBefore(editor.prosemirrorView!.state.doc, parent.children![0]!.id),
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
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
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
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');
    view.dispatch(view.state.tr.insertText('!'));

    land(editor, ids[0]!, manager);
    manager.undo();

    expect(shape(editor)).toEqual(['A', 'B', 'C!']);
  });

  it('keeps what is typed straight after it out of its undo step', () => {
    const { editor, manager } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');

    land(editor, ids[0]!, manager);
    view.dispatch(view.state.tr.insertText('?'));
    manager.undo();

    expect(shape(editor)).toEqual(['A', 'm1', 'B', 'C']);
  });

  it('leaves what the reader types while a file uploads in one undo step', () => {
    const { editor, manager } = open();
    const view = editor.prosemirrorView!;
    const [slot] = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
    manager.stopCapturing();
    editor.setTextCursorPosition(idOf(editor, 'C'), 'end');

    view.dispatch(view.state.tr.insertText('abc'));
    patchUploadSlot(view, slot!, { progress: 0.5 });
    view.dispatch(view.state.tr.insertText('def'));
    manager.undo();

    expect(shape(editor)).toEqual(['A', 'B', 'C']);
  });

  it('removes the placeholder of the file that landed, and only that one', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1', 'm2']);

    land(editor, ids[0]!);

    expect([...drawnAt(view.state).keys()]).toEqual([ids[1]]);
  });

  it('lands nothing for a slot that was removed', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const ids = addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);
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

    addUploadBatch(
      view,
      gapBefore(view.state.doc, idOf(editor, 'B')), ['m1']);

    expect(view.state.doc.eq(before)).toBe(true);
  });
});
