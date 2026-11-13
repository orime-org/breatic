// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A8, A10, A11, design 5.1 and 6.6: formulas through Markdown.
 *
 * Only `$$…$$` is a formula, the chat's semantics (`singleDollarTextMath:
 * false`): inline `$$x$$` in a line, a block on `$$` lines of its own. Written
 * out, an inline formula is `$$source$$` and a block `$$` lines around its
 * source, whether or not KaTeX can render it, and each formula appears once.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { blockItem, selectionItem } from '@web/spaces/document/document-to-agent';

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
  id?: string;
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

/** A formula found in some blocks. */
interface Formula {
  kind: 'block' | 'inline';
  source: string;
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
 * A formula's source, read off its props.
 * @param formula - A formula block or inline piece.
 * @returns The source.
 */
function sourceOf(formula: unknown): string {
  return String((formula as { props?: { source?: string } }).props?.source ?? '');
}

/**
 * Every formula in some blocks, in document order.
 * @param blocks - The blocks.
 * @returns The formulas.
 */
function formulas(blocks: readonly Seen[]): Formula[] {
  const out: Formula[] = [];
  for (const block of blocks) {
    if (block.type === 'mathBlock') out.push({ kind: 'block', source: sourceOf(block) });
    else if (Array.isArray(block.content)) {
      for (const piece of block.content as Piece[]) {
        if (piece.type === 'math') out.push({ kind: 'inline', source: sourceOf(piece) });
      }
    }
    out.push(...formulas(block.children ?? []));
  }
  return out;
}

/**
 * The blocks a Markdown body reads into.
 * @param markdown - The body.
 * @returns The blocks.
 */
async function read(markdown: string): Promise<Seen[]> {
  return (await markdownBlocks(markdown)).map((b) => b.block as unknown as Seen);
}

/**
 * A paragraph with an inline formula between two runs of words.
 * @param source - The formula's source.
 * @returns The block.
 */
function inlineIn(source: string): unknown {
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Mass ', styles: {} },
      { type: 'math', props: { source: source } },
      { type: 'text', text: ' here', styles: {} },
    ],
  };
}

/**
 * How many times a needle occurs in a haystack.
 * @param haystack - The text.
 * @param needle - What to count.
 * @returns The count.
 */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Markdown into the body', () => {
  it('reads $$x$$ in a line as an inline formula', async () => {
    const blocks = await read('Mass $$E = mc^2$$ here');

    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(formulas(blocks)).toEqual([{ kind: 'inline', source: 'E = mc^2' }]);
  });

  it('reads $$ lines around a source as a formula block', async () => {
    const blocks = await read('$$\n\\frac{a}{b}\n$$');

    expect(blocks.map((b) => b.type)).toEqual(['mathBlock']);
    expect(formulas(blocks)).toEqual([{ kind: 'block', source: '\\frac{a}{b}' }]);
  });

  it('leaves single dollars as words', async () => {
    const got = await markdownBlocks('Costs $5 and $x$');

    expect(got.map((b) => [(b.block as unknown as Seen).type, b.text])).toEqual([['paragraph', 'Costs $5 and $x$']]);
    expect(formulas(got.map((b) => b.block as unknown as Seen))).toEqual([]);
  });

  it('leaves $$ inside a fenced code block as code', async () => {
    const got = await markdownBlocks('```\n$$x$$\n```');

    expect(got.map((b) => [(b.block as unknown as Seen).type, b.text])).toEqual([['codeBlock', '$$x$$']]);
  });

  it('keeps a line written straight after a formula block as a paragraph', async () => {
    const blocks = await read('$$\nx^2\n$$\nNext line');

    expect(blocks.map((b) => b.type)).toEqual(['mathBlock', 'paragraph']);
    expect(formulas(blocks)).toEqual([{ kind: 'block', source: 'x^2' }]);
    expect(wordsOf(blocks[1]!.content)).toBe('Next line');
  });

  it.each([
    ['an unclosed underscore', 'Note _see $$y_2$$ end', 'y_2'],
    ['an unclosed asterisk', 'Note *see $$a*b$$ end', 'a*b'],
  ])('keeps the formula whole after %s', async (_name, markdown, source) => {
    const blocks = await read(markdown);

    expect(formulas(blocks)).toEqual([{ kind: 'inline', source }]);
  });
});

describe('formula sources round-trip through Markdown', () => {
  it.each(['\\{ \\}', '\\\\', 'a_1 b_2', 'a < b', 'a & b', '\\frac{a}{b}'])('keeps the inline source %s', async (source) => {
    const editor = open([inlineIn(source)]);

    const again = await read(blocksMarkdown(editor, editor.document as never));

    expect(formulas(again)).toEqual([{ kind: 'inline', source }]);
  });

  it.each(['\\{ \\}', '\\\\', 'a_1 b_2', 'a < b', 'a & b', 'a\n\nb'])('keeps the block source %j', async (source) => {
    const editor = open([{ type: 'mathBlock', props: { source: source } }]);

    const again = await read(blocksMarkdown(editor, editor.document as never));

    expect(formulas(again)).toEqual([{ kind: 'block', source }]);
  });
});

describe('the body as Markdown', () => {
  it('writes an inline formula as $$source$$', () => {
    const editor = open([inlineIn('E = mc^2')]);

    expect(blocksMarkdown(editor, editor.document as never)).toBe('Mass $$E = mc^2$$ here');
  });

  it('writes a formula block with $$ on lines of their own', () => {
    const editor = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }]);

    expect(blocksMarkdown(editor, editor.document as never)).toBe('$$\n\\frac{a}{b}\n$$');
  });

  it('writes a source KaTeX cannot render the same way', () => {
    const editor = open([inlineIn('\\frac{a}{b'), { type: 'mathBlock', props: { source: '\\frac{a}{b' } }]);

    const markdown = blocksMarkdown(editor, editor.document as never);

    expect(markdown).toContain('Mass $$\\frac{a}{b$$ here');
    expect(markdown).toContain('$$\n\\frac{a}{b\n$$');
  });

  it('writes an empty formula block as its two $$ lines', () => {
    const editor = open([{ type: 'paragraph', content: 'before' }, { type: 'mathBlock' }, { type: 'paragraph', content: 'after' }]);

    const markdown = blocksMarkdown(editor, editor.document as never);

    expect(count(markdown, '$$')).toBe(2);
    expect(markdown.startsWith('before\n\n$$')).toBe(true);
  });

  it('writes each formula once, with none of KaTeX\'s glyph text', () => {
    const editor = open([inlineIn('x^2'), { type: 'mathBlock', props: { source: 'y^2' } }]);

    const markdown = blocksMarkdown(editor, editor.document as never);

    expect(count(markdown, '$$')).toBe(4);
    expect(count(markdown, 'x^2')).toBe(1);
    expect(count(markdown, 'y^2')).toBe(1);
  });

  it('exports one <math> element per formula as HTML', () => {
    const editor = open([inlineIn('x^2'), { type: 'mathBlock', props: { source: 'y^2' } }, { type: 'mathBlock', props: { source: '\\frac{a}{b' } }]);

    const html = editor.blocksToHTMLLossy(editor.document);

    expect(html.match(/<math[\s>]/g)?.length ?? 0).toBe(3);
    expect(count(html, 'application/x-tex')).toBe(3);
  });
});

describe('formulas handed to the Agent', () => {
  it('gives a block holding an inline formula as $$source$$', () => {
    const editor = open([inlineIn('E = mc^2')]);

    const item = blockItem(editor, (editor.document[0] as { id: string }).id);

    expect(item.chip?.data_snapshot).toEqual({ text: 'Mass $$E = mc^2$$ here' });
  });

  it('gives a formula block on $$ lines', () => {
    const editor = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }]);

    const item = blockItem(editor, (editor.document[0] as { id: string }).id);

    expect(item.chip?.data_snapshot).toEqual({ text: '$$\n\\frac{a}{b}\n$$' });
  });

  it('gives a selection inside one block with its formula as $$source$$', () => {
    const editor = open([inlineIn('E = mc^2')]);
    const view = editor.prosemirrorView!;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.type.name === 'paragraph') {
        from = pos + 1;
        to = pos + 1 + node.content.size;
      }
      return from < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({ text: 'Mass $$E = mc^2$$ here' });
  });
});
