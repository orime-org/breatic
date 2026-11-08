// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Blocks as Markdown, a table whose cells hold blocks included (inner#1619
 * design 5.7): what the Agent reads and the Space context carries.
 *
 * BlockNote's Markdown export flattens every cell of a `<table>` to its words
 * (`htmlToMarkdown.ts:79-80` calls `serializeTable`). A table whose every cell
 * holds one paragraph, with no cell spanning and header cells exactly in the
 * first row, is written as a GFM pipe table, which always reads its first row
 * as the header. Any other table is written as its HTML on one line, which
 * keeps header cells and spans: a Markdown HTML block ends at the first empty line
 * (`markdownToHtml.ts:1071-1085`), so every line break in it, a code block's
 * included, is written as `&#10;`, which reads back as the same break.
 * Every other block is BlockNote's own export.
 */

import type { BlockNoteEditor } from '@blocknote/core';

import { DOC_TABLE, DOC_TABLE_HEADER } from '@web/spaces/document/document-table-nodes';

/** The editor, as far as writing Markdown needs it. */
type MarkdownEditor = Pick<BlockNoteEditor<never, never, never>, 'blocksToMarkdownLossy' | 'blocksToHTMLLossy'>;

/** A block, as far as these writers read one. */
export interface BlockLike {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly BlockLike[];
}

/**
 * Rewrites blocks' words before they are written: as Markdown, or into a
 * table's HTML, whose words take no Markdown escapes (inner#1860 §5.1).
 */
export type WordsEscape = (blocks: readonly BlockLike[], into: 'markdown' | 'html') => BlockLike[];

/**
 * Leaves the words as they are.
 * @param blocks - The blocks.
 * @returns They, unchanged.
 */
const AS_THEY_ARE: WordsEscape = (blocks) => [...blocks];

/**
 * Whether a pipe table carries all of a table: every row is as wide as the
 * first, every cell holds one paragraph and nothing under it, no cell spans,
 * and the headers are the first row exactly, which a pipe table always reads as its header (GFM).
 * @param table - The table block.
 * @returns True when it does.
 */
function pipeCarries(table: BlockLike): boolean {
  const width = table.children?.[0]?.children?.length ?? 0;
  return (table.children ?? []).every((row, r) =>
    (row.children ?? []).length === width &&
    (row.children ?? []).every((cell) => {
      const blocks = cell.children ?? [];
      return (
        blocks.length === 1 &&
        blocks[0]!.type === 'paragraph' &&
        (blocks[0]!.children ?? []).length === 0 &&
        Number(cell.props?.['colspan'] ?? 1) === 1 &&
        Number(cell.props?.['rowspan'] ?? 1) === 1 &&
        (cell.type === DOC_TABLE_HEADER) === (r === 0)
      );
    }),
  );
}

/**
 * A pipe table.
 * @param editor - The editor, for each cell's own Markdown.
 * @param table - The table block.
 * @param escape - How the cells' words are escaped.
 * @returns The table's lines.
 */
function pipeTable(editor: MarkdownEditor, table: BlockLike, escape: WordsEscape): string {
  const rows = table.children ?? [];
  const lines = rows.map((row) => {
    const texts = (row.children ?? []).map((cell) =>
      editor
        .blocksToMarkdownLossy(escape(cell.children ?? [], 'markdown') as never)
        .trim()
        .replace(/\|/g, '\\|')
        // A hard break is written as a backslash before the newline.
        .replace(/\\?\n/g, '<br>'),
    );
    return `| ${texts.join(' | ')} |`;
  });
  const width = rows[0]?.children?.length ?? 0;
  lines.splice(1, 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  return lines.join('\n');
}

/**
 * The table's HTML on one line.
 * @param editor - The editor, for each cell's blocks as HTML.
 * @param table - The table block.
 * @param escape - How the cells' words are escaped.
 * @returns The HTML.
 */
function htmlTable(editor: MarkdownEditor, table: BlockLike, escape: WordsEscape): string {
  const rows = (table.children ?? []).map((row) => {
    const cells = (row.children ?? []).map((cell) => {
      const tag = cell.type === DOC_TABLE_HEADER ? 'th' : 'td';
      const spans = (['colspan', 'rowspan'] as const)
        .map((name) => [name, Number(cell.props?.[name] ?? 1)] as const)
        .filter(([, value]) => value > 1)
        .map(([name, value]) => ` ${name}="${String(value)}"`)
        .join('');
      return `<${tag}${spans}>${editor.blocksToHTMLLossy(escape(cell.children ?? [], 'html') as never)}</${tag}>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table>${rows.join('')}</table>`.replace(/\r?\n/g, '&#10;');
}

/**
 * A table as Markdown.
 * @param editor - The editor.
 * @param table - The table block.
 * @param escape - How the cells' words are escaped.
 * @returns The Markdown.
 */
function tableMarkdown(editor: MarkdownEditor, table: BlockLike, escape: WordsEscape): string {
  return pipeCarries(table) ? pipeTable(editor, table, escape) : htmlTable(editor, table, escape);
}

/**
 * Whether a block has a table under it, at any depth.
 * @param block - The block.
 * @returns True when one is.
 */
function holdsTable(block: BlockLike): boolean {
  return (block.children ?? []).some((child) => child.type === DOC_TABLE || holdsTable(child));
}

/**
 * Indents every line of some Markdown.
 * @param markdown - The Markdown.
 * @param width - How many spaces.
 * @returns It, indented.
 */
function indented(markdown: string, width: number): string {
  const pad = ' '.repeat(width);
  return markdown
    .split('\n')
    .map((line) => (line === '' ? line : `${pad}${line}`))
    .join('\n');
}

/**
 * Blocks as Markdown, tables written so their cells' blocks survive.
 * @param editor - The editor.
 * @param blocks - The blocks, as the editor's block API hands them.
 * @param escape - How the words are escaped; as they are when omitted.
 * @returns The Markdown, blocks apart by an empty line.
 */
export function blocksMarkdown(editor: MarkdownEditor, blocks: readonly BlockLike[], escape: WordsEscape = AS_THEY_ARE): string {
  const parts: string[] = [];
  let run: BlockLike[] = [];
  /** Writes the blocks gathered so far, in one export so lists keep their numbers. */
  const flush = (): void => {
    if (run.length > 0) parts.push(editor.blocksToMarkdownLossy(escape(run, 'markdown') as never).trim());
    run = [];
  };
  for (const block of blocks) {
    if (block.type === DOC_TABLE) {
      flush();
      parts.push(tableMarkdown(editor, block, escape));
    } else if (holdsTable(block)) {
      // BlockNote's export would flatten the table under it: the block goes
      // alone, and what is nested under it follows, under a list item's marker.
      flush();
      const own = editor.blocksToMarkdownLossy(escape([{ ...block, children: [] }], 'markdown') as never).trim();
      const marker = /^(?:[*+-]|\d+\.)\s+/.exec(own)?.[0].length ?? 0;
      parts.push(own, indented(blocksMarkdown(editor, block.children ?? [], escape), marker));
    } else {
      run.push(block);
    }
  }
  flush();
  return parts.filter((part) => part !== '').join('\n\n');
}
