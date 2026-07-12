// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';

import {
  caretBlindPos,
  isTrailingCaretBlind,
  referenceMentionCaretKey,
  REFERENCE_MENTION_CARET_ACTIVE_CLASS,
} from '@web/spaces/canvas/generate/reference-mention-caret';
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
 * the chip-boundary caret plugin).
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
 * Seeds the editor with two ADJACENT chips (no text between) — doc positions:
 * chip A occupies 1-2, the caret-blind boundary is pos 2, chip B occupies 2-3.
 * @param editor - The editor to seed.
 */
function seedAdjacentChips(editor: Editor): void {
  editor
    .chain()
    .insertContent(referenceMentionContent(chipA))
    .insertContent(referenceMentionContent(chipB))
    .run();
}

// The bug (batch-2 item 5, TipTap #2978): a text cursor BETWEEN two adjacent
// chips is a real document position (typing lands there) but browsers cannot
// paint a native caret — the DOM selection has no text node to anchor to.
// Gapcursor was the wrong tool (its valid() rejects textblock parents, so it
// never fires inside a paragraph). The fix draws the caret ourselves, scoped
// to exactly the caret-blind chip boundaries; native caret rules elsewhere.

/**
 * Marks the editor's caret plugin as focused/blurred by dispatching the same
 * `focus` / `blur` transaction metas TipTap's core focusEvents plugin emits
 * on the real DOM events (jsdom focus on contenteditable is unreliable).
 * @param editor - The editor.
 * @param focused - The focus state to set.
 */
function setEditorFocusState(editor: Editor, focused: boolean): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(focused ? 'focus' : 'blur', {}),
  );
}

