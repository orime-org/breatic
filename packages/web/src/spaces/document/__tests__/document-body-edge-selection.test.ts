// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124 A6: a selection that reaches past the first or last block of the body
 * when that block is a divider, a fallback block or an empty line.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { moveRowsFromKeyboard } from '@web/spaces/document/document-keyboard-move';
import {
  BodyEdgeSelection,
  bodyEdgeBetween,
  bodyEdgePos,
  bodyEdgeNeedsTakeover,
  caretAtEnd,
  dragSelection,
  extendToBodyEdge,
} from '@web/spaces/document/document-body-edge-selection';

/**
 * Presses a key through the editor's key handlers.
 * @param view - The view.
 * @param key - The key name.
 * @param shift - Whether Shift is held.
 * @returns Whether a handler took the key.
 */
function press(view: EditorView, key: string, shift = true): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true });
  return view.someProp('handleKeyDown', (f) => f(view, event)) ?? false;
}

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const editors = new WeakMap<EditorView, Editor>();

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding the given blocks.
 * @param blocks - What the document starts with.
 * @returns The editor's view.
 */
function open(blocks: unknown[]): EditorView {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  editors.set(editor.prosemirrorView!, editor);
  return editor.prosemirrorView!;
}

/**
 * Where the text of the block holding these words starts.
 * @param view - The view.
 * @param words - The block's text.
 * @returns The position.
 */
function textStart(view: EditorView, words: string): number {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === words) at = pos + 1;
    return at < 0;
  });
  return at;
}

const ABOVE_DIVIDER = [{ type: 'paragraph', content: 'Above' }, { type: 'divider' }];
const BELOW_DIVIDER_ROWS = [{ type: 'divider' }, { type: 'paragraph', content: 'Below' }];

describe('which ends of the body need taking over', () => {
  it('takes over a trailing divider, fallback block or empty line', () => {
    for (const tail of [
      { type: 'divider' },
      { type: 'unsupportedBlock', props: { originalName: 'future' } },
      { type: 'paragraph', content: '' },
    ]) {
      const view = open([{ type: 'paragraph', content: 'Above' }, tail]);
      expect(bodyEdgeNeedsTakeover(view.state.doc, 'end')).toBe(true);
    }
  });

  it('leaves a trailing line with words to the browser', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
    expect(bodyEdgeNeedsTakeover(view.state.doc, 'end')).toBe(false);
    expect(bodyEdgeNeedsTakeover(view.state.doc, 'start')).toBe(true);
  });

  it('looks at a nested last block, not its parent row', () => {
    const view = open([
      { type: 'bulletListItem', content: 'Parent', children: [{ type: 'paragraph', content: '' }] },
    ]);
    expect(bodyEdgeNeedsTakeover(view.state.doc, 'end')).toBe(true);
  });
});

describe('BodyEdgeSelection', () => {
  it('covers a trailing divider, which a text selection cannot reach', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const selection = BodyEdgeSelection.create(doc, textStart(view, 'Above'), 'end');

    expect(selection.to).toBe(bodyEdgePos(doc, 'end'));
    expect(TextSelection.between(doc.resolve(selection.from), doc.resolve(selection.to)).to)
      .toBeLessThan(selection.to);
  });

  it('keeps its edge through an edit elsewhere', () => {
    const view = open(ABOVE_DIVIDER);
    view.dispatch(
      view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end')),
    );

    view.dispatch(view.state.tr.insertText('Well ', textStart(view, 'Above')));

    const selection = view.state.selection;
    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect(selection.to).toBe(bodyEdgePos(view.state.doc, 'end'));
  });

  it('round-trips through JSON with the edge at either end', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const forward = BodyEdgeSelection.create(doc, textStart(view, 'Above'), 'end');
    const backward = BodyEdgeSelection.fromEdge(doc, 'end', textStart(view, 'Above'));

    for (const selection of [forward, backward]) {
      const back = Selection.fromJSON(doc, selection.toJSON());
      expect(back).toBeInstanceOf(BodyEdgeSelection);
      expect(back.eq(selection)).toBe(true);
    }
  });

  it('puts a non-edge end that no longer sits in text back into text when read from JSON', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    // Between the two rows: after the first row's container, before the divider's.
    const between = textStart(view, 'Above') + 'Above'.length + 2;
    const back = Selection.fromJSON(doc, { type: 'bodyEdge', anchor: between, head: bodyEdgePos(doc, 'end') });

    expect(back.$anchor.parent.inlineContent).toBe(true);
    expect(back.head).toBe(bodyEdgePos(doc, 'end'));
  });

  it('keeps its class through a bookmark', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const selection = BodyEdgeSelection.create(doc, textStart(view, 'Above'), 'end');

    expect(selection.getBookmark().resolve(doc)).toBeInstanceOf(BodyEdgeSelection);
  });

  it('removes the trailing divider along with the words when deleted', () => {
    const view = open(ABOVE_DIVIDER);
    view.dispatch(
      view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above') + 2, 'end')),
    );

    view.dispatch(view.state.tr.deleteSelection());

    const types: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'divider') types.push('divider');
      return true;
    });
    expect(types).toEqual([]);
    expect(view.state.doc.textContent).toBe('Ab');
  });
});

