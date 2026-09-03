// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A11: a whole-document selection asks before it is deleted.
 *
 * The reason is that the undo stack lives in this tab's memory only. A
 * keystroke that empties the document is one nobody else can put back, and the
 * client that pressed it loses the stack the moment the tab closes — so on
 * that one tier the key asks instead of deleting.
 *
 * Two channels reach the deletion, and both funnel into the same guard: the
 * chords tiptap's own keymap binds (which is still underneath BlockNote), and
 * `beforeinput`, which is how a browser's Edit menu deletes without ever
 * firing a keydown.
 *
 * The zero-block cases the tiptap build carried are gone: BlockNote's schema
 * is `doc > blockGroup > blockGroupChild+` (`BlockGroup.ts:11`), so a document
 * with no blocks cannot exist. Clearing therefore leaves one empty paragraph.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  clearDocument,
  DELETE_CHORDS_BASE,
  DELETE_CHORDS_MAC,
  documentSelectAllExtension,
} from '@web/spaces/document/document-select-all-guard';

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
}

/**
 * Opens an editor holding three paragraphs.
 * @param ask - What to call instead of deleting the whole document.
 * @returns The editor.
 */
function open(
  ask: (() => void) | null = null,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentSelectAllExtension(ask)],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha' },
    { type: 'paragraph', content: 'beta' },
    { type: 'paragraph', content: 'gamma' },
  ] as never);
  return editor;
}

/** How many top-level blocks the document holds. */
function blockCount(editor: ReturnType<typeof buildDocumentEditor>): number {
  return (editor.document as unknown as ReadBlock[]).length;
}

/**
 * Presses one chord through the keymap.
 * @param editor - The editor to press it in.
 * @param chord - The chord in ProseMirror's own notation, such as `Mod-Backspace`.
 * @returns Whether a handler claimed the key.
 */
function press(
  editor: ReturnType<typeof buildDocumentEditor>,
  chord: string,
): boolean {
  const parts = chord.split('-');
  const key = parts[parts.length - 1]!;
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', {
    key,
    // jsdom reports a platform that is not a Mac, so `Mod` binds to Ctrl.
    ctrlKey: parts.includes('Mod') || parts.includes('Ctrl'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'),
    bubbles: true,
    cancelable: true,
  });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/** Selects the whole document. */
function selectAll(editor: ReturnType<typeof buildDocumentEditor>): void {
  editor.transact((tr) => {
    tr.setSelection(new AllSelection(tr.doc));
  });
}

/** Puts the caret inside the first block's text. */
function caretInFirst(editor: ReturnType<typeof buildDocumentEditor>): void {
  editor.transact((tr) => {
    tr.setSelection(TextSelection.create(tr.doc, 3));
  });
}

/**
 * Fires a `beforeinput` of the given type at the view.
 * @param editor - The editor.
 * @param inputType - The event's inputType.
 * @returns Whether the handler cancelled it.
 */
function beforeInput(
  editor: ReturnType<typeof buildDocumentEditor>,
  inputType: string,
): boolean {
  const view = editor.prosemirrorView!;
  const event = new InputEvent('beforeinput', {
    inputType,
    bubbles: true,
    cancelable: true,
  });
  view.someProp('handleDOMEvents', (handlers) =>
    handlers['beforeinput']?.(view, event),
  );
  return event.defaultPrevented;
}

describe('A11 — the delete chords on a whole-document selection', () => {
  DELETE_CHORDS_BASE.forEach((chord) => {
    it(`asks instead of deleting on ${chord}`, () => {
      const ask = vi.fn();
      const editor = open(ask);
      selectAll(editor);

      expect(press(editor, chord)).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(blockCount(editor)).toBe(3);
    });
  });

  it('swallows the key when the host wired no confirmation', () => {
    // Absence of a handler must not mean deletion.
    const editor = open(null);
    selectAll(editor);
    expect(press(editor, 'Backspace')).toBe(true);
    expect(blockCount(editor)).toBe(3);
  });

  it('leaves a selection inside one block to the stock handler', () => {
    const ask = vi.fn();
    const editor = open(ask);
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, 3, 7));
    });

    press(editor, 'Backspace');
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.stringify(editor.document)).not.toContain('alpha');
  });
});

