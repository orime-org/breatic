// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What collab does with a task-counts event (#186, design §3.4).
 *
 * The canvas document holds four numbers about tasks and nothing else, so
 * this event carries the whole of them, recounted by the server after every
 * state change. There is no task id on the wire and no per-entry update.
 * Each write happens only when the event is newer than what it replaces: the
 * counts version the caller holds (in DB3), or the node's `taskResultEventId`
 * for the result.
 *
 * The transition that reaches `done` carries the content fields as well,
 * and collab writes both in ONE Yjs transaction. Split across two, there is a
 * moment where the counts say a task succeeded and the node is still empty —
 * and everyone watching that node sees it.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";

let clock = 0;
/** The counts version each document's caller would hold, as the hash in DB3 does. */
const heldCountsVersion = new WeakMap<Y.Doc, string | undefined>();

/**
 * Apply an event the way the task listener does: each event newer than the
 * last, the counts version carried between calls.
 * @param doc - The canvas document.
 * @param event - The event.
 * @param version - Its version; a fresh, newer one when omitted.
 * @returns The counts version held afterwards.
 */
function apply(
  doc: Y.Doc,
  event: Parameters<typeof applyNodeTaskCounts>[1],
  version = `1700-${++clock}`,
): string | undefined {
  const next = applyNodeTaskCounts(doc, event, {
    version,
    countsVersion: heldCountsVersion.get(doc),
  });
  heldCountsVersion.set(doc, next);
  return next;
}

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

    apply(doc, {
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

    apply(doc, {
      nodeId,
      counts: { running: 1, done: 0, failed: 0, expired: 0 },
    });
    apply(doc, {
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

    apply(doc, event);
    apply(doc, event);

    expect(data.get("taskCounts")).toEqual(event.counts);
  });

  it("leaves a node the document does not hold alone", () => {
    const { doc } = docWithNode(crypto.randomUUID());
    expect(() =>
      apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
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

    apply(doc, {
      nodeId,
      counts: first,
      result: { ...result, content: "First." },
    });
    apply(doc, {
      nodeId,
      counts: first,
      result: { ...result, content: "Second." },
    });

    expect(bodyToPlainText(data.get("body") as Y.XmlFragment)).toBe("Second.");
  });
});

describe("applyNodeTaskCounts — nothing new, nothing written", () => {
  const counts = { running: 1, done: 2, failed: 0, expired: 0 };

  it("writes nothing when the counts are the ones the node holds and no result rides along", () => {
    const { doc } = docWithNode("n-1");
    apply(doc, { nodeId: "n-1", counts });
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));

    apply(doc, { nodeId: "n-1", counts: { ...counts } });

    expect(updates).toHaveLength(0);
  });

  it("writes when one count moved", () => {
    const { doc, data } = docWithNode("n-1");
    apply(doc, { nodeId: "n-1", counts });
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));

    apply(doc, { nodeId: "n-1", counts: { ...counts, running: 0, done: 3 } });

    expect(updates.length).toBeGreaterThan(0);
    expect(data.get("taskCounts")).toEqual({ ...counts, running: 0, done: 3 });
  });
});

describe("counts and result each change only for an event newer than their own version", () => {
  const nodeId = "n-1";
  const running = { running: 1, done: 0, failed: 0, expired: 0 };
  const finished = { running: 0, done: 1, failed: 0, expired: 0 };
  const result = {
    coverUrl: null,
    width: 800,
    height: 600,
    duration: null,
    mimeType: null,
    size: null,
  };

  it("keeps the newer counts when an older counts event arrives after them", () => {
    const { doc, data } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: finished }, "1700-5");
    apply(doc, { nodeId, counts: running }, "1700-3");
    expect(data.get("taskCounts")).toEqual(finished);
  });

  it("advances the counts version on a republish of the same counts without writing the document", () => {
    const { doc } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: running }, "1700-1");
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    const held = apply(doc, { nodeId, counts: { ...running } }, "1700-9");
    expect(updates).toHaveLength(0);
    expect(held).toBe("1700-9");
  });

  it("does not let an older event undo counts a newer republish confirmed", () => {
    const { doc, data } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: running }, "1700-1");
    apply(doc, { nodeId, counts: { ...running } }, "1700-9");
    apply(doc, { nodeId, counts: finished }, "1700-5");
    expect(data.get("taskCounts")).toEqual(running);
  });

  it("keeps the newer content when an older result arrives after it", () => {
    const { doc, data } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: finished, result: { ...result, content: "new.png" } }, "1700-7");
    apply(doc, { nodeId, counts: finished, result: { ...result, content: "old.png" } }, "1700-4");
    expect(data.get("content")).toBe("new.png");
    expect(data.get("taskResultEventId")).toBe("1700-7");
  });

  it("writes an older result when no newer one landed, while leaving newer counts alone", () => {
    const { doc, data } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: running }, "1700-8");
    apply(doc, { nodeId, counts: finished, result: { ...result, content: "late.png" } }, "1700-6");
    expect(data.get("content")).toBe("late.png");
    expect(data.get("taskResultEventId")).toBe("1700-6");
    expect(data.get("taskCounts")).toEqual(running);
  });

  it("compares versions as numbers, not as text", () => {
    const { doc, data } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: finished }, "10000-0");
    apply(doc, { nodeId, counts: running }, "9999-5");
    expect(data.get("taskCounts")).toEqual(finished);
  });

  it("keeps the held counts version when the event is older", () => {
    const { doc } = docWithNode(nodeId);
    apply(doc, { nodeId, counts: finished }, "1700-5");
    expect(apply(doc, { nodeId, counts: running }, "1700-3")).toBe("1700-5");
  });
});

describe("a result that cannot be written", () => {
  it("leaves the result version unset, so a retry writes it", () => {
    const nodeId = "n-1";
    const { doc, data } = docWithNode(nodeId, "text");
    const broken = { coverUrl: null, width: null, height: null, duration: null, mimeType: null, size: null, content: 42 };

    expect(() =>
      apply(doc, { nodeId, counts: { running: 0, done: 1, failed: 0, expired: 0 }, result: broken as never }, "1700-9"),
    ).toThrow();
    expect(data.get("taskResultEventId")).toBeUndefined();
  });
});