describe('extending to an end of the body', () => {
  it('reaches a trailing divider from text', () => {
    const view = open(ABOVE_DIVIDER);
    const from = TextSelection.create(view.state.doc, textStart(view, 'Above'));

    const next = extendToBodyEdge(view.state.doc, from.anchor, 'end');

    expect(next).toBeInstanceOf(BodyEdgeSelection);
    expect(next.to).toBe(bodyEdgePos(view.state.doc, 'end'));
  });

  it('becomes a whole-document selection when the anchor is already on the other edge', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);

    const next = extendToBodyEdge(view.state.doc, bodyEdgePos(view.state.doc, 'start'), 'end');

    expect(next).toBeInstanceOf(AllSelection);
  });
});

describe('Shift+Up and Shift+Down at the ends of the body', () => {
  it('Shift+Down on the last line takes a trailing divider in', () => {
    const view = open(ABOVE_DIVIDER);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'))));

    expect(press(view, 'ArrowDown')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.to).toBe(bodyEdgePos(view.state.doc, 'end'));
  });

  it('Shift+Up on the first line takes a leading divider in', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Below') + 2)));

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.from).toBe(bodyEdgePos(view.state.doc, 'start'));
  });

  it('Shift+Down with the head already at the end changes nothing', () => {
    const view = open(ABOVE_DIVIDER);
    const selection = BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end');
    view.dispatch(view.state.tr.setSelection(selection));

    expect(press(view, 'ArrowDown')).toBe(true);

    expect(view.state.selection.eq(selection)).toBe(true);
  });

  it('Shift+Up from the end brings the head back into the last line of text', () => {
    const view = open(ABOVE_DIVIDER);
    const anchor = textStart(view, 'Above');
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, anchor, 'end')));

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.anchor).toBe(anchor);
    expect(view.state.selection.head).toBe(anchor + 'Above'.length);
  });

  it('Shift+Left on an edge selection moves the text end and keeps the edge', () => {
    const view = open(ABOVE_DIVIDER);
    const text = textStart(view, 'Above') + 3;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', text)));

    expect(press(view, 'ArrowLeft')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.anchor).toBe(bodyEdgePos(view.state.doc, 'end'));
    expect(view.state.selection.head).toBe(text - 1);
  });

  it('leaves Shift+Down to the browser when the body ends in words', () => {
    const view = open([{ type: 'paragraph', content: 'Only' }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Only'))));

    expect(press(view, 'ArrowDown')).toBe(false);
  });
});

describe('the selection between two positions, either of which may be an edge', () => {
  it('is a text selection when neither end is an edge', () => {
    const view = open(ABOVE_DIVIDER);
    const at = textStart(view, 'Above');

    const selection = bodyEdgeBetween(view.state.doc, at, at + 3);

    expect(selection).toBeInstanceOf(TextSelection);
    expect([selection.anchor, selection.head]).toEqual([at, at + 3]);
  });

  it('keeps an anchor on the edge and puts the head in text', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const at = textStart(view, 'Above');

    const selection = bodyEdgeBetween(doc, bodyEdgePos(doc, 'end'), at + 2);

    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect([selection.anchor, selection.head]).toEqual([bodyEdgePos(doc, 'end'), at + 2]);
  });

  it('collapses to a caret in the nearest text when both ends are the same edge', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const end = bodyEdgePos(doc, 'end');

    const selection = bodyEdgeBetween(doc, end, end);

    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.empty).toBe(true);
    expect(selection.head).toBe(textStart(view, 'Above') + 'Above'.length);
  });

  it('is the whole document when the ends are the two edges', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);
    const { doc } = view.state;

    expect(bodyEdgeBetween(doc, bodyEdgePos(doc, 'start'), bodyEdgePos(doc, 'end'))).toBeInstanceOf(AllSelection);
  });
});

