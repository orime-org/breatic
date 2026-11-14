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
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { markdownBlocks } from '@web/spaces/document/document-markdown';

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
