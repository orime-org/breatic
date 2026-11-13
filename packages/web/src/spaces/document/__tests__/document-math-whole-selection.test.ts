// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design 6.6: where a selection end that reaches into a hidden
 * formula source settles, in the cases a single hop got wrong.
 *
 * The end moves the way the head moved (or, for an end that did not move,
 * away from the other end), past every hidden source it would still be in,
 * and never out of the table cell the formula sits in. Going forward past a
 * closed block formula it stops at the end of the formula's own line, so
 * the lines indented under it stay out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedPos } from '@tiptap/pm/model';

import { open, positionOf, select, type, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { cellDepthOf } from '@web/spaces/document/document-table-nodes';

afterEach(unmountAll);

/**
 * Where the nth node of a type starts.
 * @param editor - The editor.
 * @param name - The node type.
 * @param nth - Which one, from 0.
 * @returns Its position, or -1.
 */
function posOf(editor: Editor, name: string, nth = 0): number {
  let at = -1;
  let seen = 0;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) {
      if (seen === nth) at = pos;
      seen += 1;
    }
    return at < 0;
  });
  return at;
}

/**
 * Every text block as `type:text`, nested ones too.
 * @param editor - The editor.
 * @returns The lines.
 */
function lines(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(`${node.type.name}:${node.textContent}`);
    return true;
  });
  return out;
}

/**
 * Deletes the selection, the way Delete over a range does.
 * @param editor - The editor.
 */
function deleteSelection(editor: Editor): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.deleteSelection());
}

/**
 * The selection's head.
 * @param editor - The editor.
 * @returns It, resolved.
 */
function head(editor: Editor): ResolvedPos {
  return editor.prosemirrorView!.state.selection.$head;
}

/** A line, two closed block formulas one under the other, a line. */
const STACKED = [
  { type: 'paragraph', content: 'head' },
  { type: 'mathBlock', content: 'aaa' },
  { type: 'mathBlock', content: 'bbb' },
  { type: 'paragraph', content: 'tail' },
];

describe('two closed block formulas one under the other', () => {
  it('a drag down into the first ends with it, short of the second', () => {
    const { editor } = open(STACKED);
    select(editor, positionOf(editor, 'head', 2), posOf(editor, 'mathBlock', 0) + 2);

    expect(head(editor).parent.textContent).toBe('aaa');
    expect(head(editor).parentOffset).toBe(3);
  });

  it('Delete after a drag down into the first leaves the second as it was', () => {
    const { editor } = open(STACKED);
    select(editor, positionOf(editor, 'head', 2), posOf(editor, 'mathBlock', 0) + 2);

    deleteSelection(editor);

    expect(lines(editor)).toEqual(['paragraph:he', 'mathBlock:bbb', 'paragraph:tail']);
  });

  it('typing after a drag down into the first leaves the second as it was', () => {
    const { editor } = open(STACKED);
    select(editor, positionOf(editor, 'head', 2), posOf(editor, 'mathBlock', 0) + 2);

    type(editor, 'Z');

    expect(lines(editor)).toEqual(['paragraph:heZ', 'mathBlock:bbb', 'paragraph:tail']);
  });

  it('a drag up into the second ends in visible text, never inside the first', () => {
    const { editor } = open(STACKED);
    select(editor, positionOf(editor, 'tail', 2), posOf(editor, 'mathBlock', 1) + 2);

    expect(head(editor).parent.type.name).toBe('paragraph');
    expect(head(editor).parent.textContent).toBe('head');
  });

  it('Delete after a drag up into the second writes no line into a formula', () => {
    const { editor } = open(STACKED);
    select(editor, positionOf(editor, 'tail', 2), posOf(editor, 'mathBlock', 1) + 2);

    deleteSelection(editor);

    expect(lines(editor)).toEqual(['paragraph:headil']);
  });
});

describe('a closed block formula that opens a table cell', () => {
  /** Two cells; the second starts with a formula above a line. */
  const CELLS = [
    tableBlock({ rows: [{ cells: ['c1', { blocks: [{ type: 'mathBlock', content: 'abc' }, { type: 'paragraph', content: 'c2' }] }] }] }),
  ];

  it('a drag up from the line under it stays in its cell', () => {
    const { editor } = open(CELLS);
    const anchor = positionOf(editor, 'c2', 1);
    select(editor, anchor, posOf(editor, 'mathBlock') + 2);

    const { $anchor, $head } = editor.prosemirrorView!.state.selection;
    expect($head.before(cellDepthOf($head))).toBe($anchor.before(cellDepthOf($anchor)));
    expect($head.parent.textContent).toBe('c2');
  });

  it('Backspace after that drag keeps both cells', () => {
    const { editor } = open(CELLS);
    select(editor, positionOf(editor, 'c2', 1), posOf(editor, 'mathBlock') + 2);

    deleteSelection(editor);

    expect(lines(editor)).toEqual(['paragraph:c1', 'mathBlock:abc', 'paragraph:2']);
  });
});

describe('Shift+Arrow past a formula and back (6.6)', () => {
  it('shrinks back over an inline formula', () => {
    const { editor } = open([{ type: 'paragraph', content: ['ab ', { type: 'math', content: 'xy' }, ' cd'] }]);
    const math = posOf(editor, 'math');
    const after = math + 4;
    const anchor = positionOf(editor, 'ab', 1);
    select(editor, anchor, after + 1);

    // Shift+ArrowLeft twice: right after the formula, then into its source.
    select(editor, anchor, after);
    select(editor, anchor, after - 1);

    expect(editor.prosemirrorView!.state.selection.head).toBe(math);
  });

  it('shrinks back over a closed block formula', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'hello' },
      { type: 'mathBlock', content: 'abc' },
      { type: 'paragraph', content: 'tail' },
    ]);
    const anchor = positionOf(editor, 'hello', 5);
    const math = posOf(editor, 'mathBlock');
    // Shift+ArrowRight into the start of the hidden source.
    select(editor, anchor, math + 1);
    expect(head(editor).parent.type.name).toBe('mathBlock');

    // Shift+ArrowLeft: the head steps back inside the source.
    select(editor, anchor, editor.prosemirrorView!.state.selection.head - 1);

    expect(editor.prosemirrorView!.state.selection.head).toBe(anchor);
  });

  it('shrinks back over a closed block formula from below', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'hello' },
      { type: 'mathBlock', content: 'abc' },
      { type: 'paragraph', content: 'tail' },
    ]);
    const anchor = positionOf(editor, 'tail', 0);
    const math = posOf(editor, 'mathBlock');
    // Shift+ArrowLeft into the end of the hidden source.
    select(editor, anchor, math + 4);
    expect(head(editor).parent.textContent).toBe('hello');

    // Shift+ArrowRight: the head steps into the start of the source.
    select(editor, anchor, math + 1);

    expect(editor.prosemirrorView!.state.selection.head).toBe(anchor);
  });
});

describe('a closed block formula with lines indented under it', () => {
  it('a drag down into it leaves those lines out', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'hello' },
      { type: 'mathBlock', content: 'abc', children: [{ type: 'paragraph', content: 'kid' }] },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'hello', 2), posOf(editor, 'mathBlock') + 2);

    expect(head(editor).parent.textContent).toBe('abc');

    deleteSelection(editor);

    expect(lines(editor)).toEqual(['paragraph:he', 'paragraph:kid', 'paragraph:tail']);
  });
});
