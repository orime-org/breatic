// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #995: alignment and colour chosen off the block handle act on the hovered
 * row, and land where the bubble bar's own form of the command lands.
 *
 * The handle is on screen only while the reader holds no selection
 * (`DocumentBlockHandle.tsx`, `holdsSelection`), and two places on the colour
 * path branch on exactly that: `writeStyle` forks into BlockNote's
 * `addStyles`, which takes no range at all, and `eachReachable` answers
 * "nothing reached". So the reader's empty selection is not an edge case here
 * — it is every press — and what these pin is that the block's own range
 * decides what gets written, while the reader's caret, selection and stored
 * marks stay where they were.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  alignFaceOver,
  runAlignment,
  NO_ALIGNABLE_BLOCK,
} from '@web/spaces/document/document-align-run';
import {
  clearColours,
  colourFaceOver,
  setColour,
} from '@web/spaces/document/document-colour-run';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content?: readonly { readonly styles?: Record<string, unknown> }[];
}

/**
 * Opens an editor holding one block of each kind this pins.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha words' },
    { type: 'paragraph', content: 'elsewhere' },
    { type: 'bulletListItem', content: 'an item' },
    { type: 'codeBlock', content: 'some code' },
    { type: 'paragraph', content: '' },
  ] as never);
  return editor;
}

/** Every block, as the document holds it. */
function blocks(editor: Editor): Seen[] {
  return editor.document as unknown as Seen[];
}

/**
 * The block at one index.
 * @param editor - The editor.
 * @param index - Which block.
 */
function blockAt(editor: Editor, index: number): Seen {
  return blocks(editor)[index]!;
}

/**
 * The selection standing for one block, the way the handle's menu builds it.
 * @param editor - The editor.
 * @param index - Which block.
 */
function over(editor: Editor, index: number) {
  return selectionOverBlockContent(
    editor.prosemirrorState.doc,
    blockAt(editor, index).id,
  );
}

/**
 * Puts the reader's caret in the second block and leaves it there.
 * @param editor - The editor.
 */
function caretElsewhere(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  const range = selectionOverBlockContent(doc, blockAt(editor, 1).id);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, range.from)));
}

/**
 * Gives the reader a mark their next character will carry, the way `Mod-b` at
 * a caret does.
 *
 * Without one, every reading of `storedMarks` is `null` before and after, so a
 * case asserting it did not move asserts nothing.
 * @param editor - The editor.
 */
function readerCarriesBold(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const bold = view.state.schema.marks['bold']!;
  view.dispatch(view.state.tr.setStoredMarks([bold.create()]));
}

/** What the reader's own state reads as. */
function readerState(editor: Editor) {
  const { selection, storedMarks } = editor.prosemirrorState;
  return {
    from: selection.from,
    to: selection.to,
    marks: storedMarks?.map((mark) => mark.type.name) ?? null,
  };
}

/**
 * Counts the transactions the editor sends from here on.
 * @param editor - The editor to watch.
 * @returns How many have gone out since this was called.
 */
function countDispatches(editor: Editor): () => number {
  const view = editor.prosemirrorView!;
  let sent = 0;
  const real = view.dispatch.bind(view);
  view.dispatch = (tr): void => {
    sent += 1;
    real(tr);
  };
  return () => sent;
}

/** The styles on every run of one block. */
function runStyles(editor: Editor, index: number): Record<string, unknown>[] {
  return (blockAt(editor, index).content ?? []).map((run) => run.styles ?? {});
}

describe('colour off the block handle', () => {
  it('colours every run of the hovered block while the reader holds no selection', () => {
    const editor = open();
    caretElsewhere(editor);

    setColour(editor as never, 'textColor', 'red', over(editor, 0));

    expect(runStyles(editor, 0).length).toBeGreaterThan(0);
    runStyles(editor, 0).forEach((styles) => {
      expect(styles['textColor']).toBe('red');
    });
  });

  it('lets the later press win over a colour the bubble bar left on one run', () => {
    const editor = open();
    // The bubble bar's form: a selection the reader dragged over part of the
    // block. `setColour` with no range reads that selection, as it does today.
    const view = editor.prosemirrorView!;
    const range = over(editor, 0);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, range.from, range.from + 5),
      ),
    );
    setColour(editor as never, 'textColor', 'red');
    caretElsewhere(editor);

    setColour(editor as never, 'textColor', 'blue', over(editor, 0));

    runStyles(editor, 0).forEach((styles) => {
      expect(styles['textColor']).toBe('blue');
    });
  });

  it('leaves the reader’s caret, selection and stored marks alone', () => {
    const editor = open();
    caretElsewhere(editor);
    readerCarriesBold(editor);
    const before = readerState(editor);
    expect(before.marks).toEqual(['bold']);

    setColour(editor as never, 'textColor', 'red', over(editor, 0));

    expect(readerState(editor)).toEqual(before);
  });
});

