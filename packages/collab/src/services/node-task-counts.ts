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
import { CANVAS_NODES_KEY } from "@breatic/shared";

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
 * @param event.result - The five content fields, present only on the
 *   transition that reached `done`.
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

  doc.transact(() => {
    data.set("taskCounts", { ...event.counts });

    const result = event.result;
    if (result === undefined) return;
    data.set("content", result.content);
    data.set("coverUrl", result.coverUrl);
    data.set("width", result.width);
    data.set("height", result.height);
    data.set("duration", result.duration);
  });
}
