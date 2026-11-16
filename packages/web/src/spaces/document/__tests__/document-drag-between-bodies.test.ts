// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A selection dragged from one body into another, in a second window or tab:
 * the drop carries ProseMirror's own HTML of the slice beside a plain text
 * that reads as Markdown, and the HTML, which keeps the words' styles, is the
 * one read.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AllSelection } from '@tiptap/pm/state';

import { caretIn, drop, open, paste, pasteFormats, select, unmountAll, written, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

afterEach(unmountAll);

/**
 * Blocks as JSON with their ids left out, which differ between two bodies.
 * @param blocks - The blocks.
 * @returns The JSON.
 */
function withoutIds(blocks: unknown): string {
  return JSON.stringify(blocks, (key, value: unknown) => (key === 'id' ? undefined : value));
}

describe('a selection dragged in from another body', () => {
  it('keeps the styles of its words', () => {
    const source = open([
      { type: 'heading', props: { level: 1 }, content: 'Title' },
      { type: 'paragraph', content: [{ type: 'text', text: 'red', styles: { textColor: 'red' } }, { type: 'text', text: ' words', styles: { underline: true } }] },
    ]).editor;
    const sourceView = source.prosemirrorView!;
    sourceView.dispatch(sourceView.state.tr.setSelection(new AllSelection(sourceView.state.doc)));
    const { dom, text } = sourceView.serializeForClipboard(sourceView.state.selection.content());
    const target = open([{ type: 'paragraph', content: 'DROPHERE' }]).editor;

    drop(target, 9, dom.innerHTML, `# Title\n\n${text}`);

    const styled = (target.document as unknown as { content?: { text?: string; styles?: Record<string, unknown> }[] }[])
      .flatMap((block) => block.content ?? [])
      .filter((piece) => Object.keys(piece.styles ?? {}).length > 0)
      .map((piece) => `${piece.text}:${Object.keys(piece.styles!).join(',')}`);
    expect(styled).toEqual(['red:textColor', ' words:underline']);
  });

  const formulas = [
    { type: 'paragraph', content: [{ type: 'text', text: 'bold', styles: { bold: true } }, ' x ', { type: 'math', props: { source: 'a^2' } }] },
    { type: 'mathBlock', props: { source: 'x^2' } },
    { type: 'paragraph', content: 'gamma' },
  ];
  const tableWithFormula = [
    { type: 'paragraph', content: 'lead' },
    tableBlock({ rows: [{ cells: ['c1', { blocks: [{ type: 'mathBlock', props: { source: 'y_1' } }] }] }] }),
    { type: 'paragraph', content: 'tail' },
  ];
  const codeLines = [{ type: 'codeBlock', content: 'line1\n  line2 *a*\n\tline3' }];
  const spaced = [{ type: 'paragraph', content: 'a  b   c' }];
  it.each([
    ['blocks with formulas', 'codeBlock', formulas],
    ['a table holding a formula block', 'codeBlock', tableWithFormula],
    ['lines of code', 'codeBlock', codeLines],
    ['lines of code', 'paragraph', codeLines],
    ['words with runs of spaces', 'codeBlock', spaced],
    ['words with runs of spaces', 'paragraph', spaced],
  ])('lands as a paste of its copy does, for %s onto a %s', (_name, target, blocks) => {
    const source = open(blocks).editor;
    select(source, 3, source.prosemirrorView!.state.doc.content.size - 3);
    const dragged = written(source.prosemirrorView!.dom, 'dragstart');
    const copied = written(source.prosemirrorView!.dom, 'copy');
    const dropped = open([{ type: target, content: 'let x = 1' }]).editor;
    const pasted = open([{ type: target, content: 'let x = 1' }]).editor;
    const end = (editor: Editor): number => editor.prosemirrorView!.state.doc.content.size - 3;

    drop(dropped, end(dropped), dragged['text/html'] ?? '', dragged['text/plain'] ?? '');
    select(pasted, end(pasted));
    pasteFormats(pasted, copied);

    expect(withoutIds(dropped.document)).toEqual(withoutIds(pasted.document));
  });
});

describe('HTML from another page that marks its parts with data-content-type', () => {
  it('lands in a code block as its plain text', () => {
    const target = open([{ type: 'codeBlock', content: 'x' }]).editor;
    select(target, target.prosemirrorView!.state.doc.content.size - 3);

    paste(target, '<div data-content-type="html"><pre>def f():\n    return 1</pre></div>', 'def f():\n    return 1');

    expect(target.prosemirrorView!.state.doc.textContent).toBe('xdef f():\n    return 1');
  });
});

describe('a slice from another ProseMirror editor', () => {
  it('is read from its Markdown plain text', () => {
    const target = open([{ type: 'paragraph', content: '' }]).editor;
    select(target, caretIn(target, 0));

    paste(target, '<p data-pm-slice="1 1 []"># Title</p><p>- item</p>', '# Title\n\n- item');

    const types = (target.document as unknown as { type: string }[]).map((block) => block.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletListItem');
  });
});
