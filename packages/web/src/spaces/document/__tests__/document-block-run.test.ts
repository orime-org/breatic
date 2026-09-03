// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A4 · A4b · A6 · C2: what pressing a row does to the blocks under
 * the selection.
 *
 * The rule (§3.2): the block gains the row that was pressed, whatever is
 * mutually exclusive with it goes, whatever is not stays. Pressing a row the
 * block already has is a cancel — except for the five content rows that are
 * not lists, where it is nothing at all.
 *
 * Every case runs on a block indented one level under another, so each of the
 * 56 transitions doubles as a C2 case: changing a block's type never moves it
 * in or out of an indentation level.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  CONTENT_ROWS,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import {
  canRunBlockType,
  runBlockType,
} from '@web/spaces/document/document-block-run';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly ReadBlock[];
}

/** The part of a block these cases judge. */
interface Shape {
  readonly type: string;
  readonly level?: unknown;
  readonly numbered?: unknown;
}

/** The block each content row starts a case from. */
const STARTS: Readonly<Record<BlockTypeId, Record<string, unknown>>> = {
  paragraph: { type: 'paragraph', content: 'x' },
  'heading-1': { type: 'heading', props: { level: 1 }, content: 'x' },
  'heading-2': { type: 'heading', props: { level: 2 }, content: 'x' },
  'heading-3': { type: 'heading', props: { level: 3 }, content: 'x' },
  'bullet-list': { type: 'bulletListItem', content: 'x' },
  'ordered-list': { type: 'numberedListItem', content: 'x' },
  'task-list': { type: 'checkListItem', content: 'x' },
  'code-block': { type: 'codeBlock', content: 'x' },
  quote: { type: 'paragraph', props: { quoted: true }, content: 'x' },
};

/** The heading level each heading row stands for. */
const LEVELS: Readonly<Record<string, number>> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
};

/**
 * The shape a row leaves behind, stated from §3.2 rather than from the code.
 *
 * `numbered` only exists on a heading, so it is only ever asserted there. A
 * heading arrives numbered from an ordered item — that pair coexists — and
 * plain from anything else.
 * @param from - The row the block was.
 * @param to - The row that was pressed.
 * @returns What the block should be afterwards.
 */
function expected(from: BlockTypeId, to: BlockTypeId): Shape {
  const level = LEVELS[to];
  if (level !== undefined) {
    return { type: 'heading', level, numbered: from === 'ordered-list' };
  }
  if (to === 'ordered-list') {
    const fromLevel = LEVELS[from];
    return fromLevel === undefined
      ? { type: 'numberedListItem' }
      : { type: 'heading', level: fromLevel, numbered: true };
  }
  const types: Readonly<Record<string, string>> = {
    paragraph: 'paragraph',
    'bullet-list': 'bulletListItem',
    'task-list': 'checkListItem',
    'code-block': 'codeBlock',
  };
  return { type: types[to]! };
}

/**
 * Opens an editor holding one block with the block under test indented under it.
 * @param inner - The block to indent, which is the one the row acts on.
 * @returns The editor.
 */
function open(
  inner: Record<string, unknown>,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'first', children: [inner] },
  ] as never);
  const inserted = (editor.document as unknown as ReadBlock[])[0]!.children[0]!;
  editor.setTextCursorPosition(inserted.id, 'end');
  return editor;
}

/** The indented block, read back off the document. */
function indented(
  editor: ReturnType<typeof buildDocumentEditor>,
): ReadBlock | undefined {
  const top = editor.document as unknown as ReadBlock[];
  return top[0]?.children[0];
}

/** The shape of the indented block. */
function shapeOf(block: ReadBlock): Shape {
  if (block.type !== 'heading') {
    return { type: block.type };
  }
  return {
    type: block.type,
    level: block.props['level'],
    numbered: block.props['numbered'],
  };
}

describe('A4 · C2 — every transition between two content rows', () => {
  CONTENT_ROWS.forEach((from) => {
    CONTENT_ROWS.filter((to) => to !== from).forEach((to) => {
      it(`turns ${from} into ${to}, leaving it indented`, () => {
        const editor = open(STARTS[from]);
        runBlockType(editor, to);

        const block = indented(editor);
        expect(block).toBeDefined();
        expect(shapeOf(block!)).toEqual(expected(from, to));
        // C2: still the only child of the block above it.
        expect(editor.document).toHaveLength(1);
      });
    });
  });
});

describe('A6 — pressing the row the block already is', () => {
  const QUIET: BlockTypeId[] = [
    'paragraph',
    'heading-1',
    'heading-2',
    'heading-3',
    'code-block',
  ];

  QUIET.forEach((row) => {
    it(`leaves ${row} untouched and dispatches nothing`, () => {
      const editor = open(STARTS[row]);
      const view = editor.prosemirrorView!;
      const before = view.state.doc;
      const dispatch = vi.spyOn(view, 'dispatch');

      runBlockType(editor, row);

      expect(dispatch).not.toHaveBeenCalled();
      expect(view.state.doc).toBe(before);
    });
  });

  const LISTS: BlockTypeId[] = ['bullet-list', 'ordered-list', 'task-list'];

  LISTS.forEach((row) => {
    it(`takes ${row} back off, leaving a paragraph`, () => {
      const editor = open(STARTS[row]);
      runBlockType(editor, row);
      expect(indented(editor)?.type).toBe('paragraph');
    });
  });
});

