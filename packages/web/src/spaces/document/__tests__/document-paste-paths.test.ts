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
import { AllSelection, NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { canvasClipboardOf } from './canvas-clipboard-fixture';
import { OURS, open, pasteFormats, positionOf, settled, shape, unmountAll, type Editor } from './paste-harness';
import { nodeAt } from './paste-matrix';
import { BodyEdgeSelection } from '@web/spaces/document/document-body-edge-selection';
import { putContent } from '@web/spaces/document/document-put';
import { readClipboardSlice } from '@web/spaces/document/document-paste-slice';
import { keepTablesWhole } from '@web/spaces/document/document-table-nodes';
import { HOLD_PRE_EDIT_SELECTION } from '@web/spaces/document/document-undo-selection';
import type { Transaction } from '@tiptap/pm/state';
import { tableBlock } from './table-fixtures';

vi.mock('@web/spaces/document/document-table-nodes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/spaces/document/document-table-nodes')>();
  return { ...real, keepTablesWhole: vi.fn(real.keepTablesWhole) };
});

afterEach(unmountAll);

const PIC = `${OURS}p.png`;
const STORED = { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } };
/** A stored table carrying its own quote and colour, its first cell and an empty last one an alignment and a colour. */
const STORED_STYLED = {
  type: 'table',
  props: { quoted: true, textColor: 'red' },
  content: {
    type: 'tableContent',
    rows: [{
      cells: [
        { type: 'tableCell', props: { textColor: 'green', textAlignment: 'center' }, content: [{ type: 'text', text: 'l1', styles: {} }] },
        'l2',
        { type: 'tableCell', props: { textColor: 'blue', textAlignment: 'right' }, content: [] },
      ],
    }],
  },
};
/** A table of blocks whose first cell starts with a block that holds no words. */
const DIVIDED = tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'n1' }] }, 'n2'] }] });
/** What `styleOf` reads from a body holding `STORED_STYLED` as a table of blocks. */
const STYLE = {
  table: { quoted: true, textColor: 'red' },
  l1: { textColor: 'green', textAlignment: 'center' },
  empty: { textColor: 'blue', textAlignment: 'right' },
};

/**
 * The quote and colour of the body's table of blocks, and the alignment and colour of its line `l1` and of the line of its last cell.
 * @param editor - The editor.
 * @returns They.
 */
