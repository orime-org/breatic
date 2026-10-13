// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Apply a task-counts event to a canvas document (#186, design §3.4).
 *
 * The document holds four numbers about tasks and nothing else, so the event
 * carries all four, recounted on the server after every state change. Collab
 * writes what it is told, but only when the event is newer than what the node
 * holds: the result version sits in the node, the counts version in DB3
 * (inner#1497). Counts and result are versioned apart: an event older than
 * the version it would replace changes nothing.
 *
 * All judgement happens before the event is published — which task moved,
 * what the counts now are, whether a result rides along. Collab reaches no
 * database and could not judge any of it.
 */

import * as Y from "yjs";
import type { NodeTaskCounts, NodeTaskResult } from "@breatic/shared";
import { CANVAS_NODES_KEY } from "@breatic/shared";
import { writeNodeMedia } from "@breatic/shared";
import { writePlainTextIntoBody } from "@breatic/shared/canvas/text-body";
import { isNewerStreamId } from "@collab/services/stream-id.js";

/** Node field naming the event the node's content last came from. */
export const TASK_RESULT_EVENT_ID_KEY = "taskResultEventId";

/**
 * Write the counts, and the content fields when the event carries them, each
 * only when the event is newer than what the node holds (inner#1497 §6.1).
 *
 * Counts and content are versioned apart. A result can arrive after a newer
 * counts-only event and still be the newest content the node has seen; it
 * lands while the newer counts stay.
 *
 * The counts version lives outside the document, in the caller's hands: the
 * server republishes a node's counts whenever its task list is read, and
 * writing a version into the document for each of those would store the
 * document and count it as an edit of the project. A newer event carrying the
 * counts the node already holds only moves the version.
 *
 * What does land, lands in one transaction. Split across two there is a
 * moment where the counts say a task succeeded and the node is still empty,
 * and every client watching that node renders it.
 * A node the document no longer holds is left alone: the user may have
 * deleted it while the task was still running.
 * @param doc - The canvas document.
 * @param event - What the server recounted.
 * @param event.nodeId - The node these counts belong to.
 * @param event.counts - All four, freshly counted from the table.
 * @param event.result - The content fields, present only on the transition
 *   that reached `done`.
 * @param at - Versions.
 * @param at.version - This event's version: its origin id, else its stream id.
 * @param at.countsVersion - The counts version the caller holds for this node.
 * @returns The counts version to hold after this event.
 * @throws {Error} When `at.version` is not a stream id.
 */
export function applyNodeTaskCounts(
  doc: Y.Doc,
  event: { nodeId: string; counts: NodeTaskCounts; result?: NodeTaskResult },
  at: { version: string; countsVersion: string | undefined },
): string | undefined {
  const nodes = doc.getMap(CANVAS_NODES_KEY);
  const node = nodes.get(event.nodeId);
  if (!(node instanceof Y.Map)) return at.countsVersion;
  const data = node.get("data");
  if (!(data instanceof Y.Map)) return at.countsVersion;
  const isText = node.get("type") === "text";

  const countsNewer = isNewerStreamId(at.version, at.countsVersion);
  const writeCounts = countsNewer && !sameCounts(data.get("taskCounts"), event.counts);
  const result = event.result;
  const writeResult =
    result !== undefined && isNewerStreamId(at.version, data.get(TASK_RESULT_EVENT_ID_KEY));
  const heldAfter = countsNewer ? at.version : at.countsVersion;
  if (!writeCounts && !writeResult) return heldAfter;

  doc.transact(() => {
    if (writeCounts) data.set("taskCounts", { ...event.counts });
    if (!writeResult || result === undefined) return;
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
    } else {
      data.set("content", result.content);
      writeNodeMedia(data, result);
    }
    // Last, so a write that throws leaves the version for the retry.
    data.set(TASK_RESULT_EVENT_ID_KEY, at.version);
  });
  return heldAfter;
}

/**
 * Whether the counts a node holds are exactly these.
 * @param held - What the node's `taskCounts` holds, if anything.
 * @param next - The counts just published.
 * @returns True when all four match.
 */
function sameCounts(held: unknown, next: NodeTaskCounts): boolean {
  if (typeof held !== "object" || held === null) return false;
  const h = held as Partial<NodeTaskCounts>;
  return (
    h.running === next.running &&
    h.done === next.done &&
    h.failed === next.failed &&
    h.expired === next.expired
  );
}