describe('what an empty block does to a colour press', () => {
  // The colour row greys on an empty block, so no reader reaches this. The
  // write guards it too, because the branch it would otherwise land in is
  // BlockNote's `addStyles` — which takes no range and would put the hue on
  // whatever the reader types next, in a different block.
  it('writes nothing and leaves the reader carrying what they carried', () => {
    const editor = open();
    caretElsewhere(editor);
    readerCarriesBold(editor);
    const before = readerState(editor);

    setColour(editor as never, 'textColor', 'red', over(editor, 4));

    expect(runStyles(editor, 4)).toEqual([]);
    expect(readerState(editor)).toEqual(before);
  });
});

describe('a press with nothing to write', () => {
  // Both modules say a press that reaches nothing costs nothing. Asking to
  // restore the reader's marks is itself a write — `setStoredMarks` turns
  // `storedMarksSet` on whatever it is handed, and BlockNote's `transact`
  // dispatches on that flag — so the restore has to ask first whether a step
  // ran at all.
  it('sends no transaction when the block carries no such colour', () => {
    const editor = open();
    const sent = countDispatches(editor);

    clearColours(editor as never, ['textColor'], over(editor, 0));

    expect(sent()).toBe(0);
  });

  it('sends no transaction when alignment reaches no block', () => {
    const editor = open();
    const sent = countDispatches(editor);

    runAlignment(editor as never, 'center', over(editor, 3));

    expect(sent()).toBe(0);
  });
});

describe('alignment off the block handle', () => {
  it('aligns the hovered block and leaves the others alone', () => {
    const editor = open();
    caretElsewhere(editor);

    runAlignment(editor as never, 'center', over(editor, 0));

    expect(blockAt(editor, 0).props['textAlignment']).toBe('center');
    expect(blockAt(editor, 1).props['textAlignment']).toBe('left');
  });

  it('aligns an empty block, which has a caret to carry', () => {
    const editor = open();
    caretElsewhere(editor);

    runAlignment(editor as never, 'center', over(editor, 4));

    expect(blockAt(editor, 4).props['textAlignment']).toBe('center');
  });

  it('leaves the reader’s caret, selection and stored marks alone', () => {
    const editor = open();
    caretElsewhere(editor);
    readerCarriesBold(editor);
    const before = readerState(editor);

    runAlignment(editor as never, 'center', over(editor, 0));

    expect(readerState(editor)).toEqual(before);
  });
});

describe('what the two rows read to decide they cannot act', () => {
  it('reads a list item as out of alignment’s reach', () => {
    const editor = open();

    const face = alignFaceOver(editor.prosemirrorState.doc, over(editor, 2));

    expect(face).toBe(NO_ALIGNABLE_BLOCK);
  });

  it('reads a paragraph as within alignment’s reach', () => {
    const editor = open();

    const face = alignFaceOver(editor.prosemirrorState.doc, over(editor, 0));

    expect(face).not.toBe(NO_ALIGNABLE_BLOCK);
  });

  it('reads a code block as out of colour’s reach', () => {
    const editor = open();

    const face = colourFaceOver(editor.prosemirrorState.doc, over(editor, 3));

    expect(face.appliesHere).toBe(false);
  });

  it('reads an empty block as out of colour’s reach, whatever the reader carries', () => {
    const editor = open();
    // The reader's own caret can carry marks, and the caret branch of
    // `eachReachable` would read those rather than the block. An empty block
    // holds no run to colour, so the answer comes from the range being empty.
    caretElsewhere(editor);

    const face = colourFaceOver(editor.prosemirrorState.doc, over(editor, 4));

    expect(face.appliesHere).toBe(false);
  });

  it('reads a paragraph with words as within colour’s reach', () => {
    const editor = open();

    const face = colourFaceOver(editor.prosemirrorState.doc, over(editor, 0));

    expect(face.appliesHere).toBe(true);
  });
});
