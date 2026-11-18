// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The mentions and hand-overs a Space document holds (breatic#1488 §11.6,
 * §11.7), read the same way by collab and the browser.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { readCommentAssignments, readCommentMentions } from "@shared/comment-records.js";
import { canvasNodesMap } from "@shared/canvas/model/canvas-read.js";
import { documentBodyFragment, documentCommentThreads } from "@shared/document-body.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-9222-222222222222";

/**
 * A mention as stored.
 * @param userId - Who is mentioned.
 * @param mentionedAt - When.
 * @param projectId - The project it was written in.
 * @returns The stored value.
 */
function mention(userId: string, mentionedAt = 1, projectId = PROJECT): Record<string, unknown> {
  return { userId, projectId, mentionedAt, label: `@${userId}` };
}

/**
 * Add an annotation node to a canvas document.
 * @param doc - The canvas document.
 * @param id - The node id, which is the thread id.
 * @param data - Its data fields.
 * @param replies - Its replies.
 */
function annotation(doc: Y.Doc, id: string, data: Record<string, unknown>, replies: Array<Record<string, unknown>> = []): void {
  const node = new Y.Map<unknown>();
  canvasNodesMap(doc).set(id, node);
  node.set("id", id);
  node.set("type", "annotation");
  const dataMap = new Y.Map<unknown>();
  node.set("data", dataMap);
  for (const [key, value] of Object.entries({ content: "hi", createdBy: "author", createdAt: 1, ...data })) dataMap.set(key, value);
  const list = new Y.Array<Y.Map<unknown>>();
  dataMap.set("replies", list);
  list.push(
    replies.map((r) => {
      const m = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({ content: "re", createdAt: 2, ...r })) m.set(key, value);
      return m;
    }),
  );
}

/**
 * Add a document thread, and words marked with it in the body unless `marked` is false.
 * @param doc - The document Space's document.
 * @param id - The thread id.
 * @param options - Its parts.
 * @param options.comments - Its comments.
 * @param options.metadata - The thread metadata.
 * @param options.resolved - Whether it is resolved.
 * @param options.marked - Whether the body still marks words with it.
 * @param options.markKey - The attribute key the mark is stored under.
 */
function thread(
  doc: Y.Doc,
  id: string,
  options: {
    comments: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    resolved?: boolean;
    marked?: boolean;
    markKey?: string;
  },
): void {
  const map = new Y.Map<unknown>();
  documentCommentThreads(doc).set(id, map);
  map.set("id", id);
  map.set("resolved", options.resolved ?? false);
  map.set("metadata", options.metadata);
  const comments = new Y.Array<Y.Map<unknown>>();
  map.set("comments", comments);
  comments.push(
    options.comments.map((c) => {
      const m = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(c)) m.set(key, value);
      return m;
    }),
  );
  if (options.marked === false) return;
  const block = new Y.XmlElement("paragraph");
  documentBodyFragment(doc).push([block]);
  const text = new Y.XmlText();
  block.push([text]);
  text.insert(0, "plain ");
  text.insert(6, "marked", { [options.markKey ?? "comment--AbCd1234"]: { threadId: id, orphan: false } });
}

describe("readCommentMentions — canvas", () => {
  it("reads every member mentioned in an annotation's body and replies, with entry, thread and author", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", { mentions: [mention("m1", 10)] }, [{ id: "r1", createdBy: "replier", mentions: [mention("m2", 20)] }]);
    expect(readCommentMentions("canvas", doc, PROJECT)).toEqual([
      { entryId: "a1", threadId: "a1", authorId: "author", userId: "m1", mentionedAt: 10 },
      { entryId: "r1", threadId: "a1", authorId: "replier", userId: "m2", mentionedAt: 20 },
    ]);
  });

  it("drops mentions written in another project, malformed ones, and a second mention of the same member", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", { mentions: [mention("m1", 10, OTHER_PROJECT), { userId: 5 }, mention("m2", 1), mention("m2", 2)] });
    expect(readCommentMentions("canvas", doc, PROJECT)).toEqual([{ entryId: "a1", threadId: "a1", authorId: "author", userId: "m2", mentionedAt: 1 }]);
  });

  it("reads nothing from nodes that are not annotations", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", { mentions: [mention("m1")] });
    canvasNodesMap(doc).get("a1")!.set("type", "text");
    expect(readCommentMentions("canvas", doc, PROJECT)).toEqual([]);
  });
});