function styleOf(editor: Editor): typeof STYLE {
  let table: PMNode | null = null;
  editor.prosemirrorView.state.doc.descendants((node: PMNode) => {
    if (node.type.name === 'docTable') table ??= node;
    return table === null;
  });
  const lines: PMNode[] = [];
  (table as PMNode | null)?.descendants((node: PMNode) => {
    if (node.type.name === 'paragraph') lines.push(node);
    return true;
  });
  const attrs = (node: PMNode | undefined, names: readonly string[]): Record<string, unknown> => Object.fromEntries(names.map((name) => [name, node?.attrs[name]]));
  const line = ['textColor', 'textAlignment'] as const;
  return {
    table: attrs(table ?? undefined, ['quoted', 'textColor']),
    l1: attrs(lines.find((node) => node.textContent === 'l1'), line),
    empty: attrs(lines[lines.length - 1], line),
  } as typeof STYLE;
}

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
  select(editor, from, to);
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
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
  ownListItem: async () => {
    const source = await openReady([{ type: 'bulletListItem', content: 'pppp', children: [{ type: 'bulletListItem', content: 'xhellox' }] }]);
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
    // An empty plain line takes the type of the line it receives (§5.4.3).
    const line = source === 'ownListItem' && target === 'emptyP' ? 'bulletListItem:hello' : ONE_LINE_TARGETS[target]!.line;
    expect(shape(editor)).toEqual(['paragraph:lead', line, 'paragraph:tail']);
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

describe('one line of words keeps the target line\'s quote and type (§5.4.3)', () => {
  it.each([
    ['an empty quoted line', [{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', props: { quoted: true } }, { type: 'paragraph', content: 'tail' }], (e: Editor) => select(e, nodeAt(e, 'blockContainer', 1) + 2)],
    ['a quoted line selected whole', [{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', props: { quoted: true }, content: 'abcd' }, { type: 'paragraph', content: 'tail' }], (e: Editor) => select(e, positionOf(e, 'abcd', 0), positionOf(e, 'abcd', 4))],
  ] as const)('pasted on %s, stays quoted', async (_name, blocks, aim) => {
    const editor = await openReady([...blocks]);
    aim(editor);
    pasteFormats(editor, { 'text/html': '<p>w</p>', 'text/plain': 'w' });
    await settled();
    const line = editor.prosemirrorView.state.doc.firstChild!.child(1).firstChild!;
    expect([line.textContent, line.attrs['quoted']]).toEqual(['w', true]);
  });

  it.each(['heading', 'bulletListItem', 'checkListItem'])('pasted over a %s whose words are selected whole, keeps that type', async (type) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, { type, content: 'abcd' }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4));
    pasteFormats(editor, { 'text/html': '<p>w</p>', 'text/plain': 'w' });
    await settled();
    expect(shape(editor)).toEqual(['paragraph:lead', `${type}:w`, 'paragraph:tail']);
  });

  const PASTES = [
    ['one line', { 'text/html': '<p>w</p>', 'text/plain': 'w' }],
    ['two lines', { 'text/html': '<p>w</p><p>v</p>', 'text/plain': 'w\nv' }],
  ] as const;
  const QUOTES = [[true, true], [true, false], [false, true]] as const;
  it.each(PASTES.flatMap(([name, formats]) => QUOTES.map(([before, after]) => [name, before, after, formats] as const)))(
    'pasted as %s between pictures quoted %s and %s, lands as quoted as the picture before',
    async (_name, before, after, formats) => {
      const editor = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'image', props: { url: PIC, quoted: before } }, { type: 'image', props: { url: `${OURS}q.png`, quoted: after } }, { type: 'paragraph', content: 'tail' }]);
      const view = editor.prosemirrorView;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodeAt(editor, 'image', 1))));
      view.focus();
      view.someProp('handleKeyDown', (handle) => handle(view, new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
      pasteFormats(editor, formats);
      await settled();
      const lines: PMNode[] = [];
      view.state.doc.descendants((node) => {
        if (node.isTextblock && ['w', 'v'].includes(node.textContent)) lines.push(node);
        return true;
      });
      expect(lines.map((line) => [line.textContent, line.attrs['quoted']])).toEqual(formats['text/plain'].split('\n').map((words) => [words, before]));
    },
  );
});

