// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing a proposal's or a template's prompt into a generation node's shared
 * fragment (#229, inner#977).
 *
 * The reader presses one button and the prompt is in the box, with each node
 * the proposal wired into the pool already mentioned (inner#1315) and what is
 * still theirs to do marked: a template's reference to @ by hand, words to
 * fill in, and notes on operating the panel at the top.
 *
 * Written straight into the Yjs types rather than through the editor, for the
 * same two reasons `canvas/text-body.ts` in `@breatic/shared` gives: an editor
 * write needs a ProseMirror `Schema`, which belongs to the extension list
 * above this layer, and the editor is not mounted at placing time. What keeps
 * the hand-built shape honest is the round-trip test, which binds a real
 * prompt editor to what is written here.
 */

import * as Y from 'yjs';

import { markText, type CanvasProposal, type PromptSegment } from '@breatic/shared';

import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';
import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import type { NodeKind } from '@web/data/yjs/node-view';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
  MENTION_THUMBNAIL_ATTR,
} from '@web/spaces/canvas/generate/reference-mention';

/** The block element a line of the prompt becomes. */
const BLOCK = 'paragraph';

/** What one ref mentions: the attrs a mention picked with @ carries. */
export interface ProposalMention {
  /** The placed node the ref points at. */
  sourceNodeId: string;
  /** Its name. */
  label: string;
  /** Its kind, for the chip's icon. */
  kind: NodeKind;
  /** Its picture, when it lands holding one. */
  thumbnail?: string;
}

/** Answers what a ref at a proposal index mentions; undefined when nothing was placed there. */
export type MentionOf = (index: number) => ProposalMention | undefined;

/**
 * What each ref in a placed proposal mentions: the node placed for that
 * index, under the name and kind the proposal gave it. A picture or a clip
 * it lands holding shows on the chip as its reference row does (an image's
 * file, a video's cover); any other chip starts without one, the way a
 * mention of an empty node does, and follows the node once it fills.
 * @param proposal - The proposal being placed.
 * @param nodeIds - The id placed for each of its nodes, in order.
 * @returns The answer for each index.
 * @throws {never} Never.
 */
export function proposalMentionOf(proposal: CanvasProposal, nodeIds: readonly string[]): MentionOf {
  return (index) => {
    const node = proposal.nodes[index];
    const sourceNodeId = nodeIds[index];
    if (!node || !sourceNodeId) return undefined;
    const thumbnail = node.type === 'image' ? node.material : node.type === 'video' ? (node.materialMedia?.coverUrl ?? undefined) : undefined;
    return { sourceNodeId, label: node.name, kind: node.type, ...(thumbnail === undefined ? {} : { thumbnail }) };
  };
}

/** A stretch of one line: words, or a mention. */
type Part = string | ProposalMention;

/**
 * Lay the segments out as notes and lines of parts.
 *
 * A newline inside a text segment starts a new line: a raw newline inside a
 * text node is not something the editor's schema allows. Notes are gathered
 * wherever they were written, since the box holds them above the words. A
 * ref answered by nothing is left out rather than written as a mention of a
 * node that is not there.
 * @param segments - The prompt as the model or template wrote it.
 * @param mentionOf - What each ref mentions.
 * @returns The notes in order, and the parts of each line.
 * @throws {never} Never.
 */
function layOut(segments: readonly PromptSegment[], mentionOf: MentionOf): { notes: string[]; lines: Part[][] } {
  const notes: string[] = [];
  const lines: Part[][] = [[]];
  for (const segment of segments) {
    if (segment.slot?.kind === 'note') {
      notes.push(segment.slot.label);
      continue;
    }
    if (segment.ref !== undefined) {
      const mention = mentionOf(segment.ref);
      if (mention) lines[lines.length - 1]?.push(mention);
      continue;
    }
    const [first = '', ...rest] = (segment.slot ? markText(segment.slot) : segment.text).split('\n');
    // Words running on from words join them: the schema holds a line's text
    // as one run between mentions.
    const line = lines[lines.length - 1] ?? [];
    const last = line[line.length - 1];
    if (typeof last === 'string') line[line.length - 1] = last + first;
    else line.push(first);
    for (const next of rest) lines.push([next]);
  }
  return { notes, lines };
}

/**
 * Build one mention element.
 * @param mention - What it mentions.
 * @returns The element, its attrs those `referenceMentionContent` writes.
 * @throws {never} Never.
 */
function mentionElement(mention: ProposalMention): Y.XmlElement {
  const element = new Y.XmlElement(REFERENCE_MENTION_NODE);
  element.setAttribute(MENTION_SOURCE_ID_ATTR, mention.sourceNodeId);
  element.setAttribute(MENTION_LABEL_ATTR, mention.label);
  element.setAttribute(MENTION_KIND_ATTR, mention.kind);
  if (mention.thumbnail !== undefined) element.setAttribute(MENTION_THUMBNAIL_ATTR, mention.thumbnail);
  return element;
}

/**
 * Build one line's block.
 * @param parts - The line's words and mentions.
 * @returns The paragraph element; a blank line is a paragraph with no children,
 *   since one holding an empty text node is rejected by the schema.
 * @throws {never} Never.
 */
function lineBlock(parts: readonly Part[]): Y.XmlElement {
  const block = new Y.XmlElement(BLOCK);
  const children = parts.flatMap((part): (Y.XmlElement | Y.XmlText)[] =>
    typeof part !== 'string' ? [mentionElement(part)] : part.length > 0 ? [new Y.XmlText(part)] : [],
  );
  if (children.length > 0) block.insert(0, children);
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
 * @param mentionOf - What each ref mentions; a template's prompt has none.
 * @throws {never} Never.
 */
export function writeProposalPrompt(
  prompt: Y.XmlFragment,
  segments: readonly PromptSegment[],
  mentionOf: MentionOf = () => undefined,
): void {
  const { notes, lines } = layOut(segments, mentionOf);
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
