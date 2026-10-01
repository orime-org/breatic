// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124 A6: a selection that reaches past the first or last block of the body
 * when that block is a divider, a fallback block or an empty line.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { moveRowsFromKeyboard } from '@web/spaces/document/document-keyboard-move';
import { EMPTY_LINE_CLASS } from '@web/spaces/document/document-selection-paint';
import { selectorEndingIn } from '@web/spaces/document/__tests__/index-css-rules';
import {
  BodyEdgeSelection,
  bodyEdgeBetween,
  bodyEdgePos,
  bodyEdgeNeedsTakeover,
  caretAt,
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

  it('takes over an empty line of any kind at either end', () => {
    for (const empty of [
      { type: 'heading', props: { level: 2 } },
      { type: 'bulletListItem' },
      { type: 'codeBlock' },
    ]) {
      const view = open([empty, { type: 'paragraph', content: 'Middle' }, empty]);
      expect([bodyEdgeNeedsTakeover(view.state.doc, 'start'), bodyEdgeNeedsTakeover(view.state.doc, 'end')]).toEqual([true, true]);
    }
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

  it('reads two ends on the same edge from JSON as the caret beside it, like every other path', () => {
    const view = open(ABOVE_DIVIDER);
    const { doc } = view.state;
    const end = bodyEdgePos(doc, 'end');

    const back = Selection.fromJSON(doc, { type: 'bodyEdge', anchor: end, head: end });

    expect(back.eq(bodyEdgeBetween(doc, end, end))).toBe(true);
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

  it('Shift+Right carries the text end over into the next block', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const aboveEnd = textStart(view, 'Above') + 'Above'.length;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', aboveEnd)));

    press(view, 'ArrowRight');

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.head).toBe(textStart(view, 'Middle'));
  });

  it('Shift+Right past the last text onto the anchor edge collapses to a caret', () => {
    const view = open(ABOVE_DIVIDER);
    const aboveEnd = textStart(view, 'Above') + 'Above'.length;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', aboveEnd)));

    press(view, 'ArrowRight');

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([aboveEnd, aboveEnd]);
  });

  it('Shift+Left past the first text onto the other edge takes the whole document', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', textStart(view, 'Mid'))));

    press(view, 'ArrowLeft');

    expect(view.state.selection).toBeInstanceOf(AllSelection);
  });

  it('Shift+Up from a selection anchored on the end reaches a leading divider', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', textStart(view, 'Mid') + 1)));

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(AllSelection);
  });

  it('Shift+Up from a selection anchored on the start moves the head a line up, as the browser lays it out', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }]);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'start', textStart(view, 'Middle') + 2)));
    const above = [...view.dom.querySelectorAll('.bn-inline-content')].find((el) => el.textContent === 'Above')!.firstChild!;
    const dom = document.getSelection()!;
    const modify = vi.fn(() => dom.collapse(above, 3));
    Object.assign(dom, { modify });

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(modify).toHaveBeenCalledWith('move', 'backward', 'line');
    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      bodyEdgePos(view.state.doc, 'start'),
      textStart(view, 'Above') + 3,
    ]);
  });

  /**
   * Lays out the lines of a block for coordsAtPos: the head on one line, the
   * block's start and end on the first and the last.
   * @param view - The view.
   * @param head - The head.
   * @param headLine - Which of three lines the head is on, 0 to 2.
   */
  function linesFor(view: EditorView, head: number, headLine: number): void {
    const $head = view.state.doc.resolve(head);
    const line = (n: number): { left: number; right: number; top: number; bottom: number } => ({ left: 0, right: 10, top: n * 20, bottom: n * 20 + 20 });
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) =>
      line(pos === head ? headLine : pos === $head.start() ? 0 : pos === $head.end() ? 2 : headLine),
    );
  }

  it('Shift+Down from a head on the first of three lines next to the end is not taken as the last line', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const head = textStart(view, 'Middle') + 2;
    const selection = BodyEdgeSelection.fromEdge(view.state.doc, 'end', head);
    view.dispatch(view.state.tr.setSelection(selection));
    linesFor(view, head, 0);

    press(view, 'ArrowDown');

    expect(view.state.selection.eq(selection)).toBe(true);
  });

  it('Shift+Down from a head on the last of three lines next to the end takes the end in', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const head = textStart(view, 'Middle') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'), head)));
    linesFor(view, head, 2);

    press(view, 'ArrowDown');

    expect([view.state.selection.constructor, view.state.selection.head]).toEqual([BodyEdgeSelection, bodyEdgePos(view.state.doc, 'end')]);
  });

  it('moves the top of a range made by the mouse on Shift+Up, as the page does, and reaches a leading divider from it', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Last' }]);
    const from = textStart(view, 'Middle') + 1;
    const to = textStart(view, 'Middle') + 5;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const $from = view.state.doc.resolve(from);
    const line = (n: number): { left: number; right: number; top: number; bottom: number } => ({ left: 0, right: 10, top: n * 20, bottom: n * 20 + 20 });
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => line(pos === to || pos === $from.end() ? 2 : 0));
    Object.defineProperty(document.getSelection()!, 'direction', { value: 'none', configurable: true });
    try {
      expect(press(view, 'ArrowUp')).toBe(true);
    } finally {
      Reflect.deleteProperty(document.getSelection()!, 'direction');
    }

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([to, bodyEdgePos(view.state.doc, 'start')]);
  });

  it('takes a head at a line wrap as the line it ends, so Shift+Down from the end of the next-to-last line moves a line first', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const head = textStart(view, 'Middle') + 3;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'), head)));
    const $head = view.state.doc.resolve(head);
    const line = (n: number): { left: number; right: number; top: number; bottom: number } => ({ left: 0, right: 10, top: n * 20, bottom: n * 20 + 20 });
    // The wrap point reads as the end of line 0 leaning back and the start of line 1 leaning on.
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos, side) => line(pos === head ? (side !== undefined && side < 0 ? 0 : 1) : pos === $head.end() ? 1 : 0));

    expect(press(view, 'ArrowDown')).toBe(false);
  });

  it('reads the last line of a block ending in a line break as that empty line, not the one above it', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const head = textStart(view, 'Middle') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'), head)));
    const $head = view.state.doc.resolve(head);
    const line = (n: number): { left: number; right: number; top: number; bottom: number } => ({ left: 0, right: 10, top: n * 20, bottom: n * 20 + 20 });
    // The block's end leaning back reads the break on the head's line; leaning on, the empty line below it.
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos, side) =>
      line(pos === $head.end() ? (side !== undefined && side < 0 ? 0 : 1) : 0),
    );

    expect(press(view, 'ArrowDown')).toBe(false);
  });

  it('leaves the whole document as it is on Shift+Right and Shift+Down when the body ends in words', () => {
    for (const key of ['ArrowRight', 'ArrowDown']) {
      const view = open([{ type: 'paragraph', content: 'One' }, { type: 'paragraph', content: 'Two' }]);
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

      press(view, key);

      expect(view.state.selection).toBeInstanceOf(AllSelection);
    }
  });

  it('measures the line without swapping the view state, which would reset the browser\'s goal column', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const head = textStart(view, 'Middle') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'), head)));
    linesFor(view, head, 0);
    const updates = vi.spyOn(view, 'updateState');

    expect(press(view, 'ArrowDown')).toBe(false);

    expect(updates).not.toHaveBeenCalled();
  });

  it('Shift+Left steps over a whole emoji, not half of it', () => {
    const view = open([{ type: 'paragraph', content: 'Hi\u{1F600}' }, { type: 'divider' }]);
    const after = textStart(view, 'Hi\u{1F600}') + 4;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', after)));

    press(view, 'ArrowLeft');

    expect(view.state.selection.head).toBe(after - 2);
  });

  it('Shift+Right steps over a joined emoji sequence in one press', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const view = open([{ type: 'paragraph', content: `A${family}B` }, { type: 'divider' }]);
    const start = textStart(view, `A${family}B`) + 1;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'end', start)));

    press(view, 'ArrowRight');

    expect(view.state.selection.head).toBe(start + family.length);
  });

  it('Shift+Up from the whole document lets go of the end and keeps the start', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      bodyEdgePos(view.state.doc, 'start'),
      textStart(view, 'Mid') + 'Mid'.length,
    ]);
  });

  it('leaves Shift+Down to the browser when the body ends in words', () => {
    const view = open([{ type: 'paragraph', content: 'Only' }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Only'))));

    expect(press(view, 'ArrowDown')).toBe(false);
  });
});

