// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1149 A1–A5: the outline is read from the document alone. It lists the
 * body's level 1–3 headings as a tree in reading order, leaves out headings in
 * table cells and headings with no words, and shows each heading's number
 * exactly as the body draws it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { computeNumbering } from '@web/spaces/document/document-numbering';
import { readOutline, type OutlineEntry } from '@web/spaces/document/document-outline';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding the given blocks. The editor gives every block
 * its own id, so the ids written in a fixture never reach the document.
 * @param blocks - The document, in block JSON.
 * @returns The editor.
 */
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * A heading block.
 * @param id - The block id.
 * @param level - 1, 2 or 3.
 * @param text - Its words.
 * @param props - Further props (numbered, quoted).
 * @returns The block JSON.
 */
function h(id: string, level: number, text: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'heading', props: { level, ...props }, content: text };
}

/**
 * A paragraph block.
 * @param id - The block id.
 * @param children - Blocks indented under it.
 * @returns The block JSON.
 */
function p(id: string, children: readonly unknown[] = []): Record<string, unknown> {
  return { id, type: 'paragraph', content: 'words', children };
}

/** An entry reduced to what these tests compare: the editor gives blocks its own ids. */
interface Shape {
  level: number;
  text: string;
  number: string | null;
  children: Shape[];
}

/**
 * The outline of an editor's document, reduced for comparing.
 * @param editor - The editor.
 * @returns The tree.
 */
function outlineOf(editor: Editor): Shape[] {
  const shape = (entry: OutlineEntry): Shape => ({
    level: entry.level,
    text: entry.text,
    number: entry.number,
    children: entry.children.map(shape),
  });
  return readOutline(editor.prosemirrorState.doc).map(shape);
}

/**
 * An entry with no number.
 * @param level - Its level.
 * @param text - Its words.
 * @param children - Entries under it.
 * @returns The expected shape.
 */
function entry(level: number, text: string, children: Shape[] = []): Shape {
  return { level, text, number: null, children };
}

/**
 * The id the editor gave the top-level block holding these words.
 * @param editor - The editor.
 * @param text - The block's words.
 * @returns The block id.
 * @throws {Error} When no top-level block holds the words.
 */
function idOf(editor: Editor, text: string): string {
  const words = (content: unknown): string =>
    Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('') : '';
  const blocks = editor.document as readonly { id: string; content?: unknown }[];
  const block = blocks.find((b) => words(b.content) === text);
  if (block === undefined) throw new Error(`no block holds ${text}`);
  return block.id;
}

describe('readOutline — A1: a tree in reading order', () => {
  it('hangs each heading under the nearest heading of a higher level before it', () => {
    const editor = open([
      h('a', 1, 'One'),
      p('p1'),
      h('b', 2, 'One one'),
      h('c', 3, 'One one one'),
      h('d', 2, 'One two'),
      h('e', 1, 'Two'),
      h('f', 2, 'Two one'),
    ]);

    expect(outlineOf(editor)).toEqual([
      entry(1, 'One', [
        entry(2, 'One one', [entry(3, 'One one one')]),
        entry(2, 'One two'),
      ]),
      entry(1, 'Two', [entry(2, 'Two one')]),
    ]);
  });

  it('hangs a skipped level under the nearest higher heading', () => {
    const editor = open([h('a', 1, 'One'), h('b', 3, 'Straight to three'), h('c', 2, 'Then two')]);

    expect(outlineOf(editor)).toEqual([
      entry(1, 'One', [entry(3, 'Straight to three'), entry(2, 'Then two')]),
    ]);
  });

  it('puts headings before the first higher one at the top', () => {
    const editor = open([h('a', 2, 'Early two'), h('b', 3, 'Early three'), h('c', 1, 'One')]);

    expect(outlineOf(editor)).toEqual([
      entry(2, 'Early two', [entry(3, 'Early three')]),
      entry(1, 'One'),
    ]);
  });
});

