// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The six media fields a result puts on a node besides its content (#2184).
 *
 * Two writers put a result on a node: collab when a task settles, and the
 * canvas when a reader restores a history row or replaces from the task list.
 * Both go through this function, so the same result leaves the node holding
 * the same fields whichever way it arrived.
 */

import type * as Y from 'yjs';

import type { NodeTaskResult } from '@shared/types/canvas-node.js';

/** A result's media fields, everything it carries besides the content. */
export type NodeMediaFields = Omit<NodeTaskResult, 'content'>;

/** The node-data keys {@link writeNodeMedia} owns, which describe the content itself. */
export const NODE_MEDIA_KEYS = ['coverUrl', 'mediaWidth', 'mediaHeight', 'duration', 'mimeType', 'size'] as const;

/** The six media fields as a node holds them. */
export interface NodeMediaData {
  coverUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
  mimeType?: string;
  size?: number;
}

/** Which of {@link NodeMediaData}'s fields hold text; the rest hold numbers. */
const TEXT_MEDIA_KEYS: ReadonlySet<string> = new Set(['coverUrl', 'mimeType']);

/**
 * Read the media fields off an untyped record, keeping each one only when it
 * holds the type the node declares for it.
 * @param source - A node's data, or a payload that claims to carry one.
 * @returns The fields that passed.
 */
export function readNodeMedia(source: Readonly<Record<string, unknown>>): NodeMediaData {
  const out: Record<string, string | number> = {};
  for (const key of NODE_MEDIA_KEYS) {
    const value = source[key];
    if (TEXT_MEDIA_KEYS.has(key) ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value as string | number;
    }
  }
  return out;
}

/**
 * Write a result's media fields onto a node, removing each one it has no value
 * for.
 *
 * A field the medium has no number for is absent on the node, which is not the
 * same as holding null: the node's data declares these optional and a reader
 * renders whatever is there. Removing is also what takes the previous result's
 * numbers away when this one has none. `width` / `height` land as
 * `mediaWidth` / `mediaHeight`, since `width` / `height` are a Group's own
 * footprint on the canvas and every node's fields share one map.
 * @param data - The node's data map.
 * @param media - The result's media fields.
 */
export function writeNodeMedia(data: Y.Map<unknown>, media: NodeMediaFields): void {
  setOrRemove(data, 'coverUrl', media.coverUrl);
  setOrRemove(data, 'mediaWidth', media.width);
  setOrRemove(data, 'mediaHeight', media.height);
  setOrRemove(data, 'duration', media.duration);
  setOrRemove(data, 'mimeType', media.mimeType);
  setOrRemove(data, 'size', media.size);
}

/**
 * Write one optional field, or take it away when there is no value.
 * @param data - The node's data map.
 * @param key - The field.
 * @param value - The value, null when the medium has none.
 */
function setOrRemove(data: Y.Map<unknown>, key: string, value: string | number | null): void {
  if (value === null) data.delete(key);
  else data.set(key, value);
}
