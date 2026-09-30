// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124 A6: a selection that reaches past the first or last block of the body
 * when that block is a divider, a fallback block or an empty line.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  BodyEdgeSelection,
  bodyEdgeNeedsTakeover,
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

    expect(selection.to).toBe(doc.content.size - 1);
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
    expect(selection.to).toBe(view.state.doc.content.size - 1);
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
    const back = Selection.fromJSON(doc, { type: 'bodyEdge', anchor: between, head: doc.content.size - 1 });

    expect(back.$anchor.parent.inlineContent).toBe(true);
    expect(back.head).toBe(doc.content.size - 1);
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
    expect(next.to).toBe(view.state.doc.content.size - 1);
  });

  it('becomes a whole-document selection when the anchor is already on the other edge', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]);

    const next = extendToBodyEdge(view.state.doc, 1, 'end');

    expect(next).toBeInstanceOf(AllSelection);
  });
});

describe('Shift+Up and Shift+Down at the ends of the body', () => {
  it('Shift+Down on the last line takes a trailing divider in', () => {
    const view = open(ABOVE_DIVIDER);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Above'))));

    expect(press(view, 'ArrowDown')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.to).toBe(view.state.doc.content.size - 1);
  });

  it('Shift+Up on the first line takes a leading divider in', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Below') + 2)));

    expect(press(view, 'ArrowUp')).toBe(true);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect(view.state.selection.from).toBe(1);
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
    expect(view.state.selection.anchor).toBe(view.state.doc.content.size - 1);
    expect(view.state.selection.head).toBe(text - 1);
  });

  it('leaves Shift+Down to the browser when the body ends in words', () => {
    const view = open([{ type: 'paragraph', content: 'Only' }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart(view, 'Only'))));

    expect(press(view, 'ArrowDown')).toBe(false);
  });
});
