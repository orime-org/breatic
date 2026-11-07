// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Landing acceptance after a Timeline store (inner#1711 design §5.1).
 *
 * The browser writes `operationReceipts[actionId]` once the server has accepted an execution. After collab stores
 * the document, the receipts in the bytes it just stored move each matching `awaiting_landing` row of that Project
 * and Space to `queued`: the action, the execution, the input hash, a listed Space, the document's frame rate and the
 * original deadline must all agree. Each accepted row is enqueued under its execution id and signals the Space.
 *
 * A row left waiting is not lost: the next store tries it again, and the worker's sweep ends it at its deadline. A
 * duplicated Project's document carries its source's receipts; they name rows of another Project, which this
 * Project's query never returns.
 */

import * as Y from "yjs";
import {
  TIMELINE_QUEUE,
  addTimelineExecutionJob,
  createLogger,
  createQueue,
  listedContentDocNamesInState,
  publishSpaceTasksChanged,
  timelineExecutionRepo,
} from "@breatic/core";
import { parseDocName, projectMetaDocName, spaceContentDocName, type TimelineExecution, type TimelineRate } from "@breatic/shared";
import { TimelineExecutionInputSchema, readTimelineDocument } from "@breatic/shared/space-content";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

const logger = createLogger("timeline-receipt-acceptance");

type Queue = ReturnType<typeof createQueue>;

let queue: Queue | undefined;

/**
 * The `timeline` queue, opened on first use.
 * @returns It.
 * @throws {never} Never.
 */
function timelineQueue(): Queue {
  queue ??= createQueue(TIMELINE_QUEUE);
  return queue;
}

/**
 * Whether two frame rates are the same rate.
 * @param a - One.
 * @param b - The other.
 * @returns True when they are equal as fractions.
 * @throws {never} Never.
 */
function sameRate(a: TimelineRate, b: TimelineRate): boolean {
  return a.num * b.den === b.num * a.den;
}

/**
 * Whether the Project's stored meta document still lists this Timeline Space.
 * @param projectId - The Project.
 * @param documentName - The Space's content document.
 * @returns True when it is listed.
 * @throws {Error} When the Yjs database read fails.
 */
async function isListed(projectId: string, documentName: string): Promise<boolean> {
  const meta = await yjsDocumentsRepo.fetchDocData(projectMetaDocName(projectId));
  return meta !== null && listedContentDocNamesInState(projectId, meta).has(documentName);
}

/**
 * Land one execution: queue it, enqueue its job and signal the Space. A job that fails to enqueue is added by the
 * worker's sweep, since the row is due at once.
 * @param row - The awaiting row.
 * @returns Nothing.
 * @throws {Error} When the transition fails.
 */
async function land(row: TimelineExecution): Promise<void> {
  const result = await timelineExecutionRepo.transition({ id: row.id, event: { type: "land", inputHash: row.inputHash } });
  if (!result.applied) return;
  try {
    await addTimelineExecutionJob(timelineQueue(), row.id);
  } catch (err) {
    logger.error({ err, executionId: row.id, projectId: row.projectId }, "timeline_execution_enqueue_failed");
  }
  try {
    await publishSpaceTasksChanged(row.projectId, row.spaceId);
  } catch (err) {
    logger.error({ err, executionId: row.id, projectId: row.projectId, spaceId: row.spaceId }, "space_tasks_publish_failed");
  }
}

/**
 * Accept the landing receipts in a Timeline document's stored bytes.
 * @param documentName - The content document just stored.
 * @param state - The bytes that were stored, never the live document.
 * @returns Nothing; a row that cannot land now is left for the next store or the sweep.
 * @throws {Error} When the document cannot be decoded or a database read fails.
 */
export async function acceptTimelineReceipts(documentName: string, state: Uint8Array): Promise<void> {
  const parsed = parseDocName(documentName);
  if (parsed === null || parsed.kind !== "timeline") return;
  const { projectId, spaceId } = parsed;
  const doc = new Y.Doc();
  let receipts: ReturnType<typeof readTimelineDocument>["operationReceipts"];
  let fps: TimelineRate;
  try {
    Y.applyUpdate(doc, state);
    if (!doc.share.has("timeline")) return;
    const document = readTimelineDocument(doc);
    receipts = document.operationReceipts;
    fps = document.settings.fps;
  } finally {
    doc.destroy();
  }
  if (Object.keys(receipts).length === 0) return;

  const awaiting = (await timelineExecutionRepo.listForSpace({ projectId, spaceId })).filter((row) => {
    const receipt = receipts[row.actionId];
    return row.status === "awaiting_landing" && receipt?.executionId === row.id && receipt.inputHash === row.inputHash;
  });
  if (awaiting.length === 0) return;
  if (!(await isListed(projectId, spaceContentDocName(projectId, spaceId, "timeline")))) return;

  for (const row of awaiting) {
    const input = TimelineExecutionInputSchema.safeParse(row.input);
    if (!input.success || !sameRate(input.data.fps, fps)) {
      // The document's rate is fixed at creation; a different one comes only from a client defect.
      logger.error({ executionId: row.id, projectId, spaceId, documentFps: fps, inputFps: input.success ? input.data.fps : null }, "timeline_receipt_fps_mismatch");
      continue;
    }
    if (Date.parse(row.deadlineAt) <= Date.now()) continue;
    try {
      await land(row);
    } catch (err) {
      logger.error({ err, executionId: row.id, projectId, spaceId }, "timeline_receipt_landing_failed");
    }
  }
}
