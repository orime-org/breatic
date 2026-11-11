// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a comment on a picture, a video or an audio block stands
 * (inner#1316 §5.2).
 *
 * The anchor is the block's id, written on the thread's metadata when the
 * thread is created and never again. The body carries nothing: whether the
 * thread has a place is read off the body every time, as "a media block with
 * that id". What the user sees then follows from what happens to the id:
 * deleting the block takes the place away and an undo writes the same id
 * back; a copy, a paste and a drag that copies all mint fresh ids, so a copy
 * comes without the comment, as copied words do; a drag that moves keeps it.
 *
 * Each thread writes its own entry, so two people commenting on one picture
 * at once both keep their comment. A single attribute on the block listing
 * thread ids would be written by both and settle on one.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
import { rowById, type RowInDocument } from '@web/spaces/document/document-row-by-id';

/** The thread metadata key naming the media block a comment stands on. */
export const MEDIA_BLOCK_ID = 'mediaBlockId';

/** A thread as far as its anchor goes. */
interface AnchoredThread {
  readonly id: string;
  readonly metadata?: unknown;
}

/**
 * The media block a thread's metadata names, if any.
 * @param metadata - The thread's metadata.
 * @returns The block id, or null for a thread on words.
 */
export function mediaBlockIdOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const id = (metadata as Record<string, unknown>)[MEDIA_BLOCK_ID];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The row of a media block with this id, uploaded or not.
 * @param doc - The body.
 * @param blockId - The block id.
 * @returns The row, or undefined when no media block has that id.
 */
export function mediaRowById(doc: PMNode, blockId: string): RowInDocument | undefined {
  const row = rowById(doc, blockId);
  const content = row?.node.type.name === 'blockContainer' ? row.node.firstChild : null;
  return content !== null && isMediaBlockType(content.type.name) ? row : undefined;
}

/**
 * Whether a comment can be written on the block with this id: a media block
 * whose upload has finished. A pending frame takes no comment (§5.1).
 * @param doc - The body.
 * @param blockId - The block id.
 * @returns True when it can.
 */
export function canCommentOnMedia(doc: PMNode, blockId: string): boolean {
  const row = mediaRowById(doc, blockId);
  return row !== undefined && pendingUploadId(row.node.firstChild!.attrs) === null;
}

/**
 * Where each media thread stands now: the whole row of its block. Threads on
 * words, and threads whose block is gone, are left out.
 * @param doc - The body.
 * @param threads - The threads.
 * @returns Thread id to the row's range, in the order the threads came.
 */
export function mediaThreadPositions(
  doc: PMNode,
  threads: Iterable<AnchoredThread>,
): Map<string, { from: number; to: number }> {
  const positions = new Map<string, { from: number; to: number }>();
  for (const thread of threads) {
    const blockId = mediaBlockIdOf(thread.metadata);
    if (blockId === null) continue;
    const row = mediaRowById(doc, blockId);
    if (row !== undefined) positions.set(thread.id, { from: row.from, to: row.to });
  }
  return positions;
}

/**
 * The media block ids threads stand on, read straight from a document's
 * comments map. A deleted thread is gone from the map, so it names nothing.
 * @param threads - The document's comments map.
 * @returns The block ids.
 */
export function anchoredMediaIds(threads: Y.Map<unknown>): Set<string> {
  const ids = new Set<string>();
  threads.forEach((thread) => {
    if (!(thread instanceof Y.Map)) return;
    const blockId = mediaBlockIdOf(thread.get('metadata'));
    if (blockId !== null) ids.add(blockId);
  });
  return ids;
}
