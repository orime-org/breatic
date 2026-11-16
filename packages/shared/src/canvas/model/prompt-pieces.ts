// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A prompt read off its fragment as pieces: every stretch of words as stored
 * (the space the editor keeps after a line's last mention included), and
 * mentions by source node and kind, one block per line (breatic#1488 §9).
 *
 * Reading a prompt for the model takes two things that live in different
 * places: the fragment, which collab holds, and each media chip's words,
 * which come from the model catalog the MCP service holds. The pieces are the
 * handover between the two, plain JSON; `serializePromptFragment` is the same
 * two steps run in one place, so every reader of a prompt follows one rule.
 *
 * The same walk gives the text an external agent reads, with each mention
 * written as `@[label](node id)` and notes in their marked form.
 */

import * as Y from 'yjs';

import { writtenMark } from '@shared/types/canvas-proposal.js';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
  MENTION_SOURCE_ID_ATTR,
  PROMPT_NOTE_LABEL_ATTR,
  PROMPT_NOTE_NODE,
  REFERENCE_MENTION_NODE,
  SPEAKER_ATTR,
} from '@shared/canvas/model/prompt-nodes.js';
import type { ReferenceRailItem } from '@shared/canvas/model/derive-references.js';
import type { MentionTokens } from '@shared/canvas/model/reference-urls.js';

/** One piece of a prompt line: words as written, or a mention. */
export type PromptPiece = { text: string } | { mention: { sourceNodeId: string; kind: string } };

/** One line of a prompt; a dialogue line carries its speaker. */
export interface PromptPieceBlock {
  pieces: PromptPiece[];
  speaker?: number;
}

/** A mention as the walk reads it, with the label the chip shows. */
interface MentionRead {
  sourceNodeId: string;
  kind: string;
  label: string;
}

/** What the editor puts between two blocks of a prompt (`serializePromptText`'s default). */
const BLOCK_SEPARATOR = '\n\n';

/**
 * What a chip reads as in the prompt the model gets: a text chip its source's
 * words, any other chip its token. One rule for every reader of a prompt, the
 * mounted editor and the fragment read at submit alike (#2218).
 * @param pool - The node's reference rows, for what a text chip says.
 * @param tokens - Each media chip's words, by source id.
 * @returns Reads one chip, given its source id and kind.
 */
export function chipWordsReader(
  pool: ReadonlyArray<ReferenceRailItem>,
  tokens: MentionTokens,
): (id: string | null, kind: string | null) => string {
  const textById = new Map(
    pool
      .filter((r) => r.sourceNodeType === 'text')
      .map((r) => [r.sourceNodeId, r.textContent ?? '']),
  );
  return (id, kind) => {
    if (id == null) return '';
    if (kind === 'text') return textById.get(id) ?? '';
    return Object.hasOwn(tokens, id) ? tokens[id]! : '';
  };
}

/**
 * An attribute read as a string.
 * @param element - The element.
 * @param name - The attribute.
 * @returns Its value, or the empty string when it is not one.
 */
function stringAttr(element: Y.XmlElement, name: string): string {
  const value = element.getAttribute(name);
  return typeof value === 'string' ? value : '';
}

/**
 * The words and mentions under a node, in document order.
 * @param node - A piece of the prompt.
 * @returns Its parts.
 */
function partsOf(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Array<string | MentionRead> {
  if (node instanceof Y.XmlText) return [node.toJSON()];
  if (!(node instanceof Y.XmlElement)) return [];
  if (node.nodeName !== REFERENCE_MENTION_NODE) return node.toArray().flatMap(partsOf);
  const sourceNodeId = node.getAttribute(MENTION_SOURCE_ID_ATTR);
  // A mention with no source reads as nothing, as `chipWordsReader` reads it.
  if (typeof sourceNodeId !== 'string') return [];
  return [{ sourceNodeId, kind: stringAttr(node, MENTION_KIND_ATTR), label: stringAttr(node, MENTION_LABEL_ATTR) }];
}

/**
 * The speaker a dialogue line carries.
 * @param block - The line's element.
 * @returns The speaker, or undefined on a line that names none.
 */
function speakerOf(block: Y.XmlElement): number | undefined {
  const raw = block.getAttribute(SPEAKER_ATTR) as unknown;
  const speaker = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(speaker) ? speaker : undefined;
}

/**
 * Whether a block is a note, which is never sent.
 * @param block - A top-level piece of the prompt.
 * @returns True for a note.
 */
function isNote(block: unknown): block is Y.XmlElement {
  return block instanceof Y.XmlElement && block.nodeName === PROMPT_NOTE_NODE;
}

/**
 * A prompt's lines as pieces, notes left out.
 * @param fragment - The prompt.
 * @returns One block per line.
 */
export function promptPieces(fragment: Y.XmlFragment): PromptPieceBlock[] {
  return fragment.toArray().flatMap((block): PromptPieceBlock[] => {
    if (isNote(block)) return [];
    const parts = partsOf(block);
    const pieces = parts.map((part): PromptPiece =>
      typeof part === 'string' ? { text: part } : { mention: { sourceNodeId: part.sourceNodeId, kind: part.kind } },
    );
    const speaker = block instanceof Y.XmlElement ? speakerOf(block) : undefined;
    return [{ pieces, ...(speaker === undefined ? {} : { speaker }) }];
  });
}

/**
 * A prompt's pieces as the model reads them: a text chip as its source's
 * words, a media chip as its token, lines apart.
 * @param blocks - The pieces {@link promptPieces} read.
 * @param pool - The node's reference rows, for what a text chip says.
 * @param tokens - Each media chip's words, by source id.
 * @returns The text.
 */
export function serializePromptPieces(
  blocks: ReadonlyArray<PromptPieceBlock>,
  pool: ReadonlyArray<ReferenceRailItem>,
  tokens: MentionTokens,
): string {
  const words = chipWordsReader(pool, tokens);
  return blocks
    .map((block) => block.pieces.map((piece) => ('text' in piece ? piece.text : words(piece.mention.sourceNodeId, piece.mention.kind))).join(''))
    .join(BLOCK_SEPARATOR);
}

/**
 * A prompt as an external agent reads it: each mention as `@[label](node id)`,
 * each note in its marked form, lines apart.
 * @param fragment - The prompt.
 * @returns The text.
 */
export function promptMarkup(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((block) => {
      if (isNote(block)) return writtenMark({ kind: 'note', label: stringAttr(block, PROMPT_NOTE_LABEL_ATTR) });
      const parts = partsOf(block);
      return parts.map((part) => (typeof part === 'string' ? part : `@[${part.label}](${part.sourceNodeId})`)).join('');
    })
    .join(BLOCK_SEPARATOR);
}
