// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1097: which button the strip shows, read off the row as the document holds
 * it now (A1, A9).
 *
 * The side menu's own state is stubbed to point at one row and never refresh,
 * which is what the library does while the pointer stays on that row
 * (`SideMenu.ts:229-236`) — so the face has to follow the document, not that
 * snapshot.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const side = vi.hoisted(() => ({
  editor: undefined as unknown,
  block: undefined as unknown,
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

describe('the strip on an empty paragraph (A1)', () => {
  it('shows the plus, which is not draggable', () => {
    openOver([{ type: 'paragraph', content: 'words' }, { type: 'paragraph' }], 1);
    render(<DocumentBlockHandle />);

    const plus = screen.getByTestId('doc-block-plus');
    expect(plus.getAttribute('draggable')).toBeNull();
    expect(screen.queryByTestId('doc-block-handle')).toBeNull();
  });

  it.each([
    ['a paragraph with words', { type: 'paragraph', content: 'words' }],
    ['an empty heading', { type: 'heading', props: { level: 1 } }],
    ['an empty list item', { type: 'bulletListItem' }],
  ])('shows the grip on %s', (_name, block) => {
    openOver([block], 0);
    render(<DocumentBlockHandle />);

    expect(screen.getByTestId('doc-block-handle')).toBeTruthy();
    expect(screen.queryByTestId('doc-block-plus')).toBeNull();
  });

  it('opens the insert entries, not the grip menu', () => {
    openOver([{ type: 'paragraph' }], 0);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(screen.getByTestId('doc-block-insert-heading-1')).toBeTruthy();
    expect(screen.getByTestId('doc-block-insert-divider')).toBeTruthy();
    expect(screen.queryByTestId('doc-block-row-duplicate')).toBeNull();
  });

  it('greys quote on a line already in a quote (A5)', () => {
    openOver([{ type: 'paragraph', props: { quoted: true } }], 0);
    render(<DocumentBlockHandle />);

    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(
      screen.getByTestId('doc-block-insert-quote').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByTestId('doc-block-insert-heading-1').getAttribute('aria-disabled'),
    ).toBeNull();
  });
});

describe('the strip follows the row, not the snapshot (A9)', () => {
  it('turns into the grip once the line has words', () => {
    const editor = openOver([{ type: 'paragraph' }], 0);
    render(<DocumentBlockHandle />);
    expect(screen.getByTestId('doc-block-plus')).toBeTruthy();

    act(() => {
      editor.setTextCursorPosition((editor.document[0] as unknown as { id: string }).id, 'start');
      editor.insertInlineContent('x');
    });

    expect(screen.getByTestId('doc-block-handle')).toBeTruthy();
    expect(screen.queryByTestId('doc-block-plus')).toBeNull();
  });

  it('turns into the plus once the line is emptied', () => {
    const editor = openOver([{ type: 'paragraph', content: 'x' }], 0);
    render(<DocumentBlockHandle />);
    expect(screen.getByTestId('doc-block-handle')).toBeTruthy();

    act(() => {
      editor.updateBlock((editor.document[0] as unknown as { id: string }).id, { content: [] } as never);
    });

    expect(screen.getByTestId('doc-block-plus')).toBeTruthy();
  });
});

describe('the strip keeps its face through what the reader started', () => {
  it('stays the grip through a drag that leaves the row empty, then ends it', () => {
    const editor = openOver([{ type: 'paragraph', content: 'x' }], 0);
    render(<DocumentBlockHandle />);
    const grip = screen.getByTestId('doc-block-handle');

    fireEvent.dragStart(grip);
    act(() => {
      editor.updateBlock((editor.document[0] as unknown as { id: string }).id, { content: [] } as never);
    });
    // Mid-drag the row is empty, but the drag's source has to keep its end.
    expect(screen.getByTestId('doc-block-handle')).toBe(grip);

    fireEvent.dragEnd(grip);
    expect(screen.getByTestId('doc-block-plus')).toBeTruthy();
  });

  it('keeps the menu it opened while the row changes under it', () => {
    const editor = openOver([{ type: 'paragraph', content: 'x' }], 0);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-handle'));
    expect(screen.getByTestId('doc-block-row-duplicate')).toBeTruthy();

    act(() => {
      editor.updateBlock((editor.document[0] as unknown as { id: string }).id, { content: [] } as never);
    });

    expect(screen.getByTestId('doc-block-row-duplicate')).toBeTruthy();
    expect(screen.queryByTestId('doc-block-insert-heading-1')).toBeNull();
  });

  it('greys quote as soon as the open line is quoted (A5)', () => {
    const editor = openOver([{ type: 'paragraph' }], 0);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));
    expect(
      screen.getByTestId('doc-block-insert-quote').getAttribute('aria-disabled'),
    ).toBeNull();

    act(() => {
      editor.updateBlock((editor.document[0] as unknown as { id: string }).id, {
        props: { quoted: true },
      } as never);
    });

    expect(
      screen.getByTestId('doc-block-insert-quote').getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('the plus menu removes the line (A12)', () => {
  it('ends with a delete entry that takes the empty line away', () => {
    const editor = openOver([{ type: 'paragraph', content: 'keep' }, { type: 'paragraph' }], 1);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));

    const remove = screen.getByTestId('doc-block-plus-delete');
    expect(remove.textContent).toBe('spaces.document.blockHandle.delete');
    fireEvent.click(remove);

    expect(editor.document).toHaveLength(1);
  });

  it('greys delete on a document that holds only this line', () => {
    openOver([{ type: 'paragraph' }], 0);
    render(<DocumentBlockHandle />);
    fireEvent.click(screen.getByTestId('doc-block-plus'));

    expect(screen.getByTestId('doc-block-plus-delete').getAttribute('aria-disabled')).toBe('true');
  });
});
