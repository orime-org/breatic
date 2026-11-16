// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Column groups for tests, in block JSON (inner#1314).
 *
 * Cases write a group as its columns, each column the words of its
 * paragraphs; an empty string is an empty paragraph.
 */

/** A column as cases write it: the words of its paragraphs, or its blocks. */
export type ColumnInput = readonly string[] | { readonly blocks: readonly unknown[]; readonly width?: number };

/**
 * One paragraph.
 * @param words - The words, or empty for an empty paragraph.
 * @returns The paragraph block.
 */
export function para(words: string): Record<string, unknown> {
  return words === '' ? { type: 'paragraph' } : { type: 'paragraph', content: words };
}

/**
 * A column group block.
 * @param columns - The columns.
 * @returns The `docColumnList` block.
 */
export function columnsBlock(...columns: readonly ColumnInput[]): Record<string, unknown> {
  return {
    type: 'docColumnList',
    children: columns.map((column) => {
      const blocks = 'blocks' in column ? column.blocks : (column as readonly string[]).map(para);
      const width = 'blocks' in column ? column.width : undefined;
      return { type: 'docColumn', props: width === undefined ? {} : { width }, children: blocks };
    }),
  };
}

/** A block as the editor reads it back, reduced to what the cases compare. */
interface ReadBlock {
  readonly type: string;
  readonly content?: unknown;
  readonly children?: readonly ReadBlock[];
}

/**
 * The text of an inline content array.
 * @param content - The block's content.
 * @returns Its words.
 */
function wordsOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((part: { text?: string }) => part.text ?? '').join('');
}

/**
 * A document's shape, columns written as `[a|b]` and paragraphs as their words.
 * @param blocks - The editor's top-level blocks.
 * @returns One string per top-level block.
 */
export function shapeOf(blocks: readonly ReadBlock[]): string[] {
  return blocks.map((block) => {
    if (block.type === 'docColumnList') {
      const columns = (block.children ?? []).map((column) =>
        (column.children ?? []).map((inner) => shapeOf([inner])[0]).join(','),
      );
      return `[${columns.join('|')}]`;
    }
    if (block.type === 'paragraph') return wordsOf(block.content) === '' ? '¶' : wordsOf(block.content);
    return block.type;
  });
}