describe("readCommentMentions — document", () => {
  it("reads mentions in comments of a thread whose words are still marked, skipping deleted comments", () => {
    const doc = new Y.Doc();
    thread(doc, "t1", {
      comments: [
        { id: "c1", userId: "author", metadata: { mentions: [mention("m1", 5)] } },
        { id: "c2", userId: "author", deletedAt: 9, metadata: { mentions: [mention("m2")] } },
      ],
    });
    expect(readCommentMentions("document", doc, PROJECT)).toEqual([{ entryId: "c1", threadId: "t1", authorId: "author", userId: "m1", mentionedAt: 5 }]);
  });

  it.each(["comment", "comment--AbCd1234"])("finds the thread's mark stored under %s", (markKey) => {
    const doc = new Y.Doc();
    thread(doc, "t1", { markKey, comments: [{ id: "c1", userId: "a", metadata: { mentions: [mention("m1")] } }] });
    expect(readCommentMentions("document", doc, PROJECT)).toHaveLength(1);
  });

  it("reads nothing from a thread whose words are gone", () => {
    const doc = new Y.Doc();
    thread(doc, "t1", { marked: false, comments: [{ id: "c1", userId: "a", metadata: { mentions: [mention("m1")] } }] });
    expect(readCommentMentions("document", doc, PROJECT)).toEqual([]);
  });
});

describe("readCommentAssignments — canvas", () => {
  const assignment = { connectionId: "conn", assignedBy: "giver", assignedAt: 100, projectId: PROJECT };

  it("reads a hand-over as pending until a reply by that connection answers that hand-over", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", { assignment }, [{ id: "r1", createdBy: "giver", via: "conn", answers: 99 }]);
    annotation(doc, "a2", { assignment }, [{ id: "r2", createdBy: "giver", via: "conn", answers: 100 }]);
    annotation(doc, "a3", { assignment }, [{ id: "r3", createdBy: "giver", via: "other", answers: 100 }]);
    expect(readCommentAssignments("canvas", doc, PROJECT)).toEqual([
      { threadId: "a1", connectionId: "conn", assignedBy: "giver", assignedAt: 100, status: "pending" },
      { threadId: "a2", connectionId: "conn", assignedBy: "giver", assignedAt: 100, status: "answered" },
      { threadId: "a3", connectionId: "conn", assignedBy: "giver", assignedAt: 100, status: "pending" },
    ]);
  });

  it("reads nothing from a hand-over given in another project, as a project copy carries", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", { assignment: { ...assignment, projectId: OTHER_PROJECT } });
    annotation(doc, "a2", { assignment: { connectionId: "conn", assignedBy: "giver", assignedAt: 100 } });
    expect(readCommentAssignments("canvas", doc, PROJECT)).toEqual([]);
  });

  it("reads nothing from an annotation with no hand-over or a malformed one", () => {
    const doc = new Y.Doc();
    annotation(doc, "a1", {});
    annotation(doc, "a2", { assignment: { connectionId: "conn", assignedBy: "giver", assignedAt: "soon" } });
    expect(readCommentAssignments("canvas", doc, PROJECT)).toEqual([]);
  });
});

describe("readCommentAssignments — document", () => {
  const assignment = { connectionId: "conn", assignedBy: "giver", assignedAt: 100, projectId: PROJECT };

  it("reads pending, answered and resolved, answered winning over resolved", () => {
    const doc = new Y.Doc();
    const answering = { id: "c2", userId: "giver", metadata: { via: "conn", answers: 100 } };
    thread(doc, "pending", { metadata: { assignment }, comments: [{ id: "c1", userId: "a" }] });
    thread(doc, "answered", { metadata: { assignment }, comments: [{ id: "c1", userId: "a" }, answering] });
    thread(doc, "resolved", { metadata: { assignment }, resolved: true, comments: [{ id: "c1", userId: "a" }] });
    thread(doc, "both", { metadata: { assignment }, resolved: true, comments: [answering] });
    expect(readCommentAssignments("document", doc, PROJECT).map((r) => [r.threadId, r.status])).toEqual([
      ["pending", "pending"],
      ["answered", "answered"],
      ["resolved", "resolved"],
      ["both", "answered"],
    ]);
  });

  it("does not count a deleted answering reply, and reads nothing once the thread's words are gone", () => {
    const doc = new Y.Doc();
    thread(doc, "t1", { metadata: { assignment }, comments: [{ id: "c2", userId: "g", deletedAt: 5, metadata: { via: "conn", answers: 100 } }] });
    thread(doc, "t2", { metadata: { assignment }, marked: false, comments: [{ id: "c1", userId: "a" }] });
    expect(readCommentAssignments("document", doc, PROJECT)).toEqual([{ threadId: "t1", connectionId: "conn", assignedBy: "giver", assignedAt: 100, status: "pending" }]);
  });
});
