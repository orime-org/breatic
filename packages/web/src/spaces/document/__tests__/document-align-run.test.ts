// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A1 · A2: what pressing an alignment row does, and which row the
 * menu draws as active.
 *
 * Alignment is a block prop, so a press is `updateBlockTr` over every block the
 * selection covers — the same shape `document-block-run.ts` uses for block
 * type, off the same enumerator `selectionCanAlign` greys the slot with. Two
 * enumerators would let the judgement and the act see different blocks.
 *
 * A block alignment says nothing about is left where it is: a selection running
 * from a paragraph into a code block moves the paragraph and leaves the code
 * alone, which is the same "one alignable block is enough" the slot greys by.
 *
 * The selection needs no restoring here. Alignment changes no block's type, so
 * a press emits only `AttrStep`, whose step map is empty — measured on a word
 * selection, a two-block selection and an `AllSelection`, all three unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  MIXED_ALIGNMENT,
  NO_ALIGNABLE_BLOCK,
  alignFace,
  runAlignment,
} from '@web/spaces/document/document-align-run';

type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

const mounted: DocumentEditor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * A mounted document holding the given blocks.
 * @param blocks - The body, in BlockNote's own shape.
 * @returns The editor.
 */
function open(blocks: readonly Record<string, unknown>[]): DocumentEditor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Puts the caret in the first block.
 * @param editor - The editor.
 */
function caretInFirstBlock(editor: DocumentEditor): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)),
  );
}

/**
 * Selects from the first character to the last.
 * @param editor - The editor.
 */
function selectAllText(editor: DocumentEditor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  // Both ends inside text. Endpoints that resolve into a `blockGroup` are what
  // ProseMirror warns about, and no reader's selection has them.
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, 3, doc.content.size - 3),
    ),
  );
}

/**
 * What every block reads as, in order.
 * @param editor - The editor.
 * @returns One `textAlignment` per block.
 */
function alignments(editor: DocumentEditor): unknown[] {
  return (editor.document as unknown as ReadBlock[]).map(
    (block) => block.props['textAlignment'],
  );
}

describe('pressing an alignment row', () => {
  it('centres the paragraph the caret sits in', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    caretInFirstBlock(editor);

    runAlignment(editor, 'center');

    expect(alignments(editor)).toEqual(['center']);
  });

  it('takes a centred paragraph back to the left', () => {
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'center' }, content: 'w' },
    ]);
    caretInFirstBlock(editor);

    runAlignment(editor, 'left');

    expect(alignments(editor)).toEqual(['left']);
  });

  it('reaches a heading', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'a heading' },
    ]);
    caretInFirstBlock(editor);

    runAlignment(editor, 'right');

    expect(alignments(editor)).toEqual(['right']);
  });

  it('moves every alignable block the selection covers', () => {
    const editor = open([
      { type: 'paragraph', content: 'first' },
      { type: 'heading', props: { level: 1 }, content: 'second' },
      { type: 'paragraph', content: 'third' },
    ]);
    selectAllText(editor);

    runAlignment(editor, 'center');

    expect(alignments(editor)).toEqual(['center', 'center', 'center']);
  });

  it('leaves a block alignment does not reach where it is', () => {
    const editor = open([
      { type: 'paragraph', content: 'a line' },
      { type: 'codeBlock', content: 'npm i' },
      { type: 'bulletListItem', content: 'an item' },
    ]);
    selectAllText(editor);

    runAlignment(editor, 'center');

    // A list item carries the prop and keeps the value it had. A code block
    // does not declare it at all, so what it reads as is nothing.
    expect(alignments(editor)).toEqual(['center', undefined, 'left']);
  });

  it('does nothing where the selection holds no alignable block', () => {
    // A list item rather than a code block: it declares `textAlignment` and so
    // has a value that a press reaching too far would visibly change. A code
    // block does not declare the prop, and reads as nothing either way.
    const editor = open([{ type: 'bulletListItem', content: 'an item' }]);
    caretInFirstBlock(editor);

    runAlignment(editor, 'center');

    expect(alignments(editor)).toEqual(['left']);
  });
});

describe('what the alignment slot reads off the selection', () => {
  it('is the alignment the caret block carries', () => {
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'right' }, content: 'w' },
    ]);
    caretInFirstBlock(editor);

    expect(alignFace(editor)).toBe('right');
  });

  it('is left where the block was never aligned', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    caretInFirstBlock(editor);

    expect(alignFace(editor)).toBe('left');
  });

  it('is mixed where the covered blocks disagree', () => {
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'center' }, content: 'a' },
      { type: 'paragraph', props: { textAlignment: 'right' }, content: 'b' },
    ]);
    selectAllText(editor);

    expect(alignFace(editor)).toBe(MIXED_ALIGNMENT);
  });

  it('ignores the alignment of a block it does not reach', () => {
    // A code block's own `textAlignment` is not something the menu speaks for,
    // so a selection over an aligned paragraph and a code block still reads as
    // that paragraph's alignment.
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'center' }, content: 'a' },
      { type: 'codeBlock', content: 'npm i' },
    ]);
    selectAllText(editor);

    expect(alignFace(editor)).toBe('center');
  });
});

describe('which selections alignment reaches', () => {
  // Moved here from `document-align-model.test.ts` when the two answers the
  // slot needs — whether it is live, and which row is active — became one.
  it.each([
    ['a paragraph', { type: 'paragraph', content: 'plain words' }],
    ['a heading', { type: 'heading', props: { level: 2 }, content: 'a head' }],
    [
      'a quoted paragraph, quote taking no part in the question',
      { type: 'paragraph', props: { quoted: true }, content: 'quoted' },
    ],
  ])('reaches %s', (_name, block) => {
    const editor = open([block]);
    caretInFirstBlock(editor);

    expect(alignFace(editor)).not.toBe(NO_ALIGNABLE_BLOCK);
  });

  it.each([
    ['a bullet list item', { type: 'bulletListItem', content: 'an item' }],
    ['a numbered list item', { type: 'numberedListItem', content: 'an item' }],
    ['a task list item', { type: 'checkListItem', content: 'a task' }],
    ['a code block', { type: 'codeBlock', content: 'npm install' }],
  ])('does not reach %s', (_name, block) => {
    const editor = open([block]);
    caretInFirstBlock(editor);

    expect(alignFace(editor)).toBe(NO_ALIGNABLE_BLOCK);
  });

  it('reaches a selection running from a heading into a code block', () => {
    // One alignable block is enough: pressing a row still moves the heading,
    // so the slot is live rather than grey.
    const editor = open([
      { type: 'heading', props: { level: 1 }, content: 'a heading' },
      { type: 'codeBlock', content: 'npm i' },
    ]);
    selectAllText(editor);

    expect(alignFace(editor)).not.toBe(NO_ALIGNABLE_BLOCK);
  });

  it('does not reach a selection holding only list items and code', () => {
    const editor = open([
      { type: 'bulletListItem', content: 'an item' },
      { type: 'codeBlock', content: 'npm i' },
    ]);
    selectAllText(editor);

    expect(alignFace(editor)).toBe(NO_ALIGNABLE_BLOCK);
  });
});
