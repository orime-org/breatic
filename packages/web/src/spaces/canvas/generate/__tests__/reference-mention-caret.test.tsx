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
import { CollabUndoSelection } from '@web/spaces/canvas/generate/collab-undo-selection';
import { referenceMentionCaretKey } from '@web/spaces/canvas/generate/reference-mention-caret';
import {
  isStoppable,
  planCascadeDeletion,
  planWhitespaceInsertions,
} from '@web/spaces/canvas/generate/reference-mention-whitespace';
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

  it('after inserting a chip the caret converges to a stoppable position (appendWhitespace ?? normalizeSelection)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .run();
      // Two-pass appendTransaction: spaces are added, then the caret is snapped
      // off any unstoppable landing. End state: invariant satisfied AND the caret
      // rests at a stoppable position (never on a chip side of an owned space).
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(isStoppable(editor.state.doc, editor.state.selection.from)).toBe(true);
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

describe('deletion (handleKeyDown) — D: delete direction always matches chip position', () => {
  it('form ③ `文␣▢␣|` Backspace removes the chip AND both owned spaces (no residue)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      // `x [A] y`; caret after the chip's right space (form ③, stoppable).
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p + 2); // chip␣|y
      expect(editor.state.selection.from).toBe(p + 2); // stoppable — not normalized away
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy'); // both owned spaces gone
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('form ① `文|␣▢` Delete removes the chip AND its owned spaces', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p - 1); // x|␣A (form ①, stoppable)
      expect(editor.state.selection.from).toBe(p - 1);
      expect(keydown(editor, 'Delete')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy');
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('REGRESSION `文␣|▢`: caret is normalized off it, and Backspace no longer deletes the chip', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p); // `x␣|A` — unstoppable
      // normalization snaps the caret left to the form-① position (x|␣A)
      expect(editor.state.selection.from).toBe(p - 1);
      // and Backspace there is native (would delete 'x'), never the chip (reverse-direction gone)
      expect(keydown(editor, 'Backspace')).toBe(false);
      expect(chipPosOf(editor, 'a')).toBeGreaterThan(-1); // chip survives
    } finally {
      editor.destroy();
    }
  });

  it('form ② deleting one of two adjacent chips KEEPS the shared space for the survivor', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent(referenceMentionContent(chipB))
        .run();
      // ` [A][B] `; caret between the chips (A|␣B, form ②, stoppable).
      const pa = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(pa + 1);
      expect(editor.state.selection.from).toBe(pa + 1); // stoppable
      expect(keydown(editor, 'Backspace')).toBe(true); // deletes A leftward
      expect(chipPosOf(editor, 'a')).toBe(-1);
      expect(chipPosOf(editor, 'b')).toBeGreaterThan(-1);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('  '); // ` [B] `
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
      editor.commands.setTextSelection(p + 2);
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

  it('Backspace on a NODE-SELECTED chip (click-to-select) deletes the chip AND its owned spaces (no orphan)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a'); // `x [A] y`
      editor.commands.setNodeSelection(p); // click-to-select → NodeSelection on the chip
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy'); // both owned spaces gone, no orphan
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('Delete on a node-selected chip also deletes the chip unit', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setNodeSelection(p);
      expect(keydown(editor, 'Delete')).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy');
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('Cmd/Ctrl+Backspace on a node-selected chip STILL deletes the chip unit (no orphan; R3)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setNodeSelection(p);
      // A modifier held: the node-selected chip delete must still fire (it precedes
      // the modifier gate) — else native deleteSelection orphans the spaces.
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleKeyDown?.call(
        plugin,
        editor.view,
        new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true }),
      );
      expect(handled).toBe(true);
      expect(editor.state.doc.textContent).toBe('xy');
      expect(chipPosOf(editor, 'a')).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  it('applying planCascadeDeletion for a stale RUN heals the live doc (invariant holds, no orphan double space)', () => {
    const editor = makeEditor();
    try {
      const mk = (id: string, name: string): ReturnType<typeof referenceMentionContent> =>
        referenceMentionContent({
          refId: id,
          sourceNodeId: id,
          sourceNodeType: 'image',
          sourceNodeName: name,
          thumbnail: `${id}.png`,
        });
      editor
        .chain()
        .insertContent(mk('a', 'A'))
        .insertContent(mk('b', 'B'))
        .insertContent(mk('c', 'C'))
        .insertContent(mk('d', 'D'))
        .run();
      // B and C go stale together (adjacent run flanked by surviving A and D)
      const stale = new Set([chipPosOf(editor, 'b'), chipPosOf(editor, 'c')]);
      const ranges = planCascadeDeletion(editor.state.doc, stale);
      const tr = editor.state.tr;
      for (const { from, to } of ranges) tr.delete(from, to); // descending → safe
      editor.view.dispatch(tr);
      // healed end-state: A and D survive, adjacent, sharing exactly ONE space
      expect(chipPosOf(editor, 'b')).toBe(-1);
      expect(chipPosOf(editor, 'c')).toBe(-1);
      expect(chipPosOf(editor, 'd')).toBe(chipPosOf(editor, 'a') + 2);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]); // no unhealed gap
      expect(editor.state.doc.textContent).toBe('   '); // ` [A] [D] ` = 3 spaces, no double
    } finally {
      editor.destroy();
    }
  });

  it('a non-delete key on a node-selected chip is left to native (plugin declines)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setNodeSelection(p);
      expect(keydown(editor, 'ArrowRight')).toBe(false); // arrows on a node-selected chip stay native
    } finally {
      editor.destroy();
    }
  });

  it('Backspace on a node-selected DOUBLE-shared middle chip heals A—C to one shared space', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent(referenceMentionContent(chipB))
        .insertContent(
          referenceMentionContent({
            refId: 'c',
            sourceNodeId: 'c',
            sourceNodeType: 'image',
            sourceNodeName: 'C',
            thumbnail: 'c.png',
          }),
        )
        .run();
      // ` [A][B][C] `; node-select the middle chip B and delete it
      const pb = chipPosOf(editor, 'b');
      editor.commands.setNodeSelection(pb);
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(chipPosOf(editor, 'b')).toBe(-1);
      expect(chipPosOf(editor, 'a')).toBeGreaterThan(-1);
      expect(chipPosOf(editor, 'c')).toBeGreaterThan(-1);
      // A and C now adjacent sharing exactly ONE space (no orphan double space)
      expect(chipPosOf(editor, 'c')).toBe(chipPosOf(editor, 'a') + 2);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('   '); // ` [A] [C] ` = 3 spaces
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

  it('ArrowRight crosses the whole chip `文|␣▢` → `▢␣|文` in one press (form ① → ③)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a'); // `x [A] y`; chip at p
      editor.commands.setTextSelection(p - 1); // x|␣A (form ①)
      expect(keydown(editor, 'ArrowRight')).toBe(true);
      const sel = editor.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.from).toBe(p + 2); // A␣|y (form ③), past the whole chip
    } finally {
      editor.destroy();
    }
  });

  it('ArrowLeft mirrors: `▢␣|文` → `文|␣▢` in one press', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      editor.commands.setTextSelection(p + 2); // A␣|y (form ③)
      expect(keydown(editor, 'ArrowLeft')).toBe(true);
      expect(editor.state.selection.from).toBe(p - 1); // x|␣A (form ①)
    } finally {
      editor.destroy();
    }
  });

  it('ArrowRight stops BETWEEN two adjacent chips (form ②), then past both', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent(referenceMentionContent(chipB))
        .insertContent('y')
        .run();
      const pa = chipPosOf(editor, 'a'); // `x [A][B] y`; A at pa, shared pa+1, B pa+2
      editor.commands.setTextSelection(pa - 1); // x|␣A (form ①)
      expect(keydown(editor, 'ArrowRight')).toBe(true);
      expect(editor.state.selection.from).toBe(pa + 1); // A|␣B (form ②, between the chips)
      expect(keydown(editor, 'ArrowRight')).toBe(true);
      expect(editor.state.selection.from).toBe(pa + 4); // B␣|y (form ③)
    } finally {
      editor.destroy();
    }
  });

  it('ArrowRight in plain text is left to native (plugin declines away from chips)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      editor.commands.setTextSelection(2);
      expect(keydown(editor, 'ArrowRight')).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('normalizes a programmatic caret that lands on an unstoppable position', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a'); // `x [A] y`
      editor.commands.setTextSelection(p); // `x␣|A` — unstoppable
      expect(editor.state.selection.from).toBe(p - 1); // snapped left to x|␣A
      editor.commands.setTextSelection(p + 1); // `A|␣y` — unstoppable
      expect(editor.state.selection.from).toBe(p + 2); // snapped right to A␣|y (nearer)
    } finally {
      editor.destroy();
    }
  });

  it('handleClick snaps a click on an unstoppable position before the chip to the left stoppable', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a'); // `x [A] y`; pos p = x␣|A (unstoppable)
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        p,
        { target: editor.view.dom } as unknown as MouseEvent,
      );
      expect(handled).toBe(true);
      expect(editor.state.selection.from).toBe(p - 1); // snapped to x|␣A
    } finally {
      editor.destroy();
    }
  });

  it('handleClick snaps a click after the chip (A|␣y) to the nearer right stoppable', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        p + 1,
        { target: editor.view.dom } as unknown as MouseEvent,
      );
      expect(handled).toBe(true);
      expect(editor.state.selection.from).toBe(p + 2); // snapped to A␣|y
    } finally {
      editor.destroy();
    }
  });

  it('handleClick declines a click on a stoppable position (leaves native caret)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        p - 1, // x|␣A, stoppable
        { target: editor.view.dom } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('handleClick declines a click ON the chip (keeps default node selection)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      const chipEl = document.createElement('span');
      chipEl.setAttribute('data-reference-mention', '');
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        p, // even at an unstoppable pos, a click on the chip is left to node handling
        { target: chipEl } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('never TAKES OVER the pointer — native drag-selection stays in charge (real spaces everywhere)', () => {
    // Evolution note: the #323-era guard asserted NO mousedown handler at all
    // (the separator-era drag-selection takeover was proven dead and deleted).
    // Item ⑦ (2026-07-14) legitimately added a mousedown handler back with a
    // DIFFERENT contract: it only preventDefault()s to keep the native
    // selection alive when the press lands on a chip INSIDE the selection, and
    // ALWAYS returns false — PM's own pointer handling (and the browser's
    // drag-selection over plain text) is never taken over. This pins that
    // contract instead of the handler's absence.
    const editor = makeEditor();
    try {
      editor.chain().insertContent('plain words ').run();
      editor.chain().insertContent(referenceMentionContent(chipA)).run();
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handler = plugin?.props.handleDOMEvents?.mousedown as
        | ((view: unknown, event: MouseEvent) => boolean)
        | undefined;
      expect(handler).toBeDefined();
      // A press on PLAIN TEXT: not handled, not defaultPrevented — the
      // browser's native drag-selection owns the pointer.
      const textEl = editor.view.dom.querySelector('p') as HTMLElement;
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      Object.defineProperty(down, 'target', { value: textEl });
      expect(handler?.(editor.view, down)).toBe(false);
      expect(down.defaultPrevented).toBe(false);
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
  function makeCollabEditor(ydoc: Y.Doc = new Y.Doc()): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        Collaboration.configure({ fragment: ydoc.getXmlFragment('prompt') }),
        CollabUndoSelection, // same wiring as PromptEditor (undo restores pre-edit selection)
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

  // The cascade-clear + display-sync effects (PromptEditor.tsx) dispatch
  // machine-derived doc changes with setMeta('addToHistory', false) so Cmd+Z never
  // reverts them (batch-4: undo resurrecting an orphan chip / reverting a thumbnail
  // sync). This asserts that MECHANISM at the plugin/editor level; the component
  // effects' own dispatches are exercised behaviourally by PromptEditor.test.tsx and
  // the Cmd+Z keyboard path is a real-machine check (the narrow handle exposes no undo).
  /**
   * The yUndo manager from the live editor (y-prosemirror is a transitive dep,
   * so the plugin is located by its key name instead of an import).
   * @param editor - The collab editor.
   * @returns The Yjs UndoManager.
   */
  function undoManagerOf(editor: Editor): { stopCapturing: () => void } {
    const plugin = editor.state.plugins.find(
      (pl) => (pl as unknown as { key?: string }).key === 'y-undo$',
    );
    const state = plugin?.getState(editor.state) as
      | { undoManager: { stopCapturing: () => void } }
      | undefined;
    if (!state) throw new Error('y-undo plugin not found');
    return state.undoManager;
  }

  it('undo of a chip deletion restores the caret to its PRE-DELETE position (after the restored content)', () => {
    const editor = makeCollabEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a'); // `x [A] y`
      // Separate the upcoming delete into its OWN undo stack item.
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection(p + 2); // form ③: chip␣‸y (pre-delete caret)
      expect(keydown(editor, 'Backspace')).toBe(true);
      expect(chipPosOf(editor, 'a')).toBe(-1);
      editor.commands.undo();
      // Content restored…
      expect(chipPosOf(editor, 'a')).toBe(p);
      // …and the caret returns to where it was BEFORE the delete: AFTER the
      // restored content (standard undo semantics — the real-machine bug put it
      // before the restored content).
      expect(editor.state.selection.from).toBe(p + 2);
    } finally {
      editor.destroy();
    }
  });

  it('undo of a RANGE deletion restores the SELECTION (highlighted range), not a collapsed caret', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('hello').run();
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection({ from: 2, to: 4 }); // select 'el'
      editor.commands.deleteSelection();
      expect(editor.state.doc.textContent).toBe('hlo');
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe('hello');
      // The pre-delete selection was a RANGE — undo restores it as a range.
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(4);
    } finally {
      editor.destroy();
    }
  });

  it('redo returns the caret to its POST-EDIT position (standard redo semantics)', () => {
    const editor = makeCollabEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y')
        .run();
      const p = chipPosOf(editor, 'a');
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection(p + 2);
      expect(keydown(editor, 'Backspace')).toBe(true); // delete the chip unit
      editor.commands.undo(); // chip back, caret at p+2
      editor.commands.redo(); // chip gone again
      expect(chipPosOf(editor, 'a')).toBe(-1);
      // caret back where the user was after the original delete
      expect(editor.state.selection.from).toBe(p - 1);
    } finally {
      editor.destroy();
    }
  });

  it('the undo selection handoff does not linger into later transactions (stale-restore guard)', async () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('hello').run();
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection({ from: 2, to: 4 });
      editor.commands.deleteSelection();
      editor.commands.undo();
      // The upstream late stack-item-popped write is cleared in a microtask —
      // after it, the binding holds no stale selection to force onto the NEXT
      // (e.g. remote) restore transaction.
      await Promise.resolve();
      const sync = editor.state.plugins.find(
        (pl) => (pl as unknown as { key?: string }).key === 'y-sync$',
      );
      const binding = (sync?.getState(editor.state) as {
        binding: { beforeTransactionSelection: unknown };
      }).binding;
      expect(binding.beforeTransactionSelection).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  /**
   * Simulates a ProseMirror drag-move: one transaction deleting [from,to) and
   * inserting the slice at `target` (mapped through the delete), exactly what a
   * drop of an in-editor selection dispatches.
   * @param editor - The editor.
   * @param from - Selection start.
   * @param to - Selection end.
   * @param target - Drop position in the PRE-move doc.
   */
  function dragMove(editor: Editor, from: number, to: number, target: number): void {
    const slice = editor.state.doc.slice(from, to);
    const tr = editor.state.tr.deleteRange(from, to);
    tr.insert(tr.mapping.map(target), slice.content);
    editor.view.dispatch(tr);
  }

  it('undo of a PLAIN-TEXT drag-move restores the original range selection (control)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('hello world').run();
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection({ from: 2, to: 4 }); // 'el'
      dragMove(editor, 2, 4, 8); // move 'el' after the 'w'
      expect(editor.state.doc.textContent).toBe('hlo welorld');
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe('hello world');
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(4);
    } finally {
      editor.destroy();
    }
  });

  it('undo of a CHIP-containing drag-move restores the original range selection (user bug ⑤)', () => {
    const editor = makeCollabEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y and tail')
        .run();
      // `x [A] y and tail`: x[1,2] ␣[2,3] A[3,4] ␣[4,5] y[5,6] …
      undoManagerOf(editor).stopCapturing();
      const p = chipPosOf(editor, 'a');
      const from = p - 1; // x|␣A (form ①)
      const to = p + 2; // A␣|y (form ③) — range covers space+chip+space
      const before = editor.state.doc.textContent;
      editor.commands.setTextSelection({ from, to });
      dragMove(editor, from, to, editor.state.doc.content.size - 2); // move near the end
      expect(chipPosOf(editor, 'a')).toBeGreaterThan(p); // chip moved right
      editor.commands.undo();
      // Doc restored…
      expect(editor.state.doc.textContent).toBe(before);
      expect(chipPosOf(editor, 'a')).toBe(p);
      // …and the ORIGINAL range is selected again, same as the plain-text case.
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to);
    } finally {
      editor.destroy();
    }
  });

  it('undo of a PARTIAL-FLANK chip drag-move (chip + right space only) restores the original range (⑤ variant)', () => {
    const editor = makeCollabEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y and tail')
        .run();
      undoManagerOf(editor).stopCapturing();
      const p = chipPosOf(editor, 'a');
      const from = p; // ␣‸A — range starts AT the chip (left owned space stays behind)
      const to = p + 2; // covers chip + right space
      const before = editor.state.doc.textContent;
      editor.commands.setTextSelection({ from, to });
      dragMove(editor, from, to, editor.state.doc.content.size - 2);
      // The moved chip lacks its LEFT flank at the target → the invariant appends
      // a space in the SAME undo capture group (the interesting difference).
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe(before);
      expect(chipPosOf(editor, 'a')).toBe(p);
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to);
    } finally {
      editor.destroy();
    }
  });

  it('undo of a BARE-chip drag-move (no flanking spaces in the slice) restores the original range (⑤ variant)', () => {
    const editor = makeCollabEditor();
    try {
      editor
        .chain()
        .insertContent('x')
        .insertContent(referenceMentionContent(chipA))
        .insertContent('y and tail')
        .run();
      undoManagerOf(editor).stopCapturing();
      const p = chipPosOf(editor, 'a');
      const before = editor.state.doc.textContent;
      editor.commands.setTextSelection({ from: p, to: p + 1 });
      dragMove(editor, p, p + 1, editor.state.doc.content.size - 2);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe(before);
      expect(chipPosOf(editor, 'a')).toBe(p);
      expect(editor.state.selection.from).toBe(p);
      expect(editor.state.selection.to).toBe(p + 1);
    } finally {
      editor.destroy();
    }
  });

  it('warns in dev when the collab internals cannot be located (silent-no-op guard)', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string): void => {
      warnings.push(String(msg));
    };
    let editor: Editor | null = null;
    try {
      // CollabUndoSelection WITHOUT Collaboration → the y-sync/y-undo plugin
      // keys don't exist, mirroring a duplicate-y-tiptap bundle where the keys
      // mint as 'y-sync$1' and the lookup silently fails.
      editor = new Editor({
        element: document.createElement('div'),
        extensions: [Document, Paragraph, Text, CollabUndoSelection],
      });
      expect(
        warnings.some((w) => w.includes('undo selection restore is INACTIVE')),
      ).toBe(true);
    } finally {
      console.warn = original;
      editor?.destroy();
    }
  });

  it('a REMOTE update after an undo maps the local selection normally (fix never touches remote restores)', async () => {
    const ydoc = new Y.Doc();
    const editor = makeCollabEditor(ydoc);
    try {
      editor.chain().insertContent('hello').run();
      undoManagerOf(editor).stopCapturing();
      editor.commands.setTextSelection({ from: 2, to: 4 });
      editor.commands.deleteSelection();
      editor.commands.undo(); // selection restored to [2,4]
      await Promise.resolve(); // stale handoff cleared
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(4);
      // A collaborator prepends 'AB' at the paragraph start and their update
      // arrives as a REMOTE transaction (origin ≠ this undo manager).
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const para = remote.getXmlFragment('prompt').get(0) as Y.XmlElement;
      const text = para.get(0) as Y.XmlText;
      text.insert(0, 'AB');
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)), 'remote');
      // The local selection maps THROUGH the remote change (shifted by 2) —
      // never teleported to a stale undo handoff.
      expect(editor.state.doc.textContent).toBe('ABhello');
      expect(editor.state.selection.from).toBe(4);
      expect(editor.state.selection.to).toBe(6);
    } finally {
      editor.destroy();
    }
  });

  it('a machine-derived edit (addToHistory:false, like cascade-clear / display-sync) is EXCLUDED from undo', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('U').run(); // user edit → undoable
      // machine-derived edit mirroring the cascade-clear / display-sync dispatches:
      // insert 'M' with addToHistory:false so it is NOT captured into the undo stack.
      editor.view.dispatch(
        editor.state.tr.insertText('M', 2).setMeta('addToHistory', false),
      );
      expect(editor.state.doc.textContent).toBe('UM');
      // Undo reverts the USER 'U' insert and LEAVES the machine 'M' — proving the
      // machine edit was excluded. If it were tracked it would group with 'U' and
      // undo to '' (probe-verified), so asserting 'M' FAILS the moment setMeta is
      // removed = a true-green regression guard, not the earlier false-green ''.
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe('M');
    } finally {
      editor.destroy();
    }
  });
});
