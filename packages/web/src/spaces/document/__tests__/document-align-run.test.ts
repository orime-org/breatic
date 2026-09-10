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
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  activeAlignment,
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
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, 1, doc.content.size - 1),
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

  it('keeps the selection over the same text', () => {
    // `updateBlockTr` replaces the node it changes, and a replacement collapses
    // the selection inside it — which takes the bar off screen and leaves the
    // reader selecting the same words again to press a second row.
    const editor = open([
      { type: 'paragraph', content: 'first' },
      { type: 'paragraph', content: 'second' },
    ]);
    selectAllText(editor);

    runAlignment(editor, 'center');

    const { selection } = editor.prosemirrorView!.state;
    expect(selection.empty).toBe(false);
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

describe('which alignment row the menu draws as active', () => {
  it('is the one the caret block carries', () => {
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'right' }, content: 'w' },
    ]);
    caretInFirstBlock(editor);

    expect(activeAlignment(editor)).toBe('right');
  });

  it('is left where the block was never aligned', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    caretInFirstBlock(editor);

    expect(activeAlignment(editor)).toBe('left');
  });

  it('is none where the covered blocks disagree', () => {
    const editor = open([
      { type: 'paragraph', props: { textAlignment: 'center' }, content: 'a' },
      { type: 'paragraph', props: { textAlignment: 'right' }, content: 'b' },
    ]);
    selectAllText(editor);

    expect(activeAlignment(editor)).toBeUndefined();
  });

  it('is none where no covered block is alignable', () => {
    // The slot is grey there, so no row should read as the one you are on.
    const editor = open([{ type: 'codeBlock', content: 'npm i' }]);
    caretInFirstBlock(editor);

    expect(activeAlignment(editor)).toBeUndefined();
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

    expect(activeAlignment(editor)).toBe('center');
  });
});
