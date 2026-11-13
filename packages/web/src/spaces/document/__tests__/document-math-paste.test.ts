// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design 5.1 and 6.6: what a paste does with formulas.
 *
 * Into an open formula, a paste is source text whatever the clipboard holds:
 * `putContent` hands every parent whose spec is `code` the clipboard's words
 * (design round 3 item 9). From the chat, a formula arrives as an element
 * carrying `data-math` / `data-math-block` and becomes a formula again; from
 * another app, KaTeX's output and bare MathML parse to one formula each, read
 * off the TeX annotation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import katex from 'katex';
import type { Node as PMNode } from '@tiptap/pm/model';
import { SourceBlockWithPreviewExtension } from '@blocknote/core/extensions';

import { caretIn, open, pasteFormats, select, settled, unmountAll, type Editor } from './paste-harness';

afterEach(unmountAll);

/**
 * One text block as a label: its type, then its words, an inline formula
 * written `[math:source]`.
 * @param block - The text block.
 * @returns The label.
 */
function label(block: PMNode): string {
  let words = '';
  block.forEach((child) => {
    if (child.isText) words += child.text;
    else if (child.type.name === 'math') words += `[math:${child.textContent}]`;
    else words += `[${child.type.name}]`;
  });
  return `${block.type.name}:${words}`;
}

/**
 * Every text block in document order, a block formula as `mathBlock:source`.
 * @param editor - The editor.
 * @returns The labels.
 */
function lines(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorView.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    out.push(label(node));
    return false;
  });
  return out;
}

/**
 * The position just inside the end of the first inline formula's source.
 * @param editor - The editor.
 * @returns The position.
 */
function endOfInlineSource(editor: Editor): number {
  let at = -1;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'math') at = pos + 1 + node.content.size;
    return at < 0;
  });
  return at;
}

/**
 * Opens the source popup of the block formula the caret is in, as a click on
 * its preview does.
 * @param editor - The editor.
 */
function openBlockPopup(editor: Editor): void {
  const { id } = editor.getTextCursorPosition().block as { id: string };
  editor.getExtension(SourceBlockWithPreviewExtension)!.store.setState({ popupOpen: id, selected: id });
}

/**
 * The body's own clipboard for a paragraph and a heading, as a copy in the
 * body writes it.
 * @param editor - The editor that serialises it.
 * @returns The clipboard formats.
 */
function ourParagraphAndHeading(editor: Editor): Record<string, string> {
  const html = editor.blocksToFullHTML([
    { type: 'paragraph', content: 'one' },
    { type: 'heading', props: { level: 2 }, content: 'Two' },
  ] as never);
  return { 'blocknote/html': html, 'text/html': html, 'text/plain': 'one\n\nTwo' };
}

describe('a paste into an open block formula', () => {
  it('puts plain text with line breaks and Markdown marks into the source as it is', async () => {
    const { editor } = open([{ type: 'mathBlock', content: 'a' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    openBlockPopup(editor);
    pasteFormats(editor, { 'text/plain': '# T\n**b**\n- c' });
    await settled();
    expect(lines(editor)).toEqual(['mathBlock:a# T\n**b**\n- c', 'paragraph:tail']);
  });

  it('puts the words of a slice copied from the body into the source, not its blocks', async () => {
    const { editor } = open([{ type: 'mathBlock', content: 'a' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    openBlockPopup(editor);
    pasteFormats(editor, ourParagraphAndHeading(editor));
    await settled();
    expect(lines(editor)).toEqual(['mathBlock:aone\nTwo', 'paragraph:tail']);
  });
});

describe('a paste into an inline formula\'s source', () => {
  it('puts Markdown-looking plain text into the source as it is', async () => {
    const { editor } = open([{ type: 'paragraph', content: ['x ', { type: 'math', content: 'a' }, ' y'] }]);
    select(editor, endOfInlineSource(editor));
    pasteFormats(editor, { 'text/plain': '# T **b** [l](u)' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:x [math:a# T **b** [l](u)] y']);
  });

  it('puts the words of a slice copied from the body into the source, not its blocks', async () => {
    const { editor } = open([{ type: 'paragraph', content: ['x ', { type: 'math', content: 'a' }, ' y'] }]);
    select(editor, endOfInlineSource(editor));
    pasteFormats(editor, ourParagraphAndHeading(editor));
    await settled();
    expect(lines(editor)).toHaveLength(1);
    expect(lines(editor)[0]).toMatch(/^paragraph:x \[math:aone\s*Two\] y$/);
  });
});

describe('a slice copied from the body, pasted in a code block', () => {
  it('keeps the result a code block has today', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    pasteFormats(editor, ourParagraphAndHeading(editor));
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:xone\nTwo', 'paragraph:tail']);
  });
});

describe('a reply copied from the chat', () => {
  it('pastes its formulas as formulas and keeps its heading and list, though its plain text reads as Markdown', async () => {
    const html = [
      '<h2>Title</h2>',
      '<ul><li>one</li><li>two</li></ul>',
      '<p>Mass is <span data-math="E=mc^2" style="white-space: pre;">$$E=mc^2$$</span>.</p>',
      '<div data-math-block="\\int x" style="white-space: pre;">$$\n\\int x\n$$</div>',
    ].join('');
    const plain = 'Title\n\none\ntwo\n\nMass is $$E=mc^2$$.\n\n$$\n\\int x\n$$';
    const { editor } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/html': html, 'text/plain': plain });
    await settled();
    expect(lines(editor)).toEqual([
      'heading:Title',
      'bulletListItem:one',
      'bulletListItem:two',
      'paragraph:Mass is [math:E=mc^2].',
      'mathBlock:\\int x',
    ]);
  });
});

describe('formulas from another app', () => {
  it('reads KaTeX\'s inline output as one formula, its source from the TeX annotation', async () => {
    const formula = katex.renderToString('x^2', { output: 'htmlAndMathml' });
    const { editor } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/html': `<p>a ${formula} b</p>`, 'text/plain': 'a x2 b' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:a [math:x^2] b']);
  });

  it('reads KaTeX\'s display output as one block formula', async () => {
    const formula = katex.renderToString('\\int x', { output: 'htmlAndMathml', displayMode: true });
    const { editor } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/html': `<p>a</p>${formula}<p>b</p>`, 'text/plain': 'a\n∫x\nb' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:a', 'mathBlock:\\int x', 'paragraph:b']);
  });

  it('reads bare MathML with a TeX annotation, inline and on a line of its own', async () => {
    const mathml = (display: boolean, source: string): string =>
      `<math${display ? ' display="block"' : ''}><semantics><mrow><mi>y</mi></mrow>` +
      `<annotation encoding="application/x-tex">${source}</annotation></semantics></math>`;
    const { editor } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);
    pasteFormats(editor, {
      'text/html': `<p>a ${mathml(false, 'y_1')} b</p>${mathml(true, '\\sqrt{y}')}`,
      'text/plain': 'a y b\ny',
    });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:a [math:y_1] b', 'mathBlock:\\sqrt{y}']);
  });
});
