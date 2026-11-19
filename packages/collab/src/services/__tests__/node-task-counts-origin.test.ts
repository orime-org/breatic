// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { CANVAS_NODES_KEY, writeNodeMedia, type NodeTaskCounts, type NodeTaskResult } from "@breatic/shared";
import { applyNodeTaskCounts, TASK_RESULT_EVENT_ID_KEY } from "@collab/services/node-task-counts.js";

// Independent literal inputs for inner#1306; the origin records first handling,
// including an original stream-order rejection, rather than current authorship.
const NODE_ID = "target-node";
const ORIGIN_KEY = "miniToolResultOrigin";
const ORIGIN = { kind: "mini-tool-output", runId: "10000000-0000-4000-8000-000000000001", planFingerprint: "a".repeat(64), outputIndex: 0 } as const;
const RUNNING: NodeTaskCounts = { running: 1, done: 0, failed: 0, expired: 0 };
const DONE: NodeTaskCounts = { running: 0, done: 1, failed: 0, expired: 0 };
const NEW_COUNTS: NodeTaskCounts = { running: 0, done: 2, failed: 1, expired: 0 };
const W: NodeTaskResult = { content: "https://assets.example.test/result.webm", coverUrl: "https://assets.example.test/result.png", width: 960, height: 540, duration: 5.005, mimeType: "video/webm", size: 1588436 };
const H: NodeTaskResult = { content: "https://assets.example.test/history.mp4", coverUrl: "https://assets.example.test/history.png", width: 640, height: 360, duration: 2, mimeType: "video/mp4", size: 2048 };
const WIRE_W = { content: W.content, coverUrl: W.coverUrl, mediaWidth: 960, mediaHeight: 540, duration: 5.005, mimeType: "video/webm", size: 1588436 };
const WIRE_H = { content: H.content, coverUrl: H.coverUrl, mediaWidth: 640, mediaHeight: 360, duration: 2, mimeType: "video/mp4", size: 2048 };
type PlannedEvent = Parameters<typeof applyNodeTaskCounts>[1] & { resultOrigin: typeof ORIGIN };
const docs: Y.Doc[] = [];

/** Construct a complete event with a test-local extension, without changing production types. */
function planned(counts: NodeTaskCounts = DONE): PlannedEvent {
  return { nodeId: NODE_ID, counts, result: { ...W }, resultOrigin: { ...ORIGIN } };
}

/** Attach real Yjs maps before initializing any node or data fields. */
function fixture(): { doc: Y.Doc; data: Y.Map<unknown> } {
  const doc = new Y.Doc(); docs.push(doc);
  const nodes = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY);
  const node = new Y.Map<unknown>(); nodes.set(NODE_ID, node);
  node.set("type", "video");
  const data = new Y.Map<unknown>(); node.set("data", data);
  data.set("content", H.content); writeNodeMedia(data, H);
  data.set("taskCounts", { ...RUNNING });
  data.set(TASK_RESULT_EVENT_ID_KEY, "50-0");
  return { doc, data };
}

/** Read all media fields and both media watermarks independently of the implementation. */
function state(data: Y.Map<unknown>): Record<string, unknown> {
  return {
    content: data.get("content"), coverUrl: data.get("coverUrl"), mediaWidth: data.get("mediaWidth"), mediaHeight: data.get("mediaHeight"),
    duration: data.get("duration"), mimeType: data.get("mimeType"), size: data.get("size"),
    taskCounts: data.get("taskCounts"), stream: data.get(TASK_RESULT_EVENT_ID_KEY), origin: data.get(ORIGIN_KEY),
  };
}

/** Emit finite fault observations into the captured test log, preserving absent fields explicitly. */
function observePhase(label: string, data: Y.Map<unknown>, countsVersion: string | undefined): void {
  console.info("planned_media_identity_P10", JSON.stringify({ label, state: state(data), countsVersion: countsVersion ?? null }, (_key, value: unknown) => value === undefined ? "<absent>" : value));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const doc of docs.splice(0)) doc.destroy();
});

