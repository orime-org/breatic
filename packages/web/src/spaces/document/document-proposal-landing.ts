// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing an Agent's document proposal (inner#1509, design §5.4 · §5.5).
 *
 * When the reader presses a card, the proposal is checked against the
 * document as it stands -- the block still there, its words still the ones
 * proposed on -- and written: a comment through the same function a reader's
 * own comment goes through, off the undo stack like theirs; a rewrite or an
 * insert as one BlockNote write, one undo step, whose new blocks take ids
 * derived from the proposal.
 *
 * Those two traces are also how a proposal is known to have landed: a thread
 * carrying its id that still has a mark in the body, or a block with the first
 * id derived from it. Both survive a reload, so a card drawn again knows.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { occurrences, type DocumentProposal } from '@breatic/shared';

import type { WriteAccess } from '@web/data/yjs/collab-socket';
import { BODY_HEADING_LEVELS } from '@web/spaces/document/document-block-type';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { commentOn, type CommentAim } from '@web/spaces/document/document-comment-post';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { ourMediaPrefixReady, ownMediaOnly, type WrittenBlock } from '@web/spaces/document/document-external-media';
import { threadRangesByThread } from '@web/spaces/document/document-comment-ranges';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { markdownBlocks, type MarkdownBlock } from '@web/spaces/document/document-markdown';
import { proposalBlocks, writtenBlockId } from '@web/spaces/document/document-proposal-blocks';
import { blockInTableCell } from '@web/spaces/document/document-table-nodes';
import type { LandingAction } from '@web/stores/document-proposals';


/** How a press ended; a landing that throws is reported as failed by its caller. */
type LandingResult =
  | ({ outcome: 'applied'; leftOut?: number } & Landed)
  | { outcome: 'mediaOnly'; leftOut: number }
  | { outcome: 'readOnly' | 'changed' | 'blockGone' | 'failed' };

/** Current lifecycle and connection permission, read synchronously at commit. */
export type ProposalAdmission = Readonly<{
  available: boolean;
  writeAccess: WriteAccess;
}>;

/** The editor parts landing uses. */
type Landable = Pick<DocumentEditorHandle, 'editor' | 'undoManager'>;

/**
 * A block anywhere in the body, by id.
 * @param doc - The body.
 * @param id - The block id.
 * @returns The block's node (a `blockContainer`, or a table's own node) and where it starts, or null.
 */
function blockById(doc: ProseMirrorNode, id: string): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.isInGroup('bnBlock') && node.attrs.id === id) found = { node, pos };
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
 * The comment a proposal put on, where it is now: a thread carrying its id
 * that still has a mark in the body, wherever that mark has moved.
 * @param handle - The document.
 * @param proposalId - The proposal.
 * @returns The thread and the block holding its first words, or null when there is none.
 */
function commentOf(handle: Pick<Landable, 'editor'>, proposalId: string): { threadId: string; blockId: string } | null {
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
    const blockId = first === undefined ? null : blockAt(doc, first.from);
    if (blockId !== null) return { threadId: id, blockId };
  }
  return null;
}

/**
 * How a proposal landed, and the block that shows it; a comment also names
 * its thread, which is how the panel is opened on it.
 */
export type Landed = { how: 'comment'; blockId: string; threadId: string } | { how: 'write'; blockId: string };

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
    const comment = commentOf(handle, proposal.proposalId);
    if (comment !== null) return { how: 'comment', ...comment };
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
 * The parts of a rewrite that go into a comment made from it: those whose
 * words are not only blanks, the rule a reader's own comment is sent by.
 * @param blocks - The rewrite's blocks.
 * @returns The blocks with words.
 */
export function commentTextOf(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  return blocks.filter((b) => b.text.trim() !== '');
}

/**
 * Prepares comment words without carrying a document target across an await.
 * @param proposal - The proposal.
 * @returns Its comment body.
 * @throws {Error} If Markdown parsing fails.
 */
async function prepareComment(proposal: DocumentProposal): Promise<unknown> {
  return proposal.kind === 'comment'
    ? asCommentBody(proposal.body)
    : commentTextOf(await markdownBlocks(proposal.body)).flatMap((b) => asCommentBody(b.text) as unknown[]);
}

/** The deepest heading level the body shows. */
const DEEPEST_LEVEL = Math.max(...BODY_HEADING_LEVELS);

/**
 * Blocks with every heading deeper than the body shows brought up to its
 * deepest level. Markdown's `####` and an HTML `<h4>` parse to levels the
 * body draws as a plain paragraph, with no row of the block-type menu ticked.
 * @param blocks - The blocks about to be written.
 * @returns The same blocks with their headings within the body's levels.
 */
function withinBodyLevels(blocks: readonly WrittenBlock[]): WrittenBlock[] {
  return blocks.map((block) => {
    const level = block.props?.['level'];
    const held =
      block.type === 'heading' && typeof level === 'number' && level > DEEPEST_LEVEL
        ? { ...block, props: { ...block.props, level: DEEPEST_LEVEL } }
        : block;
    return held.children === undefined ? held : { ...held, children: withinBodyLevels(held.children) };
  });
}

