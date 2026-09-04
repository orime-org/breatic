// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b: a run of quoted blocks reads as one quote.
 *
 * A quote used to be a `<blockquote>` wrapped around its blocks, and its seven
 * declarations all hung off that one element. Here it is a prop on each block,
 * so those seven land in three places: four on every quoted block, and three
 * that belong to the run as a whole and are reachable only through the marks
 * `document-decorations.ts` puts on the blocks at its ends.
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
 * The declarations one selector carries, as written.
 * @param selector - The selector to look up, verbatim.
 * @returns The body of that rule.
 */
function ruleFor(selector: string): string {
  const at = stylesheet().indexOf(`${selector} {`);
  expect(at, `\`${selector}\` is not in index.css`).toBeGreaterThan(-1);
  const body = stylesheet().slice(at + selector.length);
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
  it('puts the four per-block declarations on the block content element', () => {
    const editor = open([{ ...QUOTED, content: 'inside' }]);

    const marked = editor.prosemirrorView!.dom.querySelectorAll(
      '[data-quoted="true"]',
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]!.classList.contains('bn-block-content')).toBe(true);

    const rule = ruleFor('.doc-body-editor .ProseMirror [data-quoted=\'true\']');
    expect(rule).toContain('display: flow-root');
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

    expect(ruleFor('.doc-body-editor .ProseMirror [data-quoted-first]')).toContain(
      'margin-top',
    );
    expect(ruleFor('.doc-body-editor .ProseMirror [data-quoted-last]')).toContain(
      'margin-bottom',
    );
  });

  it('zeroes the inner margins at those two ends', () => {
    // The text meets the run's edges, the way it met the container's. These
    // are reachable only because `flow-root` above contains the child's
    // margin: without it the margin would have collapsed out and become the
    // run's own, and zeroing it would move the whole quote.
    expect(
      ruleFor('.doc-body-editor .ProseMirror [data-quoted-first] > :first-child'),
    ).toContain('margin-top: 0');
    expect(
      ruleFor('.doc-body-editor .ProseMirror [data-quoted-last] > :last-child'),
    ).toContain('margin-bottom: 0');
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
