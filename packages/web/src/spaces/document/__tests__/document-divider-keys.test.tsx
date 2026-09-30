// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124: what the keys do around a divider, and what the block commands do to
 * it.
 *
 * A4 — a selected divider goes with Backspace or Delete, and undo brings it
 * back. A5 — typing on a selected divider, by key or through an input method,
 * changes nothing; Enter opens a line under it. A7 — Backspace at the head of
 * the line below and Delete at the end of the line above take the divider in
 * one press. A8 — the block handle menu on a divider row offers only what can
 * act on it. A10 — quoting a range takes the dividers in it along; a fallback
 * block has no quote to write and is left alone.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { tickedOver } from '@web/spaces/document/document-block-ticks';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import type {
  HandleEditor,
  PressedBlock,
} from '@web/spaces/document/document-handle-commands';

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
  // Y.UndoManager groups by a capture timeout a test outruns.
  manager.stopCapturing();
  editor.prosemirrorView!.focus();
  return { editor, manager };
}

/** Above, a divider, Below. */
const SANDWICH = [
  { type: 'paragraph', content: 'Above' },
  { type: 'divider' },
  { type: 'paragraph', content: 'Below' },
];

/**
 * The document as `type:text` entries.
 * @param editor - The editor.
 * @returns One entry per top-level block.
 */
function shape(editor: Editor): string[] {
  return (editor.document as Seen[]).map(
    (b) => `${b.type}:${(b.content ?? []).map((c) => c.text ?? '').join('')}`,
  );
}

/**
 * Where the first node of this type starts.
 * @param editor - The editor.
 * @param name - The node type.
 * @returns Its position.
 */
function posOf(editor: Editor, name: string): number {
  let at = -1;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (node.type.name === name) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * Node-selects the first node of this type.
 * @param editor - The editor.
 * @param name - The node type.
 */
function select(editor: Editor, name = 'divider'): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(NodeSelection.create(view.state.doc, posOf(editor, name))),
  );
}

/**
 * Whether the selection is a node selection over the first divider.
 * @param editor - The editor.
 * @returns True when it is.
 */
function dividerSelected(editor: Editor): boolean {
  const { selection } = editor.prosemirrorView!.state;
  return (
    selection instanceof NodeSelection &&
    selection.node.type.name === 'divider' &&
    selection.from === posOf(editor, 'divider')
  );
}

/**
 * Presses a key through the editor's own key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @returns Whether a handler took it.
 */
function press(editor: Editor, key: string): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/**
 * Puts the caret at one end of the block holding this text.
 * @param editor - The editor.
 * @param text - The block's text.
 * @param where - Which end.
 */
function caretIn(editor: Editor, text: string, where: 'start' | 'end'): void {
  const block = (editor.document as Seen[]).find(
    (b) => (b.content ?? []).map((c) => c.text ?? '').join('') === text,
  )!;
  editor.setTextCursorPosition(block.id, where);
}

