// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment threads written outside the editor (collab's external-agent
 * commands, a Space's own server-side writers) must be what BlockNote's
 * `YjsThreadStore` reads back, or the comment panel shows nothing.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";

import { appendThreadComment, startCommentThread } from "@shared/document/model/document-comment-threads.js";
import { documentCommentThreads } from "@shared/document-body.js";

describe("comment threads written outside the editor", () => {
  it("reads back through YjsThreadStore with its comments, authors, bodies and metadata", () => {
    const doc = new Y.Doc();
    const threads = documentCommentThreads(doc);
    doc.transact(() => {
      const comments = startCommentThread(threads, "t1");
      appendThreadComment(comments, "c1", "u1", "First", { via: "conn" });
      appendThreadComment(comments, "c2", "u2", "Second", { via: "conn", answers: 5 });
    });
    const store = new YjsThreadStore("u1", threads, new DefaultThreadStoreAuth("u1", "comment"));
    const thread = store.getThreads().get("t1")!;
    expect(thread).toMatchObject({ id: "t1", resolved: false });
    expect(thread.comments.map((c) => [c.id, c.userId, c.metadata])).toEqual([
      ["c1", "u1", { via: "conn" }],
      ["c2", "u2", { via: "conn", answers: 5 }],
    ]);
    expect(JSON.stringify(thread.comments[0]!.body)).toContain("First");
  });
});