describe('Enter on a selection that reaches past an end', () => {
  /**
   * The text of every text block, and whether a divider is left.
   * @param view - The view.
   * @returns The lines, then the dividers left.
   */
  function lines(view: EditorView): { texts: string[]; dividers: number } {
    const texts: string[] = [];
    let dividers = 0;
    view.state.doc.descendants((node) => {
      if (node.isTextblock) texts.push(node.textContent);
      if (node.type.name === 'divider') dividers += 1;
      return true;
    });
    return { texts, dividers };
  }

  it('replaces the range and breaks the line, whichever end is on which edge', () => {
    const cases = [
      { blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'Below' }], make: (v: EditorView) => BodyEdgeSelection.create(v.state.doc, textStart(v, 'Below') + 2, 'start'), texts: ['', 'low'] },
      { blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'Below' }], make: (v: EditorView) => BodyEdgeSelection.fromEdge(v.state.doc, 'start', textStart(v, 'Below') + 2), texts: ['', 'low'] },
      { blocks: ABOVE_DIVIDER, make: (v: EditorView) => BodyEdgeSelection.create(v.state.doc, textStart(v, 'Above') + 1, 'end'), texts: ['A', ''] },
      { blocks: ABOVE_DIVIDER, make: (v: EditorView) => BodyEdgeSelection.fromEdge(v.state.doc, 'end', textStart(v, 'Above') + 1), texts: ['A', ''] },
    ];
    for (const { blocks, make, texts } of cases) {
      const view = open(blocks);
      view.dispatch(view.state.tr.setSelection(make(view)));

      expect(press(view, 'Enter', false)).toBe(true);

      expect(lines(view)).toEqual({ texts, dividers: 0 });
    }
  });
});

