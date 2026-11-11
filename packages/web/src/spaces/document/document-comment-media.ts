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

import { isMediaBlockType, pendingUploadId, type MediaBlockType } from '@web/spaces/document/document-media-types';
import type { RowInDocument } from '@web/spaces/document/document-row-by-id';

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
  return mediaRows(doc, new Set([blockId])).get(blockId);
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
 * The rows of the media blocks with these ids, found in one walk of the body.
 * @param doc - The body.
 * @param ids - The block ids wanted.
 * @returns Block id to row, for each one the body holds.
 */
function mediaRows(doc: PMNode, ids: ReadonlySet<string>): Map<string, RowInDocument> {
  const rows = new Map<string, RowInDocument>();
  if (ids.size === 0) return rows;
  doc.descendants((node, pos) => {
    if (rows.size === ids.size) return false;
    const id = node.attrs['id'];
    if (node.type.name === 'blockContainer' && typeof id === 'string' && ids.has(id) && !rows.has(id)) {
      const content = node.firstChild;
      if (content !== null && isMediaBlockType(content.type.name)) rows.set(id, { node, from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return rows;
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
  const named: [string, string][] = [];
  for (const thread of threads) {
    const blockId = mediaBlockIdOf(thread.metadata);
    if (blockId !== null) named.push([thread.id, blockId]);
  }
  const rows = mediaRows(doc, new Set(named.map(([, blockId]) => blockId)));
  const positions = new Map<string, { from: number; to: number }>();
  for (const [threadId, blockId] of named) {
    const row = rows.get(blockId);
    if (row !== undefined) positions.set(threadId, { from: row.from, to: row.to });
  }
  return positions;
}

/**
 * Where every thread stands: the library's table for comments on words,
 * joined with the media blocks for comments on media. This is the one table
 * the panel's order, cards and count read.
 * @param doc - The body.
 * @param threads - Every thread.
 * @param onWords - The library's position table.
 * @returns Thread id to range.
 */
export function commentPositions<T>(
  doc: PMNode,
  threads: Iterable<AnchoredThread>,
  onWords: ReadonlyMap<string, T>,
): ReadonlyMap<string, T | { from: number; to: number }> {
  const onMedia = mediaThreadPositions(doc, threads);
  if (onMedia.size === 0) return onWords;
  return new Map<string, T | { from: number; to: number }>([...onWords, ...onMedia]);
}

/** What a card shows in place of quoted words, for a comment on media. */
export interface MediaQuote {
  /** The block it stands on. */
  readonly blockId: string;
  readonly type: MediaBlockType;
  /** The block's name, possibly empty. */
  readonly name: string;
  /** Its caption, possibly empty. */
  readonly caption: string;
  /** Where the file is, for a picture's thumbnail. */
  readonly url: string;
}

/** The catalog key of each media kind's name. */
const MEDIA_KIND_KEY: Readonly<Record<MediaBlockType, string>> = {
  image: 'spaces.document.media.image',
  video: 'spaces.document.media.video',
  audio: 'spaces.document.media.audio',
};

/**
 * What a picture, video or audio block is called wherever it is named: its
 * name, else its caption, else its kind (§5.4).
 * @param media - The block's kind, name and caption.
 * @param translate - The catalog lookup.
 * @returns The name.
 */
export function mediaNameOf(
  media: Pick<MediaQuote, 'type' | 'name' | 'caption'>,
  translate: (key: string) => string,
): string {
  return media.name || media.caption || translate(MEDIA_KIND_KEY[media.type]);
}

/**
 * What a card quotes for each of these media blocks, found in one walk of the
 * body.
 * @param doc - The body.
 * @param blockIds - The blocks.
 * @returns Block id to quote, for each media block the body holds.
 */
export function mediaQuotes(doc: PMNode, blockIds: Iterable<string>): Map<string, MediaQuote> {
  const quotes = new Map<string, MediaQuote>();
  for (const [blockId, row] of mediaRows(doc, new Set(blockIds))) {
    const media = row.node.firstChild!;
    /**
     * One of the block's text attributes, empty when unset.
     * @param key - The attribute.
     * @returns Its text.
     */
    const text = (key: string): string => (typeof media.attrs[key] === 'string' ? (media.attrs[key] as string) : '');
    quotes.set(blockId, { blockId, type: media.type.name as MediaBlockType, name: text('name'), caption: text('caption'), url: text('url') });
  }
  return quotes;
}

/**
 * What a card quotes for one media block.
 * @param doc - The body.
 * @param blockId - The block.
 * @returns The quote, or null when the body holds no media block with that id.
 */
export function mediaQuoteOf(doc: PMNode, blockId: string): MediaQuote | null {
  return mediaQuotes(doc, [blockId]).get(blockId) ?? null;
}

/**
 * Whether two media quotes draw the same.
 * @param a - One.
 * @param b - The other.
 * @returns True when both are absent or match field for field.
 */
export function sameMediaQuote(a: MediaQuote | null, b: MediaQuote | null): boolean {
  if (a === null || b === null) return a === b;
  return a.blockId === b.blockId && a.type === b.type && a.name === b.name && a.caption === b.caption && a.url === b.url;
}

/**
 * The element a comment is about in the rendered body: the highlight of a
 * comment on words, or the block of a comment on media.
 * @param root - The editor's element.
 * @param threadId - The thread.
 * @param mediaBlockId - The media block it stands on, or null for words.
 * @returns The element, or null when it is not on the page.
 */
export function commentedElement(root: ParentNode, threadId: string, mediaBlockId: string | null): HTMLElement | null {
  return mediaBlockId === null
    ? root.querySelector<HTMLElement>(`.bn-thread-mark[data-bn-thread-id="${CSS.escape(threadId)}"]`)
    : root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(mediaBlockId)}"]`);
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
