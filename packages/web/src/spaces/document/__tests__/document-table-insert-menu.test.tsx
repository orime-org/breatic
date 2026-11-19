// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1619 T2: the insert menu in a cell is the body's, with the table entry
 * drawn out of reach — a table never goes inside a cell, and an entry that
 * cannot act is greyed, never hidden (`document-unavailable-control.ts`).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const side = vi.hoisted(() => ({
  editor: undefined as unknown,
  block: undefined as unknown,
  menu: {
    freezeMenu: vi.fn(),
    unfreezeMenu: vi.fn(),
    blockDragStart: (): undefined => undefined,
    blockDragEnd: (): undefined => undefined,
  },
}));

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => side.editor,
  useExtension: () => side.menu,
  useExtensionState: () => side.block,
}));

const { DocumentBlockHandle } = await import('@web/spaces/document/DocumentBlockHandle');

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as the block API hands it, as far as these read one. */
interface Seen {
  id: string;
  type: string;
  children: Seen[];
}

/**
 * Opens an editor holding a table whose first cell holds the given blocks,
 * and points the strip at the first of them.
 * @param blocks - The first cell's blocks.
 * @returns The editor.
 */
function openInCell(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [tableBlock({ rows: [{ cells: [{ blocks }, 'b'] }] })] as never);
  side.editor = editor;
  side.block = (editor.document as unknown as Seen[])[0]!.children[0]!.children[0]!.children[0];
  return editor;
}

/**
 * Opens an editor holding the given blocks and points the strip at the first.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function openInBody(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  side.editor = editor;
  side.block = editor.document[0];
  return editor;
}

/**
 * Whether the insert menu's table entry is drawn out of reach.
 * @returns True when it is.
 */
function tableGreyed(): boolean {
  return screen.getByTestId('doc-block-insert-table').getAttribute('aria-disabled') === 'true';
}

describe('the insert menu in a cell', () => {
  it('greys the table entry on the plus of an empty line in a cell', () => {
    openInCell([{ type: 'paragraph' }]);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(tableGreyed()).toBe(true);
    expect(screen.getByTestId('doc-block-insert-divider').getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('doc-block-insert-heading-1').getAttribute('aria-disabled')).toBeNull();
  });

  it('greys the table entry under insert below on a block in a cell', () => {
    openInCell([{ type: 'paragraph', content: 'words' }]);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-handle'));
    fireEvent.click(screen.getByTestId('doc-block-row-insertBelow'));

    expect(tableGreyed()).toBe(true);
  });

  it('keeps the table entry in reach in the body', () => {
    openInBody([{ type: 'paragraph' }]);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(tableGreyed()).toBe(false);
  });
});

describe('the insert menu on a line with blocks under it', () => {
  it('greys the table entry on the plus, since the table would take their place', () => {
    openInBody([
      { type: 'paragraph', children: [{ type: 'paragraph', content: 'child' }] },
      { type: 'paragraph', content: 'after' },
    ]);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(tableGreyed()).toBe(true);
  });
});

describe('a formula picked from the menu (inner#1423 A5)', () => {
  it.each([
    ['the plus of an empty line in a cell', () => openInCell([{ type: 'paragraph' }]), ['doc-block-plus']],
    ['insert below on a block in a cell', () => openInCell([{ type: 'paragraph', content: 'words' }]), ['doc-block-handle', 'doc-block-row-insertBelow']],
    ['the plus of an empty line in the body', () => openInBody([{ type: 'paragraph' }]), ['doc-block-plus']],
  ] as const)('hands the keyboard to its box once the menu closes (%s)', async (_where, openIt, path) => {
    openIt();
    render(<DocumentBlockHandle />);
    for (const id of path) fireEvent.click(screen.getByTestId(id));

    fireEvent.click(screen.getByTestId('doc-block-insert-formula'));

    await vi.waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
      const field = document.querySelector('[data-formula-box] textarea');
      expect(field).not.toBeNull();
      expect(document.activeElement).toBe(field);
    });
  });
});
