// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The body's own copies read as slices and the slice read as lines (inner#1351
 * design §5.4.1 reading table, §5.4.3 "slice read as lines"): a copy read back
 * is the slice that was copied, ids and open ends included, and the same
 * lines read the same whether they were copied nested or at the top.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Selection } from '@tiptap/pm/state';

import { readClipboardSlice, rowsOf } from '@web/spaces/document/document-paste-slice';
import { OURS, open, positionOf, unmountAll, type Editor } from './paste-harness';
import { tableBlock } from './table-fixtures';

afterEach(unmountAll);

/**
 * A selection between two places in words.
 * @param editor - The editor.
 * @param a - The words and offset it starts at.
 * @param b - The words and offset it ends at.
 * @returns The selection.
 */
function between(editor: Editor, a: [string, number], b: [string, number]): Selection {
  return TextSelection.create(editor.prosemirrorView.state.doc, positionOf(editor, ...a), positionOf(editor, ...b));
}

/**
 * What the reader's copy of a selection reads back as, in another body.
 * @param editor - The body copied from.
 * @param selection - What the reader selected.
 * @returns The original slice and the slice read back.
 */
function copyAndRead(editor: Editor, selection: Selection): { original: Slice; read: Slice } {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(selection));
  const { dom, text, slice: original } = view.serializeForClipboard(view.state.selection.content());
  return { original, read: readClipboardSlice(view.state.schema, dom.innerHTML, text) };
}

/**
 * A line as a label: `type:words`, nested lines in brackets.
 * @param node - A block container, or a block such as a table.
 * @returns The label.
 */
function label(node: PMNode): string {
  if (node.type.name !== 'blockContainer') return node.type.name;
  const own = node.firstChild!;
  const group = node.childCount > 1 ? node.lastChild! : null;
  const kids: string[] = [];
  group?.forEach((kid) => kids.push(label(kid)));
  return `${own.type.name}:${own.textContent}${kids.length > 0 ? `[${kids.join('|')}]` : ''}`;
}

/**
 * The lines a selection's copy reads as, and how each end lands.
 * @param editor - The body copied from.
 * @param selection - What the reader selected.
 * @returns The labels and both ends.
 */
function linesOf(editor: Editor, selection: Selection): { rows: string[]; start: string; end: string } {
  const { rows, start, end } = rowsOf(copyAndRead(editor, selection).read);
  return { rows: rows.map(label), start, end };
}

const COPIES: Record<string, { blocks: unknown[]; pick: (editor: Editor) => Selection }> = {
  twoParas: { blocks: [{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph', content: 'bbbb' }], pick: (e) => between(e, ['aaaa', 2], ['bbbb', 2]) },
  headingToList: { blocks: [{ type: 'heading', props: { level: 2 }, content: 'hhhh' }, { type: 'bulletListItem', content: 'llll' }], pick: (e) => between(e, ['hhhh', 1], ['llll', 3]) },
  nestedKid: { blocks: [{ type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk' }] }, { type: 'paragraph', content: 'qqqq' }], pick: (e) => between(e, ['kkkk', 2], ['qqqq', 2]) },
  intoKid: { blocks: [{ type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk' }] }], pick: (e) => between(e, ['pppp', 2], ['kkkk', 2]) },
  quoted: { blocks: [{ type: 'paragraph', props: { quoted: true }, content: 'qqqq' }, { type: 'paragraph', props: { quoted: true }, content: 'rrrr' }], pick: (e) => between(e, ['qqqq', 1], ['rrrr', 3]) },
  code: { blocks: [{ type: 'codeBlock', content: 'c1\nc2' }, { type: 'paragraph', content: 'tttt' }], pick: (e) => between(e, ['c1', 1], ['tttt', 2]) },
  image: { blocks: [{ type: 'paragraph', content: 'aaaa' }, { type: 'image', props: { url: `${OURS}x.png`, caption: 'cap' } }, { type: 'paragraph', content: 'bbbb' }], pick: (e) => between(e, ['aaaa', 2], ['bbbb', 2]) },
  marks: {
    blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'boldtext', styles: { bold: true, textColor: 'red' } }, { type: 'link', href: 'https://x.test/', content: 'lnk' }] }, { type: 'paragraph', content: 'zzzz' }],
    pick: (e) => between(e, ['boldtext', 2], ['zzzz', 2]),
  },
  tableWhole: { blocks: [{ type: 'paragraph', content: 'aaaa' }, tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['d1', 'd2'] }] }), { type: 'paragraph', content: 'bbbb' }], pick: (e) => between(e, ['aaaa', 2], ['bbbb', 2]) },
  inCell: { blocks: [tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: 'cc11' }, { type: 'paragraph', content: 'cc22' }] }, 'c2'] }] })], pick: (e) => between(e, ['cc11', 2], ['cc22', 2]) },
  cellBlocks: {
    blocks: [tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'heading', content: 'hh' }, { type: 'image', props: { url: `${OURS}y.png` } }, { type: 'paragraph', content: 'pp' }] }, 'c2'] }] }), { type: 'paragraph', content: 'after' }],
    pick: (e) => between(e, ['hh', 0], ['after', 2]),
  },
  checkNumbered: { blocks: [{ type: 'checkListItem', props: { checked: true }, content: 'chk1' }, { type: 'numberedListItem', content: 'num1' }], pick: (e) => between(e, ['chk1', 1], ['num1', 3]) },
};

