// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b: a run of quoted blocks reads as one quote.
 *
 * A quote used to be a `<blockquote>` wrapped around its blocks, and all of its
 * declarations hung off that one element. Here it is a prop on each block, so
 * they land in three places: on every quoted block, on every block after the
 * first of a run, and on the two at a run's ends — the last two reachable only
 * through the marks `document-decorations.ts` puts there.
 *
 * What this file holds is the pair those rules are written against — the
 * ATTRIBUTES the editor puts in the DOM, and the SELECTORS the stylesheet
 * reaches them with. A rename on either side turns it red rather than turning
 * the quote invisible, which is what happened when the container went away and
 * the rules stayed behind.
 *
 * Geometry is not asserted here — jsdom lays nothing out. Whether the rule
 * reads as continuous down a run, and what the run's edges measure, are the
 * two things that need a browser (A8 and A8b).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const roots: HTMLElement[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  roots.splice(0).forEach((root) => {
    root.remove();
  });
});

/** The stylesheet, read once per case so a rule rename cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../../index.css'),
    'utf8',
  );
}

/**
 * The declarations the first rule whose selector ends this way carries.
 *
 * Matched on the tail rather than the whole selector: these selectors are long
 * enough that prettier breaks them over several lines, and the part that says
 * which element is reached is the last one either way.
 * @param tail - The final part of the selector, verbatim.
 * @returns The body of that rule.
 */
function ruleFor(tail: string): string {
  const sheet = stylesheet();
  const opens = sheet.split(`${tail} {`).length - 1;
  // Two rules ending the same way would leave this reading whichever came
  // first and saying nothing about it, which is how a rule can be edited with
  // its test still green. Both `[data-quoted='true']` rules end that way, so
  // callers reach the second one through the `>` in front of it.
  expect(opens, `\`${tail}\` should open exactly one rule in index.css`).toBe(1);
  const body = sheet.slice(sheet.indexOf(`${tail} {`) + tail.length);
  return body.slice(body.indexOf('{') + 1, body.indexOf('}'));
}

/**
 * Opens an editor holding the given blocks, with the run marks live.
 * @param blocks - What to put in the document.
 * @returns The editor.
 */
function open(
  blocks: readonly Readonly<Record<string, unknown>>[],
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentDecorationsExtension()],
  });
  const root = document.createElement('div');
  root.className = 'doc-body-editor';
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** One quoted block. */
const QUOTED = { type: 'paragraph', props: { quoted: true } } as const;

