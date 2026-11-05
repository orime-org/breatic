// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two paths content takes into the body (inner#1351 design §5.4.3 "the
 * slice transformed once on the target", "one line of words", code blocks and
 * stored tables): one line of words through ProseMirror's own paste, every
 * other content through our placement, each transform once on the target, and
 * row ids that never repeat.
 */

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { canvasClipboardOf } from './canvas-clipboard-fixture';
import { OURS, open, pasteFormats, positionOf, settled, shape, unmountAll, type Editor } from './paste-harness';
import { nodeAt } from './paste-matrix';
import { tableBlock } from './table-fixtures';

afterEach(unmountAll);

const PIC = `${OURS}p.png`;
const STORED = { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } };

/**
 * Opens a body and lets its first mutations finish.
 * @param blocks - The body.
 * @returns The editor.
 */
async function openReady(blocks: unknown[]): Promise<Editor> {
  const { editor } = open(blocks as never, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } });
  await act(async () => { await settled(); });
  return editor;
}

/**
 * Sets a text selection.
 * @param editor - The editor.
 * @param from - Its start.
 * @param to - Its end.
 */
function select(editor: Editor, from: number, to = from): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  view.focus();
}

/**
 * The reader's copy of a range of this body, as the clipboard holds it.
 * @param editor - The editor.
 * @param from - Where it starts.
 * @param to - Where it ends.
 * @returns The clipboard's formats.
 */
function copyOf(editor: Editor, from: number, to: number): Record<string, string> {
  const view = editor.prosemirrorView;
  const { dom, text } = view.serializeForClipboard(TextSelection.create(view.state.doc, from, to).content());
  return { 'blocknote/html': dom.innerHTML, 'text/html': dom.innerHTML, 'text/plain': text };
}

/**
 * Drops content of these formats at a document position.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param formats - Each format the drag carries.
 * @param copyKey - Whether the platform's copy key is held.
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>, copyKey = false): void {
  const view = editor.prosemirrorView;
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1, altKey: copyKey, ctrlKey: copyKey });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' },
  });
  view.dom.dispatchEvent(event);
}

/**
 * Drags a range of the body to a point, the way a reader's drag inside the body does.
 * @param editor - The editor.
 * @param from - Where the dragged range starts.
 * @param to - Where it ends.
 * @param at - Where it is dropped.
 * @param copyKey - Whether the copy key is held at the drop.
 */
function dragWithin(editor: Editor, from: number, to: number, at: number, copyKey = false): void {
  const view = editor.prosemirrorView;
  select(editor, from, to);
  (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(view.state.selection.content()).slice, move: true };
  dropFormats(editor, at, { 'text/html': '<p>x</p>' }, copyKey);
}

/**
 * Every block id in the body, nested and cell blocks included.
 * @param editor - The editor.
 * @returns The ids.
 */
function ids(editor: Editor): string[] {
  const found: string[] = [];
  editor.prosemirrorView.state.doc.descendants((node: PMNode) => {
    if (typeof node.attrs['id'] === 'string') found.push(node.attrs['id']);
    return true;
  });
  return found;
}

/**
 * Asserts no two blocks share an id.
 * @param editor - The editor.
 */
function expectUniqueIds(editor: Editor): void {
  const all = ids(editor);
  expect(new Set(all).size).toBe(all.length);
}

const LINE = [{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'tail' }];

/** Where a target caret sits, and what one line of `hello` makes of the line. */
const ONE_LINE_TARGETS: Record<string, { blocks: unknown[]; at: (editor: Editor) => number; line: string }> = {
  mid: { blocks: LINE, at: (e) => positionOf(e, 'abcd', 2), line: 'paragraph:abhellocd' },
  start: { blocks: LINE, at: (e) => positionOf(e, 'abcd', 0), line: 'paragraph:helloabcd' },
  end: { blocks: LINE, at: (e) => positionOf(e, 'abcd', 4), line: 'paragraph:abcdhello' },
  emptyP: { blocks: [LINE[0], { type: 'paragraph' }, LINE[2]], at: (e) => nodeAt(e, 'blockContainer', 1) + 2, line: 'paragraph:hello' },
  emptyH: { blocks: [LINE[0], { type: 'heading' }, LINE[2]], at: (e) => nodeAt(e, 'blockContainer', 1) + 2, line: 'heading:hello' },
};

