// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing a proposal's prompt into the generation node's shared fragment
 * (#229, design §5.3 step 6 and §5.4).
 *
 * The reader presses one button and the prompt is already in the box, with
 * every spot still theirs to fill marked in brackets where it belongs. Two
 * kinds of spot: `asset` is material only they have, `tweak` is a phrase the
 * agent guessed at. An `asset` spot also carries the `@`-mention of the empty
 * node the material goes into, so the generate button works the moment they
 * drop a file in -- without it they would have to make that mention by hand,
 * which is exactly the canvas knowledge this whole feature exists to spare
 * them.
 *
 * Written straight into the Yjs types rather than through the editor, for the
 * same two reasons `data/yjs/text-body.ts` gives: an editor write needs a
 * ProseMirror `Schema`, which belongs to the extension list above this layer,
 * and the editor is not mounted at placing time -- the panel opens after, and
 * may never open at all. What keeps the hand-built shape honest is the
 * round-trip test, which binds a real prompt editor to what is written here
 * and reads the mention back through the actual schema.
 */

import * as Y from 'yjs';

import type { GenerationNodeType, PromptSegment } from '@breatic/shared';

import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/spaces/canvas/generate/at-reference';
import { MENTION_KIND_ATTR } from '@web/spaces/canvas/generate/reference-mention';

/** The block element a line of the prompt becomes. */
const BLOCK = 'paragraph';

/** What brackets a spot the reader still has to fill in (design §5.4). */
const MARK_OPEN = '[';
const MARK_CLOSE = ']';

/** The symbol each kind of spot wears, so the two read apart at a glance. */
const MARK_SYMBOL: Record<'asset' | 'tweak', string> = {
  asset: '📎',
  tweak: '✏️',
};

/** An empty node an asset spot points at, and what kind of node it is. */
export interface ProposalSource {
  id: string;
  kind: GenerationNodeType;
}

/** One piece of inline content: some words, or a mention of a source node. */
type Inline = { text: string } | { mention: ProposalSource };

/**
 * Lay the segments out as lines of inline pieces.
 *
 * A newline inside a text segment starts a new block: a raw newline inside a
 * text node is not something the editor's schema allows, so leaving one in
 * would break the box the moment the reader opened it.
 * @param segments - The prompt as the model sent it.
 * @param sources - The empty nodes to mention, one per asset spot in order.
 * @returns One array of inline pieces per line.
 * @throws {never} Never.
 */
function layOut(
  segments: readonly PromptSegment[],
  sources: readonly ProposalSource[],
): Inline[][] {
  const lines: Inline[][] = [[]];
  /**
   * Append some words to the current line, starting new lines at newlines.
   * @param text - The words to append.
   */
  const addText = (text: string): void => {
    text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece.length > 0) lines[lines.length - 1]!.push({ text: piece });
    });
  };
  let assetsSeen = 0;
  for (const segment of segments) {
    if (segment.slot) {
      const { kind, label } = segment.slot;
      addText(`${MARK_OPEN}${MARK_SYMBOL[kind]} ${label}${MARK_CLOSE}`);
      if (kind === 'asset') {
        // The mention sits right after the bracket that names it, so the
        // reader sees the instruction and the node it points at together.
        // Mentions run out when the proposal marks more asset spots than it
        // proposed nodes to fill; the check refuses that before a card is
        // drawn, and the bracket alone still says what to do.
        const source = sources[assetsSeen];
        assetsSeen += 1;
        if (source) lines[lines.length - 1]!.push({ mention: source });
      }
      continue;
    }
    addText(segment.text);
  }
  return lines;
}

/**
 * Join neighbouring runs of words into one piece each.
 *
 * A paragraph holds one text node per run, and two adjacent ones do not
 * survive the trip through the editor: written as three siblings, a sentence
 * broken by a marker comes back with its tail missing.
 * @param line - The pieces on this line, as the segments produced them.
 * @returns The same line with consecutive words joined.
 * @throws {never} Never.
 */
function merged(line: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of line) {
    const last = out[out.length - 1];
    if ('text' in piece && last && 'text' in last) {
      out[out.length - 1] = { text: last.text + piece.text };
      continue;
    }
    out.push(piece);
  }
  return out;
}

/**
 * Build one block from a line of inline pieces.
 * @param line - The pieces on this line.
 * @returns The paragraph element.
 * @throws {never} Never.
 */
function blockFor(line: readonly Inline[]): Y.XmlElement {
  const block = new Y.XmlElement(BLOCK);
  const children = merged(line).map((piece) => {
    if ('text' in piece) return new Y.XmlText(piece.text);
    const mention = new Y.XmlElement(REFERENCE_MENTION_NODE);
    // Only the two attrs that identify the source. The label and the
    // thumbnail are left at their defaults for the projection to fill in, so
    // the chip follows the node instead of freezing what it looked like now.
    mention.setAttribute(MENTION_SOURCE_ID_ATTR, piece.mention.id);
    mention.setAttribute(MENTION_KIND_ATTR, piece.mention.kind);
    return mention;
  });
  // A blank line is a block with no children: a paragraph holding an empty
  // text node is rejected by the schema the editor binds with.
  if (children.length > 0) block.insert(0, children);
  return block;
}

/**
 * Write a proposal's prompt into a generation node's prompt fragment.
 *
 * Replacement, not append: the node was created moments ago and its prompt is
 * empty, and a proposal placed twice has to read as one prompt rather than two
 * spliced together.
 * @param prompt - The node's prompt fragment.
 * @param segments - The prompt as the model sent it.
 * @param sources - The empty nodes to mention, one per asset spot in order.
 * @throws {never} Never.
 */
export function writeProposalPrompt(
  prompt: Y.XmlFragment,
  segments: readonly PromptSegment[],
  sources: readonly ProposalSource[],
): void {
  const blocks = layOut(segments, sources).map((line) => blockFor(line));
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
