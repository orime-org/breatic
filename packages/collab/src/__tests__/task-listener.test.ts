/**
 * Unit tests for `handleHistoryUpdateEvent` in task-listener.ts.
 *
 * Strategy:
 *   - Use real `yjs` (`new Y.Doc()`, `Y.Map`, `Y.Array`) — deterministic, no mocking needed.
 *   - Stub Hocuspocus: `openDirectConnection` returns a fake connection whose
 *     `transact` callback receives the pre-seeded Y.Doc.
 *   - Mock the collab logger so we can assert warn/info calls without file I/O.
 *   - Mock `event-stream` to prevent Redis connections during import.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import type { HistoryUpdateEvent } from "@breatic/shared";

// ── Hoist spy instances so they are available inside vi.mock factories ─────
// vi.mock factories are hoisted to the top of the file by Vitest's transform,
// so variables declared with `const` in module scope are not yet initialized
// when the factory runs. `vi.hoisted` is the correct escape hatch.
const { warnSpy, infoSpy, debugSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

// ── Mock the logger before importing the module under test ────────────────
// `createLogger` returns a child pino logger. We replace it with a factory
// that hands out a plain object with spy methods so we can assert on calls.
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: infoSpy,
    debug: debugSpy,
  }),
}));

// Mock event-stream so importing task-listener doesn't try to connect to Redis.
vi.mock("../event-stream.js", () => ({
  startStreamConsumer: vi.fn(),
}));

// Mock pino — the real pino tries to spawn worker threads for transports
// which can fail in test environments without the file-system setup.
vi.mock("pino", () => ({
  default: vi.fn(() => ({
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
  })),
}));

// Now import the function under test (after mocks are in place).
import { handleHistoryUpdateEvent } from "../task-listener.js";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a seeded Y.Doc that mirrors the canvas structure:
 *
 * ```
 * doc
 *   canvas: Y.Map
 *     nodesMap: Y.Map
 *       [nodeId]: Y.Map
 *         data: Y.Map
 *           history: Y.Array<Y.Map>   ← each entry has at least { id, status }
 * ```
 */
function buildSeededDoc(
  nodeId: string,
  historyItems: Array<Record<string, unknown>>,
): Y.Doc {
  const doc = new Y.Doc();
  const canvasMap = doc.getMap("canvas");

  const nodesMap = new Y.Map();
  canvasMap.set("nodesMap", nodesMap);

  const nodeMap = new Y.Map();
  nodesMap.set(nodeId, nodeMap);

  const dataMap = new Y.Map();
  nodeMap.set("data", dataMap);

  const history = new Y.Array();
  for (const item of historyItems) {
    const itemMap = new Y.Map();
    for (const [k, v] of Object.entries(item)) {
      itemMap.set(k, v);
    }
    history.push([itemMap]);
  }
  dataMap.set("history", history);

  return doc;
}

/**
 * Build a Hocuspocus stub whose `openDirectConnection` delivers
 * `transact` callbacks to the provided pre-built doc.
 */
function buildHocuspocus(doc: Y.Doc): Hocuspocus {
  const transact = vi.fn(async (cb: (doc: Y.Doc) => void) => {
    cb(doc);
  });
  const disconnect = vi.fn(async () => undefined);
  const openDirectConnection = vi.fn(async () => ({ transact, disconnect }));

  return { openDirectConnection } as unknown as Hocuspocus;
}