describe('caretBlindPos — where the fake caret must render', () => {
  it('returns the position between two adjacent chips', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(2);
      expect(caretBlindPos(editor.state)).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('returns the paragraph-start position before a leading chip (no text anchor there either)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(1);
      expect(caretBlindPos(editor.state)).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it('returns NULL after a trailing chip — PM separator anchors the native caret there (B1, user 2026-07-12)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(3);
      // The trailing after-chip position (end of textblock) now retires the fake
      // caret: PM's img.ProseMirror-separator gives a native caret, and drawing
      // our fake one over it both hid the native caret AND obstructed Chrome's
      // native drag hit-test. Between-chip / leading-chip positions still return
      // their pos (no separator there).
      expect(caretBlindPos(editor.state)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('returns null at a chip|text boundary (the adjacent text node anchors the native caret)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent('hi')
        .run();
      editor.commands.setTextSelection(2);
      expect(caretBlindPos(editor.state)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('returns null inside plain text', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      editor.commands.setTextSelection(3);
      expect(caretBlindPos(editor.state)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('returns null in an empty paragraph (trailing-break keeps the native caret visible)', () => {
    const editor = makeEditor();
    try {
      expect(caretBlindPos(editor.state)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('returns null for a NodeSelection (a selected chip renders its own selection ring)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setNodeSelection(1);
      expect(caretBlindPos(editor.state)).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});

// B1 (user 2026-07-12): the trailing after-chip position both retires the fake
// caret (native caret via PM's separator) and is the only spot the mouse-drag
// takeover engages — Chrome refuses to native-drag FROM there.
describe('isTrailingCaretBlind — the trailing after-chip position', () => {
  it('is true after a trailing chip (end of the textblock)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor); // A(1-2) B(2-3); end of content = pos 3
      expect(isTrailingCaretBlind(editor.state.doc.resolve(3))).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('is false between two chips (no separator there → the fake caret stays)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      expect(isTrailingCaretBlind(editor.state.doc.resolve(2))).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('is false before a leading chip (nodeAfter is the chip, not null)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      expect(isTrailingCaretBlind(editor.state.doc.resolve(1))).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('is false at the end of a trailing TEXT run (nodeBefore is text, not a chip)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent('hi')
        .run();
      // chip 1-2, 'hi' 2-4; end of content = 4, nodeBefore is the text.
      expect(isTrailingCaretBlind(editor.state.doc.resolve(4))).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

// The mouse-drag takeover is scoped to the trailing after-chip press only; the
// full drag needs a real browser (posAtCoords needs layout — synthetic events
// can't drive native PM drag), so these cover the guard branches that decline.
describe('reference-mention caret plugin — mousedown takeover scoping (B1)', () => {
  const mousedown = (editor: Editor, event: Partial<MouseEvent>): boolean => {
    const plugin = referenceMentionCaretKey.get(editor.state);
    return (
      plugin?.props.handleDOMEvents?.mousedown?.call(plugin, editor.view, {
        button: 0,
        target: editor.view.dom,
        preventDefault: (): void => {},
        ...event,
      } as unknown as MouseEvent) ?? false
    );
  };

  it('declines when a modifier is held (leaves native selection extension)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      expect(mousedown(editor, { shiftKey: true })).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('declines a press ON a chip (keeps the default node-selection)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      const chipEl = document.createElement('span');
      chipEl.setAttribute('data-reference-mention', '');
      expect(mousedown(editor, { target: chipEl })).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('declines a non-left button', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      expect(mousedown(editor, { button: 2 })).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

describe('reference-mention caret plugin — wiring, clicks, decorations', () => {
  it('is installed by the ReferenceMention extension', () => {
    const editor = makeEditor();
    try {
      expect(referenceMentionCaretKey.get(editor.state)).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('handleClick claims a gap click between chips and places an empty text cursor there', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        2,
        { target: editor.view.dom } as unknown as MouseEvent,
      );
      expect(handled).toBe(true);
      const sel = editor.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.empty).toBe(true);
      expect(sel.from).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('handleClick leaves a click ON a chip to the default NodeSelection behavior', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      const chipEl = document.createElement('span');
      chipEl.setAttribute('data-reference-mention', '');
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        2,
        { target: chipEl } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('handleClick declines positions where the native caret works (text adjacency)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent('hi')
        .run();
      const plugin = referenceMentionCaretKey.get(editor.state);
      const handled = plugin?.props.handleClick?.call(
        plugin,
        editor.view,
        2,
        { target: editor.view.dom } as unknown as MouseEvent,
      );
      expect(handled).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('renders exactly one caret widget decoration at the caret-blind position (focused)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      setEditorFocusState(editor, true);
      editor.commands.setTextSelection(2);
      const plugin = referenceMentionCaretKey.get(editor.state);
      const decos = plugin?.props.decorations?.call(plugin, editor.state);
      // DecorationSet.find() lists the concrete decorations.
      const found = (
        decos as { find: () => Array<{ from: number }> } | null | undefined
      )?.find();
      expect(found).toHaveLength(1);
      expect(found?.[0].from).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('renders no decoration while the native caret is in charge', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      editor.commands.setTextSelection(3);
      const plugin = referenceMentionCaretKey.get(editor.state);
      const decos = plugin?.props.decorations?.call(plugin, editor.state);
      expect(decos ?? null).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('marks the editor root while the fake caret shows (hides the native caret — never two carets)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      setEditorFocusState(editor, true);
      editor.commands.setTextSelection(2);
      expect(editor.view.dom.classList.contains(REFERENCE_MENTION_CARET_ACTIVE_CLASS)).toBe(
        true,
      );
      editor.commands.setNodeSelection(1);
      expect(editor.view.dom.classList.contains(REFERENCE_MENTION_CARET_ACTIVE_CLASS)).toBe(
        false,
      );
    } finally {
      editor.destroy();
    }
  });
});

// Focus gating (adversarial round-1): a native caret NEVER renders in an
// unfocused editor. Without the gate the fake caret blinked on panel open
// (initial selection lands before a leading chip, editor unfocused) and kept
// blinking after blur — two carets at once, falsely signalling where
// keystrokes land. The plugin tracks TipTap's focus/blur transaction metas.
describe('reference-mention caret plugin — focus gating', () => {
  it('renders NO decoration while the editor is unfocused (panel open, initial selection)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      // Initial selection in a chip-leading doc IS caret-blind — but the
      // editor was never focused, so nothing may render.
      editor.commands.setTextSelection(1);
      const plugin = referenceMentionCaretKey.get(editor.state);
      const decos = plugin?.props.decorations?.call(plugin, editor.state);
      expect(decos ?? null).toBeNull();
      expect(
        editor.view.dom.classList.contains(
          REFERENCE_MENTION_CARET_ACTIVE_CLASS,
        ),
      ).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('blur removes the caret and the native-caret suppression, focus restores them', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      setEditorFocusState(editor, true);
      editor.commands.setTextSelection(2);
      const plugin = referenceMentionCaretKey.get(editor.state);
      expect(
        (plugin?.props.decorations?.call(plugin, editor.state) as
          | { find: () => unknown[] }
          | null
          | undefined)?.find(),
      ).toHaveLength(1);
      setEditorFocusState(editor, false);
      expect(plugin?.props.decorations?.call(plugin, editor.state) ?? null).toBeNull();
      expect(
        editor.view.dom.classList.contains(
          REFERENCE_MENTION_CARET_ACTIVE_CLASS,
        ),
      ).toBe(false);
      setEditorFocusState(editor, true);
      expect(
        (plugin?.props.decorations?.call(plugin, editor.state) as
          | { find: () => unknown[] }
          | null
          | undefined)?.find(),
      ).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });
});

// P5 (user 2026-07-12): a reference chip is an ATOM, so a plain ArrowRight from
// before it lands a NodeSelection ON the chip first (chip highlighted, no
// caret) and only a SECOND press moves the text cursor past it — "hitting a
// chip needs two presses to show the caret". The plugin's keymap collapses that
// into ONE press: when the caret's immediate neighbour in the arrow direction
// is a chip, it steps the TEXT cursor straight to the far boundary, skipping the
// atom NodeSelection. The chip is still deletable (Backspace at the boundary)
// and still selectable by click.
describe('reference-mention caret plugin — one-press chip crossing (P5)', () => {
  const arrow = (editor: Editor, key: string, shiftKey = false): boolean => {
    const plugin = referenceMentionCaretKey.get(editor.state);
    return (
      plugin?.props.handleKeyDown?.call(
        plugin,
        editor.view,
        new KeyboardEvent('keydown', { key, shiftKey }),
      ) ?? false
    );
  };

  it('ArrowRight from before a leading chip lands the text cursor past it in ONE press (no NodeSelection stop)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(1); // before chip A
      expect(arrow(editor, 'ArrowRight')).toBe(true);
      const sel = editor.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.empty).toBe(true);
      expect(sel.from).toBe(2); // between A and B — the caret-blind position
    } finally {
      editor.destroy();
    }
  });

  it('ArrowRight from between two chips lands after the trailing chip in one press', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(2);
      expect(arrow(editor, 'ArrowRight')).toBe(true);
      expect(editor.state.selection.from).toBe(3);
    } finally {
      editor.destroy();
    }
  });

  it('ArrowLeft from after a trailing chip lands between the chips in one press', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(3);
      expect(arrow(editor, 'ArrowLeft')).toBe(true);
      expect(editor.state.selection.from).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('ArrowLeft from between chips lands before the leading chip', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(2);
      expect(arrow(editor, 'ArrowLeft')).toBe(true);
      expect(editor.state.selection.from).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it('does not intercept when the caret is not adjacent to a chip (plain text keeps native arrows)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      editor.commands.setTextSelection(3);
      expect(arrow(editor, 'ArrowRight')).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('does not intercept while Shift is held (selection extension keeps native behavior)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(1);
      expect(arrow(editor, 'ArrowRight', true)).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});

// Contract tests bind STRUCTURALLY (block-scoped regex, not
// substring-anywhere) — the R4 adversarial lesson: an assertion that scans to
// end-of-file goes green on a decoy rule.
describe('caret CSS contract (index.css)', () => {
  const css = readFileSync(
    resolve(__dirname, '../../../../index.css'),
    'utf8',
  );

  it('draws the caret line and blinks it', () => {
    expect(css).toMatch(
      /\.reference-mention-caret\s*\{[^}]*border-left:[^}]*\}/,
    );
    expect(css).toMatch(
      /\.reference-mention-caret\s*\{[^}]*animation:[^}]*reference-mention-caret-blink[^}]*\}/,
    );
    expect(css).toMatch(/@keyframes reference-mention-caret-blink/);
  });

  it('suppresses the native caret only while the fake one is active', () => {
    expect(css).toMatch(
      /\.reference-mention-caret-active\s*\{[^}]*caret-color:\s*transparent[^}]*\}/,
    );
  });

  // P5 (user 2026-07-12): the 1.5px caret line, inserted as a real inline box
  // between two chips, pushed the following chip ~1.5px to the right. Negative
  // horizontal margins (-0.75px each side) absorb the border so the caret
  // occupies ZERO net inline width — clicking a gap no longer nudges a chip.
  it('the caret occupies zero net inline width (negative margins offset its 1.5px border)', () => {
    expect(css).toMatch(
      /\.reference-mention-caret\s*\{[^}]*margin-left:\s*-0\.75px[^}]*\}/,
    );
    expect(css).toMatch(
      /\.reference-mention-caret\s*\{[^}]*margin-right:\s*-0\.75px[^}]*\}/,
    );
  });
});
