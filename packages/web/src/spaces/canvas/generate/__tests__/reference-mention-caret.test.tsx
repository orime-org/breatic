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

  it('returns the paragraph-end position after a trailing chip', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
      editor.commands.setTextSelection(3);
      expect(caretBlindPos(editor.state)).toBe(3);
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

  it('renders exactly one caret widget decoration at the caret-blind position', () => {
    const editor = makeEditor();
    try {
      seedAdjacentChips(editor);
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
});