describe('copies of every shape the body makes paste in', () => {
  /**
   * A copy of the selection the body holds, as its copy writes it.
   * @param editor - The body copied from.
   * @param selection - The selection.
   * @returns The clipboard's formats.
   */
  function copySelection(editor: Editor, selection: Selection): Record<string, string> {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(selection));
    const { dom, text } = view.serializeForClipboard(view.state.selection.content());
    return { 'blocknote/html': dom.innerHTML, 'text/html': dom.innerHTML, 'text/plain': text };
  }

  /**
   * Pastes formats in the middle of `wxyz` in a new body.
   * @param formats - The clipboard.
   * @returns The new body.
   */
  async function pasteMid(formats: Record<string, string>): Promise<Editor> {
    const editor = await openReady([{ type: 'paragraph', content: 'wxyz' }]);
    select(editor, positionOf(editor, 'wxyz', 2));
    pasteFormats(editor, formats);
    await settled();
    return editor;
  }

  it('a copy of the whole body', async () => {
    const source = await openReady([{ type: 'heading', content: 'hhhh' }, { type: 'paragraph', content: 'pppp', children: [{ type: 'paragraph', content: 'kkkk' }] }]);
    const editor = await pasteMid(copySelection(source, new AllSelection(source.prosemirrorView.state.doc)));
    expect(editor.prosemirrorView.state.doc.textContent).toBe('wxhhhhppppkkkkyz');
  });

  it('a copy starting in a table nested under a line and leaving it', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'pppp', children: [tableBlock({ rows: [{ cells: ['c1', 'c2'] }] })] }, { type: 'paragraph', content: 'qqqq' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'c1', 1), positionOf(source, 'qqqq', 2))));
    expect(shape(editor)).toContain('table');
    expect(editor.prosemirrorView.state.doc.textContent).toContain('qq');
  });

  it('a copy ending in a table nested under a line', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph', content: 'pppp', children: [tableBlock({ rows: [{ cells: ['c1', 'c2'] }] })] }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'aaaa', 2), positionOf(source, 'c1', 1))));
    expect(shape(editor)).toContain('table');
    expect(editor.prosemirrorView.state.doc.textContent).toContain('pppp');
  });

  const TABLES = [['stored', STORED], ['new', tableBlock({ rows: [{ cells: ['l1', 'l2'] }] })]] as const;
  const LEAVING = [
    ['from a cell out of the table', (s: Editor) => TextSelection.create(s.prosemirrorView.state.doc, positionOf(s, 'l2', 1), positionOf(s, 'twox', 3)), ['paragraph:wx', 'paragraph:twoyz']],
    ['from outside into a cell', (s: Editor) => TextSelection.create(s.prosemirrorView.state.doc, positionOf(s, 'xone', 1), positionOf(s, 'l1', 1)), ['paragraph:wxone', 'paragraph:yz']],
    ['across the whole table', (s: Editor) => TextSelection.create(s.prosemirrorView.state.doc, positionOf(s, 'xone', 1), positionOf(s, 'twox', 3)), ['paragraph:wxone', 'paragraph:twoyz']],
  ] as const;
  it.each(TABLES.flatMap(([kind, table]) => LEAVING.map(([how, pick, ends]) => [how, kind, table, pick, ends] as const)))(
    'a copy %s of a %s table carries the whole table and nothing more',
    async (_how, _kind, table, pick, ends) => {
      const source = await openReady([{ type: 'paragraph', content: 'xone' }, table, { type: 'paragraph', content: 'twox' }]);
      const editor = await pasteMid(copySelection(source, pick(source)));
      expect(shape(editor)).toEqual([ends[0], 'table', ends[1]]);
      expect(editor.prosemirrorView.state.doc.textContent).toContain('l1l2');
    },
  );

  it('a copy from a stored cell into a line nested under the next line lifts that line out', async () => {
    const source = await openReady([STORED, { type: 'paragraph', content: 'twox', children: [{ type: 'paragraph', content: 'kid' }] }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'l2', 1), positionOf(source, 'kid', 2))));
    expect(shape(editor)).toEqual(['paragraph:wx', 'table', 'paragraph:twox', 'paragraph:kiyz']);
  });

  it.each([
    ['into a cell carries the table alone', (s: Editor) => positionOf(s, 'l1', 1), ['paragraph:wxone', 'table', 'paragraph:yz']],
    ['into the line nested under it puts that line after the table', (s: Editor) => positionOf(s, 'kid', 2), ['paragraph:wxone', 'table', 'paragraph:kiyz']],
  ] as const)('a copy from outside a stored table with a line nested under it %s', async (_name, end, expected) => {
    const source = await openReady([{ type: 'paragraph', content: 'xone' }, { ...STORED, children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'twox' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'xone', 1), end(source))));
    expect(shape(editor)).toEqual(expected);
  });

  it('a stored cell\'s words copied by BlockNote alone paste in as words, the body valid', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'lead' }, STORED]);
    const view = source.prosemirrorView;
    const slice = TextSelection.create(view.state.doc, positionOf(source, 'l1', 0), positionOf(source, 'l1', 2)).content();
    const { dom, text } = view.serializeForClipboard(slice);
    const editor = await pasteMid({ 'blocknote/html': dom.innerHTML, 'text/html': dom.innerHTML, 'text/plain': text });
    expect(() => editor.prosemirrorView.state.doc.check()).not.toThrow();
    expect(editor.prosemirrorView.state.doc.textContent).toContain('l1');
  });

  it('a copy of a stored table keeps its quote and colour and each cell\'s alignment and colour, as its conversion does', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'xone' }, STORED_STYLED, { type: 'paragraph', content: 'twox' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'xone', 1), positionOf(source, 'twox', 3))));
    expect(styleOf(editor)).toEqual(STYLE);
  });

  it('a copy across the cells of one stored table keeps its quote and colour and each cell\'s alignment and colour', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'xone' }, STORED_STYLED, { type: 'paragraph', content: 'twox' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'l1', 1), positionOf(source, 'l2', 1))));
    expect(styleOf(editor)).toEqual(STYLE);
  });

  it('a copy from a new table whose first cell starts with a divider into a stored one carries the new table whole', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'lead' }, DIVIDED, { type: 'paragraph', content: 'mid' }, STORED, { type: 'paragraph', content: 'more' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'n1', 1), positionOf(source, 'l1', 1))));
    let dividers = 0;
    editor.prosemirrorView.state.doc.descendants((node: PMNode) => { if (node.type.name === 'divider') dividers += 1; return true; });
    expect(dividers).toBe(1);
  });

  it('a copy from a stored cell into the line nested under the table puts that line after the table', async () => {
    const source = await openReady([{ type: 'paragraph', content: 'lead' }, { ...STORED, children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'more' }]);
    const editor = await pasteMid(copySelection(source, TextSelection.create(source.prosemirrorView.state.doc, positionOf(source, 'l1', 1), positionOf(source, 'kid', 1))));
    expect(shape(editor)).toEqual(['paragraph:wx', 'table', 'paragraph:kyz']);
  });
});

