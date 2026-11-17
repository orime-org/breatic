// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which insert entries are out of reach on a row (inner#1125 A7, design 5.2).
 *
 * One function answers for the plus menu (`fill`), the handle's insert-below
 * submenu (`below`) and the slash menu (either, by what the row holds).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { insertReach } from '@web/spaces/document/document-insert-entries';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

function editorWith(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (found !== undefined) return false;
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs.id);
      return false;
    }
    return true;
  });
  if (found === undefined) throw new Error(`no block reads "${words}"`);
  return found;
}

function reach(editor: Editor, words: string, mode: 'fill' | 'below'): string[] {
  return [...insertReach(editor.prosemirrorState.doc, idOf(editor, words), mode)].sort();
}

describe('insert entries out of reach', () => {
  it('leaves everything in reach on a plain body row', () => {
    const editor = editorWith([para('plain')]);
    expect(reach(editor, 'plain', 'fill')).toEqual([]);
    expect(reach(editor, 'plain', 'below')).toEqual([]);
  });

  it('greys the table in a table cell, both ways', () => {
    const editor = editorWith([tableBlock({ rows: [{ cells: ['cell', 'b'] }] })]);
    expect(reach(editor, 'cell', 'fill')).toContain('table');
    expect(reach(editor, 'cell', 'below')).toContain('table');
  });

  it('greys the table filling a row that has blocks nested under it', () => {
    const editor = editorWith([{ ...para(''), children: [para('child one'), para('child two')] }, para('after')]);
    expect(reach(editor, '', 'fill')).toContain('table');
    expect(reach(editor, '', 'below')).not.toContain('table');
  });

  it('greys columns inside a column, both ways', () => {
    const editor = editorWith([columnsBlock(['left'], ['right'])]);
    expect(reach(editor, 'left', 'fill')).toContain('columns');
    expect(reach(editor, 'left', 'below')).toContain('columns');
  });

  it('greys quote in a quote only when the row itself turns into the pick', () => {
    const editor = editorWith([{ type: 'paragraph', content: 'quoted', props: { quoted: true } }]);
    expect(reach(editor, 'quoted', 'fill')).toContain('quote');
    // Insert below keeps today's behaviour: the new row inherits the quote,
    // and picking Quote gives a quoted row (document-block-run.ts).
    expect(reach(editor, 'quoted', 'below')).not.toContain('quote');
  });
});
