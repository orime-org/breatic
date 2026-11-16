// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 design 5.1 and 6.6: what a copy in the body puts on the
 * clipboard when the selection holds formulas.
 *
 * The plain text is Markdown written by BlockNote's `htmlToMarkdown`, patched
 * so an inline formula is `$$source$$`; a block formula is `$$` on its own
 * lines. An inline formula holds no text of the body, so a selection takes it
 * whole.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { written, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding these blocks, focused.
 * @param blocks - The body.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  editor.prosemirrorView.focus();
  return editor;
}

/**
 * Where the first node of a type starts.
 * @param editor - The editor.
 * @param type - The node type.
 * @returns The position before it.
 */
function before(editor: Editor, type: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === type) found = pos;
    return found < 0;
  });
  return found;
}

/**
 * Selects a range.
 * @param editor - The editor.
 * @param from - Its start.
 * @param to - Its end.
 */
function select(editor: Editor, from: number, to: number): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

describe('copying a selection that holds formulas', () => {
  it('writes an inline formula into the plain text as $$source$$', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a^2' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    expect(written(editor.prosemirrorView.dom, 'copy')['text/plain']?.trim()).toBe('x $$a^2$$ y');
  });

  it('writes a multi-line inline formula into the plain text on one line, without its comments', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a % c\nb' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    expect(written(editor.prosemirrorView.dom, 'copy')['text/plain']?.trim()).toBe('x $$a b$$ y');
  });

  it('writes two formulas side by side into the plain text so they read back as two', async () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);

    const [read] = await markdownBlocks(written(editor.prosemirrorView.dom, 'copy')['text/plain'] ?? '');

    const pieces = (read!.block as unknown as { content: { type: string; props?: { source?: string } }[] }).content;
    expect(pieces.filter((piece) => piece.type === 'math').map((piece) => piece.props?.source)).toEqual(['a', 'b']);
  });

  // The plain text is for people: where two dollar runs meet, a space parts
  // them, as a person writes it, in place of the Markdown writer's comment.
  it.each([
    ['two formulas side by side', ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'], 'x $$a$$ $$b$$ y'],
    ['a word ending in $ before a formula', ['US$', { type: 'math', props: { source: 'c' } }, ' more'], 'US$ $$c$$ more'],
  ])('parts %s with a space in the plain text', (_name, content, plain) => {
    const editor = open([{ type: 'paragraph', content }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    expect(written(editor.prosemirrorView.dom, 'copy')['text/plain']?.trim()).toBe(plain);
  });

  it('parts two formulas side by side in a table cell with a space in the plain text', () => {
    const cell = { blocks: [{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }] };
    const editor = open([tableBlock({ rows: [{ cells: [cell as never, 'other'] }] })]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    const plain = written(editor.prosemirrorView.dom, 'copy')['text/plain'] ?? '';
    expect(plain).toContain('$$a$$ $$b$$');
    expect(plain).not.toContain('<!--');
  });

  it('parts two formulas side by side with a space in the plain text of a range through a table', () => {
    const editor = open([
      { type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] },
      tableBlock({ rows: [{ cells: ['one', 'two'] }] }),
      { type: 'paragraph', content: 'end' },
    ]);
    select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
    const plain = written(editor.prosemirrorView.dom, 'copy')['text/plain'] ?? '';
    expect(plain).toContain('$$a$$ $$b$$');
    expect(plain).not.toContain('<!--');
  });

  it('parts two formulas side by side with a space in the plain text a block drag carries', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }]);
    const data: Record<string, string> = {};
    const transfer = { clearData: (): void => undefined, setData: (format: string, value: string): void => { data[format] = value; }, setDragImage: (): void => undefined, effectAllowed: '' };
    const sideMenu = (editor as unknown as { getExtension: (name: string) => { blockDragStart: (event: unknown, block: unknown) => void; blockDragEnd: () => void } }).getExtension('sideMenu');
    sideMenu.blockDragStart({ dataTransfer: transfer }, editor.document[0]);
    try {
      expect(data['text/plain']?.trim()).toBe('x $$a$$ $$b$$ y');
    } finally {
      // BlockNote keeps the drag's preview in module state that outlives this
      // file; a drag left running breaks the next file's first drag.
      sideMenu.blockDragEnd();
    }
  });

  // A drag carries what a copy of the same selection writes, as ProseMirror
  // hands both the same serialisation; the chat box reads a drop's plain text.
  const sideBySide = { type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] };
  const wholeLine = (editor: Editor): void => {
    const paragraph = before(editor, 'paragraph');
    select(editor, paragraph + 1, paragraph + 1 + editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size);
  };
  const toTheEnd = (editor: Editor): void => select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
  it.each([
    ['two formulas side by side', [sideBySide], wholeLine],
    ['words ending and starting with $ around a formula', [{ type: 'paragraph', content: ['US$', { type: 'math', props: { source: 'c' } }, '$5'] }], wholeLine],
    ['a formula alone beside a $ word', [{ type: 'paragraph', content: ['US$', { type: 'math', props: { source: 'c' } }, ' each'] }], (editor: Editor): void => {
      const at = before(editor, 'math');
      select(editor, at, at + 1);
    }],
    ['a formula block between paragraphs', [{ type: 'paragraph', content: 'above' }, { type: 'mathBlock', props: { source: '\\frac{a}{b}' } }, { type: 'paragraph', content: 'below' }], toTheEnd],
    ['a range through a table', [sideBySide, tableBlock({ rows: [{ cells: ['one', 'two'] }] }), { type: 'paragraph', content: 'end' }], toTheEnd],
  ])('gives a selection drag the plain text a copy writes, for %s', (_name, blocks, pick) => {
    const editor = open(blocks);
    pick(editor);
    const dragged = written(editor.prosemirrorView.dom, 'dragstart')['text/plain'];
    expect(dragged).toBe(written(editor.prosemirrorView.dom, 'copy')['text/plain']);
  });

  it('leaves a serialising after a drag, and the selection it reads, to Tiptap', async () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'mathBlock', props: { source: 'x' } }, { type: 'paragraph', content: 'tail' }]);
    select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
    written(editor.prosemirrorView.dom, 'dragstart');
    await Promise.resolve();
    const view = editor.prosemirrorView;

    expect(view.serializeForClipboard(view.state.selection.content()).text).not.toBe(written(editor.prosemirrorView.dom, 'copy')['text/plain']);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, before(editor, 'mathBlock'))));
    const selected = view.state.selection;
    view.serializeForClipboard(selected.content());
    expect(view.state.selection.eq(selected)).toBe(true);
  });

  it('gives a block formula its $$ text in the HTML a selection drag carries', () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'mathBlock', props: { source: 'x^2' } }, { type: 'paragraph', content: 'tail' }]);
    select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
    const host = document.createElement('div');
    host.innerHTML = written(editor.prosemirrorView.dom, 'dragstart')['text/html'] ?? '';
    // A text field the drag lands in reads the HTML's words.
    expect(host.querySelector('[data-content-type="mathBlock"]')?.textContent).toBe('$$\nx^2\n$$');
  });

  it('writes a block formula into the plain text as $$ on lines of their own', () => {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'mathBlock', props: { source: '\\int x' } },
      { type: 'paragraph', content: 'tail' },
    ]);
    const { doc } = editor.prosemirrorState;
    select(editor, before(editor, 'paragraph') + 1, doc.content.size - 3);
    expect(written(editor.prosemirrorView.dom, 'copy')['text/plain']).toContain('$$\n\\int x\n$$');
  });

});

describe('pasting a copy that holds a formula block into a code block', () => {
  it('keeps the formula block as its $$ lines', () => {
    const editor = open([
      { type: 'codeBlock', props: { language: 'javascript' }, content: 'let x = 1' },
      { type: 'paragraph', content: 'lead' },
      { type: 'mathBlock', props: { source: 'x^2' } },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
    const formats = written(editor.prosemirrorView.dom, 'copy');
    const code = before(editor, 'codeBlock');
    const end = code + 1 + editor.prosemirrorState.doc.nodeAt(code)!.content.size;
    select(editor, end, end);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { types: Object.keys(formats), files: [], items: [], getData: (type: string) => formats[type] ?? '' } });
    editor.prosemirrorView.dom.dispatchEvent(event);

    expect(editor.prosemirrorState.doc.nodeAt(before(editor, 'codeBlock'))!.textContent).toContain('$$\nx^2\n$$');
  });
});
