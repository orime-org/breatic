// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A4 · A5 · A7: what the colour cells do, and which one reads as the
 * one in force.
 *
 * The cell marked as in force has to speak for the whole selection, the way the
 * four marks on the same bar do — `document-tools.ts` records why they were
 * changed: `getActiveStyles()` reads the marks at `$to` alone, so a selection
 * carrying a style over only part of itself read as carrying it. A colour panel
 * doing that names the hue of the selection's last run, whatever the rest is.
 *
 * A press covers the whole selection minus its whitespace edges, again as the
 * four marks do: a reader dragging over a word picks up the space after it, and
 * a tinted trailing space is visible where a bold one is not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  NO_COLOUR,
  clearColours,
  colourFace,
  setColour,
  type ColourKind,
} from '@web/spaces/document/document-colour-run';

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

describe('which colour cell reads as the one in force', () => {
  it('names the hue where the whole selection carries it', () => {
    // `alpha beta` is 10 characters, so the text runs 3..13.
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 13);

    expect(colourOnRow(editor, 'textColor')).toBe('red');
  });

  it('names none where the whole selection carries no colour', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);

    expect(colourOnRow(editor, 'textColor')).toBe(NO_COLOUR);
  });

  it('names nothing where only part of the selection is coloured', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 13);

    expect(colourOnRow(editor, 'textColor')).toBeUndefined();
  });

  it('names nothing where the selection carries two hues', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'red');
    select(editor, 8, 13);
    setColour(editor, 'textColor', 'teal');
    select(editor, 3, 13);

    expect(colourOnRow(editor, 'textColor')).toBeUndefined();
  });

  it('answers for the caret from the marks at it', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'violet');
    // A caret inside the coloured word.
    select(editor, 5, 5);

    expect(colourOnRow(editor, 'textColor')).toBe('violet');
  });

  it('reads the two rows apart', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);
    setColour(editor, 'backgroundColor', 'pink');
    select(editor, 3, 13);

    expect(colourOnRow(editor, 'backgroundColor')).toBe('pink');
    expect(colourOnRow(editor, 'textColor')).toBe(NO_COLOUR);
  });
});

describe('what a colour press covers', () => {
  it('leaves the whitespace a drag picked up outside the colour', () => {
    // Dragging over `alpha ` takes the space after the word, which the four
    // marks on the same bar trim before they act.
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 9);

    setColour(editor, 'textColor', 'red');

    expect(runs(editor).map((run) => run.text)).toEqual(['alpha', ' beta']);
  });

  it('trims the fill row the same way', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 9);

    setColour(editor, 'backgroundColor', 'teal');

    expect(runs(editor).map((run) => run.text)).toEqual(['alpha', ' beta']);
  });

  it('takes a colour off the run that has it', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 13);

    clearColours(editor, 'textColor');

    expect(runs(editor)[0]?.styles['textColor']).toBeUndefined();
  });

  it('takes one row off and leaves the other', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 13);
    setColour(editor, 'backgroundColor', 'teal');
    select(editor, 3, 13);

    clearColours(editor, 'textColor');

    expect(runs(editor)[0]?.styles).toEqual({ backgroundColor: 'teal' });
  });

  it('takes both rows off at once', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);
    setColour(editor, 'textColor', 'green');
    select(editor, 3, 13);
    setColour(editor, 'backgroundColor', 'orange');
    select(editor, 3, 13);

    clearColours(editor, 'textColor', 'backgroundColor');

    expect(runs(editor)[0]?.styles).toEqual({});
  });
});

describe('which selections the colour panel can act on', () => {
  it('acts on a paragraph', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 13);

    expect(colourFace(editor).appliesHere).toBe(true);
  });

  it('acts on a heading', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'a heading' },
    ]);
    select(editor, 3, 12);

    expect(colourFace(editor).appliesHere).toBe(true);
  });

  it('acts on a list item', () => {
    const editor = open([{ type: 'bulletListItem', content: 'an item' }]);
    select(editor, 3, 10);

    expect(colourFace(editor).appliesHere).toBe(true);
  });

  it('does not act inside a code block', () => {
    // Measured: `addStyles` over a code block's text leaves `styles` empty, so
    // every cell of the panel is a press with nothing behind it.
    const editor = open([{ type: 'codeBlock', content: 'const a = 1' }]);
    select(editor, 3, 14);

    expect(colourFace(editor).appliesHere).toBe(false);
  });

  it('acts on a selection running from a paragraph into a code block', () => {
    // One block it reaches is enough, which is how the alignment slot judges
    // the same shape of selection.
    const editor = open([
      { type: 'paragraph', content: 'prose here' },
      { type: 'codeBlock', content: 'const a = 1' },
    ]);
    const view = editor.prosemirrorView!;
    const { doc } = view.state;
    select(editor, 3, doc.content.size - 3);

    expect(colourFace(editor).appliesHere).toBe(true);
  });
});

