// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design 6.6 "表格格子里的公式": formulas in table cells through
 * Markdown.
 *
 * A pipe table escapes a formula's pipes as it escapes any cell's, since GFM
 * splits cells on unescaped pipes before it reads the formula; reading back
 * turns `\|` in the formula into `|`. A source that itself holds `\|` cannot
 * come back that way, so its table is written as HTML. In an HTML table
 * remark reads the whole table as one HTML node, so formulas there are
 * elements carrying their source (`data-math`, `data-math-block`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding the given blocks.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** A block, loosely typed. */
interface Seen {
  type: string;
  content?: unknown;
  children?: Seen[];
}

/** A piece of inline content, loosely typed. */
interface Piece {
  type: string;
  text?: string;
  content?: unknown;
}

/**
 * The words of some content: a string, or styled text pieces.
 * @param content - The content.
 * @returns The words.
 */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Piece[]).map((piece) => (piece.type === 'text' ? piece.text ?? '' : '')).join('');
}

/**
 * Every formula in some blocks, in document order, as `kind:source`.
 * @param blocks - The blocks.
 * @returns The formulas.
 */
function formulas(blocks: readonly Seen[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'mathBlock') out.push(`block:${wordsOf(block.content)}`);
    else if (Array.isArray(block.content)) {
      for (const piece of block.content as Piece[]) {
        if (piece.type === 'math') out.push(`inline:${wordsOf(piece.content)}`);
      }
    }
    out.push(...formulas(block.children ?? []));
  }
  return out;
}

/**
 * A cell holding one paragraph with an inline formula.
 * @param source - The formula's source.
 * @returns The cell.
 */
function inlineCell(source: string): { blocks: unknown[] } {
  return { blocks: [{ type: 'paragraph', content: [{ type: 'math', content: source }] }] };
}

/**
 * The body written as Markdown and read back.
 * @param editor - The editor.
 * @returns The Markdown and the blocks it reads into.
 */
async function roundTrip(editor: Editor): Promise<{ markdown: string; again: Seen[] }> {
  const markdown = blocksMarkdown(editor, editor.document as never);
  const again = (await markdownBlocks(markdown)).map((b) => b.block as unknown as Seen);
  return { markdown, again };
}

describe('formulas in table cells as Markdown', () => {
  it('keeps a pipe table and brings $$|x|$$ in a cell back whole', async () => {
    const editor = open([tableBlock({ rows: [{ cells: ['Norm', 'Value'] }, { cells: ['abs', inlineCell('|x|')] }], headerRows: 1 })]);

    const { markdown, again } = await roundTrip(editor);

    expect(markdown.startsWith('| Norm | Value |')).toBe(true);
    expect(formulas(again)).toEqual(['inline:|x|']);
  });

  it('writes the table as HTML when a cell\'s formula holds \\| and brings it back whole', async () => {
    const editor = open([tableBlock({ rows: [{ cells: ['Norm', 'Value'] }, { cells: ['abs', inlineCell('a\\|b')] }], headerRows: 1 })]);

    const { markdown, again } = await roundTrip(editor);

    expect(markdown.startsWith('<table>')).toBe(true);
    expect(formulas(again)).toEqual(['inline:a\\|b']);
  });

  it('writes formulas in an HTML table as elements carrying their source and brings both kinds back', async () => {
    const editor = open([
      tableBlock({
        rows: [
          {
            cells: [
              { blocks: [{ type: 'mathBlock', content: '\\frac{a}{b}' }] },
              { blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'r ', styles: {} }, { type: 'math', content: 'x^2' }] }] },
            ],
          },
        ],
      }),
    ]);

    const { markdown, again } = await roundTrip(editor);

    expect(markdown).toContain('data-math-block="\\frac{a}{b}"');
    expect(markdown).toContain('data-math="x^2"');
    expect(formulas(again)).toEqual(['block:\\frac{a}{b}', 'inline:x^2']);
  });
});
