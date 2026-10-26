// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T10, design 5.7: a table as Markdown, for the Agent and the
 * Space context. A table whose every cell holds one paragraph is a GFM pipe
 * table; one whose cells hold other blocks is an HTML table on lines of its
 * own, with no empty line in it, so Markdown keeps it one HTML block and it
 * reads back into the same cells.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
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

/** What a block JSON keeps for comparing cells. */
interface Seen {
  type: string;
  content?: { text?: string }[] | unknown;
  children: Seen[];
}

/**
 * Each cell of the first table, as its blocks' types and words.
 * @param blocks - The blocks.
 * @returns Per row, per cell, the blocks as `type:words`, nested ones indented by `>`.
 */
function cells(blocks: readonly Seen[]): string[][][] {
  const table = blocks.find((block) => block.type === 'docTable');
  if (table === undefined) throw new Error('no table');
  /**
   * One block and the ones under it.
   * @param block - The block.
   * @param depth - How deep it is nested.
   * @returns Its lines.
   */
  const lines = (block: Seen, depth: number): string[] => {
    const words = Array.isArray(block.content)
      ? (block.content as { text?: string }[]).map((part) => part.text ?? '').join('')
      : '';
    return [`${'>'.repeat(depth)}${block.type}:${words}`, ...block.children.flatMap((child) => lines(child, depth + 1))];
  };
  return table.children.map((row) => row.children.map((cell) => cell.children.flatMap((block) => lines(block, 0))));
}

/**
 * Each cell of the first table as its type and spans.
 * @param blocks - The blocks.
 * @returns Per row, per cell, `type colspan×rowspan`.
 */
function layout(blocks: readonly Seen[]): string[][] {
  const table = blocks.find((block) => block.type === 'docTable');
  if (table === undefined) throw new Error('no table');
  return table.children.map((row) =>
    row.children.map((cell) => {
      const props = (cell as Seen & { props?: Record<string, unknown> }).props ?? {};
      return `${cell.type} ${String(props['colspan'] ?? 1)}x${String(props['rowspan'] ?? 1)}`;
    }),
  );
}

describe('a table as Markdown', () => {
  it('is a pipe table when every cell holds one paragraph, its first row the header', () => {
    const editor = open([tableBlock({ rows: [{ cells: ['Shot', 'Size'] }, { cells: ['1', 'Wide | far'] }], headerRows: 1 })]);

    expect(blocksMarkdown(editor, editor.document as never)).toBe(
      '| Shot | Size |\n| --- | --- |\n| 1 | Wide \\| far |',
    );
  });

  it('keeps the styles of a cell in a pipe table', () => {
    const editor = open([
      tableBlock({ rows: [{ cells: ['a', 'b'] }], headerRows: 1 }),
    ]);
    editor.updateBlock((editor.document[0] as unknown as Seen & { children: { children: { children: { id: string }[] }[] }[] }).children[0]!.children[0]!.children[0]!.id, {
      content: [{ type: 'text', text: 'a', styles: { bold: true } }],
    } as never);

    expect(blocksMarkdown(editor, editor.document as never)).toBe('| **a** | b |\n| --- | --- |');
  });

  it('is an HTML table with no empty line in it when a cell holds other blocks', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      tableBlock({
        rows: [
          { cells: ['a', { blocks: [{ type: 'heading', props: { level: 2 }, content: 'H' }] }] },
          {
            cells: [
              { blocks: [{ type: 'codeBlock', props: { language: 'ts' }, content: 'x\n\ny' }] },
              {
                blocks: [
                  { type: 'bulletListItem', content: 'one', children: [{ type: 'bulletListItem', content: 'two' }] },
                ],
              },
            ],
          },
        ],
      }),
      { type: 'paragraph', content: 'after' },
    ]);

    const markdown = blocksMarkdown(editor, editor.document as never);
    const table = markdown.slice(markdown.indexOf('<table'), markdown.indexOf('</table>') + '</table>'.length);

    expect(markdown.startsWith('before\n\n<table')).toBe(true);
    expect(markdown.endsWith('</table>\n\nafter')).toBe(true);
    expect(table).not.toContain('\n');
  });

  it('reads back into the same cells', () => {
    const rows = [
      { cells: ['a', { blocks: [{ type: 'heading', props: { level: 2 }, content: 'H' }] }] },
      {
        cells: [
          { blocks: [{ type: 'codeBlock', props: { language: 'ts' }, content: 'x\n\ny' }] },
          {
            blocks: [
              { type: 'bulletListItem', content: 'one', children: [{ type: 'bulletListItem', content: 'two' }] },
            ],
          },
        ],
      },
    ];
    const editor = open([tableBlock({ rows })]);

    const again = editor.tryParseMarkdownToBlocks(blocksMarkdown(editor, editor.document as never)) as unknown as Seen[];

    expect(cells(again)).toEqual([
      [['paragraph:a'], ['heading:H']],
      [['codeBlock:x\n\ny'], ['bulletListItem:one', '>bulletListItem:two']],
    ]);
  });

  it('reads a pipe table back into the same cells', () => {
    const editor = open([tableBlock({ rows: [{ cells: ['Shot', 'Size'] }, { cells: ['1', 'Wide'] }], headerRows: 1 })]);

    const again = editor.tryParseMarkdownToBlocks(blocksMarkdown(editor, editor.document as never)) as unknown as Seen[];

    expect(cells(again)).toEqual([
      [['paragraph:Shot'], ['paragraph:Size']],
      [['paragraph:1'], ['paragraph:Wide']],
    ]);
  });

  it.each([
    ['no header', { rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] }],
    ['a header column', { rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }], headerCols: 1 }],
    ['a header row and a header column', { rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }], headerRows: 1, headerCols: 1 }],
    ['merged cells', { rows: [{ cells: [{ content: 'ab', props: { colspan: 2 } }] }, { cells: ['c', 'd'] }], headerRows: 1 }],
  ] as const)('reads a table with %s back with the same headers and spans', (_name, input) => {
    const editor = open([tableBlock(input as never)]);

    const again = editor.tryParseMarkdownToBlocks(blocksMarkdown(editor, editor.document as never)) as unknown as Seen[];

    expect(layout(again)).toEqual(layout(editor.document as unknown as Seen[]));
  });

  it('writes the blocks around a table as the editor does', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'Scene' },
      { type: 'paragraph', content: 'words' },
    ]);

    expect(blocksMarkdown(editor, editor.document as never)).toBe(
      editor.blocksToMarkdownLossy(editor.document as never).trim(),
    );
  });
});

describe('tables the Markdown carries whole (inner#1619 T10)', () => {
  it('keeps a line break in a cell as <br> alone', () => {
    const editor = open([tableBlock({ rows: [{ cells: ['h1', 'h2'] }, { cells: ['a', 'c'] }], headerRows: 1 })]);
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === 'a') at = pos + 1;
      return at < 0;
    });
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.insert(at, [view.state.schema.nodes.hardBreak!.create(), view.state.schema.text('b')]));

    const markdown = blocksMarkdown(editor as never, editor.document as never);

    expect(markdown).toContain('| a<br>b |');
  });

  it('keeps the blocks of a table nested under a list item', () => {
    const editor = open([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [
          tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'heading', props: { level: 2 }, content: 'Big' }, { type: 'bulletListItem', content: 'a' }] }, 'x'] }] }),
        ],
      },
    ]);

    const markdown = blocksMarkdown(editor as never, editor.document as never);

    expect(markdown).toContain('parent');
    expect(markdown).toContain('<h2');
    expect(markdown).not.toContain('Biga');
  });
});