describe('what a press leaves the selection as', () => {
  it('keeps a select-all whole', () => {
    // Trimming reads the runs at each end. A select-all has no text at either
    // end — its ends resolve into the document itself — and rebuilding a text
    // selection from those positions collapses it to a caret, which takes the
    // bar off screen mid-press.
    const editor = open([
      { type: 'paragraph', content: 'first line' },
      { type: 'paragraph', content: 'second one' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    setColour(editor, 'textColor', 'red');

    expect(view.state.selection.empty).toBe(false);
  });

  it('colours every block a select-all covers', () => {
    const editor = open([
      { type: 'paragraph', content: 'first line' },
      { type: 'paragraph', content: 'second one' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    setColour(editor, 'textColor', 'red');

    const blocks = editor.document as unknown as {
      content?: readonly ReadRun[];
    }[];
    expect(
      blocks.map((block) => block.content?.[0]?.styles['textColor']),
    ).toEqual(['red', 'red']);
  });
});

describe('what the panel counts as reachable', () => {
  it('is unavailable over a run of inline code', () => {
    // The `code` mark excludes every other mark (`excludes: '_'`), so a colour
    // added over it never lands.
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    select(editor, 3, 8);
    editor.addStyles({ code: true } as never);
    select(editor, 3, 8);

    expect(colourFace(editor).appliesHere).toBe(false);
  });

  it('stays available where part of the selection is plain', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    select(editor, 3, 8);
    editor.addStyles({ code: true } as never);
    select(editor, 3, 14);

    expect(colourFace(editor).appliesHere).toBe(true);
  });

  it('ignores text a colour cannot reach when reading the cell in force', () => {
    // The code block's text can never take a colour, so counting it would
    // leave the panel unable to confirm the hue it just applied.
    const editor = open([
      { type: 'paragraph', content: 'prose here' },
      { type: 'codeBlock', content: 'const a = 1' },
    ]);
    const view = editor.prosemirrorView!;
    const { doc } = view.state;
    select(editor, 3, doc.content.size - 3);
    setColour(editor, 'textColor', 'blue');
    const after = view.state.doc;
    select(editor, 3, after.content.size - 3);

    expect(colourOnRow(editor, 'textColor')).toBe('blue');
  });

  it('ignores a run of inline code when reading the cell in force', () => {
    // `plain ` — the space included, so the whole selection below is either
    // code or coloured and nothing plain is left between them.
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    select(editor, 3, 9);
    editor.addStyles({ code: true } as never);
    select(editor, 9, 14);
    setColour(editor, 'textColor', 'green');
    select(editor, 3, 14);

    expect(colourOnRow(editor, 'textColor')).toBe('green');
  });
});

describe('the range the panel reads is the range a press covers', () => {
  it('names the hue where a drag picked up the trailing space', () => {
    // The drag `trimEdges` exists for: the word and the space after it. The
    // press covers `alpha` alone, so the panel has to answer for `alpha`
    // alone — reading the untrimmed range finds a red run and a plain one and
    // marks no cell, over a selection the reader coloured red a moment ago.
    const editor = open([{ type: 'paragraph', content: 'alpha beta' }]);
    select(editor, 3, 8);
    setColour(editor, 'textColor', 'red');
    select(editor, 3, 9);

    expect(colourOnRow(editor, 'textColor')).toBe('red');
  });

  it('is unavailable over a code word and the space a drag picked up', () => {
    // The trim moves the range off the space, leaving the code run, which no
    // colour reaches. Judging the untrimmed range finds the space, draws the
    // panel live, and every cell is then a press with nothing behind it.
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    select(editor, 3, 8);
    editor.addStyles({ code: true } as never);
    select(editor, 3, 9);

    expect(colourFace(editor).appliesHere).toBe(false);
  });

  it('colours whitespace that spans two runs', () => {
    const editor = open([{ type: 'paragraph', content: 'ab  cd' }]);
    select(editor, 3, 6);
    editor.addStyles({ italic: true } as never);
    select(editor, 5, 7);

    setColour(editor, 'backgroundColor', 'teal');

    expect(runs(editor).map((run) => run.styles['backgroundColor'])).toEqual([
      undefined,
      'teal',
      'teal',
      undefined,
    ]);
  });

  it('colours whitespace that spans two blocks', () => {
    const editor = open([
      { type: 'paragraph', content: 'abc ' },
      { type: 'paragraph', content: ' def' },
    ]);
    select(editor, 6, 12);

    setColour(editor, 'backgroundColor', 'teal');

    const blocks = editor.document as unknown as {
      content?: readonly ReadRun[];
    }[];
    expect(
      blocks.map((block) => block.content?.at(-1)?.styles['backgroundColor']),
    ).toEqual(['teal', undefined]);
    expect(blocks[1]?.content?.[0]?.styles['backgroundColor']).toBe('teal');
  });
});
