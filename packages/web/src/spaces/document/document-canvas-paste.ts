// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a canvas clipboard becomes in the document body (inner#1351 +
 * inner#1390 design §4.3, §5.2, §5.3): text lines and media blocks in reading
 * order, and how many nodes could not be pasted.
 */

import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import type { ClipboardNode, ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { bodyText } from '@web/spaces/canvas/paste-addresses';
import { routeAddress } from '@web/spaces/document/document-media-address';
import { isMediaBlockType, type MediaBlockType } from '@web/spaces/document/document-media-types';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';

/** Where a pasted medium's bytes come from: an address, never a file. */
export type PastedMediaSource = Exclude<UploadSource, { kind: 'file' }>;

/** One media block to insert as pending. */
export interface PastedMedia {
  readonly kind: 'media';
  readonly type: MediaBlockType;
  readonly name: string;
  readonly caption: string;
  /** The node's pixel size, when it has one, so the block keeps its shape while it loads. */
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
  readonly source: PastedMediaSource;
}

/** Lines of text, one paragraph each. */
export interface PastedText {
  readonly kind: 'text';
  readonly lines: readonly string[];
}

/** One item of a paste, in reading order. */
export type PastedItem = PastedMedia | PastedText;

/** What a canvas clipboard becomes. */
export interface CanvasPastePlan {
  readonly items: readonly PastedItem[];
  /** Nodes with content the body cannot take: no content yet, or an address it cannot fetch. */
  readonly notPasted: number;
}

/**
 * The nodes in reading order (§4.3): rows from the top, each row taking every
 * node whose top lies within the first node's height, left to right inside a
 * row, clipboard order on a tie.
 * @param nodes - The content nodes.
 * @returns The same nodes, reordered.
 */
function readingOrder(nodes: readonly ClipboardNode[]): ClipboardNode[] {
  const left = nodes.map((node, index) => ({ node, index }));
  const ordered: ClipboardNode[] = [];
  while (left.length > 0) {
    const first = left.reduce((top, entry) =>
      entry.node.position.y < top.node.position.y ? entry : top,
    );
    const top = first.node.position.y;
    const bottom = top + (first.node.height ?? EMPTY_NODE_SIZE.height);
    const row = left.filter(
      (entry) => entry === first || (entry.node.position.y >= top && entry.node.position.y <= bottom),
    );
    row.sort((a, b) => a.node.position.x - b.node.position.x || a.index - b.index);
    for (const entry of row) {
      ordered.push(entry.node);
      left.splice(left.indexOf(entry), 1);
    }
  }
  return ordered;
}

/**
 * Whether a clipboard node has the shape the canvas writes: a position of two
 * finite numbers, a finite height when it has one, and data. The clipboard
 * is any page's to write, and the marker alone does not make it ours.
 * @param node - The node.
 * @returns True when it can be ordered and read.
 */
function isWellFormed(node: unknown): node is ClipboardNode {
  if (typeof node !== 'object' || node === null) return false;
  const { position, height, data } = node as { position?: { x?: unknown; y?: unknown }; height?: unknown; data?: unknown };
  return (
    Number.isFinite(position?.x) &&
    Number.isFinite(position?.y) &&
    (height === undefined || Number.isFinite(height)) &&
    typeof data === 'object' &&
    data !== null
  );
}

/**
 * A text field of a node's data, or empty.
 * @param data - The data.
 * @param key - The field.
 * @returns The string.
 */
function text(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

/**
 * What one content node becomes, or null when it cannot be pasted.
 * @param node - The node.
 * @returns The item, or null.
 */
function itemOf(node: ClipboardNode): PastedItem | null {
  if (node.type === 'text') {
    const words = bodyText(node.data['body']);
    return words === '' ? null : { kind: 'text', lines: words.split('\n') };
  }
  if (!isMediaBlockType(node.type)) return null;
  const content = text(node.data, 'content');
  if (content === '') return null;
  const name = text(node.data, 'name');
  const { type } = node;
  const { mediaWidth, mediaHeight } = node.data;
  const size =
    typeof mediaWidth === 'number' && typeof mediaHeight === 'number' ? { mediaWidth, mediaHeight } : {};
  if (node.external === true) {
    return routeAddress(content) === 'skip'
      ? null
      : { kind: 'media', type, name, caption: name, ...size, source: { kind: 'address', url: content } };
  }
  const coverUrl = text(node.data, 'coverUrl');
  return {
    kind: 'media',
    type,
    name,
    caption: name,
    ...size,
    source: { kind: 'ours', url: content, ...(coverUrl !== '' && { coverUrl }) },
  };
}

/**
 * What a canvas clipboard becomes in the body. A node of a broken shape is
 * counted as not pasted whatever its type. Well-formed groups and stickies
 * are not content and are not counted: a group's members land on their own.
 * @param payload - The parsed clipboard.
 * @returns The items in reading order and the count of nodes left out.
 */
export function planCanvasPaste(payload: ClipboardPayload): CanvasPastePlan {
  const readable = payload.nodes.filter(isWellFormed);
  const content = readable.filter((node) => node.type !== 'group' && node.type !== 'annotation');
  const items: PastedItem[] = [];
  let notPasted = payload.nodes.length - readable.length;
  for (const node of readingOrder(content)) {
    const item = itemOf(node);
    if (item === null) notPasted += 1;
    else items.push(item);
  }
  return { items, notPasted };
}