describe('the selection a drag gives, by where it was pressed and where the pointer is', () => {
  const BOTH_ENDS = [{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }];

  it('leaves a drag that never left the body to the browser', () => {
    const view = open(BOTH_ENDS);
    const at = textStart(view, 'Mid');

    expect(dragSelection(view.state.doc, { press: 'body', anchor: at, left: false }, 'body', at + 2)).toBeNull();
  });

  it('reaches either edge from a press in the body', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;
    const at = textStart(view, 'Mid') + 1;

    const down = dragSelection(doc, { press: 'body', anchor: at, left: true }, 'end', null);
    const up = dragSelection(doc, { press: 'body', anchor: at, left: true }, 'start', null);

    expect([down?.anchor, down?.head]).toEqual([at, bodyEdgePos(doc, 'end')]);
    expect([up?.anchor, up?.head]).toEqual([at, bodyEdgePos(doc, 'start')]);
  });

  it('follows the pointer from the anchor after coming back into the body', () => {
    const view = open(BOTH_ENDS);
    const at = textStart(view, 'Mid');

    const back = dragSelection(view.state.doc, { press: 'body', anchor: at, left: true }, 'body', at + 2);

    expect(back).toBeInstanceOf(TextSelection);
    expect([back?.anchor, back?.head]).toEqual([at, at + 2]);
  });

  it('anchors on the edge a press outside it was made past', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;
    const at = textStart(view, 'Mid') + 1;

    const fromEnd = dragSelection(doc, { press: 'end', anchor: bodyEdgePos(doc, 'end'), left: true }, 'body', at);
    const fromStart = dragSelection(doc, { press: 'start', anchor: bodyEdgePos(doc, 'start'), left: true }, 'body', at);

    expect(fromEnd).toBeInstanceOf(BodyEdgeSelection);
    expect([fromEnd?.anchor, fromEnd?.head]).toEqual([bodyEdgePos(doc, 'end'), at]);
    expect([fromStart?.anchor, fromStart?.head]).toEqual([bodyEdgePos(doc, 'start'), at]);
  });

  it('treats a press past an edge that has not moved as a click', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    expect(dragSelection(doc, { press: 'end', anchor: bodyEdgePos(doc, 'end'), left: false }, 'end', null)).toBeNull();
  });

  it('collapses to a caret beside the edge when the drag comes back past where it was pressed', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    const back = dragSelection(doc, { press: 'end', anchor: bodyEdgePos(doc, 'end'), left: true }, 'end', null);

    expect(back).toBeInstanceOf(TextSelection);
    expect(back?.empty).toBe(true);
    expect(back?.head).toBe(textStart(view, 'Mid') + 'Mid'.length);
  });

  it('is the whole document from one edge past the other', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    expect(dragSelection(doc, { press: 'end', anchor: bodyEdgePos(doc, 'end'), left: true }, 'start', null))
      .toBeInstanceOf(AllSelection);
    expect(dragSelection(doc, { press: 'start', anchor: bodyEdgePos(doc, 'start'), left: true }, 'end', null))
      .toBeInstanceOf(AllSelection);
  });

  it('keeps the anchor a Shift+click started from wherever the pointer goes', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;
    const at = textStart(view, 'Mid');
    const shift = { press: 'shift', anchor: at, left: true } as const;

    const inBody = dragSelection(doc, shift, 'body', at + 2);
    const pastEnd = dragSelection(doc, shift, 'end', null);

    expect([inBody?.anchor, inBody?.head]).toEqual([at, at + 2]);
    expect(pastEnd).toBeInstanceOf(BodyEdgeSelection);
    expect([pastEnd?.anchor, pastEnd?.head]).toEqual([at, bodyEdgePos(doc, 'end')]);
  });

  it('is the whole document from a Shift+click past one edge when the anchor is on the other', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    expect(dragSelection(doc, { press: 'shift', anchor: bodyEdgePos(doc, 'start'), left: true }, 'end', null)).toBeInstanceOf(AllSelection);
  });

  it('keeps the current selection when the pointer in the body lands on no position', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    expect(dragSelection(doc, { press: 'end', anchor: bodyEdgePos(doc, 'end'), left: true }, 'body', null)).toBeNull();
  });
});

