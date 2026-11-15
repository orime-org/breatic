// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 A10 and design §5.6: two people working on one column group end
 * up with the same document, and words typed in a column nobody moved stay.
 *
 * Each side works on its own copy and the copies are exchanged afterwards,
 * through the real y-prosemirror binding, which is what a collaborator's edit
 * arriving mid-way looks like.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { dropRowBeside } from '@web/spaces/document/document-column-drop';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { adoptDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Mounts an editor on a document.
 * @param doc - The Yjs document.
 * @returns The editor.
 */
function mount(doc: Y.Doc): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/** Two editors whose documents are exchanged only when asked. */
interface Pair {
  readonly ours: Editor;
  readonly theirs: Editor;
  /** Exchanges every change made since the last exchange, both ways. */
  readonly sync: () => void;
  /** Our document. */
  readonly a: Y.Doc;
  /** Theirs. */
  readonly b: Y.Doc;
}

/**
 * Two editors on the same blocks, in step with each other.
 * @param blocks - The top-level blocks.
 * @returns The pair.
 */
function pair(blocks: readonly unknown[]): Pair {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const ours = mount(a);
  const theirs = mount(b);
  ours.replaceBlocks(ours.document, blocks as never);
  const sync = (): void => {
    for (let round = 0; round < 5; round += 1) {
      const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, toB, 'peer');
      Y.applyUpdate(a, toA, 'peer');
      const settled =
        Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)).length <= 2 &&
        Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)).length <= 2;
      if (settled) return;
    }
  };
  sync();
  return { ours, theirs, sync, a, b };
}

/**
 * The id of the first block whose words are these.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The block id.
 */
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

/**
 * Types after the words of a block.
 * @param editor - The editor.
 * @param words - The block's words now.
 * @param text - What to type.
 */
function typeAfter(editor: Editor, words: string, text: string): void {
  const view = editor.prosemirrorView;
  let end = -1;
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (end >= 0) return false;
    if (node.isTextblock && node.textContent === words) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end < 0) throw new Error(`no textblock reads "${words}"`);
  const at = Selection.near(view.state.doc.resolve(end), -1);
  view.dispatch(view.state.tr.setSelection(at).insertText(text));
}

/**
 * Both editors' shapes, which must agree.
 * @param p - The pair.
 * @returns The shared shape.
 */
function agreed(p: Pair): string[] {
  const ours = shapeOf(p.ours.document as never);
  expect(shapeOf(p.theirs.document as never)).toEqual(ours);
  return ours;
}

describe('concurrent edits around a column group (A10)', () => {
  it('keeps the other column when both sides take a different block out of the same column', () => {
    const p = pair([para('lead'), columnsBlock(['p1', 'p2'], ['q'])]);
    p.ours.removeBlocks([idOf(p.ours, 'p1')]);
    p.theirs.removeBlocks([idOf(p.theirs, 'p2')]);
    p.sync();
    const shape = agreed(p);
    expect(shape.join(' ')).toContain('q');
    expect(shape.join(' ')).not.toContain('p1');
    expect(shape.join(' ')).not.toContain('p2');
  });

  it('keeps the last column when both sides empty a different column of three', () => {
    const p = pair([columnsBlock(['a'], ['b'], ['c'])]);
    p.ours.removeBlocks([idOf(p.ours, 'a')]);
    p.theirs.removeBlocks([idOf(p.theirs, 'b')]);
    p.sync();
    const shape = agreed(p);
    expect(shape.join(' ')).toContain('c');
  });

  it('keeps words typed in the other column while two columns swap', () => {
    const p = pair([columnsBlock(['X'], ['Y'])]);
    dropRowBeside(p.ours, idOf(p.ours, 'X'), idOf(p.ours, 'Y'), 'right');
    typeAfter(p.theirs, 'Y', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['[Y+typed|X]']);
  });

  it('keeps words typed in an untouched column when a sole block moves to the far right', () => {
    const p = pair([columnsBlock(['p1'], ['q1', 'q2', 'q3'], ['r1'])]);
    dropRowBeside(p.ours, idOf(p.ours, 'p1'), idOf(p.ours, 'r1'), 'right');
    typeAfter(p.theirs, 'q2', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['[q1,q2+typed,q3|r1|p1]']);
  });

  it('keeps words typed beside a block that moves into a new column on the left of its group', () => {
    const p = pair([columnsBlock(['p1', 'p2'], ['q'])]);
    dropRowBeside(p.ours, idOf(p.ours, 'p1'), idOf(p.ours, 'p2'), 'left');
    typeAfter(p.theirs, 'p2', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['[p1|p2+typed|q]']);
  });

  it('keeps words typed in a block lying between the target and the dragged block', () => {
    const p = pair([para('T'), para('b'), para('D')]);
    dropRowBeside(p.ours, idOf(p.ours, 'D'), idOf(p.ours, 'T'), 'right');
    typeAfter(p.theirs, 'b', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['[T|D]', 'b+typed']);
  });

  it('keeps the untouched columns\' widths, and gives the moved one the mean, when two of three columns swap', () => {
    const p = pair([
      columnsBlock({ blocks: [para('a')], width: 2 }, { blocks: [para('b')], width: 1.5 }, { blocks: [para('c')], width: 0.5 }),
    ]);
    dropRowBeside(p.ours, idOf(p.ours, 'a'), idOf(p.ours, 'c'), 'right');
    p.sync();
    expect(agreed(p)).toEqual(['[b|c|a]']);
    const group = p.theirs.document[0] as unknown as { children: { props: { width: number } }[] };
    expect(group.children.map((column) => column.props.width)).toEqual([1.5, 0.5, 1]);
  });

  it('keeps the moved block when a collaborator types between the two halves of a swap', () => {
    const p = pair([columnsBlock(['X'], ['Y'])]);
    const updates: Uint8Array[] = [];
    p.a.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') updates.push(update);
    });
    const moved = idOf(p.ours, 'X');
    dropRowBeside(p.ours, moved, idOf(p.ours, 'Y'), 'right');
    expect(updates.length).toBeGreaterThan(1);
    // Theirs sees the first half only, and types then.
    Y.applyUpdate(p.b, updates[0]!, 'peer');
    typeAfter(p.theirs, 'Y', '+t');
    for (const update of updates.slice(1)) Y.applyUpdate(p.b, update, 'peer');
    p.sync();
    expect(agreed(p)).toEqual(['[Y+t|X]']);
    expect(idOf(p.ours, 'X')).toBe(moved);
  });

  it('keeps the ids of a moved row and the row under it when a collaborator receives the two halves apart', () => {
    const p = pair([para('T'), { ...para('D'), children: [para('d')] }]);
    const updates: Uint8Array[] = [];
    p.a.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') updates.push(update);
    });
    const [row, child] = [idOf(p.ours, 'D'), idOf(p.ours, 'd')];
    dropRowBeside(p.ours, row, idOf(p.ours, 'T'), 'left');
    for (const update of updates) Y.applyUpdate(p.b, update, 'peer');
    p.sync();
    expect(agreed(p)).toEqual(['[D|T]']);
    for (const editor of [p.ours, p.theirs]) expect([idOf(editor, 'D'), idOf(editor, 'd')]).toEqual([row, child]);
  });
});