describe('a stored table dragged inside the body', () => {
  it('copied twice leaves no row without an id of its own', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'tail' }, { type: 'paragraph', content: 'more' }]);
    dragWithin(editor, positionOf(editor, 'lead', 1), positionOf(editor, 'l1', 1), positionOf(editor, 'tail', 4), true);
    await settled();
    dragWithin(editor, positionOf(editor, 'lead', 1), positionOf(editor, 'l1', 1), positionOf(editor, 'more', 4), true);
    await settled();
    expect(ids(editor)).not.toContain('null');
    expectUniqueIds(editor);
  });

  it.each([['stored', STORED], ['new', tableBlock({ rows: [{ cells: ['l1', 'l2'] }] })]] as const)('a %s table moved with the words before it lands with no empty line before it', async (_kind, table) => {
    const editor = await openReady([{ type: 'paragraph', content: 'xone' }, table, { type: 'paragraph', content: 'tail' }]);
    dragWithin(editor, positionOf(editor, 'xone', 1), positionOf(editor, 'l1', 1), positionOf(editor, 'tail', 4));
    await settled();
    // The body's last block is a line after the table.
    expect(shape(editor)).toEqual(['paragraph:x', 'paragraph:tailone', 'table', 'paragraph:']);
  });

  it('moved from one cell into the next takes the whole table from where it was', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'tail' }]);
    dragWithin(editor, positionOf(editor, 'l1', 1), positionOf(editor, 'l2', 1), positionOf(editor, 'tail', 4));
    await settled();
    expect(shape(editor).filter((line) => line === 'table')).toHaveLength(1);
    expect(editor.prosemirrorView.state.doc.textContent.match(/l1l2/g)).toHaveLength(1);
  });
});

/**
 * Fires a cut, its clipboard thrown away.
 * @param editor - The editor.
 */
function cut(editor: Editor): void {
  const event = new Event('cut', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: vi.fn(), clearData: vi.fn(), getData: () => '' } });
  editor.prosemirrorView.dom.dispatchEvent(event);
}