/** How each source pastes one line of `hello`; the source body is opened first when it needs one. */
const ONE_LINE_SOURCES: Record<string, () => Promise<Record<string, string>>> = {
  web: async () => ({ 'text/html': '<p>hello</p>', 'text/plain': 'hello' }),
  ownTop: async () => {
    const source = await openReady([{ type: 'paragraph', content: 'xhellox' }]);
    return copyOf(source, positionOf(source, 'xhellox', 1), positionOf(source, 'xhellox', 6));
  },
  ownNested: async () => {
    const source = await openReady([{ type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'xhellox' }] }]);
    return copyOf(source, positionOf(source, 'xhellox', 1), positionOf(source, 'xhellox', 6));
  },
  canvas: async () => ({ 'text/plain': canvasClipboardOf(['hello']) }),
};

describe('one line of words', () => {
  const cells = Object.keys(ONE_LINE_SOURCES).flatMap((source) => Object.keys(ONE_LINE_TARGETS).map((target): [string, string] => [source, target]));
  it.each(cells)('pasted from %s at %s joins the line', async (source, target) => {
    const formats = await ONE_LINE_SOURCES[source]!();
    const editor = await openReady(ONE_LINE_TARGETS[target]!.blocks);
    select(editor, ONE_LINE_TARGETS[target]!.at(editor));
    pasteFormats(editor, formats);
    await settled();
    expect(shape(editor)).toEqual(['paragraph:lead', ONE_LINE_TARGETS[target]!.line, 'paragraph:tail']);
    expectUniqueIds(editor);
  });

  it.each(Object.keys(ONE_LINE_TARGETS))('dropped from another body at %s joins the line at the drop point', async (target) => {
    const formats = await ONE_LINE_SOURCES['ownTop']!();
    const editor = await openReady(ONE_LINE_TARGETS[target]!.blocks);
    select(editor, positionOf(editor, 'lead', 0));
    dropFormats(editor, ONE_LINE_TARGETS[target]!.at(editor), formats);
    await settled();
    expect(shape(editor)).toEqual(['paragraph:lead', ONE_LINE_TARGETS[target]!.line, 'paragraph:tail']);
    expectUniqueIds(editor);
  });

  it.each([['moved', false], ['copied', true]] as const)('%s inside the body joins the line at the drop point', async (_how, copyKey) => {
    const editor = await openReady([{ type: 'paragraph', content: 'xhellox' }, ...LINE]);
    dragWithin(editor, positionOf(editor, 'xhellox', 1), positionOf(editor, 'xhellox', 6), positionOf(editor, 'abcd', 2), copyKey);
    await settled();
    expect(shape(editor)).toEqual([copyKey ? 'paragraph:xhellox' : 'paragraph:xx', 'paragraph:lead', 'paragraph:abhellocd', 'paragraph:tail']);
    expectUniqueIds(editor);
  });

  it('moved out of a heading onto an empty line leaves no two blocks with one id', async () => {
    const editor = await openReady([{ type: 'heading', content: 'xyz' }, { type: 'paragraph' }, { type: 'paragraph', content: 'tail' }]);
    dragWithin(editor, positionOf(editor, 'xyz', 0), positionOf(editor, 'xyz', 2), nodeAt(editor, 'blockContainer', 1) + 2);
    await settled();
    expect(editor.prosemirrorView.state.doc.textContent).toBe('zxytail');
    expectUniqueIds(editor);
  });

  it('pasted as a web address over selected words makes those words a link', async () => {
    const editor = await openReady(LINE);
    select(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3));
    pasteFormats(editor, { 'text/plain': 'https://x.test/' });
    await settled();
    const link = (editor.document as { content: { type: string; href?: string; content?: { text: string }[] }[] }[])[1]!.content.find((c) => c.type === 'link');
    expect(link?.href).toBe('https://x.test/');
    expect(link?.content?.map((c) => c.text).join('')).toBe('bc');
  });

  it('copied from a line\'s end into the next line pastes as two lines in a line and as one line on an empty line', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'xyz' }]);
    const formats = copyOf(source, positionOf(source, 'one', 3), positionOf(source, 'xyz', 2));
    const inLine = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    select(inLine, positionOf(inLine, 'abcd', 2));
    pasteFormats(inLine, formats);
    await settled();
    expect(shape(inLine)).toEqual(['paragraph:ab', 'paragraph:xycd']);
    const empty = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    select(empty, nodeAt(empty, 'blockContainer', 1) + 2);
    pasteFormats(empty, formats);
    await settled();
    expect(shape(empty)).toEqual(['paragraph:lead', 'paragraph:xy']);
  });
});