describe('a copy of the body read back', () => {
  it.each(Object.keys(COPIES))('is the slice that was copied: %s', (name) => {
    const { editor } = open(COPIES[name]!.blocks as never);
    const { original, read } = copyAndRead(editor, COPIES[name]!.pick(editor));
    expect(read.toJSON()).toEqual(original.toJSON());
  });

  it('reads words copied inside a stored table\'s cell as those words, a valid slice', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } },
      { type: 'paragraph', content: 'tail' },
    ] as never);
    const { read } = copyAndRead(editor, between(editor, ['l1', 0], ['l1', 2]));
    expect(() => read.content.forEach((node) => node.check())).not.toThrow();
    expect(rowsOf(read).rows.map(label)).toEqual(['paragraph:l1']);
  });
});

describe('a copy the schema does not take, read as whole blocks', () => {
  it.each([['double', '"'], ['single', '\'']] as const)('reads one whose slice is recorded in %s quotes at once, a valid slice', (_name, quote) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } }] as never);
    const view = editor.prosemirrorView;
    // A stored cell's words as another editor copies them: inside the cell, which the body's paragraphs do not go in.
    const { dom, text } = view.serializeForClipboard(between(editor, ['l1', 0], ['l1', 2]).content());
    const recorded = dom.firstElementChild!.getAttribute('data-pm-slice')!;
    const html = dom.innerHTML.replace(/data-pm-slice="[^"]*"/, `data-pm-slice=${quote}${recorded.replaceAll('"', quote === '"' ? '&quot;' : '"')}${quote}`);
    const started = performance.now();
    const read = readClipboardSlice(view.state.schema, html, text);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => read.content.forEach((node) => node.check())).not.toThrow();
    expect(read.content.textBetween(0, read.content.size)).toBe('l1');
  });
});

