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

  it('draws the rule on the block’s wrapper, not on its content', () => {
    // The wrapper's box is the one that already holds the space between two
    // blocks: `.bn-block` is a flex container, and a flex container does not
    // collapse its child's margin away. Drawn there the rule runs unbroken
    // while every block keeps its own type's spacing (user 2026-09-08).
    const editor = open([{ ...QUOTED, content: 'inside' }]);

    const marked =
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]');
    expect(marked).toHaveLength(1);
    expect(marked[0].classList.contains('bn-block-outer')).toBe(true);

    const rule = ruleFor('.ProseMirror [data-quoted-run]');
    expect(rule).toContain('border-inline-start');
    expect(rule).toContain('padding-inline-start');
  });

  it('marks the ends of a run, which is where the run’s own margins go', () => {
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

    expect(ruleFor('[data-quoted-run-first]')).toContain('margin-top');
    expect(ruleFor('[data-quoted-run-last]')).toContain('margin-bottom');
  });

  it('pulls the rule back out by however deep the block sits', () => {
    // The rule is the wrapper's border, so indentation would carry it along —
    // one `blockGroup` margin of 24px per level (BlockNote's `Block.css:80`).
    // The box gives that back and the text takes it again, so every segment
    // lands on the editor's own left edge with the text where it was.
    const quoted = ruleFor('.ProseMirror [data-quoted-run]');
    expect(quoted).toContain(
      'margin-inline-start: calc(-24px * var(--quote-depth, 0))',
    );
    expect(quoted).toContain(
      'padding-inline-start: calc(24px * var(--quote-depth, 0) + 1em)',
    );
  });

  it('indents every quoted block by the body’s size, headings included', () => {
    // That `1em` resolves against the element it is written on. On the content
    // element it was the block's own size, so a quoted h1 indented 24px, an h2
    // 20px and a paragraph 15px, and the text column stepped in and out beside
    // one straight rule. The wrapper carries no heading size, so one run now
    // has one text column (user 2026-09-08).
    const editor = open([
      { type: 'heading', props: { level: 1, quoted: true }, content: 'head' },
      { ...QUOTED, content: 'body' },
    ]);

    const wrappers = Array.from(
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]'),
    );
    expect(wrappers).toHaveLength(2);
    wrappers.forEach((wrapper) => {
      expect(wrapper.classList.contains('bn-block-outer')).toBe(true);
      // The heading size lives on the content element one level in, which is
      // what made the two indent differently.
      expect(
        wrapper.querySelector('[data-content-type="heading"], [data-content-type="paragraph"]'),
      ).not.toBeNull();
    });
  });

  it('counts the levels a quoted block sits in, however many', () => {
    // The number the two offsets above are multiplied by, so every one of
    // them is only as right as this is. A container's depth counts TWO per
    // level of indentation — `blockGroup` then `blockContainer` — which one
    // level cannot tell apart from counting one, or from subtracting a
    // constant. Three levels can.
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

    // A wrapper contains the blocks indented under it, so each one is read by
    // its OWN content element rather than by everything inside it.
    const depths = Array.from(
      editor.prosemirrorView.dom.querySelectorAll('[data-quoted-run]'),
    ).map((element) => ({
      text: element.querySelector('.bn-block-content')?.textContent,
      depth: (element as HTMLElement).style.getPropertyValue('--quote-depth'),
    }));
    expect(depths).toEqual([
      { text: 'top', depth: '0' },
      { text: 'one in', depth: '1' },
      { text: 'two in', depth: '2' },
    ]);
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

    // The run's own outer space is the one thing stated, on the two wrappers
    // at its ends. Below the run it meets the next block's own top margin and
    // the two collapse — wrappers are block boxes — so a heading after a
    // quote keeps the space its level asks for.
    expect(ruleFor('[data-quoted-run-first]')).toContain('margin-top');
    expect(ruleFor('[data-quoted-run-last]')).toContain('margin-bottom');
  });

  it('marks a lone quoted block as both ends of its own run', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'alone' },
    ]);

    const only =
      editor.prosemirrorView.dom.querySelector('[data-quoted-run]');
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
