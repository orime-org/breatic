/**
 * Unit tests for `handleNodeStateUpdateEvent` in task-listener.ts.
 *
 * Strategy:
 *   - Use real `yjs` (`new Y.Doc()`, `Y.Map`) — deterministic, no mocking needed.
 *   - Stub Hocuspocus: `openDirectConnection` returns a fake connection whose
 *     `transact` callback receives the pre-seeded Y.Doc.
 *   - Mock the collab logger so we can assert warn/info calls without file I/O.
 *   - Mock `event-stream` to prevent Redis connections during import.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import type { NodeStateUpdateEvent } from "@breatic/shared";

// ── Hoist spy instances so they are available inside vi.mock factories ─────
// vi.mock factories are hoisted to the top of the file by Vitest's transform,
// so variables declared with `const` in module scope are not yet initialized
// when the factory runs. `vi.hoisted` is the correct escape hatch.
const { warnSpy, infoSpy, debugSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

// ── Mock the logger before importing the module under test ────────────────
// `createLogger` returns a child pino logger. We replace it with a factory
// that hands out a plain object with spy methods so we can assert on calls.
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: infoSpy,
    debug: debugSpy,
    error: errorSpy,
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
import { handleNodeStateUpdateEvent } from "../task-listener.js";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a seeded Y.Doc that mirrors the v10 multi-doc canvas
 * structure:
 *
 * ```
 * doc                     ← `project-{pid}/canvas-{spaceId}`
 *   nodesMap: Y.Map       ← top-level (no `canvas` wrapper Map)
 *     [nodeId]: Y.Map
 *       data: Y.Map       ← keyed by CanvasNodeFields['data'] field names
 * ```
 */
function buildSeededDoc(
  nodeId: string,
  dataFields: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const nodesMap = doc.getMap("nodesMap");

  const nodeMap = new Y.Map();
  nodesMap.set(nodeId, nodeMap);

  const dataMap = new Y.Map();
  for (const [k, v] of Object.entries(dataFields)) {
    dataMap.set(k, v);
  }
  nodeMap.set("data", dataMap);

  return doc;
}

/**
 * Build a Hocuspocus stub whose `openDirectConnection` delivers
 * `transact` callbacks to the provided pre-built doc.
 *
 * Captures doc.transact calls so tests can assert transaction origin.
 */
function buildHocuspocus(doc: Y.Doc): {
  hocuspocus: Hocuspocus;
  transactSpy: ReturnType<typeof vi.fn>;
  disconnectSpy: ReturnType<typeof vi.fn>;
} {
  const transactSpy = vi.fn(async (cb: (doc: Y.Doc) => void) => {
    cb(doc);
  });
  const disconnectSpy = vi.fn(async () => undefined);
  const openDirectConnection = vi.fn(async () => ({
    transact: transactSpy,
    disconnect: disconnectSpy,
  }));

  return {
    hocuspocus: { openDirectConnection } as unknown as Hocuspocus,
    transactSpy,
    disconnectSpy,
  };
}

/** Helper: navigate to a node's data Y.Map (v10 top-level layout). */
function getDataMap(doc: Y.Doc, nodeId: string): Y.Map<unknown> {
  const nodesMap = doc.getMap("nodesMap");
  const nodeMap = nodesMap.get(nodeId) as Y.Map<unknown>;
  return nodeMap.get("data") as Y.Map<unknown>;
}

