// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 A1, design §6.4: the insert menu's formula entry and what it puts
 * into the document.
 *
 * The plus menu and the insert-below submenu draw the same
 * `DocumentInsertChoices`, so one rendering pins the row's place in both: it
 * sits under the table and columns, above the media entries. Picking it on an empty line turns that line into
 * an empty formula block; picking it under a row adds one below. Either is
 * one undo step, like the table.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentInsertChoices } from '@web/spaces/document/DocumentInsertChoices';
import type { PressedBlock } from '@web/spaces/document/document-handle-commands';
import { fillEmptyRow, insertBelow, type InsertChoice } from '@web/spaces/document/document-insert-row';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { sourceOf } from '@web/spaces/document/__tests__/math-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

/** A block as this file reads it. */
interface Seen {
  readonly id: string;
  readonly type: string;
  readonly content?: unknown;
}

/** The menu's pick for a formula, which `InsertChoice` gains with it. */
const FORMULA = 'formula' as unknown as InsertChoice;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * The insert menu, open.
 * @param onPick - What picking a non-media entry does.
 * @param withMedia - Whether the media entries are drawn.
 */
function openMenu(onPick: (choice: InsertChoice) => void, withMedia: boolean): void {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DocumentInsertChoices onPick={onPick} onPickMedia={withMedia ? vi.fn() : undefined} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

/**
 * The test ids of the menu's rows, top to bottom.
 * @returns The ids.
 */
function rowIds(): (string | null)[] {
  return screen.getAllByRole('menuitem').map((item) => item.getAttribute('data-testid'));
}

/**
 * Opens a focused editor holding the given blocks, with undo tracking on.
 * @param blocks - What the document starts with.
 * @returns The editor and its undo manager.
 */
function open(blocks: unknown[]): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.stopCapturing();
  editor.prosemirrorView!.focus();
  return { editor, manager };
}

/**
 * The document's blocks as `type` entries.
 * @param editor - The editor.
 * @returns One entry per top-level block.
 */
function types(editor: Editor): string[] {
  return (editor.document as unknown as Seen[]).map((block) => block.type);
}

/**
 * The block at this index.
 * @param editor - The editor.
 * @param index - Its top-level index.
 * @returns The block.
 */
function rowAt(editor: Editor, index: number): PressedBlock {
  return editor.document[index] as unknown as PressedBlock;
}

const AROUND_EMPTY = [
  { type: 'paragraph', content: 'Above' },
  { type: 'paragraph' },
  { type: 'paragraph', content: 'Below' },
];

describe('the formula entry in the insert menu', () => {
  it.each([true, false])('sits right under the table and columns (media entries drawn: %s)', (withMedia) => {
    openMenu(vi.fn(), withMedia);
    const ids = rowIds();
    // Columns follow the table (inner#1314); the formula comes next.
    expect(ids.slice(ids.indexOf('doc-block-insert-table'), ids.indexOf('doc-block-insert-table') + 3)).toEqual([
      'doc-block-insert-table',
      'doc-block-insert-columns',
      'doc-block-insert-formula',
    ]);
  });

  it('picks the formula', () => {
    const onPick = vi.fn();
    openMenu(onPick, true);
    fireEvent.click(screen.getByTestId('doc-block-insert-formula'));
    expect(onPick).toHaveBeenCalledWith('formula');
  });
});

describe('picking the formula', () => {
  it('turns the empty line into an empty formula block, keeping its id', () => {
    const { editor } = open(AROUND_EMPTY);
    const line = rowAt(editor, 1);

    fillEmptyRow(editor, line, FORMULA);

    expect(types(editor)).toEqual(['paragraph', 'mathBlock', 'paragraph']);
    expect(rowAt(editor, 1).id).toBe(line.id);
    expect(sourceOf(editor.document[1])).toBe('');
  });

  it('adds an empty formula block under the row', () => {
    const { editor } = open([{ type: 'paragraph', content: 'Above' }]);

    insertBelow(editor, rowAt(editor, 0), FORMULA);

    expect(types(editor)[1]).toBe('mathBlock');
  });

  it.each([
    ['on an empty line', (editor: Editor) => fillEmptyRow(editor, rowAt(editor, 1), FORMULA), 1],
    ['under a row', (editor: Editor) => insertBelow(editor, rowAt(editor, 0), FORMULA), 1],
  ])('names the new formula, whose box the menu opens once it closes (%s)', (_where, pick, index) => {
    const { editor } = open(AROUND_EMPTY);

    const made = pick(editor);

    expect(made).toBe(rowAt(editor, index).id);
    expect(types(editor)[index]).toBe('mathBlock');
  });

  it('names nothing for a pick that is not a formula', () => {
    const { editor } = open(AROUND_EMPTY);

    expect(fillEmptyRow(editor, rowAt(editor, 1), 'divider' as unknown as InsertChoice)).toBeUndefined();
    expect(insertBelow(editor, rowAt(editor, 0), 'divider' as unknown as InsertChoice)).toBeUndefined();
  });

  it('is taken back by one undo on an empty line', () => {
    const { editor, manager } = open(AROUND_EMPTY);

    fillEmptyRow(editor, rowAt(editor, 1), FORMULA);
    expect(types(editor)).toEqual(['paragraph', 'mathBlock', 'paragraph']);
    manager.undo();

    expect(types(editor)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('is taken back by one undo under a row', () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'Above' }]);

    insertBelow(editor, rowAt(editor, 0), FORMULA);
    expect(types(editor)).toContain('mathBlock');
    manager.undo();

    expect(types(editor)).toEqual(['paragraph']);
  });
});