describe('readOutline — A2: headings in table cells stay out', () => {
  it('leaves out a heading inside a layout table cell', () => {
    const editor = open([
      h('a', 1, 'Before'),
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'heading', props: { level: 1 }, content: 'In a cell' }] }, 'b'] }] }),
      h('c', 2, 'After'),
    ]);

    expect(outlineOf(editor)).toEqual([entry(1, 'Before', [entry(2, 'After')])]);
  });

  it('reads past a stored table', () => {
    const editor = open([
      h('a', 1, 'Before'),
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['old a', 'old b'] }] } },
      h('c', 1, 'After'),
    ]);

    expect(outlineOf(editor)).toEqual([entry(1, 'Before'), entry(1, 'After')]);
  });
});

describe('readOutline — A3: quoted and indented headings count', () => {
  it('lists a quoted heading like any other', () => {
    const editor = open([h('a', 1, 'One'), h('b', 2, 'Quoted', { quoted: true })]);

    expect(outlineOf(editor)).toEqual([entry(1, 'One', [entry(2, 'Quoted')])]);
  });

  it('lists a heading indented under another block in reading order, by its level', () => {
    const editor = open([h('a', 1, 'One'), p('p1', [h('b', 2, 'Indented')]), h('c', 2, 'Next')]);

    expect(outlineOf(editor)).toEqual([entry(1, 'One', [entry(2, 'Indented'), entry(2, 'Next')])]);
  });
});

describe('readOutline — A4: headings with no words stay out', () => {
  it('leaves out an empty heading and a heading of spaces only', () => {
    const editor = open([h('a', 1, 'One'), { id: 'b', type: 'heading', props: { level: 2 } }, h('c', 2, '   '), h('d', 2, 'Kept')]);

    expect(outlineOf(editor)).toEqual([entry(1, 'One', [entry(2, 'Kept')])]);
  });

  it('keeps a heading whose words carry spaces around them, as written', () => {
    const editor = open([h('a', 1, '  Padded  ')]);

    expect(outlineOf(editor)).toEqual([entry(1, '  Padded  ')]);
  });
});

describe('readOutline — A5: the number the body draws', () => {
  it('shows each numbered heading the string the body draws, a level-one heading with its dot', () => {
    const editor = open([
      h('a', 1, 'One', { numbered: true }),
      h('b', 2, 'One one', { numbered: true }),
      h('c', 3, 'One one one', { numbered: true }),
      h('d', 2, 'Plain'),
    ]);
    const doc = editor.prosemirrorState.doc;
    const drawn = computeNumbering(doc, quoteRuns(doc));

    const [one] = readOutline(doc);
    expect(one!.number).toBe('1.');
    expect(one!.number).toBe(drawn.get(idOf(editor, 'One')));
    expect(one!.children[0]!.number).toBe(drawn.get(idOf(editor, 'One one')));
    expect(one!.children[0]!.number).toBe('1.1');
    expect(one!.children[0]!.children[0]!.number).toBe(drawn.get(idOf(editor, 'One one one')));
    expect(one!.children[0]!.children[0]!.number).toBe('1.1.1');
    expect(one!.children[1]!.number).toBeNull();
  });

  it('copies the body even where a numbered heading in a cell took a number', () => {
    const editor = open([
      h('a', 1, 'One', { numbered: true }),
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'heading', props: { level: 1, numbered: true }, content: 'Cell' }] }] }] }),
      h('c', 1, 'After', { numbered: true }),
    ]);
    const doc = editor.prosemirrorState.doc;
    const drawn = computeNumbering(doc, quoteRuns(doc));

    const outline = readOutline(doc);
    expect(outline.map((e) => e.id)).toEqual([idOf(editor, 'One'), idOf(editor, 'After')]);
    expect(outline[1]!.number).toBe(drawn.get(idOf(editor, 'After')));
  });
});
