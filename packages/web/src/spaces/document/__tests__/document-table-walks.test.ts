// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 design 5.3 and 5.7: the walks over the body's blocks reach into a
 * table's cells, each cell read as a body of its own. The table is one block
 * of the body it stands in.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';
import { computeNumbering } from '@web/spaces/document/document-numbering';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding the given blocks.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
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
 * The words of the block a block id names, or `table` for the table.
 * @param editor - The editor.
 * @returns Id to words.
 */
function wordsById(editor: Editor): Map<string, string> {
  const out = new Map<string, string>();
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'docTable') out.set(String(node.attrs['id']), 'table');
    if (node.type.name === 'blockContainer') out.set(String(node.attrs['id']), node.firstChild!.textContent);
    return true;
  });
  return out;
}

const quoted = (words: string): unknown => ({ type: 'paragraph', content: words, props: { quoted: true } });

describe('the walks over the body reach into cells', () => {
  it('reads a quoted table as one block of the quote around it, and a quote in a cell as a quote of its own', () => {
    const editor = open([
      quoted('above'),
      tableBlock({ rows: [{ cells: [{ blocks: [quoted('in one'), quoted('in two')] }, 'b'] }] }, { quoted: true }),
      quoted('below'),
    ]);
    const words = wordsById(editor);

    const runs = quoteRuns(editor.prosemirrorState.doc).map((run) => run.ids.map((id) => words.get(id)));

    expect(runs).toContainEqual(['above', 'table', 'below']);
    expect(runs).toContainEqual(['in one', 'in two']);
    expect(runs).toHaveLength(2);
  });

  it('numbers a list in a cell from one, apart from a list around the table', () => {
    const item = (words: string): unknown => ({ type: 'numberedListItem', content: words });
    const editor = open([
      item('one'),
      item('two'),
      tableBlock({ rows: [{ cells: [{ blocks: [item('first'), item('second')] }] }] }),
      item('after'),
    ]);
    const words = wordsById(editor);
    const doc = editor.prosemirrorState.doc;

    const numbers = computeNumbering(doc, quoteRuns(doc));
    const shown = new Map([...numbers].map(([id, number]) => [words.get(id), number]));

    expect(shown.get('one')).toBe('1.');
    expect(shown.get('first')).toBe('1.');
    expect(shown.get('second')).toBe('2.');
    expect(shown.get('after')).toBe('1.');
  });

  it('draws the rule of a quote at the top of a cell at no indent, and the rule of a quoted table on the table', () => {
    open([
      tableBlock({ rows: [{ cells: [{ blocks: [quoted('in')] }, 'b'] }] }, { quoted: true }),
    ]);

    const inCell = document.querySelector<HTMLElement>('td [data-quoted-run]');
    expect(inCell?.style.getPropertyValue('--quote-depth')).toBe('0');
    const frame = document.querySelector<HTMLElement>('[data-node-type="docTable"]');
    expect(frame?.hasAttribute('data-quoted-run')).toBe(true);
    expect(frame?.style.getPropertyValue('--quote-depth')).toBe('0');
  });
});
