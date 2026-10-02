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
