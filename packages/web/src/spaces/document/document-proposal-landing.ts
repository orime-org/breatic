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
import type { EditorState } from '@tiptap/pm/state';
import { deriveId, type DocumentProposal } from '@breatic/shared';

import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { threadRangesByThread } from '@web/spaces/document/document-comment-ranges';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { markdownBlocks } from '@web/spaces/document/document-markdown';

/** What the reader pressed: put it on as a comment, or write it into the body. */
export type LandingAction = 'comment' | 'write';

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
function quoteAim(blockId: string, quote: string): (state: EditorState) => Array<{ from: number; to: number }> | null {
  return (state) => {
    const block = blockById(state.doc, blockId);
    if (block === null) return null;
    const text = blockPlainText(block.node);
    const at = text.indexOf(quote);
    if (at === -1 || text.indexOf(quote, at + 1) !== -1) return null;
    return rangesOf(state.doc, blockId, at, at + quote.length);
  };
}

/**
 * Where a whole block's words are.
 * @param blockId - The block.
 * @returns The aim for {@link commentOn}.
 */
function wholeBlockAim(blockId: string): (state: EditorState) => Array<{ from: number; to: number }> | null {
  return (state) => {
    const block = blockById(state.doc, blockId);
    return block === null ? null : rangesOf(state.doc, blockId, 0, blockPlainText(block.node).length);
  };
}

/**
 * Whether the comment a proposal put on is in the document, with words to show.
 * @param handle - The document.
 * @param proposalId - The proposal.
 * @returns True when a thread carrying the proposal's id still has a mark.
 */
function commentLanded(handle: Pick<Landable, 'editor'>, proposalId: string): boolean {
  const threads = commentsOn(handle.editor)?.threadStore.getThreads();
  if (threads === undefined) return false;
  const marked = threadRangesByThread(handle.editor.prosemirrorState.doc);
  for (const thread of threads.values()) {
    if ((thread.metadata as { proposalId?: unknown } | undefined)?.proposalId === proposalId && marked.has(thread.id)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a proposal has already landed in the document: its comment is on,
 * or the first block it writes is there. A rewrite card counts either.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns True when it has landed.
 */
export function landedOn(handle: Pick<Landable, 'editor'>, proposal: DocumentProposal): boolean {
  if (proposal.kind !== 'insert' && commentLanded(handle, proposal.proposalId)) return true;
  if (proposal.kind === 'comment') return false;
  return blockById(handle.editor.prosemirrorState.doc, writtenBlockId(proposal.proposalId, 0)) !== null;
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
 * @returns True when the comment was created.
 */
async function landComment(handle: Landable, proposal: DocumentProposal): Promise<boolean> {
  const blockId = proposal.blockId!;
  const body =
    proposal.kind === 'comment'
      ? asCommentBody(proposal.body)
      : (await markdownBlocks(proposal.body)).flatMap((b) => asCommentBody(b.text) as unknown[]);
  const aim = proposal.quote === undefined ? wholeBlockAim(blockId) : quoteAim(blockId, proposal.quote);
  const thread = await commentOn(handle.editor as never, body, aim, {
    thread: { proposalId: proposal.proposalId },
    comment: { fromAgent: true },
  });
  return thread !== null;
}

/**
 * Writes a rewrite or an insert into the body as one undo step.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @returns The id of the first block written.
 */
async function landBlocks(handle: Landable, proposal: DocumentProposal): Promise<string> {
  const parsed = await markdownBlocks(proposal.body);
  const written = parsed.map((b, n) => ({ ...(b.block as object), id: writtenBlockId(proposal.proposalId, n) }));
  const { editor, undoManager } = handle;
  undoManager.stopCapturing();
  if (proposal.kind === 'rewrite') {
    editor.replaceBlocks([proposal.blockId!], written as never);
  } else {
    const anchor = proposal.blockId ?? (editor.document[editor.document.length - 1] as { id: string }).id;
    editor.insertBlocks(written as never, anchor, 'after');
  }
  undoManager.stopCapturing();
  return writtenBlockId(proposal.proposalId, 0);
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
  if (landedOn(handle, proposal)) return { outcome: 'applied', blockId: proposal.blockId ?? writtenBlockId(proposal.proposalId, 0) };
  if (!writable) return { outcome: 'readOnly' };
  const problem = blockProblem(handle, proposal);
  if (problem !== null) return { outcome: problem };
  try {
    if (action === 'comment') {
      return (await landComment(handle, proposal)) ? { outcome: 'applied', blockId: proposal.blockId! } : { outcome: 'changed' };
    }
    return { outcome: 'applied', blockId: await landBlocks(handle, proposal) };
  } catch {
    return { outcome: 'failed' };
  }
}
