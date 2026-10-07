// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the document hands the agent's attachment tray (inner#936): a text
 * item holding the selection or the block as Markdown, named after its first
 * line.
 */

import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { selectedFragmentToHTML } from '@blocknote/core';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockItem, selectionItem } from '@web/spaces/document/document-to-agent';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens a mounted editor holding the blocks given.
 * @param blocks - The document.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The id of the block at an index.
 * @param editor - The editor.
 * @param index - Which block.
 * @returns Its id.
 */
function idAt(editor: Editor, index: number): string {
  return (editor.document as unknown as Array<{ id: string }>)[index]!.id;
}

/**
 * Selects the words between two characters of the whole document's text.
 * @param editor - The editor.
 * @param needle - The words to select; the first occurrence is used.
 */
function selectWords(editor: Editor, needle: string): void {
  const view = editor.prosemirrorView!;
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText) {
      const at = (node.text ?? '').indexOf(needle);
      if (at >= 0) from = pos + at;
    }
    return true;
  });
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + needle.length)),
  );
}

describe('selectionItem', () => {
  it('holds the selected blocks as Markdown in a ready text item', () => {
    const editor = open([
      { type: 'paragraph', content: [{ type: 'text', text: 'bold words', styles: { bold: true } }] },
      { type: 'paragraph', content: 'plain' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(1), view.state.doc.resolve(view.state.doc.content.size - 1))),
    );

    const item = selectionItem(editor);

    expect(item.type).toBe('text');
    expect(item.status).toBe('ready');
    expect(item.chip?.type).toBe('text');
    expect(item.chip?.data_snapshot).toEqual({ text: '**bold words**\n\nplain' });
    expect(item.name).toBe('bold words');
  });

  it('keeps the styles of words inside one block', () => {
    const editor = open([
      { type: 'paragraph', content: [{ type: 'text', text: 'bold words', styles: { bold: true } }] },
    ]);
    selectWords(editor, 'bold words');

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({ text: '**bold words**' });
  });

  it('gives the raw lines of a code block, as copy does', () => {
    const editor = open([{ type: 'codeBlock', content: 'a = 1\nb = 2' }]);
    selectWords(editor, 'a = 1');
    const view = editor.prosemirrorView!;
    const { $from } = view.state.selection;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, $from.start(), $from.end()),
      ),
    );

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({ text: 'a = 1\nb = 2' });
  });

  it('keeps a line break inside one block as a Markdown hard break', () => {
    const editor = open([{ type: 'paragraph', content: 'line one\nline two' }]);
    selectWords(editor, 'line one');
    const view = editor.prosemirrorView!;
    const { $from } = view.state.selection;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, $from.start(), $from.end()),
      ),
    );

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({ text: 'line one\\\nline two' });
  });

  it('keeps a link inside one block in its line', () => {
    const editor = open([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          { type: 'link', href: 'https://example.com', content: 'link' },
          { type: 'text', text: ' here', styles: {} },
        ],
      },
    ]);
    const view = editor.prosemirrorView!;
    selectWords(editor, 'see');
    const { $from } = view.state.selection;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, $from.start(), $from.end()),
      ),
    );

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({
      text: 'see [link](https://example.com) here',
    });
  });

  it('names the item after the first line and cuts it at 40 characters', () => {
    const long = 'a'.repeat(60);
    const editor = open([
      { type: 'paragraph', content: long },
      { type: 'paragraph', content: 'second line' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(1), view.state.doc.resolve(view.state.doc.content.size - 1))),
    );

    expect(selectionItem(editor).name).toBe('a'.repeat(40));
  });

  it('gives the same id to the same words selected twice', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha bravo' }]);
    selectWords(editor, 'alpha');
    const first = selectionItem(editor).id;
    selectWords(editor, 'alpha');

    expect(selectionItem(editor).id).toBe(first);
    expect(first.startsWith('document-selection-')).toBe(true);
  });

  it('gives different words a different id', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha bravo' }]);
    selectWords(editor, 'alpha');
    const first = selectionItem(editor).id;
    selectWords(editor, 'bravo');

    expect(selectionItem(editor).id).not.toBe(first);
  });
});

describe('selectionItem over table cells', () => {
  /**
   * Opens a two-by-two table holding a, b, c and d, with the cells' positions.
   * @returns The editor and its cells, in document order.
   */
  function openGrid(): { editor: Editor; cells: number[] } {
    const editor = open([
      {
        type: 'table',
        content: { type: 'tableContent', rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] },
      },
    ]);
    const cells: number[] = [];
    editor.prosemirrorView!.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') cells.push(pos);
      return true;
    });
    return { editor, cells };
  }

  it('names the item after the first cell whichever way the cells were dragged', () => {
    const { editor, cells } = openGrid();
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[3]!)));
    expect(selectionItem(editor).name).toBe('a');

    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[3]!, cells[0]!)));
    expect(selectionItem(editor).name).toBe('a');
  });
});

describe('selectionItem over the whole document', () => {
  it('gives what copy gives', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'Title' },
      { type: 'paragraph', content: [{ type: 'text', text: 'body', styles: { bold: true } }] },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    expect(selectionItem(editor).chip?.data_snapshot).toEqual({
      text: selectedFragmentToHTML(view, editor).markdown.trimEnd(),
    });
  });
});

describe('blockItem', () => {
  it('holds the block and its children as Markdown', () => {
    const editor = open([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [{ type: 'bulletListItem', content: 'child' }],
      },
    ]);

    const text = (blockItem(editor, idAt(editor, 0)).chip?.data_snapshot as { text: string }).text;

    expect(text).toContain('parent');
    expect(text).toContain('child');
  });

  it('is named after the first line of the block and keyed by the block id', () => {
    const editor = open([{ type: 'heading', props: { level: 2 }, content: 'Section title' }]);
    const id = idAt(editor, 0);

    const item = blockItem(editor, id);

    expect(item.id).toBe(`document-block-${id}`);
    expect(item.name).toBe('Section title');
    expect((item.chip?.data_snapshot as { text: string }).text).toBe('## Section title');
  });

  it('keeps the same id after the block is edited, so adding it again replaces the item', () => {
    const editor = open([{ type: 'paragraph', content: 'before' }]);
    const id = idAt(editor, 0);
    const first = blockItem(editor, id);
    editor.updateBlock(id, { content: 'after' } as never);

    const second = blockItem(editor, id);

    expect(second.id).toBe(first.id);
    expect((second.chip?.data_snapshot as { text: string }).text).toBe('after');
  });

  it('takes the name of a table from its cells', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: ['', 'cell text'] }],
        },
      },
    ]);

    expect(blockItem(editor, idAt(editor, 0)).name).toBe('cell text');
  });
});