/** Valid docName for the v10 canvas-{spaceId} pattern. */
const VALID_DOC_NAME = "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-9222-222222222222";
const NODE_ID = "node-abc";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleNodeStateUpdateEvent", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    debugSpy.mockClear();
    errorSpy.mockClear();
  });

  // ── Case 1: handling → idle success ───────────────────────────────────
  it("applies state + content; deletes handlingBy when value is undefined (handling→idle success)", async () => {
    const doc = buildSeededDoc(NODE_ID, {
      state: "handling",
      handlingBy: { userId: "u1", username: "alice" },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        content: "https://cdn.example.com/result.png",
        handlingBy: undefined,
      },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event);

    const dataMap = getDataMap(doc, NODE_ID);
    expect(dataMap.get("state")).toBe("idle");
    expect(dataMap.get("content")).toBe("https://cdn.example.com/result.png");
    // handlingBy: undefined → Y.Map.delete(key) — key should no longer exist
    expect(dataMap.has("handlingBy")).toBe(false);
  });

  // ── Case 2: handling → idle failure ───────────────────────────────────
  it("applies state + errorMessage; deletes handlingBy; leaves content untouched (handling→idle failure)", async () => {
    const doc = buildSeededDoc(NODE_ID, {
      state: "handling",
      handlingBy: { userId: "u1", username: "alice" },
      content: "https://cdn.example.com/previous.png",
    });
    const { hocuspocus } = buildHocuspocus(doc);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        errorMessage: "upstream timeout",
        handlingBy: undefined,
      },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event);

    const dataMap = getDataMap(doc, NODE_ID);
    expect(dataMap.get("state")).toBe("idle");
    expect(dataMap.get("errorMessage")).toBe("upstream timeout");
    expect(dataMap.has("handlingBy")).toBe(false);
    // content is NOT in update → must remain untouched
    expect(dataMap.get("content")).toBe("https://cdn.example.com/previous.png");
  });

  // ── Case 3: allowlist drops disallowed keys ────────────────────────────
  it("filters disallowed keys and logs droppedKeys; only allowed keys applied", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle" as const,
        // Disallowed keys
        name: "OVERWRITE",
        sourceNodeId: "evil",
      },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event as NodeStateUpdateEvent);

    const dataMap = getDataMap(doc, NODE_ID);
    // Allowed key applied
    expect(dataMap.get("state")).toBe("idle");
    // Disallowed keys NOT applied
    expect(dataMap.has("name")).toBe(false);
    expect(dataMap.has("sourceNodeId")).toBe(false);

    // droppedKeys warn emitted
    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls as [{ droppedKeys: string[] }, string][];
    const droppedCall = warnCalls.find(([, msg]) => /disallowed/i.test(msg ?? ""));
    expect(droppedCall).toBeDefined();
    const droppedKeys = droppedCall![0].droppedKeys;
    expect(droppedKeys).toEqual(expect.arrayContaining(["name", "sourceNodeId"]));
  });

  // ── Case 4: empty filtered update bails before doc load ───────────────
  it("does NOT call openDirectConnection when all keys are disallowed (filtered update empty)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: { name: "x" },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event as NodeStateUpdateEvent);

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 5: node not found ─────────────────────────────────────────────
  it("warns and returns when nodeId is not in nodesMap (race-safe)", async () => {
    // Doc has a different node; target NODE_ID is absent
    const doc = buildSeededDoc("other-node", { state: "idle" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: { state: "idle" },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event);

    expect(warnSpy).toHaveBeenCalled();
    const warningMessages = (warnSpy.mock.calls as [unknown, string][])
      .map(([, msg]) => msg ?? "");
    expect(warningMessages.some((m) => /not found/i.test(m))).toBe(true);
  });

  // ── Case 6: multi-field atomicity via doc.transact ────────────────────
  it("wraps all field mutations in a single doc.transact with origin 'node-state-update'", async () => {
    const doc = buildSeededDoc(NODE_ID, {
      state: "handling",
      handlingBy: { userId: "u1", username: "alice" },
    });

    // We intercept doc.transact to inspect the origin string.
    const transactCalls: Array<{ origin: string }> = [];
    const originalTransact = doc.transact.bind(doc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc as any).transact = (fn: () => void, origin?: unknown) => {
      transactCalls.push({ origin: origin as string });
      originalTransact(fn, origin);
    };

    const { hocuspocus } = buildHocuspocus(doc);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        content: "https://cdn.example.com/r.png",
        cover_url: "https://cdn.example.com/r.png",
        handlingBy: undefined,
      },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event);

    // Exactly one doc.transact call with the correct origin
    const nodeStateTransacts = transactCalls.filter(
      (c) => c.origin === "node-state-update",
    );
    expect(nodeStateTransacts).toHaveLength(1);

    // All 4 fields should have been applied within that single transaction
    const dataMap = getDataMap(doc, NODE_ID);
    expect(dataMap.get("state")).toBe("idle");
    expect(dataMap.get("content")).toBe("https://cdn.example.com/r.png");
    expect(dataMap.get("cover_url")).toBe("https://cdn.example.com/r.png");
    expect(dataMap.has("handlingBy")).toBe(false);
  });

  // ── Case 7: malformed docName ──────────────────────────────────────────
  it("warns and skips when docName does not match project-{id} pattern", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: "bad",   // invalid pattern
      nodeId: NODE_ID,
      update: { state: "idle" },
    };

    await handleNodeStateUpdateEvent(hocuspocus, event);

    expect(warnSpy).toHaveBeenCalled();
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 8a: malformed update payload (null) — must skip, not throw ───
  // audit #133: a null/undefined/array `update` previously crashed at
  // `Object.entries(...)` and the stream consumer treated the throw as
  // a transient handler failure → infinite-retry-loop poison message.
  it("skips when event.update is null (poison-payload tolerance)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: null,
    };

    await expect(
      handleNodeStateUpdateEvent(hocuspocus, event as unknown as NodeStateUpdateEvent),
    ).resolves.toBeUndefined();

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const msgs = (warnSpy.mock.calls as [unknown, string][]).map(([, m]) => m ?? "");
    expect(msgs.some((m) => /malformed update/i.test(m))).toBe(true);
  });

  it("skips when event.update is an array (poison-payload tolerance)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: ["state", "idle"],
    };

    await expect(
      handleNodeStateUpdateEvent(hocuspocus, event as unknown as NodeStateUpdateEvent),
    ).resolves.toBeUndefined();

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 8b: empty/missing nodeId ──────────────────────────────────────
  it("skips when event.nodeId is empty string (poison-payload tolerance)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: "",
      update: { state: "idle" as const },
    };

    await expect(
      handleNodeStateUpdateEvent(hocuspocus, event as unknown as NodeStateUpdateEvent),
    ).resolves.toBeUndefined();

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const msgs = (warnSpy.mock.calls as [unknown, string][]).map(([, m]) => m ?? "");
    expect(msgs.some((m) => /invalid nodeId/i.test(m))).toBe(true);
  });

  it("skips when event.nodeId is not a string (poison-payload tolerance)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    const event = {
      type: "node-state-update" as const,
      docName: VALID_DOC_NAME,
      nodeId: 42 as unknown as string,
      update: { state: "idle" as const },
    };

    await expect(
      handleNodeStateUpdateEvent(hocuspocus, event as unknown as NodeStateUpdateEvent),
    ).resolves.toBeUndefined();

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  // ── Case 8c: transient I/O failure should propagate (no-ack + retry) ──
  it("propagates openDirectConnection errors so the stream consumer retries", async () => {
    const failingHocuspocus = {
      openDirectConnection: vi.fn(async () => {
        throw new Error("hocuspocus persistence offline");
      }),
    } as unknown as Hocuspocus;

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: { state: "idle" },
    };

    // Throw is *expected* for transient I/O failures — the stream
    // consumer's no-ack retry path is the recovery strategy.
    await expect(handleNodeStateUpdateEvent(failingHocuspocus, event)).rejects.toThrow(
      /hocuspocus persistence offline/,
    );

    // Structured error log emits before the rethrow so ops can see the
    // failure context (docName, nodeId) instead of just the stack.
    expect(failingHocuspocus.openDirectConnection).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
    const errCall = (errorSpy.mock.calls as [Record<string, unknown>, string][])
      .find(([ctx]) => ctx.docName === VALID_DOC_NAME);
    expect(errCall).toBeDefined();
  });

  // ── Case 9: unknown event type forward-compat ─────────────────────────
  // The `NodeEvent` union currently has one member, but the router guard
  // should warn+skip unknown future types instead of crashing.
  // We test via startTaskListener's internal router by importing a private
  // helper; since that's not exported, we verify the guard indirectly by
  // checking that a future-type event with an otherwise-valid docName
  // does NOT touch openDirectConnection (the router calls the handler,
  // which starts with a type check — an unknown type returns early).
  it("warns and skips event with unrecognised type (forward-compat guard)", async () => {
    const doc = buildSeededDoc(NODE_ID, { state: "handling" });
    const { hocuspocus } = buildHocuspocus(doc);

    // Cast to NodeStateUpdateEvent to bypass TS type check for this test.
    const event = {
      type: "future-unknown-type",
      docName: VALID_DOC_NAME,
      nodeId: NODE_ID,
      update: { state: "idle" },
    } as unknown as NodeStateUpdateEvent;

    // handleNodeStateUpdateEvent will receive it; the guard at top of the
    // function checks event.type === 'node-state-update' and should bail.
    await handleNodeStateUpdateEvent(hocuspocus, event);

    // The function should not have opened a connection for an unknown type.
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const warningMessages = (warnSpy.mock.calls as [unknown, string][])
      .map(([, msg]) => msg ?? "");
    expect(warningMessages.some((m) => /Unknown event type|unknown.*type/i.test(m))).toBe(true);
  });
});