/**
 * The body's lines, each with the lines nested under it.
 * @param editor - The editor.
 * @returns They, as `type:words` with nested ones in brackets.
 */
function outline(editor: Editor): string[] {
  type Block = { type: string; content?: unknown; children?: Block[] };
  const walk = (blocks: Block[]): string[] => blocks.map((block) => {
    const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
    if (block.type === 'docTable' || block.type === 'table') return 'table';
    return (block.children ?? []).length > 0 ? `${block.type}:${words}[${walk(block.children!).join(',')}]` : `${block.type}:${words}`;
  });
  return walk(editor.document as Block[]);
}

describe('a table at an end of a cut or a move takes it whole, stored or not', () => {
  const NEW = tableBlock({ rows: [{ cells: ['n1', 'n2'] }] });
  const HOW = [
    ['a cut', (editor: Editor) => cut(editor)],
    ['a move', (editor: Editor) => {
      const { from, to } = editor.prosemirrorView.state.selection;
      dragWithin(editor, from, to, positionOf(editor, 'more', 4));
    }],
  ] as const;

  it.each(HOW.map(([how, act], moved) => [how, act, moved] as const))('%s from a new table\'s cell into a stored one leaves one empty line for both tables', async (_how, act, moved) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, NEW, { type: 'paragraph', content: 'mid' }, STORED, { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'n1', 1), positionOf(editor, 'l1', 1));
    act(editor);
    await settled();
    expect(outline(editor).slice(0, 2)).toEqual(['paragraph:lead', 'paragraph:']);
    expect(outline(editor)[2]).toMatch(/^paragraph:more/);
    // A move puts both tables whole where it drops them.
    expect(outline(editor).filter((line) => line === 'table')).toHaveLength(moved === 1 ? 2 : 0);
  });

  it.each(HOW.map(([how, act], moved) => [how, act, moved] as const))('%s from a new table whose first cell starts with a divider into a stored one takes the new table whole', async (_how, act, moved) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, DIVIDED, { type: 'paragraph', content: 'mid' }, STORED, { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'n1', 1), positionOf(editor, 'l1', 1));
    act(editor);
    await settled();
    expect(outline(editor).slice(0, 2)).toEqual(['paragraph:lead', 'paragraph:']);
    expect(outline(editor).filter((line) => line === 'table')).toHaveLength(moved === 1 ? 2 : 0);
  });

  it.each(HOW.flatMap(([how, act]) => [['stored', STORED], ['new', NEW]].map(([kind, table]) => [how, kind, table, act] as const)))(
    '%s from a %s table nested under a line into the next line joins the rest of that line to the line the table was',
    async (_how, _kind, table, act) => {
      const editor = await openReady([{ type: 'paragraph', content: 'parent', children: [table] }, { type: 'paragraph', content: 'tail' }, { type: 'paragraph', content: 'more' }]);
      const inside = (table as { type: string }).type === 'table' ? 'l2' : 'n2';
      select(editor, positionOf(editor, inside, 1), positionOf(editor, 'tail', 2));
      act(editor);
      await settled();
      expect(outline(editor)[0]).toBe('paragraph:parent[paragraph:il]');
    },
  );

  // Two tables taken away leave one line, as two lines joined do: the later one's.
  it.each(HOW)('%s from a stored table into a quoted new one leaves the new table\'s line, quoted, with the caret on it', async (_how, act) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'mid' }, tableBlock({ rows: [{ cells: ['n1', 'n2'] }] }, { quoted: true }), { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'l1', 1), positionOf(editor, 'n1', 1));
    act(editor);
    await settled();
    const line = editor.prosemirrorView.state.doc.firstChild!.child(1).firstChild!;
    expect([line.textContent, line.attrs['quoted']]).toEqual(['', true]);
    if (_how === 'a cut') expect(editor.prosemirrorView.state.selection.$from.parent).toBe(line);
  });

  it.each(HOW)('%s from outside into a stored table keeps the lines nested under the table, under the line it joins', async (_how, act) => {
    const editor = await openReady([{ type: 'paragraph', content: 'xone' }, { ...STORED, children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'xone', 1), positionOf(editor, 'l1', 1));
    act(editor);
    await settled();
    expect(outline(editor)[0]).toBe('paragraph:x[paragraph:kid]');
  });

  it.each(HOW)('%s from a new table into a quoted stored one leaves the stored table\'s line, quoted', async (_how, act) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, NEW, { type: 'paragraph', content: 'mid' }, { ...STORED, props: { quoted: true } }, { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'n1', 1), positionOf(editor, 'l1', 1));
    act(editor);
    await settled();
    const line = editor.prosemirrorView.state.doc.firstChild!.child(1).firstChild!;
    expect([line.textContent, line.attrs['quoted']]).toEqual(['', true]);
  });

  it('a move of a stored table keeps its quote and colour and each cell\'s alignment and colour, as its conversion does', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'xone' }, STORED_STYLED, { type: 'paragraph', content: 'twox' }, { type: 'paragraph', content: 'more' }]);
    dragWithin(editor, positionOf(editor, 'xone', 1), positionOf(editor, 'twox', 2), positionOf(editor, 'more', 4));
    await settled();
    expect(styleOf(editor)).toEqual(STYLE);
  });

  it.each([
    ['a cut', ['paragraph:lead', 'paragraph:']],
    ['a move', ['paragraph:le', 'table', 'divider:', 'paragraph:ad', 'paragraph:']],
  ] as const)('%s from a stored table\'s cell to the body\'s end does what it does from a new table\'s', async (how, expected) => {
    for (const [table, words] of [[STORED, 'l1'], [NEW, 'n1']] as const) {
      const editor = await openReady([{ type: 'paragraph', content: 'lead' }, table, { type: 'divider' }]);
      const view = editor.prosemirrorView;
      view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, positionOf(editor, words, 1), 'end')));
      view.focus();
      if (how === 'a cut') cut(editor);
      else {
        (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(view.state.selection.content()).slice, move: true };
        dropFormats(editor, positionOf(editor, 'lead', 2), { 'text/html': '<p>x</p>' });
      }
      await settled();
      expect(outline(editor)).toEqual(expected);
      unmountAll();
    }
  });

  it.each(HOW)('%s of words in one stored cell takes those words and leaves the table', async (_how, act) => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'more' }]);
    select(editor, positionOf(editor, 'l1', 0), positionOf(editor, 'l1', 1));
    act(editor);
    await settled();
    const table = editor.prosemirrorView.state.doc.firstChild!.child(1);
    expect([table.firstChild!.type.name, table.textContent]).toEqual(['table', '1l2']);
  });

  it('a move from a stored cell into the line nested under the table puts the table and that line\'s words at the drop', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, { ...STORED, children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'more' }]);
    dragWithin(editor, positionOf(editor, 'l1', 1), positionOf(editor, 'kid', 1), positionOf(editor, 'more', 4));
    await settled();
    expect(outline(editor)).toEqual(['paragraph:lead', 'paragraph:id', 'paragraph:more', 'table', 'paragraph:k']);
  });

  it('a cut across two cells of a stored table leaves one empty line in its place', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'lead' }, STORED, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'l1', 1), positionOf(editor, 'l2', 1));
    cut(editor);
    await settled();
    expect(outline(editor)).toEqual(['paragraph:lead', 'paragraph:', 'paragraph:tail']);
  });

  it('a drop onto the stored table the dragged selection takes whole changes nothing', async () => {
    const editor = await openReady([{ type: 'paragraph', content: 'xone' }, STORED, { type: 'paragraph', content: 'twox' }]);
    const before = editor.prosemirrorView.state.doc;
    dragWithin(editor, positionOf(editor, 'xone', 1), positionOf(editor, 'l1', 1), positionOf(editor, 'l2', 1));
    await settled();
    expect(editor.prosemirrorView.state.doc.eq(before)).toBe(true);
  });
});

