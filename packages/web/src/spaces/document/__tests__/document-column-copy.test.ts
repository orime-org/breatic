// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 A9, A11 and design §5.5: what leaves the document from a column
 * group.
 *
 * - Plain text and Markdown read the columns in reading order, column by
 *   column; external HTML lays the columns' blocks out flat, so a reader of
 *   the clipboard (Canvas pasting pictures) finds them at the top level.
 * - A selection inside one column copies that column's blocks without the
 *   group around them, so it pastes like words copied in the body.
 * - The Agent reads a group as one block, which a Markdown rewrite turns
 *   into plain blocks: it is lossy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { tableClippedBlocks } from '@web/spaces/document/document-table-copy';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function editorWith(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where some text starts.
 * @param doc - The document.
 * @param text - The text.
 * @returns The position of its first character.
 */
function posOf(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text) === true) found = pos + node.text.indexOf(text);
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}

const image = (url: string): Record<string, unknown> => ({ type: 'image', props: { url } });

describe('what leaves the document from a column group', () => {
  it('writes Markdown column by column, in reading order', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c']), para('tail')]);
    expect(blocksMarkdown(editor as never, editor.document as never)).toBe('lead\n\na\n\nb\n\nc\n\ntail');
  });

  it('lays the columns\' blocks out flat in external HTML', () => {
    const editor = editorWith([
      columnsBlock({ blocks: [image('https://example.com/a.png')] }, { blocks: [image('https://example.com/b.png')] }),
    ]);
    const html = editor.blocksToHTMLLossy(editor.document as never);
    expect(html).not.toContain('doc-column');
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const tops = [...body.children].map((child) => child.tagName);
    expect(tops.filter((tag) => tag === 'IMG' || tag === 'FIGURE')).toHaveLength(2);
  });

  it('copies words inside one column without the group around them', () => {
    const editor = editorWith([columnsBlock(['alpha', 'beta'], ['gamma'])]);
    const view = editor.prosemirrorView;
    const from = posOf(view.state.doc, 'pha');
    const to = posOf(view.state.doc, 'be') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const clipped = tableClippedBlocks(view);
    expect(clipped?.blocks.map((block: { type: string }) => block.type)).toEqual(['paragraph', 'paragraph']);
    expect(clipped?.slice?.content.firstChild?.type.name).toBe('blockGroup');
  });

  it('reads a group as one lossy block for the Agent', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a'], ['b'])]);
    const read = readTopBlocks(editor as never, new Set());
    const group = read.find((block) => block.type === 'docColumnList');
    expect(group?.markdown).toBe('a\n\nb');
    expect(group?.lossy).toBe(true);
    expect(read.find((block) => block.type === 'paragraph')?.lossy).toBe(false);
  });
});
