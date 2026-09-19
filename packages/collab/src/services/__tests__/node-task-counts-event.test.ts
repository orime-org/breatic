// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What collab does with a task-counts event (#186, design §3.4).
 *
 * The canvas document holds four numbers about tasks and nothing else, so
 * this event carries the whole of them, recounted by the server after every
 * state change. There is no task id on the wire, no per-entry update and no
 * compare-and-set: a number is either the current one or an older one, and
 * the next state change on that node replaces it outright.
 *
 * The transition that reaches `done` carries the content fields as well,
 * and collab writes both in ONE Yjs transaction. Split across two, there is a
 * moment where the counts say a task succeeded and the node is still empty —
 * and everyone watching that node sees it.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";
import { bodyToPlainText } from "@breatic/shared";

/**
 * A doc holding one node, shaped the way the canvas stores them: the nodes
 * live in a top-level map named `nodesMap`, each one holding a `data` map.
 */
function docWithNode(
  nodeId: string,
  type = "image",
): { doc: Y.Doc; data: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const nodes = doc.getMap("nodesMap");
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  node.set("type", type);
  node.set("data", data);
  nodes.set(nodeId, node);
  return { doc, data };
}

describe("a counts event replaces what the node holds about tasks", () => {
  it("writes the four numbers", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 2, done: 1, failed: 0, expired: 0 },
    });

    expect(data.get("taskCounts")).toEqual({
      running: 2,
      done: 1,
      failed: 0,
      expired: 0,
    });
  });

  it("replaces rather than merges, so a count can fall to zero", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 1, done: 0, failed: 0, expired: 0 },
    });
    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
    });

    expect(data.get("taskCounts")).toEqual({
      running: 0,
      done: 1,
      failed: 0,
      expired: 0,
    });
  });

  it("applies the same event twice to the same result", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);
    const event = {
      nodeId,
      counts: { running: 0, done: 3, failed: 1, expired: 0 },
    };

    applyNodeTaskCounts(doc, event);
    applyNodeTaskCounts(doc, event);

    expect(data.get("taskCounts")).toEqual(event.counts);
  });

  it("leaves a node the document does not hold alone", () => {
    const { doc } = docWithNode(crypto.randomUUID());
    expect(() =>
      applyNodeTaskCounts(doc, {
        nodeId: crypto.randomUUID(),
        counts: { running: 1, done: 0, failed: 0, expired: 0 },
      }),
    ).not.toThrow();
  });
});

describe("the transition that reaches done also lands the content", () => {
  it("writes the content fields alongside the counts", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "https://example.invalid/out.mp4",
        coverUrl: "https://example.invalid/out.jpg",
        width: 1920,
        height: 1080,
        duration: 12.5,
        mimeType: null,
        size: null,
      },
    });

    expect(data.get("content")).toBe("https://example.invalid/out.mp4");
    expect(data.get("coverUrl")).toBe("https://example.invalid/out.jpg");
    expect(data.get("mediaWidth")).toBe(1920);
    expect(data.get("mediaHeight")).toBe(1080);
    expect(data.get("duration")).toBe(12.5);
  });

  it("writes the type and the byte count the ledger settled on", () => {
    // What the ledger judged off the bytes that landed, which is the only
    // authority on either (storage mandate 4). The canvas gates Understand on
    // both before it builds anything, so a node that does not carry them can
    // only be gated by guessing.
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "https://example.invalid/out.mp4",
        coverUrl: null,
        width: 1920,
        height: 1080,
        duration: 12.5,
        mimeType: "video/mp4",
        size: 4_194_304,
      },
    });

    expect(data.get("mimeType")).toBe("video/mp4");
    expect(data.get("size")).toBe(4_194_304);
  });

  // The node's data declares these optional, never null: absent is how it
  // says a medium has no such number. Writing null puts a third state into a
  // field with two, and a reader that trusts the declared shape renders it —
  // an image node showed "null\u00d7null" where its size belongs.
  it("leaves out what the medium has no number for, rather than writing null", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "https://example.invalid/song.mp3",
        coverUrl: null,
        width: null,
        height: null,
        duration: 30,
        mimeType: null,
        size: null,
      },
    });

    expect(data.has("mediaWidth")).toBe(false);
    expect(data.has("mediaHeight")).toBe(false);
    expect(data.has("coverUrl")).toBe(false);
    expect(data.get("duration")).toBe(30);
  });

  it("takes away what an earlier result left, when the new one has none", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);
    data.set("width", 1920);
    data.set("height", 1080);
    data.set("coverUrl", "https://example.invalid/old.jpg");

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "https://example.invalid/song.mp3",
        coverUrl: null,
        width: null,
        height: null,
        duration: 30,
        mimeType: null,
        size: null,
      },
    });

    expect(data.has("mediaWidth")).toBe(false);
    expect(data.has("mediaHeight")).toBe(false);
    expect(data.has("coverUrl")).toBe(false);
  });

  it("lands both in one transaction, so nobody sees a done count on an empty node", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);

    // Every observer of this document sees whatever a transaction leaves
    // behind, never a half-written state. Snapshot on each one: if the write
    // were split, one snapshot would carry the count without the content.
    const seen: Array<{ done: number; content: unknown }> = [];
    doc.on("afterTransaction", () => {
      const counts = data.get("taskCounts") as
        | { done: number }
        | undefined;
      seen.push({ done: counts?.done ?? 0, content: data.get("content") });
    });

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "https://example.invalid/out.png",
        coverUrl: null,
        width: 800,
        height: 600,
        duration: null,
        mimeType: null,
        size: null,
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      done: 1,
      content: "https://example.invalid/out.png",
    });
  });

  it("leaves the content alone when no result rides along", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);
    data.set("content", "https://example.invalid/earlier.png");

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 0, failed: 1, expired: 0 },
    });

    expect(data.get("content")).toBe("https://example.invalid/earlier.png");
  });
});

describe("a text node holds what it is told in its body", () => {
  // The body is the fragment the editor binds to. A text node's `content` is
  // retired (#1774) — written there, the result would reach the node and
  // nothing would render it.
  it("writes the result into the body, not into content", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId, "text");

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
      result: {
        content: "A red bicycle against a brick wall.",
        coverUrl: null,
        width: null,
        height: null,
        duration: null,
        mimeType: null,
        size: null,
      },
    });

    expect(data.has("content")).toBe(false);
    const body = data.get("body");
    expect(body).toBeInstanceOf(Y.XmlFragment);
    expect(bodyToPlainText(body as Y.XmlFragment)).toBe(
      "A red bicycle against a brick wall.",
    );
  });

  it("replaces what the body held, rather than appending to it", () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId, "text");
    const first = { running: 0, done: 1, failed: 0, expired: 0 };
    const result = {
      coverUrl: null,
      width: null,
      height: null,
      duration: null,
      mimeType: null,
      size: null,
    };

    applyNodeTaskCounts(doc, {
      nodeId,
      counts: first,
      result: { ...result, content: "First." },
    });
    applyNodeTaskCounts(doc, {
      nodeId,
      counts: first,
      result: { ...result, content: "Second." },
    });

    expect(bodyToPlainText(data.get("body") as Y.XmlFragment)).toBe("Second.");
  });
});