/**
 * The position right after a block, where a block dropped under it lands.
 * @param editor - The editor.
 * @param words - The block's words.
 * @returns The position.
 */
function under(editor: Editor, words: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node: PMNode, pos: number) => {
    if (at >= 0) return false;
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      at = pos + node.nodeSize;
      return false;
    }
    return true;
  });
  if (at < 0) throw new Error(`no block reads "${words}"`);
  return at;
}

describe('moves into and out of a column above or below a block (design §5.2)', () => {
  it('keeps words typed in the other column when a body block moves under a column\'s block', () => {
    const p = pair([columnsBlock(['a'], ['b']), para('x')]);
    moveRowTo(p.ours.prosemirrorView, idOf(p.ours, 'x'), under(p.ours, 'b'));
    typeAfter(p.theirs, 'a', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['[a+typed|b,x]']);
  });

  it('keeps words typed in the other column when a column\'s block moves under a body block', () => {
    const p = pair([para('lead'), columnsBlock(['a', 'a2'], ['b']), para('tail')]);
    moveRowTo(p.ours.prosemirrorView, idOf(p.ours, 'a2'), under(p.ours, 'tail'));
    typeAfter(p.theirs, 'b', '+typed');
    p.sync();
    expect(agreed(p)).toEqual(['lead', '[a|b+typed]', 'tail', 'a2']);
  });

  it('keeps words typed in every untouched column when a block above the group moves into its last column', () => {
    const p = pair([para('x'), para('mid'), columnsBlock(['a'], ['b'], ['c'])]);
    moveRowTo(p.ours.prosemirrorView, idOf(p.ours, 'x'), under(p.ours, 'c'));
    typeAfter(p.theirs, 'a', '+1');
    typeAfter(p.theirs, 'b', '+2');
    typeAfter(p.theirs, 'mid', '+3');
    p.sync();
    expect(agreed(p)).toEqual(['mid+3', '[a+1|b+2|c,x]']);
  });

  it('keeps words typed in the body and other columns when a column block moves to the top', () => {
    const p = pair([para('top'), para('mid'), columnsBlock(['a', 'a2'], ['b'])]);
    moveRowTo(p.ours.prosemirrorView, idOf(p.ours, 'a2'), 0 + 1);
    typeAfter(p.theirs, 'mid', '+1');
    typeAfter(p.theirs, 'b', '+2');
    p.sync();
    expect(agreed(p)).toEqual(['a2', 'top', 'mid+1', '[a|b+2]']);
  });
});

describe('a two-step move is one undo step (design §5.2)', () => {
  it('restores the document before the move with one undo', () => {
    const doc = new Y.Doc();
    const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
      caretProvider: { awareness: new Awareness(doc) },
      readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
      editable: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    adoptDocumentEditor(handle, root);
    const { editor } = handle;
    editor.replaceBlocks(editor.document, [para('T'), para('b'), para('D')] as never);
    handle.undoManager.clear();
    dropRowBeside(editor as never, idOf(editor as never, 'D'), idOf(editor as never, 'T'), 'right');
    expect(shapeOf(editor.document as never)).toEqual(['[T|D]', 'b']);
    handle.undoManager.undo();
    expect(shapeOf(editor.document as never)).toEqual(['T', 'b', 'D']);
  });
});
