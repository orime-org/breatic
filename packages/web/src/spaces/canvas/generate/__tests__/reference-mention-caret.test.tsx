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
  caretBlindGaps,
  isTrailingCaretBlind,
  renderSeparator,
  referenceMentionCaretKey,
  REFERENCE_MENTION_SEPARATOR_CLASS,
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
 * the chip-boundary caret/anchor plugin).
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

// Root cause (WebKit bug 15256 / TipTap #2978): a text caret at a gap between two
// adjacent chips — or before a leading chip at paragraph start — is a real
// document position (typing lands there) but the DOM has no text node to anchor a
// native caret to. Chrome holds the model selection but paints nothing; WebKit
// snaps the caret AND typed input to paragraph start. The fix injects PM's own
// img.ProseMirror-separator (a raw, model-invisible replaced element the browser
// CAN anchor a native caret next to) at every such gap EXCEPT trailing, where PM's
// addTextblockHacks already injects one. This replaced the earlier display-only
// fake caret, which never participated in the native selection (A, user 2026-07-12).

describe('caretBlindGaps — every gap that needs a native-caret anchor', () => {
  it('returns the leading + between-chip gaps for two adjacent chips (not the trailing one)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor); // A(1-2) B(2-3): pos 1 leading, 2 between, 3 trailing
      // Structural, not selection-gated: the anchors exist regardless of where the
      // caret sits, so a click/arrow into any gap lands natively.
      expect(caretBlindGaps(editor.state.doc)).toEqual([1, 2]);
    } finally {
      editor.destroy();
    }
  });

  it('excludes the trailing after-chip position (PM separator anchors the native caret there, B1)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      expect(caretBlindGaps(editor.state.doc)).not.toContain(3);
    } finally {
      editor.destroy();
    }
  });

  it('returns only the leading gap for a leading chip followed by text', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chipA))
        .insertContent('hi')
        .run();
      // chip 1-2, 'hi' 2-4: pos 1 is caret-blind (leading), pos 2 has a text
      // anchor (the 'h'), so only [1].
      expect(caretBlindGaps(editor.state.doc)).toEqual([1]);
    } finally {
      editor.destroy();
    }
  });

  it('returns nothing for a trailing chip after text (text anchors before, PM separator after)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent('hi')
        .insertContent(referenceMentionContent(chipA))
        .run();
      expect(caretBlindGaps(editor.state.doc)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  it('returns nothing for plain text', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      expect(caretBlindGaps(editor.state.doc)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  it('returns nothing for an empty paragraph', () => {
    const editor = makeEditor();
    try {
      expect(caretBlindGaps(editor.state.doc)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});

describe('renderSeparator — the native-caret anchor is a real separator img, not a painted caret', () => {
  it('builds a bare img.ProseMirror-separator, silent to assistive tech', () => {
    const el = renderSeparator();
    expect(el.tagName).toBe('IMG');
    expect(el.classList.contains(REFERENCE_MENTION_SEPARATOR_CLASS)).toBe(true);
    // alt="" (not a broken-image placeholder) + aria-hidden → no AT announcement.
    expect(el.getAttribute('alt')).toBe('');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    // No `src`: an unresolved replaced element the browser anchors a caret next to.
    expect(el.hasAttribute('src')).toBe(false);
  });
});

// B1 (user 2026-07-12): the trailing after-chip position both keeps its native
// caret via PM's separator (so caretBlindGaps skips it) and is the only spot the
// mouse-drag takeover engages — Chrome refuses to native-drag FROM there.
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

  it('is false between two chips (our separator anchors it there)', () => {
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

describe('reference-mention caret plugin — wiring + decorations', () => {
  it('is installed by the ReferenceMention extension', () => {
    const editor = makeEditor();
    try {
      expect(referenceMentionCaretKey.get(editor.state)).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('renders a separator anchor at EVERY caret-blind gap, structurally (no selection/focus gate)', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      // No focus meta, no selection at a gap: the anchors are structural.
      const plugin = referenceMentionCaretKey.get(editor.state);
      const decos = plugin?.props.decorations?.call(plugin, editor.state);
      const found = (
        decos as { find: () => Array<{ from: number }> } | null | undefined
      )?.find();
      expect(found?.map((d) => d.from).sort((a, b) => a - b)).toEqual([1, 2]);
    } finally {
      editor.destroy();
    }
  });

  it('renders no decoration while the native caret is in charge (plain text)', () => {
    const editor = makeEditor();
    try {
      editor.chain().insertContent('hello').run();
      const plugin = referenceMentionCaretKey.get(editor.state);
      const decos = plugin?.props.decorations?.call(plugin, editor.state);
      expect(decos ?? null).toBeNull();
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
// atom NodeSelection. This is an independent UX choice, unrelated to caret
// anchoring (it stays regardless of the separator).
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

// Contract tests bind STRUCTURALLY (block-scoped regex, not substring-anywhere) —
// the R4 adversarial lesson: an assertion that scans to end-of-file goes green on
// a decoy rule.
describe('separator CSS contract (index.css)', () => {
  const css = readFileSync(
    resolve(__dirname, '../../../../index.css'),
    'utf8',
  );

  it('keeps the separator WIDTH 0 (a non-zero width nudges chips + re-breaks Chrome drag, tiptap #4646)', () => {
    expect(css).toMatch(
      /img\.ProseMirror-separator\s*\{[^}]*width:\s*0[^}]*\}/,
    );
  });

  it('sizes the separator HEIGHT to the text caret so the gap caret is not chip-tall (user 2026-07-12)', () => {
    // height 0 let the native caret fall back to the adjacent chip (~22px) and
    // render ~5px too tall; a text-caret-height, text-bottom-aligned box fixes it.
    expect(css).toMatch(
      /img\.ProseMirror-separator\s*\{[^}]*height:\s*1\.2em[^}]*\}/,
    );
    expect(css).toMatch(
      /img\.ProseMirror-separator\s*\{[^}]*vertical-align:\s*text-bottom[^}]*\}/,
    );
  });

  it('no longer paints a fake caret (retired in favour of the native caret, A)', () => {
    expect(css).not.toMatch(/\.reference-mention-caret\s*\{/);
    expect(css).not.toMatch(/caret-color:\s*transparent/);
  });
});
