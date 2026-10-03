// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A5: the strip on a table — the table entry, its menu, and the
 * indent rows greyed where the table cannot go.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const side = vi.hoisted(() => ({
  editor: undefined,
  block: undefined,
}));

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => side.editor,
  useExtension: () => ({
    freezeMenu: () => undefined,
    unfreezeMenu: () => undefined,
    blockDragStart: () => undefined,
    blockDragEnd: () => undefined,
  }),
  useExtensionState: () => side.block,
}));

const { DocumentBlockHandle } = await import(
  '@web/spaces/document/DocumentBlockHandle'
);


const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A 2 × 2 table block. */
const TABLE = {
  type: 'table',
  content: { type: 'tableContent', rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] },
};

/**
 * Opens an editor holding the given blocks and points the strip at one row.
 * @param blocks - What the document starts with.
 * @param index - The row the pointer is over.
 * @returns The editor.
 */
function openOver(blocks: unknown[], index: number): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  side.editor = editor;
  side.block = editor.document[index];
  return editor;
}

/**
 * The menu's rows, in order.
 * @returns Their ids.
 */
function rows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="doc-block-row-"]')).map((el) =>
    el.getAttribute('data-testid')!.replace('doc-block-row-', ''),
  );
}

describe('the strip on a table (A5)', () => {
  it('shows the table entry, which drags', () => {
    openOver([{ type: 'paragraph', content: 'above' }, TABLE], 1);
    render(<DocumentBlockHandle />);

    const entry = screen.getByTestId('doc-block-table-handle');
    expect(entry.getAttribute('draggable')).toBe('true');
    expect(screen.queryByTestId('doc-block-handle')).toBeNull();
    expect(screen.queryByTestId('doc-block-plus')).toBeNull();
  });

  it('opens the six table rows', () => {
    openOver([{ type: 'paragraph', content: 'above' }, TABLE], 1);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-table-handle'));

    expect(rows()).toEqual(['insertBelow', 'duplicate', 'indent', 'unindent', 'comment', 'delete']);
    expect(screen.getByTestId('doc-block-row-delete').textContent).toBe('Delete table');
  });

  it('greys indent on a first table and outdent at the top level', () => {
    openOver([TABLE, { type: 'paragraph', content: 'below' }], 0);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-table-handle'));

    expect(screen.getByTestId('doc-block-row-indent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-unindent').getAttribute('aria-disabled')).toBe('true');
  });

  it('indents the table under the block above', () => {
    const editor = openOver([{ type: 'paragraph', content: 'above' }, TABLE], 1);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-table-handle'));

    const indent = screen.getByTestId('doc-block-row-indent');
    expect(indent.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(indent);

    const top = editor.document as unknown as { type: string; children: { type: string }[] }[];
    expect(top.map((b) => b.type)).toEqual(['paragraph']);
    expect(top[0].children.map((b) => b.type)).toEqual(['table']);
  });

  it('keeps the grip menu as it was on every other row', () => {
    openOver([{ type: 'paragraph', content: 'words' }], 0);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-handle'));

    expect(rows()).toEqual(['blockType', 'duplicate', 'insertBelow', 'align', 'color', 'comment', 'delete']);
  });
});