describe('A11 — the chords only an Apple platform binds', () => {
  // The chord table is split by platform when the extension is built, so the
  // platform has to read as a Mac before the editor is opened.
  let restore: (() => void) | null = null;

  beforeEach(() => {
    const original = Object.getOwnPropertyDescriptor(
      window.navigator,
      'platform',
    );
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    restore = (): void => {
      if (original) {
        Object.defineProperty(window.navigator, 'platform', original);
      } else {
        Reflect.deleteProperty(window.navigator, 'platform');
      }
    };
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  DELETE_CHORDS_MAC.forEach((chord) => {
    it(`asks instead of deleting on ${chord}`, () => {
      const ask = vi.fn();
      const editor = open(ask);
      selectAll(editor);

      expect(press(editor, chord)).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(blockCount(editor)).toBe(3);
    });
  });
});

describe('A11 — the other door: beforeinput', () => {
  it('asks on a bare deletion', () => {
    const ask = vi.fn();
    const editor = open(ask);
    selectAll(editor);

    expect(beforeInput(editor, 'deleteContentBackward')).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(blockCount(editor)).toBe(3);
  });

  it('lets a cut through, which states its own intent', () => {
    const ask = vi.fn();
    const editor = open(ask);
    selectAll(editor);

    expect(beforeInput(editor, 'deleteByCut')).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lets an insertion through', () => {
    const ask = vi.fn();
    const editor = open(ask);
    selectAll(editor);

    expect(beforeInput(editor, 'insertText')).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('Mod-a selects in two tiers', () => {
  it('takes the block the caret is in first', () => {
    const editor = open();
    caretInFirst(editor);
    expect(press(editor, 'Mod-a')).toBe(true);

    const { selection } = editor.prosemirrorView!.state;
    expect(selection instanceof AllSelection).toBe(false);
    expect(selection.from).toBe(3);
    expect(selection.to).toBe(8);
  });

  it('takes the whole document on the second press', () => {
    const editor = open();
    caretInFirst(editor);
    press(editor, 'Mod-a');
    press(editor, 'Mod-a');

    expect(editor.prosemirrorView!.state.selection).toBeInstanceOf(
      AllSelection,
    );
  });

  it('goes straight to the whole document from a selection crossing blocks', () => {
    const editor = open();
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, 3, 12));
    });
    press(editor, 'Mod-a');

    expect(editor.prosemirrorView!.state.selection).toBeInstanceOf(
      AllSelection,
    );
  });

  it('stays at the top tier once it is there', () => {
    const editor = open();
    selectAll(editor);
    press(editor, 'Mod-a');

    expect(editor.prosemirrorView!.state.selection).toBeInstanceOf(
      AllSelection,
    );
  });
});

describe('clearing the document', () => {
  it('leaves one empty paragraph, which the schema requires', () => {
    const editor = open();
    expect(clearDocument(editor)).toBe(true);

    const blocks = editor.document as unknown as ReadBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(JSON.stringify(blocks)).not.toContain('alpha');
  });

  it('writes nothing on an editor the client may not write to', () => {
    // The dialog can outlive a demotion to viewer, and confirming would
    // otherwise wipe locally while the server drops the update.
    const editor = open();
    editor.isEditable = false;

    expect(clearDocument(editor)).toBe(false);
    expect(blockCount(editor)).toBe(3);
  });
});

describe('a selection the document cannot hold is put right', () => {
  it('moves a caret resolved outside any block to the nearest one', () => {
    const editor = open();
    editor.transact((tr) => {
      // Position 0 is the document boundary, outside every text block.
      tr.setSelection(TextSelection.create(tr.doc, 0, 0));
    });

    const { selection } = editor.prosemirrorView!.state;
    expect(selection.$from.parent.isTextblock).toBe(true);
  });
});