/** Valid docName matching the `project-{id}` pattern. */
const VALID_DOC_NAME = "project-00000000-0000-0000-0000-000000000001";
const NODE_ID = "node-abc";
const HISTORY_ITEM_ID = "h1";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleHistoryUpdateEvent", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    debugSpy.mockClear();
  });

  // ── Case 1: loading → done ─────────────────────────────────────────────
  it("applies status+url update when history item exists (loading→done)", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      update: { status: "done", url: "https://cdn.example.com/result.png" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    // Verify the Yjs doc was mutated correctly.
    const canvasMap = doc.getMap("canvas");
    const nodesMap = canvasMap.get("nodesMap") as Y.Map<unknown>;
    const nodeMap = nodesMap.get(NODE_ID) as Y.Map<unknown>;
    const dataMap = nodeMap.get("data") as Y.Map<unknown>;
    const history = dataMap.get("history") as Y.Array<Y.Map<unknown>>;
    const item = history.get(0);

    expect(item.get("status")).toBe("done");
    expect(item.get("url")).toBe("https://cdn.example.com/result.png");
    // Original id untouched.
    expect(item.get("id")).toBe(HISTORY_ITEM_ID);
  });

  // ── Case 2: loading → failed ───────────────────────────────────────────
  it("applies status+errorMessage update (loading→failed)", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      update: { status: "failed", errorMessage: "upstream error" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    const history = (
      (
        (doc.getMap("canvas").get("nodesMap") as Y.Map<unknown>)
          .get(NODE_ID) as Y.Map<unknown>
      ).get("data") as Y.Map<unknown>
    ).get("history") as Y.Array<Y.Map<unknown>>;

    const item = history.get(0);
    expect(item.get("status")).toBe("failed");
    expect(item.get("errorMessage")).toBe("upstream error");
  });

  // ── Case 3: allowlist filter ───────────────────────────────────────────
  it("filters disallowed keys and logs droppedKeys", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      update: {
        status: "done",
        url: "https://cdn.example.com/r.png",
        // These are disallowed: id, by (not in WORKER_UPDATABLE_FIELDS)
        id: "OVERWRITE" as never,
        by: { userId: "evil", username: "evil" } as never,
      },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    // Allowed fields applied.
    const history = (
      (
        (doc.getMap("canvas").get("nodesMap") as Y.Map<unknown>)
          .get(NODE_ID) as Y.Map<unknown>
      ).get("data") as Y.Map<unknown>
    ).get("history") as Y.Array<Y.Map<unknown>>;

    const item = history.get(0);
    expect(item.get("status")).toBe("done");
    expect(item.get("url")).toBe("https://cdn.example.com/r.png");

    // Disallowed fields NOT applied.
    expect(item.get("id")).toBe(HISTORY_ITEM_ID); // unchanged
    expect(item.get("by")).toBeUndefined();

    // droppedKeys logged.
    expect(warnSpy).toHaveBeenCalledOnce();
    // pino logger.warn(obj, message) — 2 arguments.
    const [logObj, msg] = warnSpy.mock.calls[0] as [{ droppedKeys: string[] }, string];
    expect(msg).toMatch(/disallowed/i);
    expect(logObj.droppedKeys).toEqual(expect.arrayContaining(["id", "by"]));
    expect(logObj.droppedKeys).toHaveLength(2);
  });

  // ── Case 4: empty filtered update bails before doc load ───────────────
  it("does NOT call openDirectConnection when all keys are disallowed", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      // Only disallowed keys — nothing survives the allowlist filter.
      update: {
        id: "x" as never,
      },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 5: node not found ─────────────────────────────────────────────
  it("warns and returns when nodeId is not in nodesMap", async () => {
    // Doc has no nodes.
    const doc = buildSeededDoc("other-node", [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: "missing-node",
      historyItemId: HISTORY_ITEM_ID,
      update: { status: "done" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    // Should have warned about missing node.
    // pino warn signature: logger.warn(obj, message) — message is arg[1].
    expect(warnSpy).toHaveBeenCalled();
    const warningMessages = (warnSpy.mock.calls as [unknown, string][])
      .map(([, msg]) => msg ?? "");
    expect(warningMessages.some((m) => /not found/i.test(m))).toBe(true);
  });

  // ── Case 6: history item not found ────────────────────────────────────
  it("warns and returns when historyItemId is not in history array", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: "h1", status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      historyItemId: "h999", // does not exist
      update: { status: "done" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    expect(warnSpy).toHaveBeenCalled();
    const warningMessages = (warnSpy.mock.calls as [unknown, string][])
      .map(([, msg]) => msg ?? "");
    expect(warningMessages.some((m) => /not found/i.test(m))).toBe(true);
  });

  // ── Case 7: malformed docName ──────────────────────────────────────────
  it("warns and skips when docName does not match project-{id} pattern", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: "bad-doc-name", // invalid pattern
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      update: { status: "done" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    expect(warnSpy).toHaveBeenCalled();
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 8: unknown event type dispatched via handleNodeEvent ─────────
  // We test the internal guard via the exported handler indirectly:
  // handleHistoryUpdateEvent only handles "history-update"; the unknown-type
  // guard lives in handleNodeEvent. We verify that a legacy docName sub-path
  // (which parseProjectDocName rejects) triggers the same warn+skip path,
  // ensuring forward-compat behaviour is exercised.
  it("legacy sub-path docName (project-id/canvas) is rejected with warn and no connection", async () => {
    const doc = buildSeededDoc(NODE_ID, [{ id: HISTORY_ITEM_ID, status: "loading" }]);
    const hocuspocus = buildHocuspocus(doc);

    const event: HistoryUpdateEvent = {
      type: "history-update",
      // Legacy path — parseProjectDocName returns null for this.
      docName: "project-00000000-0000-0000-0000-000000000001/canvas",
      nodeId: NODE_ID,
      historyItemId: HISTORY_ITEM_ID,
      update: { status: "done" },
    };

    await handleHistoryUpdateEvent(hocuspocus, event);

    expect(warnSpy).toHaveBeenCalled();
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });
});
