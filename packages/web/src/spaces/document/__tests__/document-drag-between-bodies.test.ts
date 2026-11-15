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

import { caretIn, drop, open, paste, pasteFormats, select, unmountAll } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

afterEach(unmountAll);

type Editor = ReturnType<typeof open>['editor'];

/**
 * Fires an event that writes a data transfer on the body, and reads what it wrote.
 * @param editor - The editor holding the selection.
 * @param type - `copy` or `dragstart`.
 * @returns Each format written, with its data.
 */
function written(editor: Editor, type: 'copy' | 'dragstart'): Record<string, string> {
  const data: Record<string, string> = {};
  const transfer = {
    types: [], files: [], effectAllowed: '',
    setData: (format: string, value: string): void => { data[format] = value; },
    getData: (format: string): string => data[format] ?? '',
    clearData: (): void => undefined,
    setDragImage: (): void => undefined,
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === 'copy' ? 'clipboardData' : 'dataTransfer', { value: transfer });
  editor.prosemirrorView!.dom.dispatchEvent(event);
  return data;
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
});

describe('a selection dragged in from another body onto a code block', () => {
  it.each([
    ['blocks with formulas', [
      { type: 'paragraph', content: [{ type: 'text', text: 'bold', styles: { bold: true } }, ' x ', { type: 'math', props: { source: 'a^2' } }] },
      { type: 'mathBlock', props: { source: 'x^2' } },
      { type: 'paragraph', content: 'gamma' },
    ]],
    ['a table holding a formula block', [
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['c1', { blocks: [{ type: 'mathBlock', props: { source: 'y_1' } }] }] }] }),
      { type: 'paragraph', content: 'tail' },
    ]],
  ])('lands as the words a copy of it pastes there, for %s', (_name, blocks) => {
    const source = open(blocks).editor;
    select(source, 3, source.prosemirrorView!.state.doc.content.size - 3);
    const dragged = written(source, 'dragstart');
    const copied = written(source, 'copy');
    const dropped = open([{ type: 'codeBlock', content: 'let x = 1' }]).editor;
    const pasted = open([{ type: 'codeBlock', content: 'let x = 1' }]).editor;
    const end = (editor: Editor): number => editor.prosemirrorView!.state.doc.content.size - 3;

    drop(dropped, end(dropped), dragged['text/html'] ?? '', dragged['text/plain'] ?? '');
    select(pasted, end(pasted));
    pasteFormats(pasted, copied);

    expect(dropped.prosemirrorView!.state.doc.textContent).toBe(pasted.prosemirrorView!.state.doc.textContent);
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
