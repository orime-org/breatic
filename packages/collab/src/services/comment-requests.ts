// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment requests (breatic#1488 §11.9, §15.8, §15.10, §15.11). The browser
 * sends them on the Space document's own connection, so the document this
 * instance holds already carries the edit a request follows. Each runs under
 * the Space count lock, which Space delete and restore also take: inside it
 * collab checks the Space's content row is live, writes the record and its
 * notification in one transaction, then updates the connection's set of new
 * hand-overs and sends the signals. An external agent's reply answers its
 * hand-over the same way, once its command is stored.
 */

import type * as Y from "yjs";

import {
  agentAccessService,
  commentRecordService,
  createLogger,
  publishAssignmentsChanged,
  publishNotificationsChanged,
  type ThreadPlace,
} from "@breatic/core";
import {
  canvasSpaceDocName,
  documentSpaceDocName,
  type CommentRequest,
  type CommentRequestErrorCode,
  type CommentResponse,
  type ProjectRole,
} from "@breatic/shared";
import { readEntryMentions, readThreadState, type CommentSpaceKind } from "@breatic/shared/space-content";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";
import { addNewAssignment, newAssignmentMember, removeNewAssignment } from "@collab/services/new-assignments.js";
import { SpaceCountLockBusyError, withSpaceCountLock } from "@collab/services/space-count-lock.js";

const logger = createLogger("comment-requests");

/** The Space document a request arrived on, as this instance holds it. */
export interface CommentTarget {
  projectId: string;
  spaceId: string;
  kind: CommentSpaceKind;
  doc: Y.Doc;
}

/** Who sent the request, from the connection's credential. */
export interface CommentCaller {
  userId: string;
  role: ProjectRole;
}

/** A refusal, with the request's id. */
class Refusal extends Error {
  /**
   * A request collab will not carry out, and why.
   * @param code - Why.
   * @param message - What to log and show.
   */
  constructor(
    readonly code: CommentRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommentRequestRefusal";
  }
}

/**
 * Tell the members and the project page what changed. Signals are best
 * effort: the records are already committed and every reader re-reads on
 * reconnect.
 * @param projectId - The project.
 * @param spaceId - The Space whose hand-overs changed, or null when none did.
 * @param notified - The users who got a notification.
 */
async function announce(projectId: string, spaceId: string | null, notified: readonly string[]): Promise<void> {
  try {
    if (spaceId !== null) await publishAssignmentsChanged(projectId, spaceId);
    await publishNotificationsChanged(notified);
  } catch (err) {
    logger.error({ err, ctx: { projectId, spaceId } }, "comment_signal_failed");
  }
}

/**
 * Run a section under the Space count lock, once the Space's content row is
 * known to be live.
 * @param target - The Space.
 * @param section - What to do.
 * @returns What the section returns.
 * @throws {Refusal} When the Space is deleted.
 * @throws {SpaceCountLockBusyError} When another Space change holds the lock too long.
 */
async function underLiveSpace<T>(target: Pick<CommentTarget, "projectId" | "spaceId" | "kind">, section: () => Promise<T>): Promise<T> {
  const name =
    target.kind === "canvas" ? canvasSpaceDocName(target.projectId, target.spaceId) : documentSpaceDocName(target.projectId, target.spaceId);
  return withSpaceCountLock(target.projectId, async () => {
    if (!(await yjsDocumentsRepo.isLiveDoc(name))) throw new Refusal("NOT_FOUND", "This Space was deleted");
    return section();
  });
}

/**
 * Record what one entry mentions now and notify the members it names first.
 * @param target - The Space.
 * @param entryId - The entry.
 * @throws {Refusal} When the entry is not in the document or the Space is deleted.
 */
async function mentioned(target: CommentTarget, entryId: string): Promise<void> {
  const mentions = readEntryMentions(target.kind, target.doc, target.projectId, entryId);
  if (mentions === null) throw new Refusal("NOT_FOUND", "This comment is gone");
  if (mentions.length === 0) return;
  const { notified } = await underLiveSpace(target, () => commentRecordService.recordMentions(target.projectId, target.spaceId, mentions));
  await announce(target.projectId, null, notified);
}

/**
 * Hand a thread to one of the caller's connections.
 * @param target - The Space.
 * @param caller - Who hands it over.
 * @param threadId - The thread.
 * @param connectionId - The connection.
 * @throws {Refusal} When the thread is gone or resolved, the connection is not theirs or not usable, or the Space is deleted.
 */
async function handOver(target: CommentTarget, caller: CommentCaller, threadId: string, connectionId: string): Promise<void> {
  const state = readThreadState(target.kind, target.doc, threadId);
  if (state === "gone") throw new Refusal("NOT_FOUND", "This comment is gone");
  if (state === "resolved") throw new Refusal("CONFLICT", "This comment is resolved");
  if (!(await agentAccessService.isOwnConnectionUsable(connectionId, caller.userId))) {
    throw new Refusal("FORBIDDEN", "This external Agent cannot take it");
  }
  const place: ThreadPlace = { projectId: target.projectId, spaceId: target.spaceId, threadId };
  const member = newAssignmentMember(target.projectId, target.spaceId, threadId);
  await underLiveSpace(target, async () => {
    const { previousConnectionId } = await commentRecordService.handOver(place, { connectionId, assignedBy: caller.userId, assignedAt: Date.now() });
    if (previousConnectionId !== null) await removeNewAssignment(previousConnectionId, member);
    await addNewAssignment(connectionId, member);
  });
  await announce(target.projectId, target.spaceId, []);
}

