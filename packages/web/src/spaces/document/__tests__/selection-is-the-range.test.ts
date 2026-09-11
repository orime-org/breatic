// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A12: the selection IS the range a command acts on.
 *
 * Not a character more, not a character less. A space is content — it carries
 * a colour, a fill and a weight, it is only invisible — so it joins the range
 * and it joins the reading. Typing at the end of a styled run continues that
 * run, which is what a reader means by making the region bigger.
 *
 * This is a rule for the whole document space (user 2026-09-11), not for one
 * command: bold, alignment, colour and fill all answer the same way, and so
 * does every command added later, unless a convention says otherwise for a
 * particular shape of content (a code block being the kind of exception meant).
 *
 * Crossing a block boundary is a separate question and is not covered here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  NO_COLOUR,
  colourFace,
  setColour,
  type ColourKind,
} from '@web/spaces/document/document-colour-run';
import { MARK_TOOLS } from '@web/spaces/document/document-tools';

type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

const mounted: DocumentEditor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** One run of text as `editor.document` hands it back. */
interface ReadRun {
  readonly text: string;
  readonly styles: Readonly<Record<string, unknown>>;
}

/**
 * A mounted document holding one paragraph.
 * @param text - The paragraph's text.
 * @returns The editor.
 */
function open(text: string): DocumentEditor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: text } as never,
  ]);
  return editor;
}

/**
 * Selects a range of the document.
 * @param editor - The editor.
 * @param from - Where to start.
 * @param to - Where to end.
 */
function select(editor: DocumentEditor, from: number, to: number): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
}

/**
 * Puts the caret at one position.
 * @param editor - The editor.
 * @param at - Where.
 */
function caret(editor: DocumentEditor, at: number): void {
  select(editor, at, at);
}

/**
 * The runs of the first block.
 * @param editor - The editor.
 * @returns Text and styles, in order.
 */
function runs(editor: DocumentEditor): ReadRun[] {
  const block = editor.document[0] as unknown as {
    content?: readonly ReadRun[];
  };
  return [...(block.content ?? [])];
}

/**
 * The styles a character typed at the caret would carry.
 * @param editor - The editor.
 * @returns The mark names, with a colour's value appended.
 */
function typedStyles(editor: DocumentEditor): string[] {
  const state = editor.prosemirrorState;
  const held = state.storedMarks ?? state.selection.$from.marks();
  return held.map((mark) => {
    const value: unknown = mark.attrs['stringValue'];
    return typeof value === 'string'
      ? `${mark.type.name}=${value}`
      : mark.type.name;
  });
}

/**
 * One row's cell in force.
 * @param editor - The editor.
 * @param kind - Which row.
 * @returns What that row draws as in force.
 */
function colourOnRow(
  editor: DocumentEditor,
  kind: ColourKind,
): string | undefined {
  const face = colourFace(editor);
  return kind === 'textColor' ? face.text : face.fill;
}

/** The Bold tool, which stands for all five marks here. */
const bold = MARK_TOOLS.find((tool) => tool.id === 'bold')!;

// `hello   tail` in a paragraph: text runs 3..15, so `hello` is 3..8, the
// three spaces are 8..11, and `tail` is 11..15.
const WORD_AND_SPACES = { text: 'hello   tail', from: 3, to: 11 } as const;

describe('a command covers every character the selection covers', () => {
  it('colours the spaces a selection includes', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);

    setColour(editor, 'textColor', 'red');

    expect(runs(editor).map((run) => run.text)).toEqual(['hello   ', 'tail']);
    expect(runs(editor)[0]?.styles['textColor']).toBe('red');
  });

  it('fills the spaces a selection includes', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);

    setColour(editor, 'backgroundColor', 'green');

    expect(runs(editor).map((run) => run.text)).toEqual(['hello   ', 'tail']);
    expect(runs(editor)[0]?.styles['backgroundColor']).toBe('green');
  });

  it('bolds the spaces a selection includes', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);

    bold.run(editor);

    expect(runs(editor).map((run) => run.text)).toEqual(['hello   ', 'tail']);
    expect(runs(editor)[0]?.styles['bold']).toBe(true);
  });

  it('colours a space at each end of the selection', () => {
    // `a hello b`: text runs 3..12, and 4..10 is ` hello `.
    const editor = open('a hello b');
    select(editor, 4, 10);

    setColour(editor, 'textColor', 'red');

    expect(runs(editor).map((run) => run.text)).toEqual(['a', ' hello ', 'b']);
    expect(runs(editor)[1]?.styles['textColor']).toBe('red');
  });
});

describe('typing at the end of a styled region continues it', () => {
  it('carries the colour of the spaces before the caret', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);
    setColour(editor, 'textColor', 'red');
    setColour(editor, 'backgroundColor', 'green');

    caret(editor, WORD_AND_SPACES.to);

    expect(typedStyles(editor).sort()).toEqual([
      'backgroundColor=green',
      'textColor=red',
    ]);
  });

  it('carries it from inside the run of spaces too', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);
    setColour(editor, 'textColor', 'red');

    caret(editor, WORD_AND_SPACES.from + 6); // after the first space

    expect(typedStyles(editor)).toEqual(['textColor=red']);
  });

  it('carries the weight of the spaces before the caret', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, WORD_AND_SPACES.from, WORD_AND_SPACES.to);
    bold.run(editor);

    caret(editor, WORD_AND_SPACES.to);

    expect(typedStyles(editor)).toEqual(['bold']);
  });
});

describe('the colour panel reads the first run the selection covers', () => {
  it('names the hue where a drag overshot onto a plain space', () => {
    // Colour `hello`, then drag over it plus the space that follows.
    const editor = open(WORD_AND_SPACES.text);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 9);

    expect(colourOnRow(editor, 'textColor')).toBe('red');
  });

  it('names none where the selection opens on a plain space', () => {
    // The mirror of the case above: the same two runs, dragged the other way.
    // `tail` is the coloured one, and the spaces before it are plain.
    const editor = open(WORD_AND_SPACES.text);
    select(editor, 11, 15);
    setColour(editor, 'textColor', 'red');
    select(editor, 8, 15);

    expect(colourOnRow(editor, 'textColor')).toBe(NO_COLOUR);
  });

  it('names the first of two hues', () => {
    const editor = open(WORD_AND_SPACES.text);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'red');
    select(editor, 11, 15);
    setColour(editor, 'textColor', 'blue');
    select(editor, 3, 15);

    expect(colourOnRow(editor, 'textColor')).toBe('red');
  });
});