describe('what the stylesheet reaches a quote by', () => {
  it('mutes a quoted block’s words on the content element', () => {
    const editor = open([{ ...QUOTED, content: 'inside' }]);

    const marked = editor.prosemirrorView.dom.querySelectorAll(
      '[data-quoted="true"]',
    );
    expect(marked).toHaveLength(1);
    expect(marked[0].classList.contains('bn-block-content')).toBe(true);

    expect(ruleFor('.ProseMirror [data-quoted=\'true\']')).toContain(
      'color: var(--color-muted-foreground)',
    );
  });

  it('draws the rule on the block’s content, beside the words', () => {
    // A quote runs beside the CONTENT, and a block's own outer space is not
    // content (user 2026-09-08). Measured on a quoted level-one heading, a
    // rule on the wrapper came out 100.78px against 31.19px of words: the
    // wrapper's box holds the heading's 45.6px of top margin, because
    // `.bn-block` is a flex container and does not collapse a child's margins
    // away.
    const editor = open([{ ...QUOTED, content: 'inside' }]);

    const marked =
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]');
    expect(marked).toHaveLength(1);
    expect(marked[0].classList.contains('bn-block-content')).toBe(true);

    const rule = ruleFor('.ProseMirror [data-quoted-run]');
    expect(rule).toContain('border-inline-start');
    expect(rule).toContain('padding-inline-start');
  });

  it('marks the ends of a run without giving them space of their own', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'one' },
      { ...QUOTED, content: 'two' },
      { ...QUOTED, content: 'three' },
      { type: 'paragraph', content: 'after' },
    ]);

    const { dom } = editor.prosemirrorView;
    expect(dom.querySelectorAll('[data-quoted-run-first]')).toHaveLength(1);
    expect(dom.querySelectorAll('[data-quoted-run-last]')).toHaveLength(1);
    expect(dom.querySelector('[data-quoted-run-first]')!.textContent).toBe(
      'one',
    );
    expect(dom.querySelector('[data-quoted-run-last]')!.textContent).toBe(
      'three',
    );

    // Quoting changes nothing in the vertical: a block keeps the distance it
    // had to the lines around it, and the ends of a run declare no margin of
    // their own (user 2026-09-08). The marks stay because they say where a
    // run begins and ends.
    const sheet = stylesheet();
    expect(sheet).not.toContain('[data-quoted-run-first] {');
    expect(sheet).not.toContain('[data-quoted-run-last] {');
  });

  it('draws a segment on every quoted block, each at its own depth', () => {
    // Every quoted block draws its own segment beside its own words, and each
    // carries how far in it sits so all of them land at one x (A8). A segment
    // covering the blocks under it is what put a rule beside a heading's
    // blank space, since only the wrapper reaches them and a wrapper's box
    // holds the block's outer margins.
    const editor = open([
      {
        ...QUOTED,
        content: 'top',
        children: [
          {
            ...QUOTED,
            content: 'one in',
            children: [{ ...QUOTED, content: 'two in' }],
          },
        ],
      },
    ]);

    const { dom } = editor.prosemirrorView;
    expect(dom.querySelectorAll('[data-quoted="true"]')).toHaveLength(3);
    const marked = Array.from(
      dom.querySelectorAll('[data-quoted-run]'),
    ) as HTMLElement[];
    expect(marked).toHaveLength(3);
    expect(marked.map((element) => element.textContent)).toEqual([
      'top',
      'one in',
      'two in',
    ]);
    // Each reads its own nesting, so the offsets do not stack.
    expect(
      marked.map((element) => element.style.getPropertyValue('--quote-depth')),
    ).toEqual(['0', '1', '2']);
  });

  it('brings that rule back out to the editor’s own left edge', () => {
    // A run beginning on an indented block would draw its rule at that indent
    // — one `blockGroup` margin of 24px per level. Every segment sits at one x
    // however deep its block is (user 2026-09-07), and the offset rides only
    // on the blocks that draw a rule, so a nest cannot stack them.
    const editor = open([
      { type: 'paragraph', content: 'not quoted' },
      {
        type: 'paragraph',
        content: 'holds the quote',
        children: [
          { ...QUOTED, content: 'opens indented', children: [{ ...QUOTED, content: 'deeper' }] },
        ],
      },
    ]);

    const marked = Array.from(
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]'),
    ) as HTMLElement[];
    expect(marked).toHaveLength(2);
    expect(
      marked.map((element) => element.style.getPropertyValue('--quote-depth')),
    ).toEqual(['1', '2']);

    const rule = ruleFor('.ProseMirror [data-quoted-run]');
    expect(rule).toContain('margin-inline-start: calc(-24px * var(--quote-depth, 0))');
    expect(rule).toContain(
      'padding-inline-start: calc(24px * var(--quote-depth, 0) + var(--font-size-base))',
    );
  });

  it('closes a run on its outermost block, whatever ends it', () => {
    // The run's lower margin has to land on a box that contains everything in
    // the run. Written on the last block in document order it lands inside the
    // wrapper that already holds it, where it separates nothing.
    const editor = open([
      {
        ...QUOTED,
        content: 'opens',
        children: [{ ...QUOTED, content: 'ends the run, indented' }],
      },
      { type: 'paragraph', content: 'after' },
    ]);

    const { dom } = editor.prosemirrorView;
    const last = dom.querySelectorAll('[data-quoted-run-last]');
    expect(last).toHaveLength(1);
    expect(last[0].querySelector('.bn-block-content')!.textContent).toBe('opens');
  });

  it('indents every quoted block by the body’s size, headings included', () => {
    // The gap between rule and words is read off the BODY size. An `em` here
    // resolves against the element the rule is written on, which is the
    // block's own content — so a quoted h1 stood 24px clear, an h2 20px and a
    // paragraph 15px, and the text column stepped in and out beside one
    // straight rule (user 2026-09-08).
    const editor = open([
      { type: 'heading', props: { level: 1, quoted: true }, content: 'head' },
      { ...QUOTED, content: 'body' },
    ]);

    const marked = Array.from(
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]'),
    );
    expect(marked).toHaveLength(2);
    expect(
      marked.map((element) => element.getAttribute('data-content-type')),
    ).toEqual(['heading', 'paragraph']);

    const rule = ruleFor('.ProseMirror [data-quoted-run]');
    expect(rule).toContain('var(--font-size-base)');
    expect(rule).not.toContain('1em');
  });

  it('leaves the space between two quoted blocks to the blocks themselves', () => {
    // The rule is drawn on the wrapper, whose box already contains that space,
    // so a run reads as one quote without any rule here restating what the
    // gap should be. Stated, it was ADDED to what the block already carried:
    // two quoted list items stood 12px apart against the 4px they take
    // outside a quote (user 2026-09-08).
    const sheet = stylesheet();
    expect(sheet).not.toContain('.bn-block-content[data-quoted=\'true\'] {');
    expect(sheet).not.toContain('data-after-quoted');

    // Nothing states vertical space either. What quoting draws is horizontal —
    // the rule and the padding that clears it — and the distance to the lines
    // above and below is whatever the block already had (user 2026-09-08).
    expect(sheet).not.toContain('[data-quoted-run-first] {');
    expect(sheet).not.toContain('[data-quoted-run-last] {');
  });

  it('marks a lone quoted block as both ends of its own run', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'alone' },
    ]);

    // The ends are marked on the wrapper; the rule itself is drawn one level
    // in, on the content.
    const only = editor.prosemirrorView.dom.querySelector(
      '[data-quoted-run-first]',
    );
    expect(only!.hasAttribute('data-quoted-run-first')).toBe(true);
    expect(only!.hasAttribute('data-quoted-run-last')).toBe(true);
  });

  it('opens a second run after a plain block splits one', () => {
    const editor = open([
      { ...QUOTED, content: 'one' },
      { type: 'paragraph', content: 'gap' },
      { ...QUOTED, content: 'two' },
    ]);

    const { dom } = editor.prosemirrorView;
    expect(dom.querySelectorAll('[data-quoted-run-first]')).toHaveLength(2);
    expect(dom.querySelectorAll('[data-quoted-run-last]')).toHaveLength(2);
  });
});