describe('a selected divider and the delete keys (A4)', () => {
  it.each(['Backspace', 'Delete'])('%s takes it away and undo brings it back', (key) => {
    const { editor, manager } = open(SANDWICH);
    select(editor);

    press(editor, key);
    expect(shape(editor)).toEqual(['paragraph:Above', 'paragraph:Below']);

    manager.undo();
    expect(shape(editor)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
  });
});

describe('typing on a selected divider (A5)', () => {
  it('a character key changes neither the document nor the selection', () => {
    const { editor } = open(SANDWICH);
    select(editor);

    expect(press(editor, 'x')).toBe(true);

    expect(shape(editor)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
    expect(dividerSelected(editor)).toBe(true);
  });

  it('Enter opens an empty line under it, and the next keystroke writes there', () => {
    const { editor } = open(SANDWICH);
    select(editor);

    press(editor, 'Enter');
    const view = editor.prosemirrorView!;
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.insertText('y', from));

    expect(shape(editor)).toEqual([
      'paragraph:Above',
      'divider:',
      'paragraph:y',
      'paragraph:Below',
    ]);
  });

  it('Enter on a quoted divider opens a quoted line', () => {
    const { editor } = open([
      { type: 'paragraph', props: { quoted: true }, content: 'Above' },
      { type: 'divider', props: { quoted: true } },
    ]);
    select(editor);

    press(editor, 'Enter');

    const opened = (editor.document as Seen[])[2]!;
    expect(opened.type).toBe('paragraph');
    expect(opened.props['quoted']).toBe(true);
  });
});

describe('an input method on a selected divider (A5)', () => {
  /**
   * Starts a composition the way a browser does: the event first, then the
   * browser moving its selection into the nearest text before ProseMirror
   * hears of it (design §5.9, reading b).
   * @param editor - The editor.
   */
  function startComposition(editor: Editor): void {
    const view = editor.prosemirrorView!;
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const aboveEnd = posOf(editor, 'divider') - 3;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, aboveEnd)));
  }

  /**
   * Ends the composition and waits for the restore that follows it.
   * @param editor - The editor.
   */
  async function endComposition(editor: Editor): Promise<void> {
    editor.prosemirrorView!.dom.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '你' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('writes nothing, during or after, and gives the selection back', async () => {
    const { editor, manager } = open(SANDWICH);
    select(editor);
    const undoDepth = manager.undoStack.length;

    startComposition(editor);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('ni', view.state.selection.from));
    expect(shape(editor)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);

    await endComposition(editor);

    expect(shape(editor)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
    expect(dividerSelected(editor)).toBe(true);
    expect(manager.undoStack.length).toBe(undoDepth);
  });

  it('lets a co-editor’s change through and keeps hold of the divider it moved', async () => {
    const { editor } = open(SANDWICH);
    select(editor);

    startComposition(editor);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.insertText('New ', 3).setMeta(ySyncPluginKey, { isChangeOrigin: true }),
    );
    expect(shape(editor)).toEqual(['paragraph:New Above', 'divider:', 'paragraph:Below']);

    await endComposition(editor);

    expect(dividerSelected(editor)).toBe(true);
  });

  it('leaves a composition in text alone', async () => {
    const { editor } = open(SANDWICH);
    caretIn(editor, 'Above', 'end');

    const view = editor.prosemirrorView!;
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch(view.state.tr.insertText('你', view.state.selection.from));
    await endComposition(editor);

    expect(shape(editor)).toEqual(['paragraph:Above你', 'divider:', 'paragraph:Below']);
  });
});

