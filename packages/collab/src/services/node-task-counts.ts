// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import type { FocusCropOutcome, FocusImage, NodeTaskCounts, NodeTaskCountsEvent } from "@breatic/shared";
import { CANVAS_NODES_KEY, MAX_FOCUS_ENTRIES, validFocusImages } from "@breatic/shared";
import { writeNodeMedia } from "@breatic/shared";
import { writePlainTextIntoBody } from "@breatic/shared/canvas/text-body";
import { isNewerStreamId } from "@collab/services/stream-id.js";

/** Node field naming the event the node's content last came from. */
export const TASK_RESULT_EVENT_ID_KEY = "taskResultEventId";
/** The first handled planned output, including a result rejected by original stream ordering. */
const MINI_TOOL_RESULT_ORIGIN_KEY = "miniToolResultOrigin";
/** The node's focus crops and the video focus crops collab already handled, by taskId (frames-split §5.5 delivery row). */
const FOCUS_IMAGES_KEY = "focusImages";
const FOCUS_CROP_OUTCOMES_KEY = "focusCropOutcomes";

/**
 * Write the counts, and the content fields when the event carries them, each
 * only when the event is newer than what the node holds (inner#1497 §6.1).
 *
 * Counts and content are versioned apart. A result can arrive after a newer
 * counts-only event and still be the newest content the node has seen; it
 * lands while the newer counts stay.
 * Planned media additionally carries its immutable output identity. Once
 * handled, even as an old event, another transport cannot make it new media.
 * Counts still advance independently; history and later legacy writes remain.
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
 * @param event.resultOrigin - The immutable planned media identity, when present.
 * @param event.focusImageAppend - A landed video focus crop's image, applied whatever the counts version (frames-split §5.5).
 * @param at - Versions.
 * @param at.version - This event's version: its origin id, else its stream id.
 * @param at.countsVersion - The counts version the caller holds for this node.
 * @returns The counts version to hold after this event.
 * @throws {Error} When `at.version` is not a stream id.
 */
export function applyNodeTaskCounts(
  doc: Y.Doc,
  event: Pick<NodeTaskCountsEvent, "nodeId" | "counts" | "result" | "resultOrigin" | "focusImageAppend">,
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
  const origin = result === undefined ? undefined : event.resultOrigin;
  const rememberOrigin = origin !== undefined && !sameResultOrigin(data.get(MINI_TOOL_RESULT_ORIGIN_KEY), origin);
  const writeResult =
    result !== undefined && (origin === undefined || rememberOrigin) && isNewerStreamId(at.version, data.get(TASK_RESULT_EVENT_ID_KEY));
  const heldAfter = countsNewer ? at.version : at.countsVersion;
  const append = focusCropAppend(data, event);
  if (!writeCounts && !writeResult && !rememberOrigin && append === null) return heldAfter;

  doc.transact(() => {
    if (writeCounts) data.set("taskCounts", { ...event.counts });
    if (append !== null) applyFocusCrop(data, append);
    if (writeResult && result !== undefined) {
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
      // The original numeric watermark advances only when media actually lands.
      data.set(TASK_RESULT_EVENT_ID_KEY, at.version);
    }
    // Remember an old-entry decision too, so a new transport cannot upgrade it.
    // Media writes precede both markers; Yjs transactions do not roll back on throw.
    if (rememberOrigin) data.set(MINI_TOOL_RESULT_ORIGIN_KEY, { ...origin });
  });
  return heldAfter;
}

/** A video focus crop's append, decided before the transaction: the image and whether it fits. */
interface FocusCropAppend { taskId: string; image: FocusImage | null; outcome: FocusCropOutcome }

/**
 * Decide a video focus crop's append (frames-split §5.5 delivery row): none for an event without one, for another node or
 * for a taskId the node already marked, so a deferred delivery's second settle and a stream redelivery add nothing; else
 * `added` by the focus image rules (`appendFocusImageCore`), or `refused` when `MAX_FOCUS_ENTRIES` images are held.
 * @param data - The node's data map.
 * @param event - The event.
 * @param event.nodeId - The node the event names.
 * @param event.focusImageAppend - The image to append, when the settle landed.
 * @returns The decision, or null when there is nothing to do.
 * @throws {never} Never.
 */
function focusCropAppend(data: Y.Map<unknown>, event: Pick<NodeTaskCountsEvent, "nodeId" | "focusImageAppend">): FocusCropAppend | null {
  const raw = event.focusImageAppend;
  if (raw === undefined || (raw.nodeId !== undefined && raw.nodeId !== event.nodeId)) return null;
  const [image] = validFocusImages([raw]);
  const taskId = typeof raw.id === "string" ? raw.id : "";
  if (taskId.length === 0 || taskId in outcomesOf(data)) return null;
  if (image === undefined) return { taskId, image: null, outcome: "refused" };
  const held = validFocusImages(snapshot(data.get(FOCUS_IMAGES_KEY)));
  return held.length >= MAX_FOCUS_ENTRIES ? { taskId, image: null, outcome: "refused" } : { taskId, image, outcome: "added" };
}

/**
 * Append a decided focus crop and record its taskId, inside the caller's transaction; the marker keeps the latest
 * `MAX_FOCUS_ENTRIES` taskIds, the oldest dropped.
 * @param data - The node's data map.
 * @param append - The decision.
 * @throws {never} Never.
 */
function applyFocusCrop(data: Y.Map<unknown>, append: FocusCropAppend): void {
  if (append.image !== null) {
    const raw = data.get(FOCUS_IMAGES_KEY);
    // A Y.Array (what the front end seeds on every node) takes a concurrent-safe push; a plain value keeps its encoding,
    // healed of malformed entries in the same write.
    if (raw instanceof Y.Array) (raw as Y.Array<FocusImage>).push([append.image]);
    else data.set(FOCUS_IMAGES_KEY, [...validFocusImages(raw), append.image]);
  }
  const entries = Object.entries(outcomesOf(data));
  entries.push([append.taskId, append.outcome]);
  data.set(FOCUS_CROP_OUTCOMES_KEY, Object.fromEntries(entries.slice(-MAX_FOCUS_ENTRIES)));
}

/**
 * The node's handled focus crops, ignoring anything malformed.
 * @param data - The node's data map.
 * @returns The outcomes by taskId, in the order they were recorded.
 * @throws {never} Never.
 */
function outcomesOf(data: Y.Map<unknown>): Record<string, FocusCropOutcome> {
  const raw = data.get(FOCUS_CROP_OUTCOMES_KEY);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, FocusCropOutcome] => entry[1] === "added" || entry[1] === "refused"));
}

/**
 * A focus images value in either encoding as a plain snapshot for the shared sanitizer.
 * @param raw - The raw value.
 * @returns The snapshot.
 * @throws {never} Never.
 */
function snapshot(raw: unknown): unknown {
  return raw instanceof Y.Array ? raw.toArray() : raw;
}

/**
 * Compare immutable planned identity without treating its tuple as a stream timestamp.
 * @param held - The node's first handled planned result, when present.
 * @param next - The original SQL-derived registered output identity.
 * @returns Whether both identify the same planned output.
 * @throws {never} Never.
 */
function sameResultOrigin(held: unknown, next: NonNullable<NodeTaskCountsEvent["resultOrigin"]>): boolean {
  if (typeof held !== "object" || held === null) return false;
  const value = held as Partial<NonNullable<NodeTaskCountsEvent["resultOrigin"]>>;
  return value.kind === next.kind && value.runId === next.runId
    && value.planFingerprint === next.planFingerprint && value.outputIndex === next.outputIndex;
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
