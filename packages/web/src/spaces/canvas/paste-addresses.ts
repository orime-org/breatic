// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a paste sends to the server and how its answer is written back
 * (inner#1349, design 5.4 and 5.10).
 *
 * Every string anywhere in a copy that names an object in our storage is sent,
 * so a field added to nodes later is registered and rewritten without anyone
 * listing it. A video and its cover travel as a pair — the node's own
 * `content` + `coverUrl`, and any object holding a stored `url` with a stored
 * `cover` (a slot) — because the server registers the cover with the video it
 * belongs to.
 */

import { isStoredObjectUrl } from '@breatic/shared';

import type { PasteHistoryItem } from '@web/data/api/canvas';
import type { SnapshotNode } from '@web/data/yjs/canvas-space';

/** A video (or audio) address and its cover. */
export interface AddressPair {
  url: string;
  cover: string;
}

/** The addresses one paste sends. */
export interface PasteAddresses {
  /** Addresses that are not one half of a pair, each once. */
  urls: string[];
  /** Video and cover pairs, each once. */
  pairs: AddressPair[];
}

/** Node types whose `content` is a media address. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio']);

/**
 * Whether a value is a plain record.
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect the storage addresses of a set of copies.
 * @param nodes - The copies.
 * @returns Standalone addresses and video/cover pairs.
 */
export function collectAddresses(nodes: ReadonlyArray<SnapshotNode>): PasteAddresses {
  const urls = new Set<string>();
  const pairs = new Map<string, AddressPair>();
  /**
   * Record a pair once.
   * @param url - The media address.
   * @param cover - Its cover.
   */
  const pair = (url: string, cover: string): void => {
    pairs.set(`${url}\n${cover}`, { url, cover });
  };
  /**
   * Walk a value, collecting addresses.
   * @param value - Any snapshot value.
   */
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (isStoredObjectUrl(value)) urls.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    const { url, cover } = value;
    const paired = typeof url === 'string' && typeof cover === 'string' && isStoredObjectUrl(url) && isStoredObjectUrl(cover);
    if (paired) pair(url, cover);
    for (const [key, entry] of Object.entries(value)) {
      if (paired && (key === 'url' || key === 'cover')) continue;
      walk(entry);
    }
  };
  for (const node of nodes) {
    const { content, coverUrl } = node.data;
    const paired =
      typeof content === 'string' && typeof coverUrl === 'string' && isStoredObjectUrl(content) && isStoredObjectUrl(coverUrl);
    if (paired) pair(content, coverUrl);
    for (const [key, entry] of Object.entries(node.data)) {
      if (paired && (key === 'content' || key === 'coverUrl')) continue;
      walk(entry);
    }
  }
  return { urls: [...urls], pairs: [...pairs.values()] };
}

/**
 * Rewrite every mapped address in a set of copies. An address mapped to
 * `null` (a cover that could not be registered) is removed from a field and
 * cleared in an element attribute.
 * @param nodes - The copies.
 * @param map - Old address → new address, or null.
 * @returns The rewritten copies.
 */
export function replaceAddresses(
  nodes: ReadonlyArray<SnapshotNode>,
  map: ReadonlyMap<string, string | null>,
): SnapshotNode[] {
  /**
   * Rewrite a value.
   * @param value - Any snapshot value.
   * @param keepNull - Whether a field mapped to null stays as null (element attributes).
   * @returns The rewritten value; `undefined` drops a field.
   */
  const walk = (value: unknown, keepNull: boolean): unknown => {
    if (typeof value === 'string') {
      if (!map.has(value)) return value;
      const next = map.get(value) ?? null;
      return next === null && !keepNull ? undefined : next;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry, keepNull));
    if (!isRecord(value)) return value;
    // An element's attributes keep a cleared address as null; the editor
    // reads a missing attribute and a null one the same way.
    const inElement = typeof value.el === 'string';
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = walk(entry, keepNull || (inElement && key === 'attrs'));
      if (next !== undefined) out[key] = next;
    }
    return out;
  };
  return nodes.map((node) => ({ ...node, data: walk(node.data, false) as Record<string, unknown> }));
}

/**
 * The words of a text body tree, one line per block.
 * @param body - The body tag from a snapshot.
 * @returns Its plain text.
 */
function bodyText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.children)) return '';
  /**
   * The text inside one element.
   * @param node - A tree node.
   * @returns Its text.
   */
  const inner = (node: unknown): string => {
    if (!isRecord(node)) return '';
    if (Array.isArray(node.text)) {
      return node.text.map((op) => (isRecord(op) && typeof op.insert === 'string' ? op.insert : '')).join('');
    }
    return Array.isArray(node.children) ? node.children.map(inner).join('') : '';
  };
  return body.children.map(inner).join('\n');
}

/**
 * The history each copy gets: a media copy with content gets an upload row
 * described by its own numbers; a text copy with words gets a snapshot row.
 * @param nodes - The copies.
 * @returns One item per copy that has something to record.
 */
export function historyItems(nodes: ReadonlyArray<SnapshotNode>): PasteHistoryItem[] {
  const items: PasteHistoryItem[] = [];
  for (const node of nodes) {
    const data = node.data;
    if (node.type === 'text') {
      const words = bodyText(data.body);
      if (words.trim().length > 0) items.push({ node_id: node.id, kind: 'text', content: words });
      continue;
    }
    if (!MEDIA_TYPES.has(node.type) || typeof data.content !== 'string' || data.content === '') continue;
    items.push({
      node_id: node.id,
      kind: 'media',
      content: data.content,
      ...(typeof data.coverUrl === 'string' ? { coverUrl: data.coverUrl } : {}),
      ...(typeof data.mediaWidth === 'number' ? { width: data.mediaWidth } : {}),
      ...(typeof data.mediaHeight === 'number' ? { height: data.mediaHeight } : {}),
      ...(typeof data.mimeType === 'string' ? { mimeType: data.mimeType } : {}),
      ...(typeof data.size === 'number' ? { size: data.size } : {}),
      ...(typeof data.duration === 'number' ? { duration: data.duration } : {}),
    });
  }
  return items;
}
