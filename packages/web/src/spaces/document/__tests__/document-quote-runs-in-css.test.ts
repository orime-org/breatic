// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b: a run of quoted blocks reads as one quote.
 *
 * A quote used to be a `<blockquote>` wrapped around its blocks, and all of its
 * declarations hung off that one element. Here it is a prop on each block, so
 * they land in two places: on every quoted block, and on the two at a run's
 * ends — all of it reachable through the marks `document-decorations.ts`
 * puts there.
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

    expect(ruleFor('.ProseMirror [data-quoted-run]')).toContain(
      'padding-inline-start',
    );
    // The rule itself is a pseudo-element on that same content box, so that a
    // segment can reach past the box's own edge without the layout following
    // it. The block is its containing block.
    expect(ruleFor('.ProseMirror [data-quoted-run]')).toContain(
      'position: relative',
    );
    expect(ruleFor('.ProseMirror [data-quoted-run]::after')).toContain(
      'background-color: var(--color-muted-foreground)',
    );
  });

  it('draws the rule on the pseudo-element the markers leave alone', () => {
    // A block has one `::before`, and a list item already draws its bullet or
    // its number there. Measured in a browser with the rule on the same one: a
    // quoted bulleted item's marker came back 24x22.5 filled with the rule's
    // grey, and a quoted numbered item's `1.` sat inside an 8px bar of it —
    // the marker gone, the rule no longer a rule. Both markers and the rule
    // reach the same element, so which pseudo-element each takes is what keeps
    // them apart.
    const sheet = readFileSync(
      resolve(import.meta.dirname, '../../../index.css'),
      'utf8',
    );
    expect(sheet).not.toContain('[data-quoted-run]::before');
    expect(sheet).not.toContain('[data-quoted-run-first]::before');
    expect(sheet).not.toContain('[data-quoted-run-last]::before');
    expect(sheet).toContain('[data-doc-number]::before');
    expect(sheet).toContain('[data-bullet-level]::before');
  });

  it('gives a run no space of its own, at either end or between', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'one' },
      { ...QUOTED, content: 'two' },
      { ...QUOTED, content: 'three' },
      { type: 'paragraph', content: 'after' },
    ]);

    const { dom } = editor.prosemirrorView;
    expect(dom.querySelectorAll('[data-quoted-run]')).toHaveLength(3);

    // Quoting changes nothing in the vertical: a block keeps the distance it
    // had to the lines around it, and what quoting draws is the rule and the
    // padding that clears it (user 2026-09-08). So the rule that draws a
    // segment states neither margin.
    const rule = ruleFor('.ProseMirror [data-quoted-run]');
    expect(rule).not.toContain('margin-top');
    expect(rule).not.toContain('margin-bottom');
    expect(rule).not.toContain('margin-block');
  });

  it('lifts each segment over the space above its block, except the run’s first', () => {
    // A run reads as ONE rule (user 2026-09-01: a quote must read as continuous top to bottom).
    // The space between two blocks is margin, which sits outside the content
    // box the rule is drawn on, so each block's segment reaches up over its
    // own margin to meet the one above it. Every margin in the body is an
    // `em`, and an `em` on the pseudo-element resolves against the same font
    // size the margin did, so the block itself carries the number.
    //
    // The run's FIRST block does not reach up: what stands above it is not
    // part of the quote, and on a level-one heading that is 45.6px of blank
    // page (1.2).
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'one' },
      { ...QUOTED, content: 'two' },
    ]);

    const { dom } = editor.prosemirrorView;
    const opens = dom.querySelectorAll('[data-quoted-run-first]');
    expect(opens).toHaveLength(1);
    expect(opens[0].textContent).toBe('one');
    expect(opens[0].classList.contains('bn-block-content')).toBe(true);

    const rule = ruleFor('.ProseMirror [data-quoted-run]::after');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('top: calc(-1 * var(--doc-block-lift))');
    // The height is stated. `top` with `bottom` resolved to zero here —
    // `.bn-block-content` is a flex container, so this is an absolutely
    // positioned child of one — and nothing was painted while both offsets
    // still read back as declared.
    expect(rule).toContain(
      'height: calc(100% + var(--doc-block-lift) + var(--doc-block-drop));',
    );

    // The ends take their own term out of that one height, so a run of a
    // single block can be both ends at once.
    expect(ruleFor('.ProseMirror [data-quoted-run-first]::after')).toContain(
      '--doc-block-lift: 0px',
    );
    expect(ruleFor('.ProseMirror [data-quoted-run-last]::after')).toContain(
      '--doc-block-drop: 0px',
    );
  });

  it('reaches over the very margins the block declares', () => {
    // The two properties above are only the same distance as the block's own
    // space while the block keeps declaring its margins FROM them. That tie is
    // in one rule and nowhere else, so a literal written into either margin for
    // one block type — the natural edit, since every other margin in the body
    // is a literal `em` — would leave that type's segment short of its
    // neighbour with nothing to say so. The `--doc-block-drop` half exists for
    // exactly that case: measured with only the lift, a run holding a heading
    // broke by 24px under it.
    const block = ruleFor('.ProseMirror .bn-block-content');
    expect(block).toContain('margin-top: var(--doc-block-lift)');
    expect(block).toContain('margin-bottom: var(--doc-block-drop)');
  });

  it('leaves the pointer to the words the rule stands beside', () => {
    // The rule lies over the first 2px of the block's own box, and a generated
    // box takes part in hit testing like any other. Measured with it taking
    // the pointer: a click on that strip left the selection as it was, so a
    // reader clicking the near edge of a quote did not get a caret
    // (`document-block-type.spec.ts`'s quote shape held the range for the full
    // ten seconds it waits). It draws and nothing else.
    expect(ruleFor('.ProseMirror [data-quoted-run]::after')).toContain(
      'pointer-events: none',
    );
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
    // One level's worth is taken off and put back, and both halves read the
    // same property: the two have to agree or a run's segments land at
    // different x's, and the Tab nudge reads it as well.
    expect(rule).toContain(
      'margin-inline-start: calc(-1 * var(--doc-indent-step) * var(--quote-depth, 0))',
    );
    // The words clear the rule by the body's size plus the rule's own 2px,
    // which the segment now occupies instead of a border.
    expect(rule.replace(/\s+/g, ' ')).toContain(
      'padding-inline-start: calc( var(--doc-indent-step) * var(--quote-depth, 0) + var(--font-size-base) + 2px );',
    );
    // And the segment sits at the block's own edge, which that negative margin
    // has already pulled back out to where an unindented block starts — so
    // every segment of a run lands at one x.
    expect(ruleFor('.ProseMirror [data-quoted-run]::after')).toContain(
      'inset-inline-start: 0',
    );
  });

  it('draws a segment down an indented block as well as the one holding it', () => {
    const editor = open([
      {
        ...QUOTED,
        content: 'opens',
        children: [{ ...QUOTED, content: 'indented, still quoted' }],
      },
      { type: 'paragraph', content: 'after' },
    ]);

    const { dom } = editor.prosemirrorView;
    const drawn = [...dom.querySelectorAll('[data-quoted-run]')];
    expect(drawn.map((element) => element.textContent)).toEqual([
      'opens',
      'indented, still quoted',
    ]);
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
    // Quoting states no vertical space anywhere. What it draws is horizontal —
    // the rule and the padding that clears it — and the distance to the lines
    // above and below is whatever the block already had (user 2026-09-08).
    // Stated, it was ADDED to what the block already carried: two quoted list
    // items stood 12px apart against the 4px they take outside a quote.
    const sheet = stylesheet();
    expect(sheet).not.toContain('.bn-block-content[data-quoted=\'true\'] {');
    expect(sheet).not.toContain('data-after-quoted');
  });
});
