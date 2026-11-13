// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design 5.1 (the table of text readers), A8, A10: every reader of
 * the body's text sees a formula as `$$source$$`, though a formula holds its
 * source in a prop and no text of it sits in the body.
 *
 * A reader that passes `textBetween` a leaf reader of its own wins over the
 * node's `leafText`, so each of those is decided on its own: the Add to Agent
 * names and gates, the bubble bar's showing, the paste and drop gate, and
 * what a single dropped block selects.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';

import { drop, open, paste, positionOf, select, shape, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { hasTextIn } from '@web/spaces/document/SelectionBubbleBar';
import { IN_SELECTION_CLASS, noTextPaint } from '@web/spaces/document/document-selection-paint';
import { blockItem, rowHoldsContent, selectionHoldsContent, selectionItem } from '@web/spaces/document/document-to-agent';

afterEach(unmountAll);

/** A paragraph holding an inline formula between two words. */
const between = { type: 'paragraph', content: ['a ', { type: 'math', props: { source: 'x^2' } }, ' b'] };

/**
 * Where the first node of a type starts.
 * @param editor - The editor.
 * @param name - The node type.
 * @returns Its position, or -1.
 */
function posOf(editor: Editor, name: string): number {
  let at = -1;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The inline formulas' sources, in document order.
 * @param editor - The editor.
 * @returns Them.
 */
function inlineSources(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === 'math') out.push(String(node.attrs['source']));
  });
  return out;
}

describe('Add to Agent on a formula (A10)', () => {
  it('counts a block formula with a source as content, and an empty one as none', () => {
    const { editor } = open([
      { type: 'mathBlock', props: { source: 'x+1' } },
      { type: 'mathBlock', props: { source: '' } },
    ]);
    const [full, empty] = editor.document as { id: string }[];
    const doc = editor.prosemirrorView!.state.doc;

    expect(rowHoldsContent(doc, full!.id)).toBe(true);
    expect(rowHoldsContent(doc, empty!.id)).toBe(false);
  });

  it('counts a selection over an inline formula alone as content', () => {
    const { editor } = open([between]);
    const at = posOf(editor, 'math');
    select(editor, at, at + 1);

    expect(selectionHoldsContent(editor.prosemirrorView!.state.doc, editor.prosemirrorView!.state.selection)).toBe(true);
  });

  it('names a block formula item after its source', () => {
    const { editor } = open([{ type: 'mathBlock', props: { source: 'x+1' } }]);

    expect(blockItem(editor as never, (editor.document as { id: string }[])[0]!.id).name).toContain('x+1');
  });

  it('names a selection item with the formula in it', () => {
    const { editor } = open([between]);
    select(editor, positionOf(editor, 'a ', 0), positionOf(editor, ' b', 2));

    expect(selectionItem(editor as never).name).toBe('a $$x^2$$ b');
  });
});

describe('the bubble bar over a formula', () => {
  it('finds content in a range that holds only an inline formula', () => {
    const { editor } = open([between]);
    const at = posOf(editor, 'math');

    expect(hasTextIn(editor.prosemirrorView!.state.doc, at, at + 1)).toBe(true);
  });

  it('finds nothing in a block formula selected whole, as in a picture (design §5.2)', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
    ]);
    const at = posOf(editor, 'mathBlock');

    expect(hasTextIn(editor.prosemirrorView!.state.doc, at, at + 1)).toBe(false);
  });
});

describe('a range selection over a block formula', () => {
  it('paints the formula the way it paints a divider', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
      { type: 'paragraph', content: 'below' },
    ]);
    const doc = editor.prosemirrorView!.state.doc;
    const at = posOf(editor, 'mathBlock');

    const painted = noTextPaint(doc, { from: positionOf(editor, 'above', 0), to: positionOf(editor, 'below', 5) });

    expect(painted.some((d) => d.from === at && (d as unknown as { type: { attrs: { class?: string } } }).type.attrs.class === IN_SELECTION_CLASS)).toBe(true);
  });
});

describe('pasting and dropping a formula on its own (A8)', () => {
  it('pastes a line holding only an inline formula as a formula', () => {
    const { editor } = open([{ type: 'paragraph', content: 'here ' }]);
    select(editor, positionOf(editor, 'here ', 5));

    paste(editor, '<p><span data-math="x^2">$$x^2$$</span></p>', '$$x^2$$');

    expect(inlineSources(editor)).toEqual(['x^2']);
  });

  it('keeps an inline formula as $$source$$ when pasted into a code block', () => {
    const { editor } = open([{ type: 'codeBlock', content: '' }]);
    select(editor, posOf(editor, 'codeBlock') + 1);

    paste(editor, '<p>a <span data-math="x">$$x$$</span> b</p>', 'a $$x$$ b');

    expect(shape(editor)[0]).toBe('codeBlock:a $$x$$ b');
  });

  it('selects a dropped block formula whole, as a dropped image', () => {
    const { editor } = open([{ type: 'paragraph', content: 'above' }, { type: 'paragraph', content: '' }]);
    const at = positionOf(editor, 'above', 5) + 3;

    drop(editor, at, '<div data-math-block="x+1">$$\nx+1\n$$</div>', '$$\nx+1\n$$');

    const { selection } = editor.prosemirrorView!.state;
    expect(selection instanceof NodeSelection && selection.node.type.name === 'mathBlock').toBe(true);
  });
});
