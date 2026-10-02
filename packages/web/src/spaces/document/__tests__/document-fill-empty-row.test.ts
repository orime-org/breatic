// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1097: the plus on an empty paragraph puts the chosen block on that line.
 *
 * Which rows count as empty (A1), what each choice turns the line into in
 * place (A3, A4), that a quoted line stays quoted (A5), that the caret ends up
 * in the line wherever it was before (A3, A4), that one undo takes it all back
 * (A6).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  fillEmptyRow,
  isEmptyParagraph,
  type InsertChoice,
} from '@web/spaces/document/document-insert-row';
import type { PressedBlock } from '@web/spaces/document/document-handle-commands';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
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
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
  });
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
 * The document as `type:text` entries, with `>` marking a quoted block.
 * @param editor - The editor.
 * @returns One entry per top-level block.
 */
function shape(editor: Editor): string[] {
  return (editor.document as Seen[]).map(
    (b) =>
      `${b.props.quoted === true ? '>' : ''}${b.type}:${(b.content ?? [])
        .map((c) => c.text ?? '')
        .join('')}`,
  );
}

/**
 * The block at this index, as the document holds it now.
 * @param editor - The editor.
 * @param index - Its top-level index.
 * @returns The block.
 */
function rowAt(editor: Editor, index: number): PressedBlock {
  return editor.document[index] as unknown as PressedBlock;
}

/** A line with words, an empty line, a line with words. */
const AROUND_EMPTY = [
  { type: 'paragraph', content: 'Above' },
  { type: 'paragraph' },
  { type: 'paragraph', content: 'Below' },
];

describe('which rows are an empty paragraph (A1)', () => {
  it.each([
    ['an empty paragraph', { type: 'paragraph' }, true],
    ['an empty quoted paragraph', { type: 'paragraph', props: { quoted: true } }, true],
    ['a paragraph with words', { type: 'paragraph', content: 'x' }, false],
    ['an empty heading', { type: 'heading', props: { level: 2 } }, false],
    ['an empty list item', { type: 'bulletListItem' }, false],
    ['an empty code block', { type: 'codeBlock' }, false],
    ['a divider', { type: 'divider' }, false],
  ])('%s', (_name, block, expected) => {
    const { editor } = open([block]);
    expect(isEmptyParagraph(rowAt(editor, 0))).toBe(expected);
  });

  it('answers false for a row that is gone', () => {
    expect(isEmptyParagraph(undefined)).toBe(false);
  });
});

describe('a block type lands on the line itself (A3)', () => {
  it.each<[InsertChoice, string]>([
    ['heading-1', 'heading:'],
    ['heading-2', 'heading:'],
    ['heading-3', 'heading:'],
    ['code-block', 'codeBlock:'],
    ['bullet-list', 'bulletListItem:'],
    ['task-list', 'checkListItem:'],
    ['ordered-list', 'numberedListItem:'],
    ['quote', '>paragraph:'],
  ])('%s turns the line into %s, keeping its id and adding no row', (choice, made) => {
    const { editor } = open(AROUND_EMPTY);
    const line = rowAt(editor, 1);

    fillEmptyRow(editor, line, choice);

    expect(shape(editor)).toEqual(['paragraph:Above', made, 'paragraph:Below']);
    expect(rowAt(editor, 1).id).toBe(line.id);
  });

  it('gives a heading the level that was picked', () => {
    const { editor } = open(AROUND_EMPTY);
    fillEmptyRow(editor, rowAt(editor, 1), 'heading-3');
    expect(rowAt(editor, 1).props?.level).toBe(3);
  });

  it('puts the caret in the line even when it was in another row', () => {
    const { editor } = open(AROUND_EMPTY);
    editor.setTextCursorPosition(rowAt(editor, 0).id, 'end');

    fillEmptyRow(editor, rowAt(editor, 1), 'heading-1');

    expect((editor.getTextCursorPosition().block as unknown as Seen).id).toBe(rowAt(editor, 1).id);
  });
});

describe('the divider goes above the line (A4)', () => {
  it('leaves the line an empty paragraph under a divider, caret in it', () => {
    const { editor } = open(AROUND_EMPTY);
    const line = rowAt(editor, 1);
    editor.setTextCursorPosition(rowAt(editor, 0).id, 'end');

    fillEmptyRow(editor, line, 'divider');

    expect(shape(editor)).toEqual([
      'paragraph:Above',
      'divider:',
      'paragraph:',
      'paragraph:Below',
    ]);
    expect(rowAt(editor, 2).id).toBe(line.id);
    expect((editor.getTextCursorPosition().block as unknown as Seen).id).toBe(line.id);
  });
});

describe('a quoted line stays quoted (A5)', () => {
  it('keeps the quote on the block it becomes', () => {
    const { editor } = open([{ type: 'paragraph', props: { quoted: true } }]);
    fillEmptyRow(editor, rowAt(editor, 0), 'bullet-list');
    expect(shape(editor)).toEqual(['>bulletListItem:']);
  });

  it('quotes the divider it puts above', () => {
    const { editor } = open([{ type: 'paragraph', props: { quoted: true } }]);
    fillEmptyRow(editor, rowAt(editor, 0), 'divider');
    expect(shape(editor)).toEqual(['>divider:', '>paragraph:']);
  });
});

describe('one undo takes it back (A6)', () => {
  it.each<InsertChoice>(['heading-1', 'quote', 'task-list', 'divider'])('%s', (choice) => {
    const { editor, manager } = open(AROUND_EMPTY);

    fillEmptyRow(editor, rowAt(editor, 1), choice);
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:Above', 'paragraph:', 'paragraph:Below']);
  });
});

describe('one pick, one transaction', () => {
  // Y.UndoManager merges edits that land close together, so the undo case
  // above stays green even when the pick is split; counting what reaches the
  // view is what pins it down.
  it.each<InsertChoice>(['heading-1', 'quote', 'divider'])('%s dispatches once', (choice) => {
    const { editor } = open(AROUND_EMPTY);
    editor.setTextCursorPosition(rowAt(editor, 0).id, 'end');
    const view = editor.prosemirrorView!;
    let dispatches = 0;
    const original = view.dispatch.bind(view);
    vi.spyOn(view, 'dispatch').mockImplementation((tr) => {
      dispatches += 1;
      original(tr);
    });

    fillEmptyRow(editor, rowAt(editor, 1), choice);

    expect(dispatches).toBe(1);
  });
});
