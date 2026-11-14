// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 design §5.1–5.2: a column group is `docColumnList > docColumn >
 * blocks`, and one local repair keeps it meaningful.
 *
 * The repair rule: a local transaction that takes every block out of a column
 * (leaving only the empty paragraph ProseMirror fills in for `+`) deletes the
 * column; a group left with one column dissolves into plain blocks; a group
 * left with none is deleted. A column holding an empty paragraph the user put
 * there is not empty, and a column whose blocks were replaced in place keeps
 * the new blocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from 'y-prosemirror';

import { DOCUMENT_SCHEMA, documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-nodes';
import { COLUMN_TAKE_AWAY } from '@web/spaces/document/document-column-repair';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * A mounted editor over the given Yjs document.
 * @param doc - The Yjs document.
 * @returns The editor.
 */
function open(doc: Y.Doc = new Y.Doc()): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function editorWith(blocks: readonly unknown[]): Editor {
  const editor = open();
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The editor's top-level shape.
 * @param editor - The editor.
 * @returns One string per top-level block.
 */
function shape(editor: Editor): string[] {
  return shapeOf(editor.document as never);
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
 * Puts the caret at the start of the first block reading these words, or in
 * the n-th empty paragraph.
 * @param editor - The editor.
 * @param words - The words, or '' for an empty paragraph.
 * @param nth - Which empty paragraph, counted from 0.
 */
function caretAt(editor: Editor, words: string, nth = 0): void {
  const view = editor.prosemirrorView;
  let seen = 0;
  let at: number | undefined;
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (at !== undefined) return false;
    if (node.isTextblock && node.textContent === words) {
      if (words !== '' || seen++ === nth) {
        at = pos + 1;
        return false;
      }
    }
    return true;
  });
  if (at === undefined) throw new Error(`no textblock reads "${words}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

/**
 * Presses a key through ProseMirror's keydown handlers.
 * @param editor - The editor.
 * @param key - The key.
 */
function press(editor: Editor, key: string): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (f) => f(view, event));
}

describe('the column nodes (design §5.1)', () => {
  it('ships both nodes in the shared schema, the group holding any number of columns', () => {
    expect(DOCUMENT_SCHEMA.nodes).toHaveProperty(DOC_COLUMN_LIST);
    expect(DOCUMENT_SCHEMA.nodes).toHaveProperty(DOC_COLUMN);
    expect(DOCUMENT_SCHEMA.content[DOC_COLUMN_LIST]).toBe('docColumn*');
  });

  it('lets a column hold blocks and tables, never another group, and never nothing', () => {
    const { schema } = open().prosemirrorState;
    const column = schema.nodes[DOC_COLUMN]!;
    const paragraphRow = schema.nodes['blockContainer']!.createAndFill()!;
    const group = schema.nodes[DOC_COLUMN_LIST]!.create(null, []);
    expect(column.validContent(Fragment.from(paragraphRow))).toBe(true);
    expect(column.contentMatch.matchType(schema.nodes['docTable']!)).not.toBeNull();
    expect(column.contentMatch.matchType(schema.nodes[DOC_COLUMN_LIST]!)).toBeNull();
    expect(column.validContent(Fragment.empty)).toBe(false);
    expect(schema.nodes[DOC_COLUMN_LIST]!.validContent(Fragment.empty)).toBe(true);
    expect(group.childCount).toBe(0);
  });

  it('lets a table cell hold a column group', () => {
    const { schema } = open().prosemirrorState;
    expect(schema.nodes['docTableCell']!.contentMatch.matchType(schema.nodes[DOC_COLUMN_LIST]!)).not.toBeNull();
  });

  it('round-trips a group with its widths through the block API and Yjs', () => {
    const doc = new Y.Doc();
    const first = open(doc);
    first.replaceBlocks(first.document, [
      para('lead'),
      columnsBlock({ blocks: [para('a'), para('b')], width: 2 }, { blocks: [para('c')], width: 1 }),
    ] as never);
    const second = open(doc);
    expect(shape(second)).toEqual(['lead', '[a,b|c]']);
    const group = second.document[1] as unknown as { children: { props: { width: number } }[] };
    expect(group.children.map((column) => column.props.width)).toEqual([2, 1]);
  });

  it('keeps Enter on an empty last paragraph in its column', () => {
    const editor = editorWith([columnsBlock([''], [''])]);
    caretAt(editor, '', 0);
    press(editor, 'Enter');
    expect(shape(editor)).toEqual(['[¶,¶|¶]']);
  });
});

