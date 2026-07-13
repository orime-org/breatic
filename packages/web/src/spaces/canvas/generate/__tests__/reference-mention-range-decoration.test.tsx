// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

import {
  ReferenceMention,
  referenceMentionContent,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { selectionChipDecorations } from '@web/spaces/canvas/generate/reference-mention-range-decoration';
import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const chip = (id: string): ReferenceRailItem => ({
  refId: `${id}->x`,
  sourceNodeId: id,
  sourceNodeType: 'image',
  sourceNodeName: id,
  thumbnail: `${id}.png`,
});

/**
 * Mounts a bare editor seeded with `ab` + chip(X) + `cd` + chip(Y).
 * @returns The editor (caller destroys).
 */
function seededEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: 'none',
        }),
      }),
    ],
  });
  editor
    .chain()
    .insertContent('ab')
    .insertContent(referenceMentionContent(chip('X')))
    .insertContent('cd')
    .insertContent(referenceMentionContent(chip('Y')))
    .run();
  return editor;
}

/**
 * Reads the ProseMirror positions of the two seeded chips.
 * @param editor - The seeded editor.
 * @returns The chip positions in document order.
 */
function chipPositions(editor: Editor): number[] {
  const ps: number[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === REFERENCE_MENTION_NODE) ps.push(pos);
  });
  return ps;
}

// I2 (batch-5, user 2026-07-12, decision A): a chip is a select-none atom, so
// the browser's native text selection paints the surrounding text blue but
// skips the chip — a range selection covering a chip left it un-highlighted,
// reading as "not selected". A local ProseMirror decoration highlights any chip
// FULLY inside the selection range so it reads as part of the selection.
describe('selectionChipDecorations — highlight chips inside a range selection', () => {
  it('returns no decorations for an empty (collapsed) selection', () => {
    const editor = seededEditor();
    try {
      const [x] = chipPositions(editor);
      expect(selectionChipDecorations(editor.state.doc, { from: x, to: x })).toEqual(
        [],
      );
    } finally {
      editor.destroy();
    }
  });

  it('highlights only the chip fully covered by the selection', () => {
    const editor = seededEditor();
    try {
      const [x] = chipPositions(editor);
      // Selection tight around chip X only (atom nodeSize = 1).
      const decos = selectionChipDecorations(editor.state.doc, {
        from: x,
        to: x + 1,
      });
      expect(decos.map((d) => [d.from, d.to])).toEqual([[x, x + 1]]);
    } finally {
      editor.destroy();
    }
  });

  it('highlights every chip when the whole document is selected', () => {
    const editor = seededEditor();
    try {
      const [x, y] = chipPositions(editor);
      const decos = selectionChipDecorations(editor.state.doc, {
        from: 0,
        to: editor.state.doc.content.size,
      });
      expect(decos.map((d) => d.from).sort((a, b) => a - b)).toEqual([x, y]);
    } finally {
      editor.destroy();
    }
  });

  it('does NOT highlight a chip only partially touched by the selection edge', () => {
    const editor = seededEditor();
    try {
      const [x] = chipPositions(editor);
      // Selection ends AT the chip's start — the chip (x..x+1) is not inside.
      expect(
        selectionChipDecorations(editor.state.doc, { from: 0, to: x }),
      ).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});
