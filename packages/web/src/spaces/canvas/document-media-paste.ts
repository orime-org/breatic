// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Media copied in the document body, pasted onto the canvas (inner#1537).
 *
 * A copy made only of the body's pictures, videos and sounds becomes nodes of
 * those kinds; a copy holding any words stays a text paste. The body's own
 * clipboard type (`blocknote/html`) is out of reach of the menu's Paste, so
 * both entries read the outside HTML the body writes.
 */

import { isStoredObjectUrl } from '@breatic/shared';

import { batchGroupName, batchLayoutAt } from '@web/spaces/canvas/drop-layout';
import type { Point } from '@web/spaces/canvas/group-geometry';
import { CLIPBOARD_VERSION, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

/** A media node type the body can hand over. */
export type DocumentMediaType = 'image' | 'video' | 'audio';

/** One medium the body handed over. */
export interface DocumentMedium {
  readonly type: DocumentMediaType;
  /** The stored address. */
  readonly url: string;
  /** Its caption, else its file name, else empty. */
  readonly name: string;
}

/** What a copy made only of body media holds. */
export interface DocumentMediaPaste {
  readonly media: readonly DocumentMedium[];
  /** Blocks still uploading when copied, which have no address to paste. */
  readonly notPasted: number;
}

/** The media element each node type is written as. */
const TYPE_OF_TAG: Readonly<Record<string, DocumentMediaType>> = { IMG: 'image', VIDEO: 'video', AUDIO: 'audio' };

/** The placeholder BlockNote writes into an empty block so it survives a round trip. */
const EMPTY_BLOCK_PLACEHOLDER = '￼';

/**
 * Whether an element holds nothing: no media and no words. A selection's ends
 * sit in text, so a copy of media takes in the empty edges of its neighbours
 * whatever kind of block they are.
 * @param element - A top-level element.
 * @returns True when it holds nothing.
 */
function holdsNothing(element: Element): boolean {
  if (element.matches('img, video, audio') || element.querySelector('img, video, audio') !== null) return false;
  return (element.textContent ?? '').replaceAll(EMPTY_BLOCK_PLACEHOLDER, '').trim() === '';
}

/**
 * The medium one top-level element is, when it is one from our storage.
 * @param element - A top-level element: a media element, or a figure holding one.
 * @returns The medium, or null.
 */
function mediumOf(element: Element): DocumentMedium | null {
  const media = element.tagName === 'FIGURE' ? element.querySelector('img, video, audio') : element;
  const type = media === null ? undefined : TYPE_OF_TAG[media.tagName];
  if (media === null || type === undefined) return null;
  if (element.tagName === 'FIGURE' && element.children.length > 2) return null;
  const url = media.getAttribute('src') ?? '';
  if (!isStoredObjectUrl(url)) return null;
  // BlockNote puts the block's data attributes on the outermost element: the
  // figure when there is a caption. The caption is the medium's name on the
  // canvas, as a node's name becomes the caption on the way back.
  const caption = element.querySelector('figcaption')?.textContent ?? element.getAttribute('data-caption') ?? '';
  const name = caption.trim() !== '' ? caption : element.getAttribute('data-name') ?? media.getAttribute('alt') ?? '';
  return { type, url, name };
}

/**
 * What a copy's outside HTML holds, when it is only media from the body.
 * @param html - The clipboard's `text/html`.
 * @returns The media in order and how many could not be pasted, or null when
 *   the copy holds anything else.
 */
export function documentMediaPaste(html: string): DocumentMediaPaste | null {
  if (html === '') return null;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const media: DocumentMedium[] = [];
  let notPasted = 0;
  for (const child of body.childNodes) {
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? '').trim() !== '') return null;
      continue;
    }
    if (!(child instanceof Element)) return null;
    if (child.hasAttribute('data-upload-pending')) {
      notPasted += 1;
      continue;
    }
    const medium = mediumOf(child);
    if (medium !== null) media.push(medium);
    else if (!holdsNothing(child)) return null;
  }
  return media.length + notPasted > 0 ? { media, notPasted } : null;
}

/**
 * One clipboard node for a medium.
 * @param medium - The medium.
 * @param id - Its id in the payload.
 * @param position - Its absolute top-left.
 * @param parentId - Its group in the payload, if any.
 * @returns The node.
 */
function nodeOf(medium: DocumentMedium, id: string, position: Point, parentId?: string): ClipboardNode {
  return {
    id,
    type: medium.type,
    position,
    ...(parentId !== undefined && { parentId }),
    // A node with no name takes its type's name when it is cloned.
    data: { ...(medium.name !== '' && { name: medium.name }), content: medium.url },
    original: true,
  };
}

/**
 * The canvas clipboard for body media, laid out the way a batch of files is:
 * one medium centred on the point, two or more four to a row inside a group
 * named after how many there are.
 * @param media - The media, at least one.
 * @param centre - Where the paste lands.
 * @param backgroundColor - The new group's background.
 * @returns The payload `pastePayload` takes.
 */
export function documentMediaPayload(
  media: readonly DocumentMedium[],
  centre: Point,
  backgroundColor: string,
): ClipboardPayload {
  const { tops, frame } = batchLayoutAt(centre, media.length);
  if (frame === null) {
    const node = nodeOf(media[0]!, 'm0', tops[0]!);
    return { version: CLIPBOARD_VERSION, picked: [node.id], nodes: [node], edges: [] };
  }
  const group: ClipboardNode = {
    id: 'g',
    type: 'group',
    position: { x: frame.x, y: frame.y },
    width: frame.width,
    height: frame.height,
    data: { name: batchGroupName(media.length), width: frame.width, height: frame.height, backgroundColor },
    original: true,
  };
  const members = media.map((medium, i) => nodeOf(medium, `m${String(i)}`, tops[i]!, group.id));
  return { version: CLIPBOARD_VERSION, picked: [group.id], nodes: [group, ...members], edges: [] };
}
