// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A selection dragged from one body into another, in a second window or tab:
 * the drop carries ProseMirror's own HTML of the slice beside a plain text
 * that reads as Markdown, and the HTML, which keeps the words' styles, is the
 * one read.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AllSelection } from '@tiptap/pm/state';

import { caretIn, drop, open, paste, select, unmountAll } from '@web/spaces/document/__tests__/paste-harness';

afterEach(unmountAll);

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
});

describe('a slice from another ProseMirror editor', () => {
  it('is read from its Markdown plain text, as before', () => {
    const target = open([{ type: 'paragraph', content: '' }]).editor;
    select(target, caretIn(target, 0));

    paste(target, '<p data-pm-slice="1 1 []"># Title</p><p>- item</p>', '# Title\n\n- item');

    const types = (target.document as unknown as { type: string }[]).map((block) => block.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletListItem');
  });
});
