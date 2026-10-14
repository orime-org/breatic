// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing an Agent's document proposal (inner#1509, design §5.4 · §5.5).
 *
 * When the reader presses a card, the proposal is checked against the
 * document as it stands -- the block still there, its words still the ones
 * proposed on -- and written as one undo step: a comment through the same
 * function a reader's own comment goes through, a rewrite or an insert as one
 * BlockNote write whose new blocks take ids derived from the proposal.
 *
 * Those two traces are also how a proposal is known to have landed: a thread
 * carrying its id that still has a mark in the body, or a block with the first
 * id derived from it. Both survive a reload, so a card drawn again knows.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { deriveId, occurrences, type DocumentProposal } from '@breatic/shared';

import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { commentOn, type CommentAim } from '@web/spaces/document/document-comment-post';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { threadRangesByThread } from '@web/spaces/document/document-comment-ranges';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import type { LandingAction } from '@web/stores/document-proposals';


/** How a press ended. */
export type LandingResult =
  | { outcome: 'applied'; blockId: string }
  | { outcome: 'readOnly' | 'changed' | 'blockGone' | 'failed' };

/** The editor parts landing uses. */
type Landable = Pick<DocumentEditorHandle, 'editor' | 'undoManager'>;

/**
 * The id the n-th block a proposal writes takes.
 * @param proposalId - The proposal.
 * @param n - Which block it writes, from 0.
 * @returns The id.
 */
function writtenBlockId(proposalId: string, n: number): string {
  return deriveId(`document-proposal:${proposalId}:${String(n)}`);
}

/**
 * A block anywhere in the body, by id.
 * @param doc - The body.
 * @param id - The block id.
 * @returns The block's `blockContainer` and where it starts, or null.
 */
function blockById(doc: ProseMirrorNode, id: string): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'blockContainer' && node.attrs.id === id) found = { node, pos };
    return found === null;
  });
  return found;
}

/**
 * Where a stretch of a block's plain text sits in the body: one range per
 * run of text it covers, so words running across table cells or paragraphs
 * come back as one range for each.
 * @param doc - The body.
 * @param blockId - The block.
 * @param start - Where the stretch starts in the block's plain text.
 * @param end - Where it ends.
 * @returns The ranges, or null when the block is gone.
 */
function rangesOf(doc: ProseMirrorNode, blockId: string, start: number, end: number): Array<{ from: number; to: number }> | null {
  const block = blockById(doc, blockId);
  if (block === null) return null;
  const ranges: Array<{ from: number; to: number }> = [];
  block.node.descendants((child, rel) => {
    if (!child.isText) return true;
    const at = block.node.textBetween(0, rel, '\n', '\n').length;
    const length = child.text?.length ?? 0;
    const from = Math.max(start, at);
    const to = Math.min(end, at + length);
    if (from < to) ranges.push({ from: block.pos + 1 + rel + (from - at), to: block.pos + 1 + rel + (to - at) });
    return false;
  });
  return ranges;
}

/**
 * Where a comment's quote is, once it still appears once in its block.
 * @param blockId - The block.
 * @param quote - The words.
 * @returns The aim for {@link commentOn}.
 */
function quoteAim(blockId: string, quote: string): CommentAim {
  return (state) => {
    const block = blockById(state.doc, blockId);
    if (block === null) return null;
    const text = blockPlainText(block.node);
    if (occurrences(text, quote) !== 1) return null;
    const at = text.indexOf(quote);
    return rangesOf(state.doc, blockId, at, at + quote.length);
  };
}

/**
 * Where a whole block's words are.
 * @param blockId - The block.
 * @returns The aim for {@link commentOn}.
 */
function wholeBlockAim(blockId: string): CommentAim {
  return (state) => {
    const block = blockById(state.doc, blockId);
    return block === null ? null : rangesOf(state.doc, blockId, 0, blockPlainText(block.node).length);
  };
}

/**
 * The block holding a position: the innermost block around it.
 * @param doc - The body.
 * @param pos - The position.
 * @returns The block's id, or null when the position is outside every block.
 */
function blockAt(doc: ProseMirrorNode, pos: number): string | null {
  const at = doc.resolve(pos);
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'blockContainer') return String(node.attrs.id);
  }
  return null;
}

/**
 * The block the comment a proposal put on is in now: a thread carrying its id
 * that still has a mark in the body, wherever that mark has moved.
 * @param handle - The document.
 * @param proposalId - The proposal.
 * @returns The block holding the comment's first words, or null when there is none.
 */
function commentBlock(handle: Pick<Landable, 'editor'>, proposalId: string): string | null {
  const threads = commentsOn(handle.editor)?.threadStore.getThreads();
  if (threads === undefined) return null;
  const ids = [...threads.values()]
    .filter((thread) => (thread.metadata as { proposalId?: unknown } | undefined)?.proposalId === proposalId)
    .map((thread) => thread.id);
  if (ids.length === 0) return null;
  const doc = handle.editor.prosemirrorState.doc;
  const marked = threadRangesByThread(doc);
  for (const id of ids) {
    const first = marked.get(id)?.[0];
    if (first !== undefined) return blockAt(doc, first.from);
  }
  return null;
}

