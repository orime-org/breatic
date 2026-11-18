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
  if (!(await isListed(parsed.projectId, documentName, loadedDoc))) return;
  await syncFromState(parsed.projectId, parsed.spaceId, parsed.kind, state);
}

/**
 * Recompute a restored Space's records from its stored content. The restore
 * itself decides the Space is listed again, so no meta check runs.
 * @param projectId - The project.
 * @param spaceId - The restored Space.
 * @param kind - Its type.
 * @param documentName - Its content document.
 * @throws {Error} When the stored content, the database or Redis cannot be reached.
 */
export async function recomputeCommentRecords(projectId: string, spaceId: string, kind: string, documentName: string): Promise<void> {
  if (kind !== "canvas" && kind !== "document") return;
  const state = await yjsDocumentsRepo.fetchDocData(documentName);
  if (state !== null) await syncFromState(projectId, spaceId, kind, state);
}

/**
 * Void a deleted Space's records, and announce it when it had hand-overs.
 * @param projectId - The project.
 * @param spaceId - The deleted Space.
 * @throws {Error} When the database or Redis cannot be reached.
 */
export async function voidCommentRecords(projectId: string, spaceId: string): Promise<void> {
  const { assignmentsChanged } = await commentRecordService.voidSpace(projectId, spaceId);
  if (assignmentsChanged) await publishAssignmentsChanged(projectId, spaceId);
}

/**
 * Sync a Space's records from its document bytes.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param kind - Its type.
 * @param state - Its document bytes.
 * @throws {Error} When the database or Redis cannot be reached.
 */
async function syncFromState(projectId: string, spaceId: string, kind: CommentSpaceKind, state: Uint8Array): Promise<void> {
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
