// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `cleanupOnDisconnect` unit tests.
 *
 * Same strategy as `task-listener.test.ts`: real `yjs`, stub Hocuspocus.
 * `cleanupOnDisconnect` mutates a real Y.Doc inside `connection.transact`;
 * we pre-seed nodes with various lock / handling shapes and assert the
 * post-cleanup state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

const { warnSpy, infoSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

// `createLogger` now comes from `@breatic/core` (the unified logger). Spread
// the real core barrel and override only `createLogger` with a spy factory.
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      warn: warnSpy,
      info: infoSpy,
      error: errorSpy,
      debug: vi.fn(),
    }),
  };
});

vi.mock("../services/event-stream.js", () => ({
  startStreamConsumer: vi.fn(),
}));

vi.mock("pino", () => ({
  default: vi.fn(() => ({
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })),
  })),
}));

import { cleanupOnDisconnect } from "../hooks/disconnect-cleanup.js";

/** Build a Y.Doc with one node fixture and the given data field values. */
function buildSeededDoc(nodes: Record<string, Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc();
  const nodesMap = doc.getMap("nodesMap");
  for (const [nodeId, dataFields] of Object.entries(nodes)) {
    const nodeMap = new Y.Map();
    nodesMap.set(nodeId, nodeMap);
    const dataMap = new Y.Map();
    for (const [k, v] of Object.entries(dataFields)) {
      dataMap.set(k, v);
    }
    nodeMap.set("data", dataMap);
  }
  return doc;
}

function buildHocuspocus(doc: Y.Doc): {
  hocuspocus: Hocuspocus;
  disconnectSpy: ReturnType<typeof vi.fn>;
} {
  const disconnectSpy = vi.fn(async () => undefined);
  const transactSpy = vi.fn(async (cb: (doc: Y.Doc) => void) => {
    cb(doc);
  });
  const openDirectConnection = vi.fn(async () => ({
    transact: transactSpy,
    disconnect: disconnectSpy,
  }));
  return {
    hocuspocus: { openDirectConnection } as unknown as Hocuspocus,
    disconnectSpy,
  };
}

function getDataMap(doc: Y.Doc, nodeId: string): Y.Map<unknown> {
  const nodesMap = doc.getMap("nodesMap");
  const nodeMap = nodesMap.get(nodeId) as Y.Map<unknown>;
  return nodeMap.get("data") as Y.Map<unknown>;
}

const VALID_CANVAS_DOC = "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-9222-222222222222";