describe('the browser extending a selection one of whose ends is an edge', () => {
  /**
   * Asks the editor what selection the browser's range reads back as.
   * @param view - The view.
   * @param anchor - The browser's anchor.
   * @param head - The browser's head.
   * @returns What a plugin answered, or null when none did.
   */
  function readBack(view: EditorView, anchor: number, head: number): Selection | null {
    const { doc } = view.state;
    return view.someProp('createSelectionBetween', (f) => f(view, doc.resolve(anchor), doc.resolve(head))) ?? null;
  }

  it('keeps the anchor on the edge', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const at = textStart(view, 'Above') + 2;

    const selection = readBack(view, bodyEdgePos(doc, 'end'), at);

    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect([selection?.anchor, selection?.head]).toEqual([bodyEdgePos(doc, 'end'), at]);
  });

  it('keeps a head written onto the edge', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const at = textStart(view, 'Above') + 2;

    const selection = readBack(view, at, bodyEdgePos(doc, 'end'));

    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect([selection?.anchor, selection?.head]).toEqual([at, bodyEdgePos(doc, 'end')]);
  });

  it('reads the page position past the last block as the end edge', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const at = textStart(view, 'Above') + 2;

    // The page can only say "past the last block" as the position between
    // blocks, one after the model's edge: measured, the edge written to the
    // page reads back as `size - 1`.
    const selection = readBack(view, doc.content.size - 1, at);

    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect([selection?.anchor, selection?.head]).toEqual([bodyEdgePos(doc, 'end'), at]);
  });

  it('reads the page position before the first block as the start edge', () => {
    const view = open(BELOW_DIVIDER_ROWS);
    const { doc } = view.state;
    const at = textStart(view, 'Below') + 2;

    const selection = readBack(view, 1, at);

    expect([selection?.anchor, selection?.head]).toEqual([bodyEdgePos(doc, 'start'), at]);
  });

  it('leaves a range past a last block with words to ProseMirror', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Below' }]);
    const at = textStart(view, 'Above');
    const size = view.state.doc.content.size;

    // Past the last block's content, and past the last block.
    for (const past of [size - 2, size - 1]) {
      expect(readBack(view, at, past)).toBeNull();
    }
  });

  it('leaves a collapsed range to ProseMirror', () => {
    const view = open(ABOVE_DIVIDER);
    const end = bodyEdgePos(view.state.doc, 'end');

    expect(readBack(view, end, end)).toBeNull();
  });

  it('leaves a range with neither end on an edge to ProseMirror', () => {
    const view = open(ABOVE_DIVIDER);
    const at = textStart(view, 'Above');

    expect(readBack(view, at, at + 3)).toBeNull();
  });
});

describe('what BlockNote reads from an edge selection', () => {
  it('finds the block at either end without falling back', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);
    const editor = editors.get(view)!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mid = textStart(view, 'Mid');

    for (const selection of [
      BodyEdgeSelection.fromEdge(view.state.doc, 'end', mid),
      BodyEdgeSelection.fromEdge(view.state.doc, 'start', mid),
    ]) {
      view.dispatch(view.state.tr.setSelection(selection));
      editor.getTextCursorPosition();
    }

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the caret a selection is dropped to', () => {
  it('sits in the last text before an end edge', () => {
    const view = open(ABOVE_DIVIDER);
    const selection = BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end');

    const caret = caretAtEnd(selection);

    expect(caret).toBeInstanceOf(TextSelection);
    expect(caret.empty).toBe(true);
    expect(caret.head).toBe(textStart(view, 'Above') + 'Above'.length);
  });

  it('sits at the text end of a selection anchored on the start edge', () => {
    const view = open(BELOW_DIVIDER_ROWS);
    const at = textStart(view, 'Below') + 3;

    expect(caretAtEnd(BodyEdgeSelection.fromEdge(view.state.doc, 'start', at)).head).toBe(at);
  });

  it('sits at the end of any other selection', () => {
    const view = open(ABOVE_DIVIDER);
    const at = textStart(view, 'Above');

    expect(caretAtEnd(TextSelection.create(view.state.doc, at, at + 3)).head).toBe(at + 3);
  });
});

describe('changing the block type under a selection that reaches past the last block', () => {
  it('keeps the same range, from the first word to the end', () => {
    const view = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'paragraph', content: 'Middle' },
      { type: 'divider' },
    ]);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end')));

    runBlockType(editors.get(view)! as never, 'heading-2');

    const { selection, doc } = view.state;
    expect(doc.resolve(textStart(view, 'Above')).parent.type.name).toBe('heading');
    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect([selection.anchor, selection.head]).toEqual([textStart(view, 'Above'), bodyEdgePos(doc, 'end')]);
  });
});

describe('moving rows under a selection that reaches past the last block', () => {
  it('keeps the same words and the divider selected', () => {
    const view = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'paragraph', content: 'Middle' },
      { type: 'divider' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Middle') + 1, 'end')));

    moveRowsFromKeyboard(editors.get(view)! as never, 'up');

    const { selection, doc } = view.state;
    const order: string[] = [];
    doc.firstChild!.forEach((row) => order.push(row.firstChild!.type.name === 'divider' ? '---' : row.textContent));
    expect(order).toEqual(['Middle', '---', 'Above']);
    expect(selection.from).toBe(textStart(view, 'Middle') + 1);
    let dividerAt = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'divider') dividerAt = pos;
    });
    expect(selection.to).toBeGreaterThan(dividerAt);
    expect(doc.textBetween(selection.from, selection.to)).toBe('iddle');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Shift+Enter on a selection that reaches past the last block', () => {
  it('does nothing: the head is on no line to break', () => {
    const view = open([{ type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const selection = BodyEdgeSelection.create(view.state.doc, textStart(view, 'Middle'), 'end');
    view.dispatch(view.state.tr.setSelection(selection));
    const before = view.state.doc;

    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    const took = view.someProp('handleKeyDown', (f) => f(view, event));

    expect(took).toBe(true);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
  });
});