describe('a slice read as lines', () => {
  it('reads two open lines as lines whose words join', () => {
    const { editor } = open(COPIES['twoParas']!.blocks as never);
    expect(linesOf(editor, COPIES['twoParas']!.pick(editor))).toEqual({ rows: ['paragraph:aa', 'paragraph:bb'], start: 'joins', end: 'joins' });
  });

  it('keeps each line its own type', () => {
    const { editor } = open(COPIES['headingToList']!.blocks as never);
    expect(linesOf(editor, COPIES['headingToList']!.pick(editor))).toEqual({ rows: ['heading:hhh', 'bulletListItem:lll'], start: 'joins', end: 'joins' });
  });

  it('drops the parent a copy starting in a nested line passes through', () => {
    const { editor } = open(COPIES['nestedKid']!.blocks as never);
    expect(linesOf(editor, COPIES['nestedKid']!.pick(editor))).toEqual({ rows: ['paragraph:kk', 'paragraph:qq'], start: 'joins', end: 'joins' });
  });

  it('takes the nested line a copy ends in out of its parent', () => {
    const { editor } = open(COPIES['intoKid']!.blocks as never);
    expect(linesOf(editor, COPIES['intoKid']!.pick(editor))).toEqual({ rows: ['paragraph:pp', 'paragraph:kk'], start: 'joins', end: 'joins' });
  });

  it('drops parents two levels up a copy starts under', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk', children: [{ type: 'paragraph', content: 'gggg' }] }] },
      { type: 'paragraph', content: 'qqqq' },
    ] as never);
    expect(linesOf(editor, between(editor, ['gggg', 2], ['qqqq', 2]))).toEqual({ rows: ['paragraph:gg', 'paragraph:qq'], start: 'joins', end: 'joins' });
  });

  it('takes a line nested two levels down a copy ends in out of its parents', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk', children: [{ type: 'paragraph', content: 'gggg' }] }] },
    ] as never);
    expect(linesOf(editor, between(editor, ['pppp', 2], ['gggg', 2]))).toEqual({ rows: ['paragraph:pp', 'paragraph:kkkk', 'paragraph:gg'], start: 'joins', end: 'joins' });
  });

  it('reads a copy starting at a line\'s end as a boundary, the lines nested under it following it', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk' }] },
      { type: 'paragraph', content: 'qqqq' },
    ] as never);
    expect(linesOf(editor, between(editor, ['pppp', 4], ['qqqq', 2]))).toEqual({ rows: ['paragraph:kkkk', 'paragraph:qq'], start: 'boundary', end: 'joins' });
  });

  it('reads a whole empty line selected between two lines as content between two boundaries', () => {
    const { editor } = open([{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph' }, { type: 'paragraph', content: 'bbbb' }] as never);
    expect(linesOf(editor, between(editor, ['aaaa', 4], ['bbbb', 0]))).toEqual({ rows: ['paragraph:'], start: 'boundary', end: 'boundary' });
  });

  it('reads lines copied inside one cell as lines, without the table', () => {
    const { editor } = open(COPIES['inCell']!.blocks as never);
    expect(linesOf(editor, COPIES['inCell']!.pick(editor))).toEqual({ rows: ['paragraph:11', 'paragraph:cc'], start: 'joins', end: 'joins' });
  });

  it('lands a code block the copy opens into at its start as its own block', () => {
    const { editor } = open(COPIES['code']!.blocks as never);
    expect(linesOf(editor, COPIES['code']!.pick(editor))).toEqual({ rows: ['codeBlock:1\nc2', 'paragraph:tt'], start: 'apart', end: 'joins' });
  });

  it('lands a code block the copy opens into at its end as its own block', () => {
    const { editor } = open([{ type: 'paragraph', content: 'aaaa' }, { type: 'codeBlock', content: 'c1' }] as never);
    expect(linesOf(editor, between(editor, ['aaaa', 2], ['c1', 1]))).toEqual({ rows: ['paragraph:aa', 'codeBlock:c'], start: 'joins', end: 'apart' });
  });

  it('joins the words of a closed slice\'s first and last lines and lands a medium at an end apart', () => {
    const { editor } = open([{ type: 'paragraph', content: 'w' }, { type: 'image', props: { url: `${OURS}x.png` } }, { type: 'paragraph', content: 'v' }] as never);
    const { doc } = editor.prosemirrorView.state;
    const blocks: PMNode[] = [];
    doc.firstChild!.forEach((block) => blocks.push(block));
    const words = rowsOf(new Slice(Fragment.from(blocks), 0, 0));
    expect({ rows: words.rows.map(label), start: words.start, end: words.end }).toEqual({ rows: ['paragraph:w', 'image:', 'paragraph:v'], start: 'joins', end: 'joins' });
    const media = rowsOf(new Slice(Fragment.from(blocks.slice(1)), 0, 0));
    expect({ start: media.start, end: media.end }).toEqual({ start: 'apart', end: 'joins' });
  });

  it('reads the same lines copied nested and copied at the top the same', () => {
    const { editor: nested } = open([{ type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph', content: 'bbbb' }] }] as never);
    const { editor: top } = open(COPIES['twoParas']!.blocks as never);
    expect(linesOf(nested, between(nested, ['aaaa', 2], ['bbbb', 2]))).toEqual(linesOf(top, COPIES['twoParas']!.pick(top)));
  });
});
