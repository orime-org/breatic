// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design 5.1 and 6.6: what a copy in the body puts on the
 * clipboard when the selection holds formulas.
 *
 * The plain text is Markdown written by BlockNote's `htmlToMarkdown`, patched
 * so an inline formula is `$$source$$`; a block formula is `$$` on its own
 * lines. A selection inside an inline formula's source is source: BlockNote's
 * "wholly in code" check is patched to read `$from.parent.type.spec.code`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

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

/**
 * Fires a copy and reads what it put on the clipboard.
 * @param editor - The editor.
 * @returns The clipboard, by format.
 */
function copy(editor: Editor): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      clearData: () => {
        Object.keys(data).forEach((key) => delete data[key]);
      },
      getData: (format: string) => data[format] ?? '',
    },
  });
  editor.prosemirrorView.dom.dispatchEvent(event);
  return data;
}

/**
 * Starts a drag of the selection the way the browser does, and reads the
 * plain text it carries.
 * @param editor - The editor.
 * @returns The plain text.
 */
function dragText(editor: Editor): string {
  const data: Record<string, string> = {};
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: [],
      effectAllowed: '',
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      clearData: () => {
        Object.keys(data).forEach((key) => delete data[key]);
      },
      setDragImage: (): void => undefined,
    },
  });
  editor.prosemirrorView.dom.dispatchEvent(event);
  return data['text/plain'] ?? '';
}

describe('copying a selection that holds formulas', () => {
  it('writes an inline formula into the plain text as $$source$$', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a^2' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    expect(copy(editor)['text/plain']?.trim()).toBe('x $$a^2$$ y');
  });

  it('writes a multi-line inline formula into the plain text on one line, without its comments', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a % c\nb' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    expect(copy(editor)['text/plain']?.trim()).toBe('x $$a b$$ y');
  });

  it('writes two formulas side by side into the plain text so they read back as two', async () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);

    const [read] = await markdownBlocks(copy(editor)['text/plain'] ?? '');

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
    expect(copy(editor)['text/plain']?.trim()).toBe(plain);
  });

  it('parts two formulas side by side in a table cell with a space in the plain text', () => {
    const cell = { blocks: [{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }] };
    const editor = open([tableBlock({ rows: [{ cells: [cell as never, 'other'] }] })]);
    const paragraph = before(editor, 'paragraph');
    const size = editor.prosemirrorState.doc.nodeAt(paragraph)!.content.size;
    select(editor, paragraph + 1, paragraph + 1 + size);
    const plain = copy(editor)['text/plain'] ?? '';
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
    const plain = copy(editor)['text/plain'] ?? '';
    expect(plain).toContain('$$a$$ $$b$$');
    expect(plain).not.toContain('<!--');
  });

  it('parts two formulas side by side with a space in the plain text a block drag carries', () => {
    const editor = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }, { type: 'math', props: { source: 'b' } }, ' y'] }]);
    const data: Record<string, string> = {};
    const transfer = { clearData: (): void => undefined, setData: (format: string, value: string): void => { data[format] = value; }, setDragImage: (): void => undefined, effectAllowed: '' };
    const sideMenu = (editor as unknown as { getExtension: (name: string) => { blockDragStart: (event: unknown, block: unknown) => void } }).getExtension('sideMenu');
    sideMenu.blockDragStart({ dataTransfer: transfer }, editor.document[0]);
    expect(data['text/plain']?.trim()).toBe('x $$a$$ $$b$$ y');
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
    const dragged = dragText(editor);
    expect(dragged).toBe(copy(editor)['text/plain']);
  });

  it('leaves the plain text of a serialising outside a drag to Tiptap', () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'mathBlock', props: { source: 'x' } }, { type: 'paragraph', content: 'tail' }]);
    select(editor, before(editor, 'paragraph') + 1, editor.prosemirrorState.doc.content.size - 3);
    const view = editor.prosemirrorView;
    expect(view.serializeForClipboard(view.state.selection.content()).text).not.toBe(copy(editor)['text/plain']);
  });

  it('leaves the selection alone when a selected block is serialised', () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'mathBlock', props: { source: 'x' } }]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, before(editor, 'mathBlock'))));
    const selected = view.state.selection;
    view.serializeForClipboard(selected.content());
    expect(view.state.selection.eq(selected)).toBe(true);
  });

  it('writes a block formula into the plain text as $$ on lines of their own', () => {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'mathBlock', props: { source: '\\int x' } },
      { type: 'paragraph', content: 'tail' },
    ]);
    const { doc } = editor.prosemirrorState;
    select(editor, before(editor, 'paragraph') + 1, doc.content.size - 3);
    expect(copy(editor)['text/plain']).toContain('$$\n\\int x\n$$');
  });

});
