// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The line a collapsed prompt row shows: the box's words as the box shows
 * them, so the reader recognises the prompt without opening it (#1201).
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { MENTION_KIND_ATTR, MENTION_LABEL_ATTR } from '@web/spaces/canvas/generate/reference-mention';
import { promptPreviewLine } from '@web/spaces/canvas/generate/prompt-preview';

const WORDS = { reference: 'Reference', notePrefix: 'Note: ' };

type Piece = string | { chip: string | null; kind?: string };

/**
 * A prompt fragment made of blocks, each a run of text and chips.
 * @param blocks - Each block's pieces, or a note's label.
 * @returns The fragment, inside a document so it can be read.
 */
function prompt(...blocks: Array<Piece[] | { note: string }>): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  fragment.insert(
    0,
    blocks.map((block) => {
      if (!Array.isArray(block)) {
        const note = new Y.XmlElement(PROMPT_NOTE_NODE);
        note.setAttribute(PROMPT_NOTE_LABEL_ATTR, block.note);
        return note;
      }
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(
        0,
        block.map((piece) => {
          if (typeof piece === 'string') return new Y.XmlText(piece);
          const chip = new Y.XmlElement(REFERENCE_MENTION_NODE);
          if (piece.chip !== null) chip.setAttribute(MENTION_LABEL_ATTR, piece.chip);
          chip.setAttribute(MENTION_KIND_ATTR, piece.kind ?? 'image');
          return chip;
        }),
      );
      return paragraph;
    }),
  );
  return fragment;
}

describe('the collapsed row preview', () => {
  it('shows a chip by the name on it', () => {
    expect(promptPreviewLine(prompt([{ chip: 'Hero' }, ' walks in']), WORDS)).toBe('@Hero walks in');
  });

  it('shows a text chip by its name, not by the words of the node it points at', () => {
    expect(promptPreviewLine(prompt([{ chip: 'Script', kind: 'text' }, ' read aloud']), WORDS)).toBe('@Script read aloud');
  });

  it('shows a chip with no name the way the chip itself does', () => {
    expect(promptPreviewLine(prompt([{ chip: null }, ' pans left']), WORDS)).toBe('@Reference pans left');
  });

  it('shows a note with its prefix, as the box shows it above the words', () => {
    expect(promptPreviewLine(prompt({ note: 'Keep the light warm' }, ['Close-up']), WORDS)).toBe('Note: Keep the light warm');
  });

  it('skips blank lines at the top', () => {
    expect(promptPreviewLine(prompt([], ['   '], ['Wide shot of the sea'], ['Second line']), WORDS)).toBe('Wide shot of the sea');
  });

  it('is empty for an empty box', () => {
    expect(promptPreviewLine(prompt([], []), WORDS)).toBe('');
  });
});
