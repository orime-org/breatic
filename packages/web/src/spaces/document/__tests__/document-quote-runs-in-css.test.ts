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
  } as never);
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
  it('puts the per-block declarations on the block content element', () => {
    const editor = open([{ ...QUOTED, content: 'inside' }]);

    const marked = editor.prosemirrorView!.dom.querySelectorAll(
      '[data-quoted="true"]',
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]!.classList.contains('bn-block-content')).toBe(true);

    const rule = ruleFor('.ProseMirror [data-quoted=\'true\']');
    expect(rule).toContain('padding-inline-start');
    expect(rule).toContain('border-inline-start');
    expect(rule).toContain('color: var(--color-muted-foreground)');
  });

  it('marks the ends of a run, which is where the run’s own margins go', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'one' },
      { ...QUOTED, content: 'two' },
      { ...QUOTED, content: 'three' },
      { type: 'paragraph', content: 'after' },
    ]);

    const { dom } = editor.prosemirrorView!;
    expect(dom.querySelectorAll('[data-quoted-first]')).toHaveLength(1);
    expect(dom.querySelectorAll('[data-quoted-last]')).toHaveLength(1);
    expect(dom.querySelector('[data-quoted-first]')!.textContent).toBe('one');
    expect(dom.querySelector('[data-quoted-last]')!.textContent).toBe('three');

    expect(ruleFor('> [data-quoted-first]')).toContain('margin-top');
    expect(ruleFor('[data-quoted-last]')).toContain('margin-bottom');
  });

  it('puts the space inside a run on the padding, and the run’s own on the margin', () => {
    // Which side of the border the space falls on is what decides whether a
    // run reads as one quote or as several: the rule is drawn on the box, so a
    // margin between two blocks breaks it and padding does not. Measured
    // before the padding form: a 13.6px break in the rule between every pair.
    const between = ruleFor('> [data-quoted=\'true\']');
    expect(between).toContain('margin-top: 0');
    expect(between).toContain('padding-top: var(--doc-paragraph-margin)');

    // And the first block of a run hands that space back to the margin, where
    // it holds the whole run apart from the paragraph above it.
    const first = ruleFor('> [data-quoted-first]');
    expect(first).toContain('margin-top');
    expect(first).toContain('padding-top: 0');
  });

  it('marks a lone quoted block as both ends of its own run', () => {
    const editor = open([
      { type: 'paragraph', content: 'before' },
      { ...QUOTED, content: 'alone' },
    ]);

    const only = editor.prosemirrorView!.dom.querySelector('[data-quoted="true"]');
    expect(only!.hasAttribute('data-quoted-first')).toBe(true);
    expect(only!.hasAttribute('data-quoted-last')).toBe(true);
  });

  it('opens a second run after a plain block splits one', () => {
    const editor = open([
      { ...QUOTED, content: 'one' },
      { type: 'paragraph', content: 'gap' },
      { ...QUOTED, content: 'two' },
    ]);

    const { dom } = editor.prosemirrorView!;
    expect(dom.querySelectorAll('[data-quoted-first]')).toHaveLength(2);
    expect(dom.querySelectorAll('[data-quoted-last]')).toHaveLength(2);
  });
});