describe('the delete keys from the lines beside a divider (A7)', () => {
  it('Backspace at the head of the line below takes the divider in one press', () => {
    const { editor, manager } = open(SANDWICH);
    caretIn(editor, 'Below', 'start');

    press(editor, 'Backspace');
    expect(shape(editor)).toEqual(['paragraph:Above', 'paragraph:Below']);

    manager.undo();
    expect(shape(editor)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
  });

  it('Delete at the end of the line above takes the divider in one press', () => {
    const { editor } = open(SANDWICH);
    caretIn(editor, 'Above', 'end');

    press(editor, 'Delete');

    expect(shape(editor)).toEqual(['paragraph:Above', 'paragraph:Below']);
  });
});

describe('quoting a range with a divider in it (A10)', () => {
  /**
   * The `quoted` prop of each top-level block.
   * @param editor - The editor.
   * @returns One entry per block.
   */
  function quotes(editor: Editor): unknown[] {
    return (editor.document as Seen[]).map((b) => b.props['quoted']);
  }

  it('quotes the divider with the words around it and takes the quote off again', () => {
    const { editor } = open(SANDWICH);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    runBlockType(editor, 'quote');
    expect(quotes(editor)).toEqual([true, true, true]);

    runBlockType(editor, 'quote');
    expect(quotes(editor)).toEqual([false, false, false]);
  });

  it('quotes a divider selected on its own', () => {
    const { editor } = open(SANDWICH);
    select(editor);

    runBlockType(editor, 'quote');

    expect(quotes(editor)).toEqual([false, true, false]);
  });

  it('leaves a fallback block in the range untouched, and still takes the quote off', () => {
    // A fallback stands in for an element a newer build wrote; it has no
    // `quoted` to write, and counting it would keep the quote from ever
    // ticking over this range.
    const { editor } = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'unsupportedBlock', props: { originalName: 'future' } },
      { type: 'paragraph', content: 'Below' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    runBlockType(editor, 'quote');
    expect(quotes(editor)).toEqual([true, undefined, true]);

    runBlockType(editor, 'quote');
    expect(quotes(editor)).toEqual([false, undefined, false]);
    expect((editor.document as Seen[])[1]!.props['originalName']).toBe('future');
  });

  it('ticks the quote only when the divider in the range is quoted too', () => {
    const { editor } = open([
      { type: 'paragraph', props: { quoted: true }, content: 'Above' },
      { type: 'divider' },
      { type: 'paragraph', props: { quoted: true }, content: 'Below' },
    ]);
    const { doc } = editor.prosemirrorView!.state;

    expect(tickedOver(doc, new AllSelection(doc)).has('quote')).toBe(false);
  });

  it('leaves the other rows reading the words only', () => {
    const { editor } = open([
      { type: 'heading', props: { level: 1 }, content: 'One' },
      { type: 'divider' },
      { type: 'heading', props: { level: 1 }, content: 'Two' },
    ]);
    const { doc } = editor.prosemirrorView!.state;

    expect(tickedOver(doc, new AllSelection(doc)).has('heading-1')).toBe(true);
  });
});

describe('the block handle on a divider row (A8)', () => {
  it('acts on the divider itself', () => {
    const { editor } = open(SANDWICH);
    const divider = (editor.document as Seen[])[1]!;
    const over = selectionOverBlockContent(editor.prosemirrorView!.state.doc, divider.id);

    expect(over instanceof NodeSelection && over.node.type.name).toBe('divider');
  });

  it('quotes the divider from Block type → Quote', () => {
    const { editor } = open(SANDWICH);
    const divider = (editor.document as Seen[])[1]!;

    runBlockType(editor, 'quote', divider.id);

    expect((editor.document as Seen[])[1]!.props['quoted']).toBe(true);
  });

  /**
   * Opens the handle menu over the divider.
   * @param editor - The editor.
   */
  function openMenuOverDivider(editor: Editor): void {
    const block = (editor.document as Seen[])[1]!;
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger />
        <DropdownMenuContent>
          <DocumentBlockMenu
            editor={editor as unknown as HandleEditor}
            block={block as unknown as PressedBlock}
            close={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  }

  /**
   * Whether an entry is drawn as out of reach.
   * @param testId - The entry.
   * @returns True when it carries `aria-disabled`.
   */
  function greyed(testId: string): boolean {
    return screen.getByTestId(testId).getAttribute('aria-disabled') === 'true';
  }

  it('greys alignment, colour and comment, and leaves the rest', () => {
    const { editor } = open(SANDWICH);
    openMenuOverDivider(editor);

    ['align', 'color', 'comment'].forEach((id) => {
      expect(greyed(`doc-block-row-${id}`)).toBe(true);
    });
    ['blockType', 'duplicate', 'insertBelow', 'delete'].forEach((id) => {
      expect(greyed(`doc-block-row-${id}`)).toBe(false);
    });
  });

  it('offers only Quote in the block type submenu', () => {
    const { editor } = open(SANDWICH);
    openMenuOverDivider(editor);

    fireEvent.click(screen.getByTestId('doc-block-row-blockType'));

    const rows = [
      'paragraph',
      'heading-1',
      'heading-2',
      'heading-3',
      'code-block',
      'bullet-list',
      'task-list',
      'ordered-list',
    ];
    rows.forEach((id) => {
      expect(greyed(`doc-block-type-${id}`)).toBe(true);
    });
    expect(greyed('doc-block-type-quote')).toBe(false);
  });
});