describe('the repair rule (design §5.2)', () => {
  it('deletes a column whose last block is removed and keeps the other columns', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'], ['c'])]);
    editor.removeBlocks([idOf(editor, 'a')]);
    expect(shape(editor)).toEqual(['[b|c]']);
  });

  it('dissolves a group left with one column into plain blocks', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a'], ['b', 'c']), para('tail')]);
    editor.removeBlocks([idOf(editor, 'a')]);
    expect(shape(editor)).toEqual(['lead', 'b', 'c', 'tail']);
  });

  it('keeps a freshly inserted group whose columns each hold one empty paragraph', () => {
    const editor = editorWith([para('lead'), columnsBlock([''], [''])]);
    editor.insertBlocks([para('more')] as never, idOf(editor, 'lead'), 'after');
    expect(shape(editor)).toEqual(['lead', 'more', '[¶|¶]']);
  });

  it('keeps a column whose only block is replaced by a new one', () => {
    const editor = editorWith([columnsBlock(['old'], ['b'])]);
    editor.replaceBlocks([idOf(editor, 'old')], [para('new')] as never);
    expect(shape(editor)).toEqual(['[new|b]']);
  });

  it('deletes the column when Backspace is pressed in its sole empty paragraph', () => {
    const editor = editorWith([columnsBlock(['a'], [''], ['c'])]);
    caretAt(editor, '', 0);
    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['[a|c]']);
  });

  it('dissolves the group when Backspace empties one of two columns', () => {
    const editor = editorWith([columnsBlock(['a'], [''])]);
    caretAt(editor, '', 0);
    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['a']);
    const { selection } = editor.prosemirrorState;
    expect(selection.$head.parent.textContent).toBe('a');
  });

  it('keeps the text in its column on Backspace at the start of a column\'s first non-empty block', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'])]);
    caretAt(editor, 'b');
    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['[a|b]']);
  });

  it('only deletes the emptied column, without dissolving, in a take-away step', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'])]);
    const view = editor.prosemirrorView;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node: PMNode, pos: number) => {
      if (node.type.name === 'blockContainer' && node.firstChild?.textContent === 'a') {
        from = pos;
        to = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    view.dispatch(view.state.tr.delete(from, to).setMeta(COLUMN_TAKE_AWAY, true));
    const group = view.state.doc.firstChild!.firstChild!;
    expect(group.type.name).toBe(DOC_COLUMN_LIST);
    expect(group.childCount).toBe(1);
    expect(group.firstChild!.textContent).toBe('b');
  });

  it('leaves a remote change alone and repairs a one-column group on the next local edit inside it', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a'], ['b'])]);
    const view = editor.prosemirrorView;
    let colFrom = -1;
    let colTo = -1;
    view.state.doc.descendants((node: PMNode, pos: number) => {
      if (node.type.name === DOC_COLUMN && node.textContent === 'a') {
        colFrom = pos;
        colTo = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    // A merged state as a collaborator's update brings it: one column left.
    view.dispatch(view.state.tr.delete(colFrom, colTo).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    expect(shape(editor)).toEqual(['lead', '[b]']);
    caretAt(editor, 'b');
    view.dispatch(view.state.tr.insertText('!'));
    expect(shape(editor)).toEqual(['lead', '!b']);
  });

  it('deletes a group left with no columns on any local transaction', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a'], ['b'])]);
    const view = editor.prosemirrorView;
    const group = view.state.doc.firstChild!.child(1);
    const groupPos = 1 + view.state.doc.firstChild!.child(0).nodeSize;
    // Every column gone at once, as a merge of two people's deletions leaves it.
    view.dispatch(
      view.state.tr
        .delete(groupPos + 1, groupPos + 1 + group.content.size)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true }),
    );
    expect(view.state.doc.firstChild!.child(1).childCount).toBe(0);
    caretAt(editor, 'lead');
    view.dispatch(view.state.tr.insertText('x'));
    expect(shape(editor)).toEqual(['xlead']);
  });

  it('repairs a group inside a table cell the same way', () => {
    const editor = editorWith([
      tableBlock({ rows: [{ cells: [{ blocks: [columnsBlock(['a'], ['b'])] }, 'z'] }] }),
    ]);
    editor.removeBlocks([idOf(editor, 'a')]);
    let groups = 0;
    editor.prosemirrorState.doc.descendants((node: PMNode) => {
      if (node.type.name === DOC_COLUMN_LIST) groups += 1;
      return true;
    });
    expect(groups).toBe(0);
    expect(editor.prosemirrorState.doc.textContent).toBe('bz');
  });
});

/**
 * Puts the caret at the end of the first block reading these words.
 * @param editor - The editor.
 * @param words - The words.
 */
function caretAtEnd(editor: Editor, words: string): void {
  const view = editor.prosemirrorView;
  let at: number | undefined;
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (at !== undefined) return false;
    if (node.isTextblock && node.textContent === words) {
      at = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  if (at === undefined) throw new Error(`no textblock reads "${words}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

describe('the keys at a column group\'s edges, as at a table\'s (design §5.5)', () => {
  it('moves the caret to the end of the last column on Backspace under the group, joining nothing', () => {
    const editor = editorWith([columnsBlock(['a'], ['b']), para('below')]);
    caretAt(editor, 'below');
    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['[a|b]', 'below']);
    const { $head } = editor.prosemirrorState.selection;
    expect($head.parent.textContent).toBe('b');
    expect($head.parentOffset).toBe(1);
  });

  it('keeps an empty line under the group on Backspace, and moves the caret into the last column', () => {
    const editor = editorWith([columnsBlock(['a'], ['b']), para('')]);
    caretAt(editor, '', 0);
    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['[a|b]', '¶']);
    expect(editor.prosemirrorState.selection.$head.parent.textContent).toBe('b');
  });

  it('does nothing on Delete at the end of the line above the group', () => {
    const editor = editorWith([para('above'), columnsBlock(['a'], ['b'])]);
    caretAtEnd(editor, 'above');
    press(editor, 'Delete');
    expect(shape(editor)).toEqual(['above', '[a|b]']);
  });

  it('joins a list item\'s child on Delete at its end when it is the column\'s last row', () => {
    const editor = editorWith([
      columnsBlock({ blocks: [{ type: 'bulletListItem', content: 'A', children: [para('B')] }] }, ['z']),
    ]);
    caretAtEnd(editor, 'A');
    press(editor, 'Delete');
    let joined = '';
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'bulletListItem') joined = node.textContent;
      return true;
    });
    expect(joined).toBe('AB');
  });
});