describe("planned media origin and independent stream watermarks", () => {
  it("P02 stores the exact first-handled tuple with the first real media write", () => {
    const warn = vi.spyOn(console, "warn");
    const { doc, data } = fixture();
    expect(applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined })).toBe("100-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
    expect(warn.mock.calls.flat().filter((value) => String(value).includes("Invalid access"))).toEqual([]);
  });

  it("P02/P06 never rewrites media or its original stream watermark for the same tuple in a newer entry", () => {
    const { doc, data } = fixture();
    applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    const set = vi.spyOn(data, "set"); const remove = vi.spyOn(data, "delete");
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "100-0" })).toBe("300-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
    expect(set.mock.calls).toEqual([]); expect(remove.mock.calls).toEqual([]);
  });

  it("P03 advances changed counts independently without touching media or either media watermark", () => {
    const { doc, data } = fixture();
    applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    const set = vi.spyOn(data, "set"); const remove = vi.spyOn(data, "delete");
    expect(applyNodeTaskCounts(doc, planned(NEW_COUNTS), { version: "300-0", countsVersion: "100-0" })).toBe("300-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: NEW_COUNTS, stream: "100-0", origin: ORIGIN });
    expect(set.mock.calls).toEqual([["taskCounts", NEW_COUNTS]]); expect(remove.mock.calls).toEqual([]);
  });

  it("P04 reuses the resolved original stream version on a consumer retry", () => {
    const { doc, data } = fixture();
    applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    const set = vi.spyOn(data, "set");
    // The listener resolves entry.originId ?? entry.id before calling this owner.
    const deadletterEntry = { id: "900-0", originId: "100-0" };
    expect(applyNodeTaskCounts(doc, planned(), { version: deadletterEntry.originId, countsVersion: "100-0" })).toBe("100-0");
    expect(set.mock.calls).toEqual([]);
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
  });

  it("P07 preserves a history-style content write and its marker against an old planned replay", () => {
    const { doc, data } = fixture();
    applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    doc.transact(() => { data.set("content", H.content); writeNodeMedia(data, H); });
    const set = vi.spyOn(data, "set");
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "100-0" })).toBe("300-0");
    expect(set.mock.calls).toEqual([]);
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
  });

  it("P11 allows a later legacy result and keeps the marker to reject an older logical replay", () => {
    const { doc, data } = fixture();
    applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    expect(applyNodeTaskCounts(doc, { nodeId: NODE_ID, counts: NEW_COUNTS, result: H }, { version: "200-0", countsVersion: "100-0" })).toBe("200-0");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: NEW_COUNTS, stream: "200-0", origin: ORIGIN });
    expect(applyNodeTaskCounts(doc, planned(NEW_COUNTS), { version: "300-0", countsVersion: "200-0" })).toBe("300-0");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: NEW_COUNTS, stream: "200-0", origin: ORIGIN });
  });

  it("P08 does not recreate a deleted target or attach a marker outside a live node", () => {
    const { doc } = fixture(); doc.getMap(CANVAS_NODES_KEY).delete(NODE_ID);
    expect(applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: "50-0" })).toBe("50-0");
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "50-0" })).toBe("50-0");
    expect(doc.getMap(CANVAS_NODES_KEY).toJSON()).toEqual({});
  });

  it("records an original old-entry decision so a newer transport cannot upgrade the same logical result", () => {
    const { doc, data } = fixture(); data.set(TASK_RESULT_EVENT_ID_KEY, "200-0");
    expect(applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: "200-0" })).toBe("200-0");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: RUNNING, stream: "200-0", origin: ORIGIN });
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "200-0" })).toBe("300-0");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: DONE, stream: "200-0", origin: ORIGIN });
  });

  it("does not stamp a counts-only event as a handled media origin", () => {
    const { doc, data } = fixture();
    expect(applyNodeTaskCounts(doc, { nodeId: NODE_ID, counts: DONE }, { version: "100-0", countsVersion: undefined })).toBe("100-0");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: DONE, stream: "50-0", origin: undefined });
  });

  it("keeps stream ms-seq validation independent of the business tuple", () => {
    const { doc, data } = fixture();
    expect(() => applyNodeTaskCounts(doc, planned(), { version: ORIGIN.runId, countsVersion: undefined })).toThrow("not a stream id");
    expect(state(data)).toEqual({ ...WIRE_H, taskCounts: RUNNING, stream: "50-0", origin: undefined });
  });

  it("preserves the tuple and original media version across generated increasing stream IDs", () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 100000 }), fc.integer({ min: 1, max: 100 }), (milliseconds, increment) => {
      const { doc, data } = fixture(); const first = `${milliseconds}-0`; const next = `${milliseconds + increment}-1`;
      applyNodeTaskCounts(doc, planned(), { version: first, countsVersion: undefined });
      expect(applyNodeTaskCounts(doc, planned(NEW_COUNTS), { version: next, countsVersion: first })).toBe(next);
      expect(state(data)).toEqual({ ...WIRE_W, taskCounts: NEW_COUNTS, stream: first, origin: ORIGIN });
    }), { numRuns: 30 });
  });
});