describe("cleanupOnDisconnect", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    errorSpy.mockClear();
  });

  it("strips operationLocks entries belonging to the disconnected user", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        operationLocks: [
          { toolId: "adjust", userId: "user-gone" },
          { toolId: "filter", userId: "user-stay" },
        ],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    const locks = dataMap.get("operationLocks") as Array<{ userId: string }>;
    expect(locks).toHaveLength(1);
    expect(locks[0]?.userId).toBe("user-stay");
  });

  it("preserves operationLocks when no entry matches the disconnected user", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        operationLocks: [
          { toolId: "adjust", userId: "user-X" },
        ],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    const locks = dataMap.get("operationLocks") as Array<{ userId: string }>;
    expect(locks).toHaveLength(1);
  });

  // Option A (#1580 slice 4): disconnect-cleanup no longer reclaims ANY
  // handling. A browser's presigned upload is invisible to collab and
  // outlives the WS, so a disconnect is NOT reliable evidence the upload
  // died — guessing false-reclaims live uploads (#3 sibling-tab of the
  // same user, #11 network jitter). The owner self-cleans on upload
  // failure (setNodeError) and the 1h lease sweeper is the backstop. So
  // even the disconnected user's OWN frontend handling is left untouched.
  it("does NOT reclaim the disconnected user's own frontend handling (Option A: sibling upload survives, #3/#11)", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        state: "handling",
        handlingBy: { userId: "user-gone", username: "alice", type: "frontend" },
        operationLocks: [],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    expect(dataMap.get("state")).toBe("handling");
    expect(dataMap.has("handlingBy")).toBe(true);
    expect(dataMap.has("errorMessage")).toBe(false);
  });

  it("does NOT touch backend-driver handling (Worker owns its lifecycle)", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        state: "handling",
        handlingBy: { userId: "user-gone", username: "alice", type: "backend" },
        operationLocks: [],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    expect(dataMap.get("state")).toBe("handling");
    expect(dataMap.has("handlingBy")).toBe(true);
    expect(dataMap.has("errorMessage")).toBe(false);
  });

  it("does NOT touch frontend-driver handling owned by a different user", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        state: "handling",
        handlingBy: { userId: "user-other", username: "bob", type: "frontend" },
        operationLocks: [],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    expect(dataMap.get("state")).toBe("handling");
    const handlingBy = dataMap.get("handlingBy") as { userId: string };
    expect(handlingBy.userId).toBe("user-other");
  });

  it("does NOT touch data.locked (user lock is user-owned and disconnect-resistant)", async () => {
    const doc = buildSeededDoc({
      "node-A": {
        locked: true,
        operationLocks: [
          { toolId: "adjust", userId: "user-gone" },
        ],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    const dataMap = getDataMap(doc, "node-A");
    expect(dataMap.get("locked")).toBe(true);
    const locks = dataMap.get("operationLocks") as unknown[];
    expect(locks).toHaveLength(0);
  });

  it("processes every node in the doc in a single pass", async () => {
    const doc = buildSeededDoc({
      "node-1": {
        operationLocks: [{ toolId: "adjust", userId: "user-gone" }],
      },
      "node-2": {
        state: "handling",
        handlingBy: { userId: "user-gone", username: "alice", type: "frontend" },
        operationLocks: [],
      },
      "node-3": {
        operationLocks: [{ toolId: "filter", userId: "user-stay" }],
      },
    });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone");

    // node-1: lock removed
    expect((getDataMap(doc, "node-1").get("operationLocks") as unknown[])).toHaveLength(0);
    // node-2: handling NOT touched (Option A — disconnect never reclaims handling)
    expect(getDataMap(doc, "node-2").get("state")).toBe("handling");
    expect(getDataMap(doc, "node-2").has("errorMessage")).toBe(false);
    // node-3: untouched (different user)
    expect((getDataMap(doc, "node-3").get("operationLocks") as unknown[])).toHaveLength(1);
  });

  it("skips non-canvas docs without opening a connection", async () => {
    const doc = buildSeededDoc({ "node-A": {} });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(
      hocuspocus,
      "project-11111111-1111-4111-8111-111111111111/meta",
      "user-gone",
    );

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it("skips malformed doc names without opening a connection", async () => {
    const doc = buildSeededDoc({ "node-A": {} });
    const { hocuspocus } = buildHocuspocus(doc);

    await cleanupOnDisconnect(hocuspocus, "garbage", "user-gone");

    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it("logs + swallows openDirectConnection errors (does NOT rethrow)", async () => {
    const failingHocuspocus = {
      openDirectConnection: vi.fn(async () => {
        throw new Error("hocuspocus loader offline");
      }),
    } as unknown as Hocuspocus;

    // Should NOT throw — disconnect cleanup is best-effort; one user
    // leaving shouldn't crash the disconnect path for everyone.
    await expect(
      cleanupOnDisconnect(failingHocuspocus, VALID_CANVAS_DOC, "user-gone"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("disconnects the direct connection even when the transact body throws", async () => {
    const disconnectSpy = vi.fn(async () => undefined);
    // Replace transact with a thrower
    const transactSpy = vi.fn(async () => {
      throw new Error("yjs write failed");
    });
    const hocuspocus = {
      openDirectConnection: vi.fn(async () => ({
        transact: transactSpy,
        disconnect: disconnectSpy,
      })),
    } as unknown as Hocuspocus;

    // The error inside transact bubbles past our try/finally → callers
    // log it (see server.ts onDisconnect wrapper). We don't claim to
    // swallow inner errors; the test verifies disconnect still ran.
    await expect(
      cleanupOnDisconnect(hocuspocus, VALID_CANVAS_DOC, "user-gone"),
    ).rejects.toThrow(/yjs write failed/);
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });
});
