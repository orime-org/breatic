// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The members a Space document's comments mention and the threads handed to
 * external agents (breatic#1488 §11.6, §11.7), read from the document's
 * bytes. Collab syncs its `comment_mentions` and `comment_assignments` rows
 * from these after each store, and the browser reads the same way.
 *
 * Collaborative data, so every field is read as untrusted.
 */

import * as Y from "yjs";
import { canvasNodesMap } from "@shared/canvas/model/canvas-read.js";
import { documentBodyFragment, documentCommentThreads } from "@shared/document-body.js";

/** The Space kinds that carry comment threads. */
export type CommentSpaceKind = "canvas" | "document";

/** One member mentioned in one comment entry (an annotation body, a reply, a document comment). */
export interface CommentMentionRecord {
  entryId: string;
  threadId: string;
  authorId: string;
  userId: string;
  mentionedAt: number;
}

/** Where a thread handed to an external agent stands. */
export type CommentAssignmentStatus = "pending" | "answered" | "resolved";

/** One thread handed to an external-agent connection. */
export interface CommentAssignmentRecord {
  threadId: string;
  connectionId: string;
  assignedBy: string;
  assignedAt: number;
  status: CommentAssignmentStatus;
}

/** One entry as both readers see it, whatever the Space kind. */
interface Entry {
  id: string;
  authorId: string;
  mentions: unknown;
  via: unknown;
  answers: unknown;
}

/** One thread as both readers see it. */
interface Thread {
  id: string;
  entries: Entry[];
  assignment: unknown;
  resolved: boolean;
}

/** A Yjs mark stored on text: the name, with y-prosemirror's `--hash` suffix on overlapping marks. */
const HASHED_MARK = /^(.*)--[a-zA-Z0-9+/=]{8}$/;

/**
 * A plain object, or undefined.
 * @param value - Anything.
 * @returns It, when it is a non-array object.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * A Yjs map or plain object as a plain object.
 * @param value - A `Y.Map`, a plain object or anything else.
 * @returns Its fields, or undefined.
 */
function fields(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Y.Map ? value.toJSON() : record(value);
}

/**
 * The threads of a canvas: one per annotation node, its body and its replies as entries.
 * @param doc - The canvas Space's document.
 * @returns The threads.
 */
function canvasThreads(doc: Y.Doc): Thread[] {
  const threads: Thread[] = [];
  canvasNodesMap(doc).forEach((node, id) => {
    if (!(node instanceof Y.Map) || node.get("type") !== "annotation") return;
    const data = fields(node.get("data"));
    if (!data) return;
    const body: Entry = { id, authorId: String(data.createdBy ?? ""), mentions: data.mentions, via: undefined, answers: undefined };
    const replies = Array.isArray(data.replies) ? data.replies : [];
    const entries = replies.flatMap((raw): Entry[] => {
      const reply = record(raw);
      return reply && typeof reply.id === "string"
        ? [{ id: reply.id, authorId: String(reply.createdBy ?? ""), mentions: reply.mentions, via: reply.via, answers: reply.answers }]
        : [];
    });
    threads.push({ id, entries: [body, ...entries], assignment: data.assignment, resolved: false });
  });
  return threads;
}

/**
 * The thread ids whose comment mark is on some words of the body, as the
 * editor reads them (y-prosemirror stores a mark as a text attribute).
 * @param doc - The document Space's document.
 * @returns The ids.
 */
function markedThreadIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  /**
   * Collect the marks under one node.
   * @param node - A body node.
   */
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText | Y.XmlHook): void => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
        for (const [key, value] of Object.entries(op.attributes ?? {})) {
          const name = HASHED_MARK.exec(key)?.[1] ?? key;
          const threadId = record(value)?.threadId;
          if (name === "comment" && typeof threadId === "string") ids.add(threadId);
        }
      }
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) node.toArray().forEach(walk);
  };
  walk(documentBodyFragment(doc));
  return ids;
}

/**
 * The threads of a document whose words are still marked, its live comments as entries.
 * @param doc - The document Space's document.
 * @returns The threads.
 */
function documentThreads(doc: Y.Doc): Thread[] {
  const marked = markedThreadIds(doc);
  const threads: Thread[] = [];
  documentCommentThreads(doc).forEach((value, id) => {
    if (!(value instanceof Y.Map) || !marked.has(id)) return;
    const comments = value.get("comments");
    const entries = (comments instanceof Y.Array ? comments.toArray() : []).flatMap((raw): Entry[] => {
      const comment = fields(raw);
      if (!comment || typeof comment.id !== "string" || comment.deletedAt !== undefined) return [];
      const metadata = record(comment.metadata) ?? {};
      return [{ id: comment.id, authorId: String(comment.userId ?? ""), mentions: metadata.mentions, via: metadata.via, answers: metadata.answers }];
    });
    threads.push({ id, entries, assignment: record(value.get("metadata"))?.assignment, resolved: value.get("resolved") === true });
  });
  return threads;
}

/**
 * The threads of a Space document.
 * @param kind - The Space kind.
 * @param doc - Its document.
 * @returns The threads.
 */
function threadsOf(kind: CommentSpaceKind, doc: Y.Doc): Thread[] {
  return kind === "canvas" ? canvasThreads(doc) : documentThreads(doc);
}

/**
 * Every member mentioned in a Space document's comments, as written in this
 * project: one record per entry and member, the first mention kept.
 * @param kind - The Space kind.
 * @param doc - Its document.
 * @param projectId - The project the document belongs to.
 * @returns The mentions.
 */
export function readCommentMentions(kind: CommentSpaceKind, doc: Y.Doc, projectId: string): CommentMentionRecord[] {
  const out: CommentMentionRecord[] = [];
  for (const thread of threadsOf(kind, doc)) {
    for (const entry of thread.entries) {
      const seen = new Set<string>();
      for (const raw of Array.isArray(entry.mentions) ? entry.mentions : []) {
        const m = record(raw);
        if (!m || typeof m.userId !== "string" || m.projectId !== projectId || typeof m.mentionedAt !== "number" || seen.has(m.userId)) continue;
        seen.add(m.userId);
        out.push({ entryId: entry.id, threadId: thread.id, authorId: entry.authorId, userId: m.userId, mentionedAt: m.mentionedAt });
      }
    }
  }
  return out;
}

/**
 * Every thread of a Space document handed to an external agent in this
 * project, and where it stands: answered once a reply written through that
 * connection answers this hand-over, resolved once a document thread is
 * resolved, pending otherwise. A hand-over given in another project, as a
 * project copy carries, is not read.
 * @param kind - The Space kind.
 * @param doc - Its document.
 * @param projectId - The project the document belongs to.
 * @returns The hand-overs.
 */
export function readCommentAssignments(kind: CommentSpaceKind, doc: Y.Doc, projectId: string): CommentAssignmentRecord[] {
  const out: CommentAssignmentRecord[] = [];
  for (const thread of threadsOf(kind, doc)) {
    const a = record(thread.assignment);
    if (!a || a.projectId !== projectId || typeof a.connectionId !== "string" || typeof a.assignedBy !== "string" || typeof a.assignedAt !== "number") continue;
    const { connectionId, assignedBy, assignedAt } = a;
    const answered = thread.entries.some((e) => e.via === connectionId && e.answers === assignedAt);
    out.push({ threadId: thread.id, connectionId, assignedBy, assignedAt, status: answered ? "answered" : thread.resolved ? "resolved" : "pending" });
  }
  return out;
}