describe('row ids on our placement', () => {
  it('a copy of two whole lines pasted elsewhere in the same body takes new ids', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }, { type: 'paragraph', content: 'tail' }]);
    const formats = copyOf(editor, positionOf(editor, 'one', 0) - 1, positionOf(editor, 'two', 3) + 1);
    select(editor, positionOf(editor, 'tail', 4));
    pasteFormats(editor, formats);
    await settled();
    expectUniqueIds(editor);
  });

  it('a copy of lines and a picture dropped from another tab of the same body takes new ids', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'one' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'two' }, { type: 'paragraph', content: 'tail' }]);
    const formats = copyOf(editor, positionOf(editor, 'one', 1), positionOf(editor, 'two', 2));
    dropFormats(editor, positionOf(editor, 'tail', 2), formats);
    await settled();
    expectUniqueIds(editor);
  });
});

describe('the transforms run on the target', () => {
  it('a copy of words and a picture dropped elsewhere while the caret is in a stored table\'s cell keeps both', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'ww' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'vv' }]);
    const formats = copyOf(source, positionOf(source, 'ww', 0), positionOf(source, 'vv', 2));
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'l1', 1));
    dropFormats(editor, positionOf(editor, 'abcd', 2), formats);
    await settled();
    expect(shape(editor)).toEqual(['paragraph:lead', 'table', 'paragraph:abww', `image[${PIC}|]`, 'paragraph:vvcd']);
  });

  it('lines and a picture dragged inside the body while a stored table\'s cell holds no selection keep both', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'ww' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'vv' }, STORED, { type: 'paragraph', content: 'abcd' }]);
    dragWithin(editor, positionOf(editor, 'ww', 0), positionOf(editor, 'vv', 2), positionOf(editor, 'abcd', 2), true);
    await settled();
    expect(shape(editor).slice(-3)).toEqual(['paragraph:abww', `image[${PIC}|]`, 'paragraph:vvcd']);
  });

  it('content of several lines dragged inside the body is placed from the drag\'s own slice, never written out as HTML', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }, ...LINE]);
    const view = editor.prosemirrorView;
    select(editor, positionOf(editor, 'one', 1), positionOf(editor, 'two', 2));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(view.state.selection.content()).slice, move: true };
    const written = vi.spyOn(view, 'serializeForClipboard');
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': '<p>x</p>' });
    await settled();
    expect(written).not.toHaveBeenCalled();
    expect(shape(editor)).toEqual(['paragraph:oo', 'paragraph:lead', 'paragraph:abne', 'paragraph:twcd', 'paragraph:tail']);
  });
});

describe('a stored table', () => {
  it('gives the words dragged out of its cell to the line they land in', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'zz' }]);
    dragWithin(editor, positionOf(editor, 'l1', 0), positionOf(editor, 'l1', 2), positionOf(editor, 'zz', 1));
    await settled();
    expect(shape(editor).at(-1)).toBe('paragraph:zl1z');
  });

  it('takes the words of content pasted into its cell and puts the picture beside it', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'ww' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'vv' }]);
    const formats = copyOf(source, positionOf(source, 'ww', 0), positionOf(source, 'vv', 2));
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'l1', 1));
    pasteFormats(editor, formats);
    await settled();
    expect(shape(editor)).toEqual(['paragraph:lead', 'table', `image[${PIC}|]`, 'paragraph:tail']);
    const cell = editor.prosemirrorView.state.doc.firstChild!.child(1).firstChild!.firstChild!.firstChild!;
    expect(cell.textContent).toBe('lwwvv1');
  });

  it('gives the words copied inside its cell to the line they are pasted in', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'zz' }]);
    const formats = copyOf(editor, positionOf(editor, 'l1', 0), positionOf(editor, 'l1', 2));
    select(editor, positionOf(editor, 'zz', 1));
    pasteFormats(editor, formats);
    await settled();
    expect(shape(editor).at(-1)).toBe('paragraph:zl1z');
  });
});

describe('a code block taking content line by line', () => {
  it('takes each line\'s words and puts the picture beside it', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'aaaa' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'bbbb' }]);
    const formats = copyOf(source, positionOf(source, 'aaaa', 2), positionOf(source, 'bbbb', 2));
    const editor = await openReady([{ type: 'codeBlock', content: 'xy' }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'xy', 1));
    pasteFormats(editor, formats);
    await settled();
    expect(shape(editor)).toEqual(['codeBlock:xaa\nbby', `image[${PIC}|]`, 'paragraph:tail']);
  });

  it('takes a whole table as rows of cells split by tabs', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'aaaa' }, tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['d1', 'd2'] }] }), { type: 'paragraph', content: 'bbbb' }]);
    const formats = copyOf(source, positionOf(source, 'aaaa', 4), positionOf(source, 'bbbb', 0));
    const editor = await openReady([{ type: 'codeBlock', content: 'xy' }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'xy', 1));
    pasteFormats(editor, formats);
    await settled();
    expect(shape(editor)).toEqual(['codeBlock:xc1\tc2\nd1\td2y', 'paragraph:tail']);
  });
});
