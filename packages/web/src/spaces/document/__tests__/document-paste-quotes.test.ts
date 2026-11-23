// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

// A quote copied from outside (a web page, Notion, Feishu, a chat reply,
// Markdown `>`) lands as quoted blocks: a quote here is the `quoted` prop on
// each block, so `<blockquote>` at any depth becomes one level of it (inner#1131).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@web/lib/toast';

import { caretIn, drop, open, paste, pasteFormats, settled, unmountAll, type Editor } from './paste-harness';

beforeEach(() => {
  vi.spyOn(toast, 'warning').mockReturnValue('paste-quotes-warning');
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const U = 'https://e.example/';

type Block = { type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

/**
 * The words of a block's inline content.
 * @param content - The content.
 * @returns Its text.
 */
function words(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((item: { text?: string; content?: unknown }) => item.text ?? words(item.content)).join('');
}

/**
 * Every block in reading order, nested ones and table cells too, as
 * `type:words`, with `>` in front when it is quoted and two spaces per level.
 * @param editor - The editor.
 * @returns The labels.
 */
function lines(editor: Editor): string[] {
  const walk = (blocks: readonly Block[], depth: number): string[] =>
    blocks.flatMap((block) => [
      `${'  '.repeat(depth)}${block.props['quoted'] === true ? '>' : ''}${block.type}:${words(block.content)}`,
      ...walk(block.children ?? [], depth + 1),
    ]);
  return walk(editor.document as Block[], 0);
}

/**
 * Pastes HTML on the one empty line of a fresh body.
 * @param html - The HTML.
 * @returns The body's blocks after the paste.
 */
async function pasted(html: string): Promise<string[]> {
  const { editor } = open([{ type: 'paragraph', content: '' }]);
  caretIn(editor, 0);
  paste(editor, html, 'x');
  await settled();
  return lines(editor);
}

describe('a quote pasted from outside stays a quote', () => {
  it('quotes each paragraph of a quote and leaves the lines around it alone', async () => {
    expect(await pasted('<p>before</p><blockquote><p>a</p><p>b</p></blockquote><p>after</p>')).toEqual([
      'paragraph:before',
      '>paragraph:a',
      '>paragraph:b',
      'paragraph:after',
    ]);
  });

  it('reads a quote nested in a quote as one level of quote', async () => {
    expect(await pasted('<blockquote><p>a</p><blockquote><p>b</p><blockquote><p>c</p></blockquote></blockquote><p>d</p></blockquote>')).toEqual([
      '>paragraph:a',
      '>paragraph:b',
      '>paragraph:c',
      '>paragraph:d',
    ]);
  });

  it('quotes words written straight into the quote, as Gmail and Notion copy them', async () => {
    expect(await pasted('<blockquote>one<br>two</blockquote><p>after</p>')).toEqual(['>paragraph:one\ntwo', 'paragraph:after']);
  });

  it('keeps every block type inside a quote and quotes it', async () => {
    const html =
      '<blockquote><h2>title</h2><ul><li>dot</li></ul><ol><li>first</li></ol>' +
      '<ul><li><input type="checkbox" checked>done</li></ul><pre><code>code</code></pre><hr><p>end</p></blockquote>';
    expect(await pasted(html)).toEqual([
      '>heading:title',
      '>bulletListItem:dot',
      '>numberedListItem:first',
      '>checkListItem:done',
      '>codeBlock:code',
      '>divider:',
      '>paragraph:end',
    ]);
  });

  it.each([
    ['a list item holding two paragraphs and a list', '<ul><li><p>a</p><p>b</p><ul><li>c</li></ul></li></ul>'],
    ['a nested list', '<ol><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li></ol>'],
    ['a list item holding code', '<ul><li><p>a</p><pre><code>k</code></pre></li></ul>'],
  ])('reads %s inside a quote as it reads outside one, every block quoted', async (_what, html) => {
    const outside = await pasted(html);
    unmountAll();
    const inside = await pasted(`<blockquote>${html}</blockquote>`);
    expect(inside).toEqual(outside.map((line) => line.replace(/^(\s*)(?=\w)/, '$1>').replace(/^(\s*)>paragraph:$/, '$1paragraph:')));
  });

  it('quotes a picture inside a quote with the lines around it', async () => {
    const { editor } = open([{ type: 'paragraph', content: '' }]);
    caretIn(editor, 0);
    paste(editor, `<blockquote><p>a</p><img src="${U}q.png"><p>b</p></blockquote>`, 'a b');
    await settled();
    expect(lines(editor)).toEqual(['>paragraph:a', '>image:', '>paragraph:b']);
  });

  it('quotes a table inside a quote and the lines in its cells, as quoting a table here does', async () => {
    const landed = await pasted('<blockquote><table><tr><td><p>t</p></td><td>u</td></tr></table></blockquote>');
    expect(landed.filter((line) => /docTable:|:t$|:u$/.test(line.trim()))).toEqual(['>docTable:', '      >paragraph:t', '      >paragraph:u']);
  });

  it('reads Markdown quotes, nested ones too, as one level of quote', async () => {
    const { editor } = open([{ type: 'paragraph', content: '' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/plain': '> m1\n>\n> > m2\n\nafter' });
    await settled();
    expect(lines(editor)).toEqual(['>paragraph:m1', '>paragraph:m2', 'paragraph:after']);
  });

  it('quotes a dropped quote the same as a pasted one', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: '' }]);
    drop(editor, caretIn(editor, 1), '<blockquote><p>q</p></blockquote>', 'q');
    await settled();
    expect(lines(editor)).toContain('>paragraph:q');
  });
});

describe('a quote copied from Notion', () => {
  it('keeps the line breaks Notion writes in it', async () => {
    const { editor } = open([{ type: 'paragraph', content: '' }]);
    caretIn(editor, 0);
    paste(editor, '<!-- notionvc: 1 --><blockquote>a  b\nc</blockquote><p>d</p>', 'a  b\nc\nd');
    await settled();
    expect(lines(editor)).toEqual(['>paragraph:a b\nc', 'paragraph:d']);
  });
});
