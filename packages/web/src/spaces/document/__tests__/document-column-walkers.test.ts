// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 A7 and design §5.5: numbering, quotes, the outline and the list
 * markers work in columns. A column is a body of its own, as a cell is: its
 * lists count from one, a quote never runs out of it, and its levels count
 * from it. A column group is one block of the body it stands in, so it cuts
 * the list it stands on. The outline takes headings in columns, in reading
 * order (column by column).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';
import { computeNumbering } from '@web/spaces/document/document-numbering';
import { readOutline } from '@web/spaces/document/document-outline';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';
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
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentDecorationsExtension()],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The id of the block whose words are these.
 * @param doc - The document.
 * @param words - The words.
 * @returns The id.
 */
function idOf(doc: PMNode, words: string): string {
  let found: string | undefined;
  doc.descendants((node) => {
    if (found !== undefined) return false;
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) found = String(node.attrs.id);
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no block reads "${words}"`);
  return found;
}

/** A numbered list item. */
const item = (words: string): Record<string, unknown> => ({ type: 'numberedListItem', content: words });

/** A quoted paragraph. */
const quoted = (words: string): Record<string, unknown> => ({ type: 'paragraph', props: { quoted: true }, content: words });

describe('walking a column group', () => {
  it('numbers each column\'s list from one, and restarts the body\'s list after the group', () => {
    const editor = editorWith([
      item('b1'),
      columnsBlock({ blocks: [item('c1'), item('c2')] }, { blocks: [item('d1')] }),
      item('b2'),
    ]);
    const doc = editor.prosemirrorState.doc;
    const numbers = computeNumbering(doc, quoteRuns(doc));
    expect(['b1', 'c1', 'c2', 'd1', 'b2'].map((words) => numbers.get(idOf(doc, words)))).toEqual([
      '1.',
      '1.',
      '2.',
      '1.',
      '1.',
    ]);
  });

  it('keeps a quote inside its column', () => {
    const editor = editorWith([
      quoted('q0'),
      columnsBlock({ blocks: [quoted('q1'), quoted('q2')] }, { blocks: [quoted('q3')] }),
      quoted('q4'),
    ]);
    const doc = editor.prosemirrorState.doc;
    const runs = quoteRuns(doc).map((run) =>
      run.ids.map((id) => {
        let words = '';
        doc.descendants((node) => {
          if (node.attrs['id'] === id) words = node.textContent;
          return words === '';
        });
        return words;
      }),
    );
    expect(runs).toContainEqual(['q1', 'q2']);
    expect(runs).toContainEqual(['q3']);
    expect(runs.some((run) => run.includes('q0') && run.includes('q1'))).toBe(false);
  });

  it('lists headings in columns, column by column', () => {
    const heading = (words: string): Record<string, unknown> => ({ type: 'heading', props: { level: 1 }, content: words });
    const editor = editorWith([
      heading('top'),
      columnsBlock({ blocks: [heading('left'), para('x')] }, { blocks: [heading('right')] }),
    ]);
    expect(readOutline(editor.prosemirrorState.doc).map((entry) => entry.text)).toEqual(['top', 'left', 'right']);
  });

  it('draws a bullet in a column at its first shape and a quote in a column at depth zero', () => {
    const editor = editorWith([
      columnsBlock(
        { blocks: [{ type: 'bulletListItem', content: 'bullet' }] },
        { blocks: [quoted('said')] },
      ),
    ]);
    const root = editor.prosemirrorView.dom;
    const bullet = root.querySelector('[data-content-type="bulletListItem"]');
    expect(bullet?.getAttribute('data-bullet-level')).toBe('0');
    const quote = [...root.querySelectorAll('[data-quoted-run]')].find((element) => element.textContent === 'said');
    expect(quote?.getAttribute('style')).toMatch(/--quote-depth:\s*0;/);
  });
});
