// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 design 5.4 (A6): the row and column handles come up over the
 * layout table's hovered cell and go when the pointer leaves the table,
 * placed by the body's own controller rather than BlockNote's, which reads
 * only its built-in table. The table's own strip comes up whenever the table
 * is hovered, with them or alone (T13, user 2026-10-21).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlockNoteContext } from '@blocknote/react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentTableHandlesController } from '@web/spaces/document/DocumentTableHandlesController';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding a paragraph and a 2 × 2 table, with the controller.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'lead' },
    tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
  ] as never);
  render(
    <BlockNoteContext.Provider value={{ editor, setContentEditableProps: () => undefined } as never}>
      <DocumentTableHandlesController editor={editor as never} />
    </BlockNoteContext.Provider>,
  );
  return editor;
}

/**
 * Moves the pointer over the element holding some words.
 * @param editor - The editor.
 * @param words - The words.
 */
function pointAt(editor: Editor, words: string): void {
  const element = [...editor.prosemirrorView.dom.querySelectorAll('*')].find(
    (el) => el.childElementCount === 0 && el.textContent === words,
  )!;
  act(() => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

describe('the row and column handles over a table', () => {
  it('come up over the cell the pointer is over', () => {
    const editor = open();

    pointAt(editor, 'b1');

    expect(screen.getByTestId('doc-table-row-handle')).toBeTruthy();
    expect(screen.getByTestId('doc-table-col-handle')).toBeTruthy();
  });

  it('go when the pointer leaves the table', async () => {
    const editor = open();
    pointAt(editor, 'b1');

    pointAt(editor, 'lead');

    // The popover fades out from a still copy of what it showed, then goes.
    await waitFor(() => {
      expect(screen.queryByTestId('doc-table-row-handle')).toBeNull();
      expect(screen.queryByTestId('doc-table-col-handle')).toBeNull();
    });
  });
});

describe('the table\'s own strip (T13, user 2026-10-21)', () => {
  it('comes up over a cell, together with the row and column handles', () => {
    const editor = open();

    pointAt(editor, 'b1');

    expect(screen.getByTestId('doc-block-table-handle')).toBeTruthy();
    expect(screen.getByTestId('doc-table-row-handle')).toBeTruthy();
    expect(screen.getByTestId('doc-table-col-handle')).toBeTruthy();
  });

  it('comes up alone with the pointer in the gutter beside the table', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(200, 100, 240, 80);
    view.dom.querySelector('[data-node-type="docTable"]')!.getBoundingClientRect = () => new DOMRect(200, 96, 600, 88);

    act(() => {
      view.dom.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 120 }));
    });

    expect(screen.getByTestId('doc-block-table-handle')).toBeTruthy();
    expect(screen.queryByTestId('doc-table-row-handle')).toBeNull();
    expect(screen.queryByTestId('doc-table-col-handle')).toBeNull();
  });

  it('goes when the pointer leaves the table', async () => {
    const editor = open();
    pointAt(editor, 'b1');

    pointAt(editor, 'lead');

    await waitFor(() => {
      expect(screen.queryByTestId('doc-block-table-handle')).toBeNull();
    });
  });

  it('stands beside the table where it moved to, not where it was', async () => {
    const editor = open();
    editor.insertBlocks([{ type: 'paragraph', content: 'tail' }] as never, editor.document[1]!, 'after');
    const view = editor.prosemirrorView;
    pointAt(editor, 'b1');
    const id = view.dom.querySelector('[data-node-type="docTable"]')!.getAttribute('data-id')!;

    act(() => {
      moveRowTo(view, id, view.state.doc.content.size - 2);
    });
    // The moved table is drawn afresh, far below where it stood.
    view.dom.querySelector('[data-node-type="docTable"]')!.getBoundingClientRect = () => new DOMRect(200, 500, 400, 80);
    act(() => {
      view.dispatch(view.state.tr.insertText('!', 1));
    });

    const carrier = (): HTMLElement => screen.getByTestId('doc-block-table-handle').closest('[data-row-id]')!.parentElement!.parentElement!;
    await waitFor(() => {
      expect(carrier().style.transform).toMatch(/, 500px\)$/);
    });
  });

  it('puts the row and column handles away while its menu is open', async () => {
    const editor = open();
    pointAt(editor, 'b1');

    fireEvent.click(screen.getByTestId('doc-block-table-handle'));

    expect(screen.getByTestId('doc-block-row-delete')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('doc-table-row-handle')).toBeNull();
      expect(screen.queryByTestId('doc-table-col-handle')).toBeNull();
    });
  });
});
