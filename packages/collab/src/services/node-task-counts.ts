// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Apply a task-counts event to a canvas document (#186, design §3.4).
 *
 * The document holds four numbers about tasks and nothing else, so the event
 * carries all four, recounted on the server after every state change. Collab
 * writes what it is told: no task ids on the wire, no per-entry merge, no
 * compare-and-set. A number is either the current one or an older one, and
 * the next state change on that node replaces it outright.
 *
 * All judgement happens before the event is published — which task moved,
 * what the counts now are, whether a result rides along. Collab reaches no
 * database and could not judge any of it.
 */

import * as Y from "yjs";
import type { NodeTaskCounts, NodeTaskResult } from "@breatic/shared";
import { CANVAS_NODES_KEY, writePlainTextIntoBody } from "@breatic/shared";

/**
 * Write the counts, and the content fields when the event carries them.
 *
 * Both land in one transaction. Split across two there is a moment where the
 * counts say a task succeeded and the node is still empty, and every client
 * watching that node renders it.
 * A node the document no longer holds is left alone: the user may have
 * deleted it while the task was still running.
 * @param doc - The canvas document.
 * @param event - What the server recounted.
 * @param event.nodeId - The node these counts belong to.
 * @param event.counts - All four, freshly counted from the table.
 * @param event.result - The content fields, present only on the transition
 *   that reached `done`.
 */
export function applyNodeTaskCounts(
  doc: Y.Doc,
  event: { nodeId: string; counts: NodeTaskCounts; result?: NodeTaskResult },
): void {
  const nodes = doc.getMap(CANVAS_NODES_KEY);
  const node = nodes.get(event.nodeId);
  if (!(node instanceof Y.Map)) return;
  const data = node.get("data");
  if (!(data instanceof Y.Map)) return;
  const isText = node.get("type") === "text";

  doc.transact(() => {
    data.set("taskCounts", { ...event.counts });

    const result = event.result;
    if (result === undefined) return;
    if (isText) {
      // A text node holds its words in the `Y.XmlFragment` the editor binds
      // to; its `content` is retired (#1774). Written there, a finished read
      // would reach the node with nothing to render it.
      let body = data.get("body");
      if (!(body instanceof Y.XmlFragment)) {
        body = new Y.XmlFragment();
        data.set("body", body);
      }
      writePlainTextIntoBody(body as Y.XmlFragment, result.content);
      return;
    }
    data.set("content", result.content);
    // The four below are absent on the node when the medium has no such
    // number, which is not the same as holding null: the node's data declares
    // them optional, and a reader that trusts that shape renders whatever is
    // there. Removing is also what takes away an earlier result's numbers when
    // this one replaced the content with a medium that has none.
    setOrRemove(data, "coverUrl", result.coverUrl);
    // `mediaWidth` / `mediaHeight`, not `width` / `height`: those two are a
    // Group's own footprint on the canvas, and every node's fields live in
    // this one map.
    setOrRemove(data, "mediaWidth", result.width);
    setOrRemove(data, "mediaHeight", result.height);
    setOrRemove(data, "duration", result.duration);
    // What the ledger judged off the bytes that landed. The canvas reads both
    // before it will start an Understand run, so a node that lost them to a
    // later result it has no numbers for is a node that can only be gated by
    // guessing — removing is as deliberate here as setting.
    setOrRemove(data, "mimeType", result.mimeType);
    setOrRemove(data, "size", result.size);
  });
}

/**
 * Write one optional field, or take it away when there is no value.
 * @param data - The node's data map.
 * @param key - The field.
 * @param value - What the result carried, null when the medium has none.
 */
function setOrRemove(
  data: Y.Map<unknown>,
  key: string,
  value: string | number | null,
): void {
  if (value === null) data.delete(key);
  else data.set(key, value);
}
