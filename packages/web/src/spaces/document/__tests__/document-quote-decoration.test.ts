// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b 的结构那半: the quote's geometry reaches the screen.
 *
 * The seven declarations the delivered quote draws (`index.css:858-864` plus
 * `:902` `:906`) hung on a real `<blockquote>` element wrapping the blocks.
 * There is no such element here — a quote is a prop on each block — so four of
 * the seven are written per block off `data-quoted`, which BlockNote renders
 * from the prop itself, and the other three need to know where the run begins
 * and ends: the outer margins belong to the whole quote, and the two blocks at
 * its ends are the ones that carry them.
 *
 * A decoration marks those two blocks. What the marks are worth on screen is
 * measured in the browser (A8, A8b); what they are put on is here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `replaceBlocks` takes it. */
type BlockSpec = Readonly<Record<string, unknown>>;

/**
 * Opens an editor over a fresh document holding the given blocks.
 * @param blocks - What to put in the document.
 * @returns The editor and the element it rendered into.
 */
function open(blocks: readonly BlockSpec[]): {
  editor: ReturnType<typeof buildDocumentEditor>;
  root: HTMLElement;
} {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentDecorationsExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, root };
}

/** A quoted paragraph holding one word. */
function q(text: string): BlockSpec {
  return { type: 'paragraph', props: { quoted: true }, content: text };
}

/** A paragraph carrying no quote. */
function plain(text: string): BlockSpec {
  return { type: 'paragraph', content: text };
}

/**
 * Reads every block's text alongside the two quote attributes on it.
 *
 * Both ride the content element: `data-quoted` is BlockNote's own, and
 * `data-quoted-run` is written onto the same element by
 * `document-decorations.ts` — the rule beside a quote is drawn from it, and a
 * quote runs beside the words rather than beside the block's outer space.
 * @param root - The element the editor rendered into.
 * @returns One row per block, in document order.
 */
function marks(
  root: HTMLElement,
): { text: string; quoted: boolean; rule: boolean }[] {
  return [...root.querySelectorAll('.bn-block-content')].map((el) => ({
    text: el.textContent ?? '',
    quoted: el.hasAttribute('data-quoted'),
    rule: el.hasAttribute('data-quoted-run'),
  }));
}

describe('the quote itself comes from the prop', () => {
  it('renders `data-quoted` on the quoted block and on no other', () => {
    const { root } = open([plain('outside'), q('inside')]);
    expect(marks(root).map((row) => [row.text, row.quoted])).toEqual([
      ['outside', false],
      ['inside', true],
    ]);
  });

  it('puts it on the block’s own content element', () => {
    const { root } = open([q('one')]);
    const marked = root.querySelector('[data-quoted]');
    expect(marked?.classList.contains('bn-block-content')).toBe(true);
  });
});

describe('every quoted block carries the rule', () => {
  it('draws a segment down each of three, and none beside a plain block', () => {
    const { root } = open([q('a'), q('b'), plain('gap'), q('c')]);
    expect(marks(root)).toEqual([
      { text: 'a', quoted: true, rule: true },
      { text: 'b', quoted: true, rule: true },
      { text: 'gap', quoted: false, rule: false },
      { text: 'c', quoted: true, rule: true },
    ]);
  });

  it('draws one down an indented block as well as the one holding it', () => {
    const { editor, root } = open([q('parent'), q('child')]);
    editor.nestBlock();
    // The caret is in the second block, which `nestBlock` moves under the
    // first: on the screen the two are still stacked, and each draws its own
    // segment at the one x its `--quote-depth` puts it at.
    expect(marks(root)).toEqual([
      { text: 'parent', quoted: true, rule: true },
      { text: 'child', quoted: true, rule: true },
    ]);
  });

  it('carries a number and the rule on the same block', () => {
    // An ordered list inside a quote: the block wants `data-doc-number` from
    // one computation and `data-quoted-run` from another, and both have to
    // arrive on the same element.
    const { root } = open([
      { type: 'numberedListItem', props: { quoted: true }, content: 'one' },
      { type: 'numberedListItem', props: { quoted: true }, content: 'two' },
    ]);
    const blocks = [...root.querySelectorAll('.bn-block-content')];
    expect(blocks[0]?.getAttribute('data-doc-number')).toBe('1.');
    expect(blocks[0]?.hasAttribute('data-quoted-run')).toBe(true);
    expect(blocks[1]?.getAttribute('data-doc-number')).toBe('2.');
    expect(blocks[1]?.hasAttribute('data-quoted-run')).toBe(true);
  });

  it('follows the document as a block joins the run', () => {
    const { editor, root } = open([q('one'), plain('two')]);
    expect(marks(root)).toEqual([
      { text: 'one', quoted: true, rule: true },
      { text: 'two', quoted: false, rule: false },
    ]);

    editor.updateBlock(editor.document[1]!, {
      props: { quoted: true },
    } as never);
    expect(marks(root)).toEqual([
      { text: 'one', quoted: true, rule: true },
      { text: 'two', quoted: true, rule: true },
    ]);
  });
});