describe('A4b — the compound start: an ordered item that is also a heading', () => {
  /** A level-one heading carrying a number. */
  const COMPOUND = {
    type: 'heading',
    props: { level: 1, numbered: true },
    content: 'x',
  };

  it('drops the number and keeps the heading when the ordered row is pressed', () => {
    const editor = open(COMPOUND);
    runBlockType(editor, 'ordered-list');
    expect(shapeOf(indented(editor)!)).toEqual({
      type: 'heading',
      level: 1,
      numbered: false,
    });
  });

  it('takes the heading down with it when the bullet row is pressed', () => {
    const editor = open(COMPOUND);
    runBlockType(editor, 'bullet-list');
    expect(indented(editor)?.type).toBe('bulletListItem');
    expect(indented(editor)?.props['numbered']).toBeUndefined();
  });

  it('keeps the number when another heading level is pressed', () => {
    const editor = open(COMPOUND);
    runBlockType(editor, 'heading-3');
    expect(shapeOf(indented(editor)!)).toEqual({
      type: 'heading',
      level: 3,
      numbered: true,
    });
  });

  it('does nothing when its own heading row is pressed', () => {
    const editor = open(COMPOUND);
    const view = editor.prosemirrorView!;
    const dispatch = vi.spyOn(view, 'dispatch');
    runBlockType(editor, 'heading-1');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('the quote row is orthogonal', () => {
  it('puts a quote on a block that has none', () => {
    const editor = open(STARTS.paragraph);
    runBlockType(editor, 'quote');
    expect(indented(editor)?.props['quoted']).toBe(true);
    expect(indented(editor)?.type).toBe('paragraph');
  });

  it('takes the quote off a block that has one', () => {
    const editor = open(STARTS.quote);
    runBlockType(editor, 'quote');
    expect(indented(editor)?.props['quoted']).toBe(false);
  });

  it('leaves the quote on when the block changes type', () => {
    const editor = open(STARTS.quote);
    runBlockType(editor, 'heading-2');
    expect(indented(editor)?.props['quoted']).toBe(true);
    expect(indented(editor)?.props['level']).toBe(2);
  });

  it('quotes a heading without touching what it is', () => {
    const editor = open(STARTS['heading-1']);
    runBlockType(editor, 'quote');
    expect(shapeOf(indented(editor)!)).toEqual({
      type: 'heading',
      level: 1,
      numbered: false,
    });
    expect(indented(editor)?.props['quoted']).toBe(true);
  });
});

describe('a selection covering several blocks', () => {
  /**
   * Opens an editor holding two top-level blocks with the caret across both.
   * @param first - The first block.
   * @param second - The second block.
   * @returns The editor.
   */
  function openPair(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ): ReturnType<typeof buildDocumentEditor> {
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [first, second] as never);
    editor.transact((tr) => {
      tr.setSelection(
        TextSelection.create(tr.doc, 3, tr.doc.content.size - 3),
      );
    });
    return editor;
  }

  it('turns every block in the selection into the pressed row', () => {
    const editor = openPair(
      { type: 'paragraph', content: 'a' },
      { type: 'bulletListItem', content: 'b' },
    );
    runBlockType(editor, 'heading-2');
    const top = editor.document as unknown as ReadBlock[];
    expect(top.map((block) => block.type)).toEqual(['heading', 'heading']);
  });

  it('cancels only when every block in the selection is that row', () => {
    const editor = openPair(
      { type: 'bulletListItem', content: 'a' },
      { type: 'bulletListItem', content: 'b' },
    );
    runBlockType(editor, 'bullet-list');
    const top = editor.document as unknown as ReadBlock[];
    expect(top.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('turns the odd one out into the row rather than cancelling', () => {
    const editor = openPair(
      { type: 'bulletListItem', content: 'a' },
      { type: 'paragraph', content: 'b' },
    );
    runBlockType(editor, 'bullet-list');
    const top = editor.document as unknown as ReadBlock[];
    expect(top.map((block) => block.type)).toEqual([
      'bulletListItem',
      'bulletListItem',
    ]);
  });
});

describe('which rows the menu offers', () => {
  it('offers every row over a selection holding a block', () => {
    const editor = open(STARTS.paragraph);
    expect(canRunBlockType(editor)).toBe(true);
  });

  it('offers none over a block this build cannot represent', () => {
    // A block written by a newer build lands as the atom fallback, which holds
    // no text. Selecting it is the one selection none of the nine rows reach.
    //
    // The transaction is never dispatched: a caret resting on the fallback
    // makes BlockNote's own `SourceBlockWithPreview` throw out of
    // `getTextCursorPosition`, which is #901's ground and not this task's.
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
      extensions: [documentFallbackExtension()],
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);

    const tr = editor.prosemirrorView!.state.tr;
    let at = -1;
    let size = 0;
    tr.doc.descendants((node, pos) => {
      if (at === -1 && node.isTextblock) {
        at = pos;
        size = node.nodeSize;
      }
      return at === -1;
    });
    const fallback = tr.doc.type.schema.nodes['unsupportedBlock']!;
    tr.replaceWith(at, at + size, fallback.create({ originalName: 'x' }));
    tr.setSelection(NodeSelection.create(tr.doc, at));

    expect(canRunBlockType({ transact: (run) => run(tr) })).toBe(false);
  });
});