/** How a proposal landed, and the block that shows it. */
export interface Landed {
  how: LandingAction;
  blockId: string;
}

/**
 * How a proposal has landed in the document, if it has, and where: the block
 * its comment is in now, or the first block it wrote. A rewrite card counts
 * either. Whether it landed and where it is come from the same trace.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns How and where it landed, or null when it has not.
 */
export function landedAt(handle: Pick<Landable, 'editor'>, proposal: DocumentProposal): Landed | null {
  if (proposal.kind !== 'insert') {
    const blockId = commentBlock(handle, proposal.proposalId);
    if (blockId !== null) return { how: 'comment', blockId };
  }
  if (proposal.kind === 'comment') return null;
  const first = writtenBlockId(proposal.proposalId, 0);
  return blockById(handle.editor.prosemirrorState.doc, first) === null ? null : { how: 'write', blockId: first };
}

/**
 * Why a proposal cannot land in the document as it is now, if anything.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns The outcome to report, or null when it can land.
 */
function blockProblem(handle: Landable, proposal: DocumentProposal): 'blockGone' | 'changed' | null {
  if (proposal.blockId === null) return null;
  const block = blockById(handle.editor.prosemirrorState.doc, proposal.blockId);
  if (block === null) return 'blockGone';
  if (blockPlainText(block.node) !== proposal.original) return 'changed';
  if (proposal.quote !== undefined && quoteAim(proposal.blockId, proposal.quote)(handle.editor.prosemirrorState) === null) {
    return 'changed';
  }
  return null;
}

/**
 * Puts a proposal on as a comment: its own words for a comment card, the
 * rewritten words one paragraph per block for a rewrite card.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns Nothing; whether it landed is read off the body afterwards.
 */
async function landComment(handle: Landable, proposal: DocumentProposal): Promise<void> {
  const blockId = proposal.blockId!;
  const body =
    proposal.kind === 'comment'
      ? asCommentBody(proposal.body)
      : (await markdownBlocks(proposal.body)).flatMap((b) => asCommentBody(b.text) as unknown[]);
  const aim = proposal.quote === undefined ? wholeBlockAim(blockId) : quoteAim(blockId, proposal.quote);
  await commentOn(handle.editor as never, body, aim, {
    thread: { proposalId: proposal.proposalId },
    comment: { fromAgent: true },
  });
}

/**
 * Writes a rewrite or an insert into the body as one undo step.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns Nothing; the blocks are in the body when it resolves.
 */
async function landBlocks(handle: Landable, proposal: DocumentProposal): Promise<void> {
  const parsed = await markdownBlocks(proposal.body);
  const written = parsed.map((b, n) => ({ ...(b.block as object), id: writtenBlockId(proposal.proposalId, n) }));
  const { editor, undoManager } = handle;
  undoManager.stopCapturing();
  if (proposal.kind === 'rewrite') {
    editor.replaceBlocks([proposal.blockId!], written as never);
  } else if (proposal.blockId !== null) {
    editor.insertBlocks(written as never, proposal.blockId, 'after');
  } else {
    // An empty last paragraph is where the end of the document is, not a
    // line to keep above what is added there.
    const last = editor.document[editor.document.length - 1] as { id: string; type: string; content?: unknown; children?: unknown[] };
    const empty = last.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0 && (last.children ?? []).length === 0;
    if (empty) editor.replaceBlocks([last.id], written as never);
    else editor.insertBlocks(written as never, last.id, 'after');
  }
  undoManager.stopCapturing();
}

/**
 * Lands a proposal the reader pressed, after checking it still fits.
 * @param handle - The document, mounted.
 * @param proposal - The proposal.
 * @param action - Whether to put it on as a comment or write it into the body.
 * @param writable - Whether this connection may write.
 * @returns How it ended, and the block to show the reader when it landed.
 */
export async function landProposal(
  handle: Landable,
  proposal: DocumentProposal,
  action: LandingAction,
  writable: boolean,
): Promise<LandingResult> {
  const already = landedAt(handle, proposal);
  if (already !== null) return { outcome: 'applied', blockId: already.blockId };
  if (!writable) return { outcome: 'readOnly' };
  const problem = blockProblem(handle, proposal);
  if (problem !== null) return { outcome: problem };
  try {
    if (action === 'comment') await landComment(handle, proposal);
    else await landBlocks(handle, proposal);
    const landed = landedAt(handle, proposal);
    return landed === null ? { outcome: 'changed' } : { outcome: 'applied', blockId: landed.blockId };
  } catch {
    return { outcome: 'failed' };
  }
}
