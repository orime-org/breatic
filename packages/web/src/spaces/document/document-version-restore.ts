// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The body's side of document snapshots (inner#1129 design §7.4, §7.5).
 *
 * A snapshot is the body's ProseMirror JSON, comment marks included, so the
 * comments the body had then come back where they were, as Tiptap's snapshot
 * restore does; the threads themselves are never touched. A restore is one
 * local edit replacing the whole body, not a merge, so it syncs to everyone
 * like typing and one Cmd/Ctrl+Z takes it back.
 *
 * Snapshots carry the `DOCUMENT_SCHEMA_VERSION` they were written in; the
 * schema change that first needs to convert old content does it here, before
 * parsing.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

import { asOneUndoStep, type UndoBoundary } from '@web/spaces/document/document-proposal-landing';
import { pendingUploadId } from '@web/spaces/document/document-media-types';

type Json = Record<string, unknown>;

/** What a restore reads of a comment thread. */
export interface ThreadState {
  readonly resolved?: boolean;
  readonly deletedAt?: unknown;
}

/** Groups whose children are blocks, and which must keep at least one. */
const CELLS = new Set(['docTableCell', 'docTableHeader']);

/**
 * Whether a block is media still uploading, which a snapshot cannot keep.
 * @param block - A `blockContainer`'s JSON.
 * @returns True for a pending upload.
 */
function isUploading(block: Json): boolean {
  const content = (block.content as Json[] | undefined)?.[0];
  return content !== undefined && pendingUploadId((content.attrs ?? {}) as Json) !== null;
}

/**
 * An empty paragraph block, for a cell or body left with none.
 * @returns The block's JSON; its id is assigned when it is written.
 */
function emptyBlock(): Json {
  return { type: 'blockContainer', content: [{ type: 'paragraph' }] };
}

/**
 * A node's JSON without its blocks still uploading.
 * @param node - The node's JSON.
 * @param left - Counts the blocks left out.
 * @param left.out - The count.
 * @returns The JSON to keep.
 */
function withoutUploading(node: Json, left: { out: number }): Json {
  const children = node.content as Json[] | undefined;
  if (children === undefined) return node;
  const kept: Json[] = [];
  for (const child of children) {
    if (child.type === 'blockContainer' && isUploading(child)) {
      left.out += 1;
      // What is nested under it is finished content: it takes the block's place.
      const nested = (child.content as Json[])[1];
      if (nested !== undefined) kept.push(...(withoutUploading(nested, left).content as Json[]));
      continue;
    }
    const next = withoutUploading(child, left);
    if (next.type === 'blockGroup' && (next.content as Json[]).length === 0) {
      // A block's children may go; the body itself keeps one line.
      if (node.type !== 'blockContainer') kept.push({ ...next, content: [emptyBlock()] });
      continue;
    }
    kept.push(next);
  }
  if (kept.length === 0 && CELLS.has(node.type as string)) kept.push(emptyBlock());
  return { ...node, content: kept };
}

/**
 * What a snapshot of the body keeps: its JSON without media still uploading.
 * @param doc - The body.
 * @returns The JSON, and how many uploading blocks were left out.
 */
export function snapshotOf(doc: PMNode): { content: Json; leftOut: number } {
  const left = { out: 0 };
  const content = withoutUploading(doc.toJSON() as Json, left);
  return { content, leftOut: left.out };
}

/**
 * The snapshot's JSON with each comment mark's `orphan` set from the threads
 * as they are now, by the library's own rule: a thread that is gone, resolved
 * or deleted is not painted.
 * @param node - The JSON.
 * @param threads - The document's threads.
 * @returns The JSON to parse.
 */
function withThreadsNow(node: Json, threads: ReadonlyMap<string, ThreadState>): Json {
  const marks = (node.marks as Json[] | undefined)?.map((mark) => {
    if (mark.type !== 'comment') return mark;
    const attrs = (mark.attrs ?? {}) as Json;
    const thread = threads.get(attrs.threadId as string);
    return { ...mark, attrs: { ...attrs, orphan: !thread || thread.resolved === true || Boolean(thread.deletedAt) } };
  });
  const content = (node.content as Json[] | undefined)?.map((child) => withThreadsNow(child, threads));
  return { ...node, ...(marks ? { marks } : {}), ...(content ? { content } : {}) };
}

/** The body a restore writes into. */
export interface Restorable {
  readonly prosemirrorView: EditorView | undefined;
}

/**
 * Replaces the whole body with a snapshot, as one undo step.
 * @param input - Where and what to restore.
 * @param input.editor - The body's editor; its own schema parses the snapshot.
 * @param input.undoManager - The body's undo manager.
 * @param input.content - The snapshot's JSON.
 * @param input.threads - The document's comment threads now, or null when the body has no thread store.
 * @returns `restored`, or `unchanged` when the body already equals the snapshot and nothing was written.
 * @throws {Error} When the body is not mounted or its schema cannot hold the snapshot; nothing is written then.
 */
export function restoreSnapshot(input: {
  editor: Restorable;
  undoManager: UndoBoundary | null;
  content: Json;
  threads: ReadonlyMap<string, ThreadState> | null;
}): 'restored' | 'unchanged' {
  const view = input.editor.prosemirrorView;
  if (!view) throw new Error('document body is not mounted');
  const json = input.threads === null ? input.content : withThreadsNow(input.content, input.threads);
  // Node types compare by identity, so only the body's own schema will do.
  const snapshot = view.state.schema.nodeFromJSON(json);
  snapshot.check();
  const { doc } = view.state;
  if (snapshot.eq(doc)) return 'unchanged';
  const tr = view.state.tr.replaceWith(0, doc.content.size, snapshot.content);
  asOneUndoStep(input.undoManager, () => view.dispatch(tr));
  return 'restored';
}
