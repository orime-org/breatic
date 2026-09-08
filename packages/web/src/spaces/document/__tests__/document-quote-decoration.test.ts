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
 * Reads every block's text alongside the three quote attributes on it.
 *
 * `data-quoted` is BlockNote's own, on the content element; the two run marks
 * belong to the block's wrapper, which is where the rule beside a quote is
 * drawn — so each row reads its own wrapper rather than the content element.
 * @param root - The element the editor rendered into.
 * @returns One row per block, in document order.
 */
function marks(
  root: HTMLElement,
): { text: string; quoted: boolean; first: boolean; last: boolean }[] {
  return [...root.querySelectorAll('.bn-block-content')].map((el) => {
    const wrapper = el.closest('.bn-block-outer');
    return {
      text: el.textContent ?? '',
      quoted: el.hasAttribute('data-quoted'),
      first: wrapper?.hasAttribute('data-quoted-run-first') ?? false,
      last: wrapper?.hasAttribute('data-quoted-run-last') ?? false,
    };
  });
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

describe('the ends of a run are marked', () => {
  it('marks the first and the last of three, and neither on the middle', () => {
    const { root } = open([q('one'), q('two'), q('three')]);
    expect(marks(root)).toEqual([
      { text: 'one', quoted: true, first: true, last: false },
      { text: 'two', quoted: true, first: false, last: false },
      { text: 'three', quoted: true, first: false, last: true },
    ]);
  });

  it('marks a run of one at both ends', () => {
    const { root } = open([q('alone')]);
    expect(marks(root)).toEqual([
      { text: 'alone', quoted: true, first: true, last: true },
    ]);
  });

  it('marks each run of a document holding two', () => {
    const { root } = open([q('a'), q('b'), plain('gap'), q('c')]);
    expect(marks(root)).toEqual([
      { text: 'a', quoted: true, first: true, last: false },
      { text: 'b', quoted: true, first: false, last: true },
      { text: 'gap', quoted: false, first: false, last: false },
      { text: 'c', quoted: true, first: true, last: true },
    ]);
  });

  it('runs through an indented block, closing on the one that holds it', () => {
    const { editor, root } = open([q('parent'), q('child')]);
    editor.nestBlock();
    // The caret is in the second block, which `nestBlock` moves under the
    // first: on the screen the two are still stacked, so they are one run.
    // The run's own margins go on the OUTERMOST block at each end — the
    // indented one's wrapper sits inside its parent's box, where a margin
    // separates nothing, and the parent's rule already runs past it.
    expect(marks(root)).toEqual([
      { text: 'parent', quoted: true, first: true, last: true },
      { text: 'child', quoted: true, first: false, last: false },
    ]);
  });

  it('carries a number and a run mark on the same block', () => {
    // An ordered list inside a quote: the block wants `data-doc-number` from
    // one computation and the run marks from another, they land on two
    // different elements of the same block, and both have to arrive.
    const { root } = open([
      { type: 'numberedListItem', props: { quoted: true }, content: 'one' },
      { type: 'numberedListItem', props: { quoted: true }, content: 'two' },
    ]);
    const blocks = [...root.querySelectorAll('.bn-block-content')];
    expect(blocks[0]?.getAttribute('data-doc-number')).toBe('1.');
    expect(
      blocks[0]?.closest('.bn-block-outer')?.hasAttribute('data-quoted-run-first'),
    ).toBe(true);
    expect(blocks[1]?.getAttribute('data-doc-number')).toBe('2.');
    expect(
      blocks[1]?.closest('.bn-block-outer')?.hasAttribute('data-quoted-run-last'),
    ).toBe(true);
  });

  it('follows the document as a block joins the run', () => {
    const { editor, root } = open([q('one'), plain('two')]);
    expect(marks(root)[0]).toEqual({
      text: 'one',
      quoted: true,
      first: true,
      last: true,
    });

    editor.updateBlock(editor.document[1]!, {
      props: { quoted: true },
    } as never);
    expect(marks(root)).toEqual([
      { text: 'one', quoted: true, first: true, last: false },
      { text: 'two', quoted: true, first: false, last: true },
    ]);
  });
});