describe('a placement that fails part way', () => {
  it.each([
    ['a paste over selected words', false],
    ['a drop between two blocks', true],
  ] as const)('%s leaves the body and the selection as they were and lets the selection go', async (_name, drop) => {
    const editor = await openReady(LINE);
    const view = editor.prosemirrorView;
    select(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3));
    const before = view.state.doc;
    const selected = [view.state.selection.from, view.state.selection.to];
    const formats = copyOf(await openReady([{ type: 'heading', content: 'hhhh' }, { type: 'paragraph', content: 'pppp' }]), 1, 12);
    const slice = readClipboardSlice(view.state.schema, formats['blocknote/html']!, formats['text/plain']!);
    const dispatch = view.dispatch.bind(view);
    const sent: Transaction[] = [];
    let failed = false;
    let writes = 0;
    // The second write fails, after the selection's deletion or the drop's
    // opened line went in.
    vi.spyOn(view, 'dispatch').mockImplementation((tr: Transaction) => {
      sent.push(tr);
      if (tr.docChanged) writes += 1;
      if (!failed && writes === 2) {
        failed = true;
        throw new Error('placement failed');
      }
      dispatch(tr);
    });
    // Inside the line's container, before its words: off a line of words.
    const options = { wordsIntoTarget: true, judge: (props: Readonly<Record<string, unknown>>) => props, byPaste: true, ...(drop && { dropAt: positionOf(editor, 'tail', 0) - 1 }) };
    expect(() => putContent(editor, { source: { kind: 'slice', slice, parsed: true }, lost: 0, plain: null }, options)).toThrow('placement failed');
    expect(failed).toBe(true);
    expect(view.state.doc.eq(before)).toBe(true);
    expect([view.state.selection.from, view.state.selection.to]).toEqual(selected);
    if (drop) expect(sent.some((tr) => tr.getMeta(HOLD_PRE_EDIT_SELECTION) === false)).toBe(true);
  });

  it('a move within the body gives the dragged words back', async () => {
    const editor = await openReady(LINE);
    const view = editor.prosemirrorView;
    const before = view.state.doc;
    const dispatch = view.dispatch.bind(view);
    let writes = 0;
    // The move's deletion goes in; the placement's write after it fails.
    vi.spyOn(view, 'dispatch').mockImplementation((tr: Transaction) => {
      if (tr.docChanged) writes += 1;
      if (writes === 2) throw new Error('placement failed');
      dispatch(tr);
    });
    /**
     * Keeps the error the drop handler throws out of the run's report.
     * @param event - The error the page reports.
     */
    const swallow = (event: ErrorEvent): void => event.preventDefault();
    window.addEventListener('error', swallow);
    try {
      dragWithin(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3), positionOf(editor, 'tail', 2));
    } finally {
      window.removeEventListener('error', swallow);
    }
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(view.state.doc.eq(before)).toBe(true);
  });
});

describe('the transforms our placement runs on the target', () => {
  it.each([
    ['one line of words, which ProseMirror\'s own paste transforms', '<p>hello</p>', 'hello', 0],
    ['two lines, which our placement lays out', '<p>he</p><p>lo</p>', 'he\nlo', 1],
  ] as const)('run for %s %i times', async (_name, html, text, times) => {
    const editor = await openReady(LINE);
    select(editor, positionOf(editor, 'abcd', 2));
    vi.mocked(keepTablesWhole).mockClear();
    pasteFormats(editor, { 'text/html': html, 'text/plain': text });
    await settled();
    expect(editor.prosemirrorView.state.doc.textContent).toContain(text.replace('\n', ''));
    expect(vi.mocked(keepTablesWhole)).toHaveBeenCalledTimes(times);
  });
});
