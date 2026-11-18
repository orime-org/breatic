// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * After a canvas or document Space is stored, sync its comment records from
 * the stored bytes (breatic#1488 §11.6, §11.7): the members its comments
 * mention, and the threads handed to external agents. Derived after the
 * store from what it stored, as `timeline-receipt-acceptance.ts` does; a
 * failure leaves the records for the next store to correct.
 *
 * A store that lands after its Space left the meta document changes nothing,
 * so a deleted Space's records stay void.
 */

import * as Y from "yjs";
import { commentRecordService, listedContentDocNames, listedContentDocNamesInState, publishAssignmentsChanged } from "@breatic/core";
import { parseDocName, projectMetaDocName } from "@breatic/shared";
import { readCommentAssignments, readCommentMentions, type CommentSpaceKind } from "@breatic/shared/space-content";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

/** A document loaded on this instance, by name. */
export type LoadedDoc = (documentName: string) => Y.Doc | undefined;

/**
 * Whether the project's meta document still lists a Space: the copy loaded
 * on this instance when there is one, the stored one otherwise.
 * @param projectId - The project.
 * @param documentName - The Space's document.
 * @param loadedDoc - Documents loaded on this instance.
 * @returns True while it is listed.
 * @throws {Error} When the stored meta cannot be read.
 */
async function isListed(projectId: string, documentName: string, loadedDoc: LoadedDoc | undefined): Promise<boolean> {
  const loaded = loadedDoc?.(projectMetaDocName(projectId));
  if (loaded) return listedContentDocNames(projectId, loaded.getMap("spaces")).has(documentName);
  const stored = await yjsDocumentsRepo.fetchDocData(projectMetaDocName(projectId));
  return stored !== null && listedContentDocNamesInState(projectId, stored).has(documentName);
}

/**
 * Sync a stored Space's comment records, and announce a change to its
 * hand-overs.
 * @param documentName - The stored document.
 * @param state - The bytes stored.
 * @param loadedDoc - Documents loaded on this instance, for the meta check.
 * @throws {Error} When reading the meta document, the database or Redis fails.
 */
export async function acceptCommentRecords(documentName: string, state: Uint8Array, loadedDoc?: LoadedDoc): Promise<void> {
  const parsed = parseDocName(documentName);
  if (parsed === null || (parsed.kind !== "canvas" && parsed.kind !== "document")) return;
  const { projectId, spaceId } = parsed;
  const kind: CommentSpaceKind = parsed.kind;
  if (!(await isListed(projectId, documentName, loadedDoc))) return;
  const doc = new Y.Doc();
  let read: Parameters<typeof commentRecordService.syncSpace>[2];
  try {
    Y.applyUpdate(doc, state);
    read = { mentions: readCommentMentions(kind, doc, projectId), assignments: readCommentAssignments(kind, doc) };
  } finally {
    doc.destroy();
  }
  const { assignmentsChanged } = await commentRecordService.syncSpace(projectId, spaceId, read);
  if (assignmentsChanged) await publishAssignmentsChanged(projectId, spaceId);
}
