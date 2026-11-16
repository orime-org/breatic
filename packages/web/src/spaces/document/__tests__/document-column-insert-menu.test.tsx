// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1314 A14 and design §5.3: the insert menu's "Columns" entry puts two
 * columns, each one empty paragraph, with the caret in the first. It is
 * greyed in a column, on a row in a list's nested group and on a row with
 * children; it is in reach in a cell.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
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
 * Opens an editor holding the blocks and points the strip at one of them.
 * @param blocks - The blocks.
 * @param pick - Picks the pressed block from the document.
 * @returns The editor.
 */
function open(blocks: unknown[], pick: (doc: Seen[]) => Seen): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  side.editor = editor;
  side.block = pick(editor.document as unknown as Seen[]);
  return editor;
}

/**
 * Whether the columns entry is drawn out of reach.
 * @returns True when it is.
 */
function columnsGreyed(): boolean {
  return screen.getByTestId('doc-block-insert-columns').getAttribute('aria-disabled') === 'true';
}

describe('the insert menu\'s columns entry', () => {
  it('turns the empty line the plus is on into two columns, the caret in the first', () => {
    const editor = open([para('lead'), para('')], (doc) => doc[1]!);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));
    expect(columnsGreyed()).toBe(false);
    fireEvent.click(screen.getByTestId('doc-block-insert-columns'));
    expect(shapeOf(editor.document as never)).toEqual(['lead', '[¶|¶]']);
    const { $head } = editor.prosemirrorState.selection;
    expect($head.node($head.depth - 2).type.name).toBe('docColumn');
    expect($head.index($head.depth - 3)).toBe(0);
  });

  it('puts two columns and a line to carry on under the pressed row', () => {
    const editor = open([para('lead'), para('tail')], (doc) => doc[0]!);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-handle'));
    fireEvent.click(screen.getByTestId('doc-block-row-insertBelow'));
    fireEvent.click(screen.getByTestId('doc-block-insert-columns'));
    expect(shapeOf(editor.document as never)).toEqual(['lead', '[¶|¶]', '¶', 'tail']);
  });

  it('is greyed in a column', () => {
    open([columnsBlock([''], ['b'])], (doc) => doc[0]!.children[0]!.children[0]!);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));
    expect(columnsGreyed()).toBe(true);
  });

  it('is greyed on a row in a list\'s nested group', () => {
    open(
      [{ type: 'bulletListItem', content: 'parent', children: [{ type: 'paragraph' }] }],
      (doc) => doc[0]!.children[0]!,
    );
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));
    expect(columnsGreyed()).toBe(true);
  });

  it('is greyed on a row with children', () => {
    open(
      [{ type: 'bulletListItem', content: 'parent', children: [{ type: 'bulletListItem', content: 'child' }] }],
      (doc) => doc[0]!,
    );
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-handle'));
    fireEvent.click(screen.getByTestId('doc-block-row-insertBelow'));
    expect(columnsGreyed()).toBe(true);
  });

  it('is in reach on an empty line in a cell', () => {
    open(
      [tableBlock({ rows: [{ cells: [{ blocks: [para('')] }, 'b'] }] })],
      (doc) => doc[0]!.children[0]!.children[0]!.children[0]!,
    );
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));
    expect(columnsGreyed()).toBe(false);
  });
});