describe('plain Left and Right on a selection that reaches past an end', () => {
  it('collapse it to a caret at its start and at its end, both in text', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
    const from = textStart(view, 'Middle') + 2;
    const selection = BodyEdgeSelection.create(view.state.doc, from, 'end');
    const caret = (): number[] => [view.state.selection.anchor, view.state.selection.head];

    view.dispatch(view.state.tr.setSelection(selection));
    expect(press(view, 'ArrowLeft', false)).toBe(true);
    expect(caret()).toEqual([from, from]);

    view.dispatch(view.state.tr.setSelection(selection));
    expect(press(view, 'ArrowRight', false)).toBe(true);
    const end = textStart(view, 'Middle') + 'Middle'.length;
    expect(caret()).toEqual([end, end]);
  });
});

describe('extending from a selected block that has no text', () => {
  /**
   * Selects the divider at a position.
   * @param view - The view.
   * @param index - Which divider, in document order.
   */
  function selectDivider(view: EditorView, index: number): void {
    const found: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'divider') found.push(pos);
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, found[index]!)));
  }

  it('keeps a divider in the middle when Shift+Down or Shift+Right goes on from it', () => {
    for (const key of ['ArrowDown', 'ArrowRight']) {
      const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
      selectDivider(view, 0);

      expect(press(view, key)).toBe(true);

      expect(view.state.selection).toBeInstanceOf(TextSelection);
      expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
        textStart(view, 'Above') + 'Above'.length,
        textStart(view, 'Below'),
      ]);
    }
  });

  it('anchors on the start when the divider is the first block', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
    selectDivider(view, 0);

    press(view, 'ArrowDown');

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      bodyEdgePos(view.state.doc, 'start'),
      textStart(view, 'Below'),
    ]);
  });

  it('anchors on the end when Shift+Up goes on from the last block', () => {
    const view = open(ABOVE_DIVIDER);
    selectDivider(view, 0);

    press(view, 'ArrowUp');

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      bodyEdgePos(view.state.doc, 'end'),
      textStart(view, 'Above') + 'Above'.length,
    ]);
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
    const shift = { press: 'body', anchor: at, left: true } as const;

    const inBody = dragSelection(doc, shift, 'body', at + 2);
    const pastEnd = dragSelection(doc, shift, 'end', null);

    expect([inBody?.anchor, inBody?.head]).toEqual([at, at + 2]);
    expect(pastEnd).toBeInstanceOf(BodyEdgeSelection);
    expect([pastEnd?.anchor, pastEnd?.head]).toEqual([at, bodyEdgePos(doc, 'end')]);
  });

  it('is the whole document from a Shift+click past one edge when the anchor is on the other', () => {
    const view = open(BOTH_ENDS);
    const { doc } = view.state;

    expect(dragSelection(doc, { press: 'body', anchor: bodyEdgePos(doc, 'start'), left: true }, 'end', null)).toBeInstanceOf(AllSelection);
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

    const caret = caretAt(selection, 1);

    expect(caret).toBeInstanceOf(TextSelection);
    expect(caret.empty).toBe(true);
    expect(caret.head).toBe(textStart(view, 'Above') + 'Above'.length);
  });

  it('sits at the text end of a selection anchored on the start edge', () => {
    const view = open(BELOW_DIVIDER_ROWS);
    const at = textStart(view, 'Below') + 3;

    expect(caretAt(BodyEdgeSelection.fromEdge(view.state.doc, 'start', at), 1).head).toBe(at);
  });

  it('sits at the end of any other selection', () => {
    const view = open(ABOVE_DIVIDER);
    const at = textStart(view, 'Above');

    expect(caretAt(TextSelection.create(view.state.doc, at, at + 3), 1).head).toBe(at + 3);
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
  it('keeps a moved divider selected when only another divider lies outward', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Text' }, { type: 'divider' }, { type: 'paragraph', content: 'Tail' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Text') + 2, 'start')));

    moveRowsFromKeyboard(editors.get(view)! as never, 'down');

    const { selection, doc } = view.state;
    const dividers: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'divider') dividers.push(pos);
    });
    expect(selection.from).toBe(bodyEdgePos(doc, 'start'));
    expect(dividers.every((pos) => pos >= selection.from && pos < selection.to)).toBe(true);
    expect(selection.to).toBe(textStart(view, 'Text') + 2);
  });

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