describe("P10 real Yjs exception phases without a rollback assumption", () => {
  it("records a genuine outer observer failure after the media transaction, then retries idempotently", () => {
    const { doc, data } = fixture(); const failure = new Error("outer observer failed once"); let armed = true;
    const observer = (): void => { if (armed) { armed = false; throw failure; } };
    data.observe(observer);
    let held: string | undefined;
    try {
      expect(() => doc.transact(() => { held = applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined }); })).toThrow(failure);
    } finally { data.unobserve(observer); }
    observePhase("outer-observer-after-throw", data, held);
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
    expect(applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: held })).toBe("100-0");
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "100-0" })).toBe("300-0");
    observePhase("outer-observer-after-retries", data, "300-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
  });

  it("records a one-shot content before-write fault without assuming earlier counts rolled back", () => {
    const { doc, data } = fixture(); const failure = new Error("synthetic content before-write"); const original = data.set.bind(data); let armed = true;
    const set = vi.spyOn(data, "set").mockImplementation(<T>(key: string, value: T): T => {
      if (armed && key === "content") { armed = false; throw failure; }
      return original(key, value);
    });
    expect(() => applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined })).toThrow(failure);
    observePhase("content-before-write-after-throw", data, undefined);
    expect(data.get("content")).toBe(H.content); expect(data.get("mediaWidth")).toBe(640);
    expect(data.get(ORIGIN_KEY)).toBeUndefined(); expect(data.get(TASK_RESULT_EVENT_ID_KEY)).toBe("50-0");
    set.mockRestore();
    expect(applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined })).toBe("100-0");
    expect(applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: "100-0" })).toBe("300-0");
    observePhase("content-before-write-after-retries", data, "300-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
  });

  it.each([TASK_RESULT_EVENT_ID_KEY, ORIGIN_KEY])("records a synthetic %s before-write partial state and both retry inputs", (failedKey) => {
    const { doc, data } = fixture(); const failure = new Error(`synthetic ${failedKey} before-write`); const original = data.set.bind(data); let armed = true;
    const successfulKeys: string[] = [];
    const set = vi.spyOn(data, "set").mockImplementation(<T>(key: string, value: T): T => {
      if (armed && key === failedKey) { armed = false; throw failure; }
      const returned = original(key, value); successfulKeys.push(key); return returned;
    });
    let thrown: unknown; let returnedVersion: string | undefined;
    try { returnedVersion = applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined }); }
    catch (error) { thrown = error; }
    observePhase(`${failedKey}-before-write-after-attempt`, data, returnedVersion);
    expect(thrown).toBe(failure);
    expect(successfulKeys).toContain("content"); expect(data.get("content")).toBe(W.content);
    expect(data.get("mediaWidth")).toBe(960); expect(data.get("mediaHeight")).toBe(540);
    expect(data.get(failedKey)).toEqual(failedKey === ORIGIN_KEY ? undefined : "50-0");
    set.mockRestore();
    const same = applyNodeTaskCounts(doc, planned(), { version: "100-0", countsVersion: undefined });
    observePhase(`${failedKey}-before-write-same-entry`, data, same);
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
    const newer = applyNodeTaskCounts(doc, planned(), { version: "300-0", countsVersion: same });
    observePhase(`${failedKey}-before-write-new-entry`, data, newer);
    expect(same).toBe("100-0"); expect(newer).toBe("300-0");
    expect(state(data)).toEqual({ ...WIRE_W, taskCounts: DONE, stream: "100-0", origin: ORIGIN });
    // Partial snapshots do not fix the two set operations' internal order or
    // establish a production trigger for these synthetic before-write faults.
  });
});
