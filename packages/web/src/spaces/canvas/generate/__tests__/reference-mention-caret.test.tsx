// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Editor } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import { referenceMentionCaretKey } from '@web/spaces/canvas/generate/reference-mention-caret';
import { planWhitespaceInsertions } from '@web/spaces/canvas/generate/reference-mention-whitespace';
import {
  ReferenceMention,
  referenceMentionContent,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const chipA: ReferenceRailItem = {
  refId: 'a->me',
  sourceNodeId: 'a',
  sourceNodeType: 'image',
  sourceNodeName: 'A',
  thumbnail: 'a.png',
};
const chipB: ReferenceRailItem = {
  refId: 'b->me',
  sourceNodeId: 'b',
  sourceNodeType: 'image',
  sourceNodeName: 'B',
  thumbnail: 'b.png',
};

/**
 * Mounts a bare editor carrying the ReferenceMention extension (which installs
 * the chip whitespace/caret plugin, so appendTransaction + handleKeyDown run).
 * @returns The editor (caller destroys).
 */
function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: 'No references',
        }),
      }),
    ],
  });
}

/**
 * Finds a chip's start position by its source id.
 * @param editor - The editor.
 * @param sourceNodeId - The chip's source node id.
 * @returns The chip's doc position, or -1.
 */
function chipPosOf(editor: Editor, sourceNodeId: string): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (
      n.type.name === REFERENCE_MENTION_NODE &&
      n.attrs.sourceNodeId === sourceNodeId
    ) {
      found = pos;
    }
  });
  return found;
}

/**
 * Dispatches a keydown through the caret plugin's handleKeyDown.
 * @param editor - The editor.
 * @param key - The key name.
 * @returns Whether the plugin handled it.
 */
function keydown(editor: Editor, key: string): boolean {
  const plugin = referenceMentionCaretKey.get(editor.state);
  return (
    plugin?.props.handleKeyDown?.call(
      plugin,
      editor.view,
      new KeyboardEvent('keydown', { key }),
    ) ?? false
  );
}

describe('whitespace invariant (appendTransaction) — every chip gets flanking spaces', () => {
  it('inserting a single chip auto-adds a space on each side (invariant satisfied)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      // No further insertions needed: the invariant is already met.
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      // ` [chip] ` → two spaces (the chip contributes no text).
      expect(editor.state.doc.textContent).toBe('  ');
    } finally {
      editor.destroy();
    }
  });

  it('two adjacent chips share exactly ONE space between them', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent(referenceMentionContent(chipB))
        .run();
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      // A at p, shared space at p+1, B at p+2 → exactly one space between.
      expect(chipPosOf(editor, 'b')).toBe(chipPosOf(editor, 'a') + 2);
      // ` [A] [B] ` → three spaces total (leading, shared, trailing).
      expect(editor.state.doc.textContent).toBe('   ');
    } finally {
      editor.destroy();
    }
  });

  it('does not touch plain text (no chip → no spaces added)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('hello');
    } finally {
      editor.destroy();
    }
  });

  it('keeps a chip flanked when typing text right after it', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      // `x [A] y` → 'x' + ' ' + ' ' + 'y'
      expect(editor.state.doc.textContent).toBe('x  y');
    } finally {
      editor.destroy();
    }
  });
});

describe('deletion unit (handleKeyDown) — chip + owned spaces delete as one', () => {
  it('Backspace on a chip between text removes the chip AND both owned spaces (no residue)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p + 1); // right after the chip
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy'); // both owned spaces gone
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('Backspace on the left owned space still deletes the chip unit (never "un-deletable")', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p); // between left space and the chip
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy');
    } finally {
      editor.destroy();
    }
  });

  it('deleting one of two adjacent chips KEEPS the shared space for the survivor', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent(referenceMentionContent(chipB))
        .run();
      const pb = chipPosOf(editor, 'b');
      editor.commands.setTextSelection(pb + 1); // right after B
      expect(keydown(editor, 'Backspace')).toBe(true);
      // B gone; A survives still flanked by spaces (invariant holds, no re-add churn).
      expect(chipPosOf(editor, 'b')).toBe(-1);
      expect(chipPosOf(editor, 'a')).toBeGreaterThan(-1);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('  '); // ` [A] `
    } finally {
      editor.destroy();
    }
  });

  it('Backspace in plain text is left to native deletion (plugin declines)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      editor.commands.setTextSelection(3);
      expect(keydown(editor, 'Backspace')).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('declines a delete with a modifier held (Cmd/Ctrl+Backspace stays native)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p + 1);
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleKeyDown?.call(
        plugin,
        editor.view,
        new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true }),
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

describe('reference-mention caret plugin — wiring + retained interactions', () => {
  it('is installed by the ReferenceMention extension', () => {
    const editor = makeEditor();
    try {
      expect(referenceMentionCaretKey.get(editor.state)).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('one-press ArrowRight crosses a chip atom in a single press (P5, retained)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p); // before the chip
      expect(keydown(editor, 'ArrowRight')).toBe(true);
      const sel = editor.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.from).toBe(p + 1); // past the chip in one press
    } finally {
      editor.destroy();
    }
  });

  it('mousedown takeover declines when a modifier is held', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleDOMEvents?.mousedown?.call(
        plugin,
        editor.view,
        {
          button: 0,
          shiftKey: true,
          target: editor.view.dom,
          preventDefault: (): void => {},
        } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('mousedown takeover declines a press ON a chip (keeps default node-selection)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      const chipEl = document.createElement('span');
      chipEl.setAttribute('data-reference-mention', '');
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleDOMEvents?.mousedown?.call(
        plugin,
        editor.view,
        {
          button: 0,
          target: chipEl,
          preventDefault: (): void => {},
        } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('mousedown takeover declines a non-left button', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleDOMEvents?.mousedown?.call(
        plugin,
        editor.view,
        {
          button: 2,
          target: editor.view.dom,
          preventDefault: (): void => {},
        } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

// Undo is a critical path (Yjs collab). The invariant space is appended in the
// same tick as the user's chip insertion, so yUndo groups them into one step —
// undoing the insertion must remove the chip AND its appended spaces, leaving no
// orphan space (design 2026-07-13 §9; appendTransaction is NOT history-excluded).
describe('undo — a chip and its invariant spaces undo together (Yjs yUndo)', () => {
  /**
   * Mounts a collaborative editor; Collaboration provides yUndo history.
   * @returns The editor (caller destroys).
   */
  function makeCollabEditor(): Editor {
    const ydoc = new Y.Doc();
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        Collaboration.configure({ fragment: ydoc.getXmlFragment('prompt') }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({
            getPool: () => [],
            emptyLabel: 'No references',
          }),
        }),
      ],
    });
  }

  it('undo after inserting a chip removes the chip AND its flanking spaces (no orphan)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      expect(chipPosOf(editor, 'a')).toBeGreaterThan(-1);
      expect(editor.state.doc.textContent).toBe('  '); // chip flanked by spaces
      editor.commands.undo();
      expect(chipPosOf(editor, 'a')).toBe(-1); // chip gone
      expect(editor.state.doc.textContent).toBe(''); // spaces gone too — no orphan
    } finally {
      editor.destroy();
    }
  });
});
