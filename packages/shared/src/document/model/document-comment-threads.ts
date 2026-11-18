// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment threads written outside the editor, in the layout BlockNote's
 * `YjsThreadStore` reads (`threadToYMap`, `commentToYMap`): collab writes
 * an external agent's comments with ids derived from its call, so a repeated
 * delivery lands on the same thread and comment (breatic#1488 §11.3). The
 * shared test reads them back through `YjsThreadStore.getThreads()`, so a
 * layout change in an upgrade turns it red.
 */

import * as Y from "yjs";
import { asCommentBody } from "@shared/document/model/document-comment-body.js";

/**
 * Start a thread with no comment yet.
 * @param threads - The document's threads map.
 * @param id - The thread's id.
 * @returns Its comments, to append the first one to.
 */
export function startCommentThread(threads: Y.Map<unknown>, id: string): Y.Array<Y.Map<unknown>> {
  const now = Date.now();
  const map = new Y.Map<unknown>();
  threads.set(id, map);
  map.set("id", id);
  map.set("createdAt", now);
  map.set("updatedAt", now);
  const comments = new Y.Array<Y.Map<unknown>>();
  map.set("comments", comments);
  map.set("resolved", false);
  map.set("resolvedUpdatedAt", undefined);
  map.set("resolvedBy", undefined);
  map.set("metadata", undefined);
  return comments;
}

/**
 * Append one comment to a thread.
 * @param comments - The thread's comments.
 * @param id - The comment's id.
 * @param userId - Its author.
 * @param text - Its words, as plain text.
 * @param metadata - What it carries beside them.
 */
export function appendThreadComment(
  comments: Y.Array<Y.Map<unknown>>,
  id: string,
  userId: string,
  text: string,
  metadata: Record<string, unknown>,
): void {
  const now = Date.now();
  const map = new Y.Map<unknown>();
  comments.push([map]);
  map.set("id", id);
  map.set("userId", userId);
  map.set("createdAt", now);
  map.set("updatedAt", now);
  map.set("body", asCommentBody(text));
  map.set("reactionsByUser", new Y.Map());
  map.set("metadata", metadata);
}