/**
 * Take a hand-over back.
 * @param target - The Space.
 * @param caller - Who asks; must be the one who handed it over.
 * @param threadId - The thread.
 * @throws {Refusal} When there is no live hand-over, it is someone else's, or the Space is deleted.
 */
async function cancelHandOver(target: CommentTarget, caller: CommentCaller, threadId: string): Promise<void> {
  const place: ThreadPlace = { projectId: target.projectId, spaceId: target.spaceId, threadId };
  await underLiveSpace(target, async () => {
    const result = await commentRecordService.cancelHandOver(place, caller.userId);
    if (!result.ok) {
      throw result.reason === "forbidden"
        ? new Refusal("FORBIDDEN", "Only the one who handed it over can take it back")
        : new Refusal("NOT_FOUND", "This comment is not handed over");
    }
    await removeNewAssignment(result.connectionId, newAssignmentMember(target.projectId, target.spaceId, threadId));
  });
  await announce(target.projectId, target.spaceId, []);
}

/**
 * Handle one comment request.
 * @param target - The Space document it arrived on.
 * @param caller - Who sent it.
 * @param req - The request.
 * @returns The answer to send back on the same connection.
 */
export async function handleCommentRequest(target: CommentTarget, caller: CommentCaller, req: CommentRequest): Promise<CommentResponse> {
  try {
    if (caller.role === "viewer") throw new Refusal("FORBIDDEN", "Viewers cannot change comments");
    if (req.payload.spaceId !== target.spaceId) throw new Refusal("NOT_FOUND", "This comment is in another Space");
    if (req.type === "comment:mentioned") await mentioned(target, req.payload.entryId);
    else if (req.type === "comment:hand-over") await handOver(target, caller, req.payload.threadId, req.payload.connectionId);
    else await cancelHandOver(target, caller, req.payload.threadId);
    return { id: req.id, ok: true };
  } catch (err) {
    if (err instanceof Refusal) return { id: req.id, ok: false, error: { code: err.code, message: err.message } };
    if (err instanceof SpaceCountLockBusyError) return { id: req.id, ok: false, error: { code: "BUSY", message: "Other changes in this project are in progress" } };
    logger.error({ err, ctx: { type: req.type, projectId: target.projectId, spaceId: target.spaceId, userId: caller.userId } }, "comment_request_failed");
    return { id: req.id, ok: false, error: { code: "INTERNAL", message: "Could not save this" } };
  }
}

/**
 * Answer a thread's hand-over for the connection that just replied in it:
 * the record becomes answered, the one who handed it over is told, and the
 * thread leaves the connection's set.
 * @param place - The thread.
 * @param kind - The Space kind.
 * @param connectionId - The connection that replied.
 * @returns Whether the reply answered a hand-over.
 * @throws {Error} When the lock, the database or Redis fails; the command is retried.
 */
export async function answerReply(place: ThreadPlace, kind: CommentSpaceKind, connectionId: string): Promise<boolean> {
  const result = await underLiveSpace({ ...place, kind }, async () => {
    const answered = await commentRecordService.answerHandOver(place, connectionId);
    if (answered.answered) await removeNewAssignment(connectionId, newAssignmentMember(place.projectId, place.spaceId, place.threadId));
    return answered;
  });
  if (result.answered) await announce(place.projectId, place.spaceId, result.notified);
  return result.answered;
}

/**
 * Void a Space's comment records as it is deleted, and take its pending
 * hand-overs out of their connections' sets. Called under the Space count
 * lock, before the delete's broadcast.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns Whether any hand-over changed.
 * @throws {Error} When the database fails; the delete is undone.
 */
export async function voidSpaceRecords(projectId: string, spaceId: string): Promise<{ changed: boolean }> {
  const { pending, changed } = await commentRecordService.voidSpace(projectId, spaceId);
  for (const p of pending) await removeNewAssignment(p.connectionId, newAssignmentMember(projectId, spaceId, p.threadId));
  return { changed };
}

/**
 * Bring back what a Space's delete voided as it is restored, and its pending
 * hand-overs into their connections' sets. Called under the Space count
 * lock, before the restore's broadcast.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns Whether any hand-over changed.
 * @throws {Error} When the database fails; the restore is undone.
 */
export async function restoreSpaceRecords(projectId: string, spaceId: string): Promise<{ changed: boolean }> {
  const { pending, changed } = await commentRecordService.restoreSpace(projectId, spaceId);
  for (const p of pending) await addNewAssignment(p.connectionId, newAssignmentMember(projectId, spaceId, p.threadId));
  return { changed };
}

/**
 * Tell the project's members a Space's hand-overs changed, once its delete
 * or restore has gone out.
 * @param projectId - The project.
 * @param spaceId - The Space.
 */
export async function announceSpaceRecords(projectId: string, spaceId: string): Promise<void> {
  await announce(projectId, spaceId, []);
}
