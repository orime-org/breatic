// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing a proposal's or a template's prompt into a generation node's shared
 * fragment (#229, inner#977).
 *
 * The reader presses one button and the prompt is in the box, with what is
 * still theirs to do marked: a reference to @ by hand, words to fill in, and
 * notes on operating the panel at the top. Nothing is @'d for them -- the node
 * to @ may still be empty, and doing it themselves is where they see that.
 *
 * Written straight into the Yjs types rather than through the editor, for the
 * same two reasons `canvas/text-body.ts` in `@breatic/shared` gives: an editor
 * write needs a ProseMirror `Schema`, which belongs to the extension list
 * above this layer, and the editor is not mounted at placing time. What keeps
 * the hand-built shape honest is the round-trip test, which binds a real
 * prompt editor to what is written here.
 */

import * as Y from 'yjs';

import { markText, type PromptSegment } from '@breatic/shared';

import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';

/** The block element a line of the prompt becomes. */
const BLOCK = 'paragraph';

/**
 * Lay the segments out as notes and lines of words.
 *
 * A newline inside a text segment starts a new line: a raw newline inside a
 * text node is not something the editor's schema allows. Notes are gathered
 * wherever they were written, since the box holds them above the words.
 * @param segments - The prompt as the model or template wrote it.
 * @returns The notes in order, and the text of each line.
 * @throws {never} Never.
 */
function layOut(segments: readonly PromptSegment[]): { notes: string[]; lines: string[] } {
  const notes: string[] = [];
  let words = '';
  for (const segment of segments) {
    if (segment.slot?.kind === 'note') notes.push(segment.slot.label);
    else words += segment.slot ? markText(segment.slot) : segment.text;
  }
  return { notes, lines: words.split('\n') };
}

/**
 * Build one line's block.
 * @param text - The line's words.
 * @returns The paragraph element; a blank line is a paragraph with no children,
 *   since one holding an empty text node is rejected by the schema.
 * @throws {never} Never.
 */
function lineBlock(text: string): Y.XmlElement {
  const block = new Y.XmlElement(BLOCK);
  if (text.length > 0) block.insert(0, [new Y.XmlText(text)]);
  return block;
}

/**
 * Build one note's block.
 * @param label - What the note says.
 * @returns The note element, its words in an attribute.
 * @throws {never} Never.
 */
function noteBlock(label: string): Y.XmlElement {
  const block = new Y.XmlElement(PROMPT_NOTE_NODE);
  block.setAttribute(PROMPT_NOTE_LABEL_ATTR, label);
  return block;
}

/**
 * Write a prompt into a generation node's prompt fragment.
 *
 * Replacement, not append: a proposal placed twice, or a template picked
 * twice, has to read as one prompt rather than two spliced together.
 * @param prompt - The node's prompt fragment for that mode.
 * @param segments - The prompt as the model or template wrote it.
 * @throws {never} Never.
 */
export function writeProposalPrompt(prompt: Y.XmlFragment, segments: readonly PromptSegment[]): void {
  const { notes, lines } = layOut(segments);
  const blocks = [...notes.map(noteBlock), ...lines.map(lineBlock)];
  /**
   * Swap the fragment's whole content for the new blocks.
   */
  const replace = (): void => {
    if (prompt.length > 0) prompt.delete(0, prompt.length);
    prompt.insert(0, blocks);
  };
  if (prompt.doc) prompt.doc.transact(replace);
  else replace();
}