/**
 * Prepares only new payload data, leaving target checks for synchronous commit.
 * @param proposal - The proposal.
 * @returns Its filtered blocks and omitted media count.
 * @throws {Error} If Markdown parsing fails.
 */
async function prepareBlocks(proposal: DocumentProposal): Promise<{ blocks: WrittenBlock[]; leftOut: number }> {
  const parsed = await markdownBlocks(proposal.body);
  const { blocks: kept, count } = ownMediaOnly(parsed.map((b) => b.block as WrittenBlock), await ourMediaPrefixReady());
  return { blocks: withinBodyLevels(kept), leftOut: count };
}

/**
 * Writes prepared output in the target's current context as one undo step.
 * @param handle - The document.
 * @param proposal - The proposal.
 * @param blocks - Its prepared new blocks.
 * @throws {Error} If schema conversion or the atomic block write fails.
 */
function landBlocks(handle: Landable, proposal: DocumentProposal, blocks: readonly WrittenBlock[]): void {
  const { editor, undoManager } = handle;
  const last = editor.document[editor.document.length - 1] as { id: string; type: string; content?: unknown; children?: unknown[] };
  const targetId = proposal.blockId ?? last.id;
  const doc = editor.prosemirrorState.doc;
  const written = proposalBlocks(blocks, doc, blockInTableCell(doc, targetId), proposal.proposalId);
  if (written.length === 0) return;
  undoManager.stopCapturing();
  try {
    if (proposal.kind === 'rewrite') {
      editor.replaceBlocks([targetId], written as never);
    } else if (proposal.blockId !== null) {
      editor.insertBlocks(written as never, targetId, 'after');
    } else {
      // An empty final paragraph is the end gap, not content to retain above it.
      const empty = last.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0 && (last.children ?? []).length === 0;
      if (empty) editor.replaceBlocks([targetId], written as never);
      else editor.insertBlocks(written as never, targetId, 'after');
    }
  } finally {
    undoManager.stopCapturing();
  }
}

/**
 * Reads the lifecycle before deduplication, then admission and current target.
 * @param handle - The current document.
 * @param proposal - The request being checked.
 * @param readAdmission - Reads current request, document and connection facts.
 * @returns An existing landing or refusal, or null when a new write may commit.
 * @throws {Error} If reading admission or document facts fails.
 */
function currentResult(
  handle: Landable,
  proposal: DocumentProposal,
  readAdmission: () => ProposalAdmission,
): LandingResult | null {
  const admission = readAdmission();
  if (!admission.available) return { outcome: 'failed' };
  const already = landedAt(handle, proposal);
  if (already !== null) return { outcome: 'applied', ...already };
  if (admission.writeAccess === 'unknown') return { outcome: 'failed' };
  if (admission.writeAccess === 'denied' || !handle.editor.isEditable) return { outcome: 'readOnly' };
  const problem = blockProblem(handle, proposal);
  return problem === null ? null : { outcome: problem };
}

/**
 * Lands a proposal the reader pressed, after checking it still fits.
 * @param handle - The document, mounted.
 * @param proposal - The proposal.
 * @param action - Whether to put it on as a comment or write it into the body.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended, and the block to show the reader when it landed.
 * @throws {Error} If preparation, comment creation or an atomic block write fails.
 */
export async function landProposal(
  handle: Landable,
  proposal: DocumentProposal,
  action: LandingAction,
  readAdmission: () => ProposalAdmission,
): Promise<LandingResult> {
  const initial = currentResult(handle, proposal, readAdmission);
  if (initial !== null) return initial;
  if (action === 'comment') {
    const body = await prepareComment(proposal);
    const ready = currentResult(handle, proposal, readAdmission);
    if (ready !== null) return ready;
    const blockId = proposal.blockId!;
    const aim = proposal.quote === undefined ? wholeBlockAim(blockId) : quoteAim(blockId, proposal.quote);
    await commentOn(handle.editor as never, body, (state) =>
      currentResult(handle, proposal, readAdmission) === null ? aim(state) : null, {
      thread: { proposalId: proposal.proposalId },
      comment: { fromAgent: true },
    });
    const result = currentResult(handle, proposal, readAdmission);
    return result ?? { outcome: 'changed' };
  }
  const prepared = await prepareBlocks(proposal);
  const ready = currentResult(handle, proposal, readAdmission);
  if (ready !== null) return ready;
  const leftOut = prepared.leftOut;
  landBlocks(handle, proposal, prepared.blocks);
  const landed = landedAt(handle, proposal);
  if (landed !== null) return leftOut > 0 ? { outcome: 'applied', ...landed, leftOut } : { outcome: 'applied', ...landed };
  return leftOut > 0 ? { outcome: 'mediaOnly', leftOut } : { outcome: 'changed' };
}