describe('an empty line at an end of the body, inside the selection', () => {
  /**
   * Whether each paragraph's element carries the empty-line mark's class, by its text.
   * @param view - The view.
   * @returns Text and whether it is painted, per paragraph.
   */
  function paragraphs(view: EditorView): string[] {
    return [...view.dom.querySelectorAll('[data-content-type="paragraph"]')].map(
      (el) => `${el.textContent ?? ''}:${el.classList.contains(EMPTY_LINE_CLASS)}`,
    );
  }

  it('is painted when the selection reaches past the last block', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: '' }]);
    view.focus();

    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end')));

    expect(paragraphs(view)).toEqual(['Above:false', ':true']);
  });

  it('is painted when the selection reaches past the first block', () => {
    const view = open([{ type: 'paragraph', content: '' }, { type: 'paragraph', content: 'Below' }]);
    view.focus();

    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'start', textStart(view, 'Below') + 2)));

    expect(paragraphs(view)).toEqual([':true', 'Below:false']);
  });

  it('is painted when it is nested under the last row', () => {
    const view = open([
      { type: 'bulletListItem', content: 'Parent', children: [{ type: 'paragraph', content: '' }] },
    ]);
    view.focus();

    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Parent'), 'end')));

    expect(paragraphs(view)).toEqual([':true']);
  });

  it('is painted at both ends under a whole-document selection', () => {
    const view = open([{ type: 'paragraph', content: '' }, { type: 'paragraph', content: 'Mid' }, { type: 'paragraph', content: '' }]);
    view.focus();

    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    expect(paragraphs(view)).toEqual([':true', 'Mid:false', ':true']);
  });

  it('is painted when the empty line at the end is a heading', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'heading', props: { level: 2 } }]);
    view.focus();

    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end')));

    expect(view.dom.querySelector('[data-content-type="heading"]')?.classList.contains(EMPTY_LINE_CLASS)).toBe(true);
  });

  it('is drawn in an empty code block, whose line sits deeper than a paragraph\'s', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'codeBlock' }]);
    view.focus();
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textStart(view, 'Above'), 'end')));
    const rule = selectorEndingIn('.bn-inline-content::before').replace('::before', '');

    const drawn = view.dom.parentElement!.querySelector(rule);

    expect(drawn?.tagName).toBe('CODE');
  });

  it('is left to the browser under a text selection', () => {
    const view = open([{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: '' }]);
    view.focus();
    const at = textStart(view, 'Above');

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 'Above'.length + 3)));

    expect(paragraphs(view)).toEqual(['Above:false', ':false']);
  });
});
