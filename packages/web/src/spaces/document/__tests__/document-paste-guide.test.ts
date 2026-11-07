// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the Agent's product guide says about where pasted content lands, each
 * sentence beside a real paste that shows it (inner#1351 design §5.14 "the
 * guide changes with the placement"). Each sentence is the guide's own, as it
 * reads in English; the domain guide test reads this file and holds every id
 * and sentence here to the guide, so a placement change that fails an example
 * here shows the sentence to change next to it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canvasClipboardOf } from './canvas-clipboard-fixture';
import { open, paste, pasteFormats, unmountAll, type Editor } from './paste-harness';
import { NEW, TARGETS, shape } from './paste-matrix';
import { tableBlock } from './table-fixtures';

afterEach(unmountAll);

/**
 * Opens a target from the placement matrix with its selection made.
 * @param name - The target.
 * @returns The editor.
 */
function at(name: string): Editor {
  const { editor } = open(TARGETS[name]!.blocks as never, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } });
  TARGETS[name]!.select(editor);
  return editor;
}

const WORDS_PICTURE_WORDS = `<p>w</p><img src="${NEW}"><p>v</p>`;

/** Each rule the guide states about where pasted content lands. */
const GUIDE_RULES: readonly { id: string; sentence: string; example: () => void }[] = [
  {
    id: 'document.paste.splitsLine',
    sentence: 'Content splits a line at the caret;',
    example: () => {
      const editor = at('mid');
      paste(editor, WORDS_PICTURE_WORDS, 'w\nv');
      expect(shape(editor)).toBe('p:lead|p:abw|img(new)|p:vcd|p:tail');
    },
  },
  {
    id: 'document.paste.emptyLine',
    sentence: 'on an empty line, content ending in a picture, video or audio lands above it and leaves the line for the caret, and content ending in words takes the line.',
    example: () => {
      const picture = at('emptyP');
      paste(picture, `<p>w</p><img src="${NEW}">`, 'w');
      expect(shape(picture)).toBe('p:lead|p:w|img(new)|p:|p:tail');
      const words = at('emptyP');
      paste(words, `<img src="${NEW}"><p>v</p>`, 'v');
      expect(shape(words)).toBe('p:lead|img(new)|p:v|p:tail');
    },
  },
  {
    id: 'document.paste.canvas',
    sentence: 'Nodes copied on the canvas and a picture copied in this chat paste the same way: each text node\'s lines become paragraphs with their original words, and each picture, video or audio carries the node\'s name as its caption, in reading order from the canvas.',
    example: () => {
      const editor = at('mid');
      pasteFormats(editor, { 'text/plain': canvasClipboardOf(['w', 'P', 'v'], NEW) });
      expect(shape(editor)).toBe('p:lead|p:abw|img(new)|p:vcd|p:tail');
    },
  },
  {
    id: 'document.paste.cellBlocks',
    sentence: 'Inside a table cell, ordinary content keeps its block types and media stay in the cell.',
    example: () => {
      const editor = at('cell');
      paste(editor, `<p>w</p><h1>hh</h1><img src="${NEW}"><p>v</p>`, 'w\nhh\nv');
      expect(shape(editor)).toBe('p:lead|T(p:c1w|h:hh|img(new)|p:v/c2)|p:tail');
    },
  },
  {
    id: 'document.paste.cellTable',
    sentence: 'A single pasted table fills cells once from the target cell, growing the table when needed;',
    example: () => {
      const editor = at('cell');
      paste(editor, '<table><tr><td>x1</td><td>x2</td><td>x3</td></tr></table>', 'x1\tx2\tx3');
      expect(shape(editor)).toBe('p:lead|T(x1/x2/x3)|p:tail');
    },
  },
  {
    id: 'document.paste.cellRefused',
    sentence: 'a table mixed with other content, or more than one table, is refused with "This format cannot be pasted here".',
    example: () => {
      const editor = at('cell');
      paste(editor, '<p>w</p><table><tr><td>x1</td></tr></table>', 'w\nx1');
      expect(shape(editor)).toBe(`p:lead|${tableLabel(['c1', 'c2'])}|p:tail`);
    },
  },
  {
    id: 'document.paste.cellSelection',
    sentence: 'A cell selection receives a copy of ordinary content in each cell.',
    example: () => {
      const editor = at('cellSel');
      paste(editor, '<p>w</p>', 'w');
      expect(shape(editor)).toBe('p:lead|T(w/w)|p:tail');
    },
  },
  {
    id: 'document.paste.codeBlock',
    sentence: 'In a code block, plain text is inserted verbatim; web text goes into the code and its media beside the code block, while canvas content carrying media lands together beside it.',
    example: () => {
      const plain = at('code');
      paste(plain, '', '# not a heading');
      expect(shape(plain)).toBe('p:lead|code:x# not a headingy|p:tail');
      const web = at('code');
      paste(web, WORDS_PICTURE_WORDS, 'w\nv');
      expect(shape(web)).toBe('p:lead|code:xw\nvy|img(new)|p:tail');
      const canvas = at('code');
      pasteFormats(canvas, { 'text/plain': canvasClipboardOf(['w', 'P'], NEW) });
      expect(shape(canvas)).toBe('p:lead|code:xy|p:w|img(new)|p:tail');
    },
  },
];

/**
 * A one-row table's label, as the matrix's labels write it.
 * @param cells - The cells' words.
 * @returns The label.
 */
function tableLabel(cells: readonly string[]): string {
  const { editor } = open([tableBlock({ rows: [{ cells: [...cells] }] })] as never);
  return shape(editor);
}

describe('each placement the product guide states', () => {
  it.each(GUIDE_RULES.map((rule) => [rule.id, rule] as const))('%s', (_id, rule) => {
    rule.example();
  });
});
