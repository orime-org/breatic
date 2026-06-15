// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the NodeStateUpdateEvent emit helpers in handlers/dispatch.ts.
 *
 * Covers:
 *  - emitNodeStateDone: success shape (all fields), partial fields, multi-node fanout
 *  - emitNodeStateFailed: failure shape, single and multi-node (via caller loop)
 *  - Guard: no publish when targetNodeIds is empty (caller-level guard simulation)
 *
 * No real Redis — publishNodeEvent from @breatic/core is fully mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock @breatic/core ──────────────────────────────────────────────
// Use a hoisted mock so the actual module (which depends on opentelemetry,
// ioredis, etc.) is never loaded. Only the symbols that handlers/dispatch.ts
// actually needs at import time are declared here.
const mockPublishNodeEvent = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  publishNodeEvent: mockPublishNodeEvent,
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  // Other core symbols imported at the top of handlers/dispatch.ts
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
}));

// ── Mock @breatic/domain (AIGC business handlers/dispatch.ts calls) ──────────
// PR4 moved task / credit / node-history / agent / canvas-lock here.
// Mocked so loading handlers never pulls the real domain barrel (→ agent
// llm → `ai` SDK → otel ESM chain, plus the MONOREPO_ROOT cascade back
// into core). Only the symbols handlers/dispatch.ts imports at top level.
vi.mock("@breatic/domain", () => ({
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
    setResolvedSkills: vi.fn(),
  },
  creditService: { deduct: vi.fn() },
  nodeHistoryService: {
    recordGenerationSuccess: vi.fn(),
    recordGenerationFailure: vi.fn(),
  },
  getModel: vi.fn(),
  buildToolSet: vi.fn(),
  getSkillRegistry: vi.fn(),
  extractPromptText: vi.fn((x: unknown) => String(x ?? "")),
  verifyCanvasNodeLock: vi.fn(),
  releaseCanvasNodeLock: vi.fn(),
}));

// @breatic/shared is used for canvasSpaceDocName inside handlers/dispatch.ts
// (v10 multi-doc routing: worker writes to project-{pid}/canvas-{sid}).
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (pid: string, sid: string) => `project-${pid}/canvas-${sid}`,
}));

// ── Also mock the mini-tool-registry which handlers/dispatch.ts imports ──────
vi.mock("../mini-tool-registry.js", () => ({
  resolveMiniToolEntry: vi.fn(),
}));

// ── Also mock the local/index handler ───────────────────────────────
vi.mock("../handlers/local/index.js", () => ({
  runLocalHandler: vi.fn(),
}));

// ── ai (used in runSkillAgent path) ─────────────────────────────────
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// ── Import the helpers under test AFTER mocks are wired ─────────────
import { emitNodeStateDone, emitNodeStateFailed } from "../handlers/dispatch.js";

// Dummy streamRedis value — handlers pass it through to publishNodeEvent
// which is mocked, so any value works.
const fakeStreamRedis = {} as Parameters<typeof emitNodeStateDone>[0];

beforeEach(() => {
  mockPublishNodeEvent.mockReset();
});

// ────────────────────────────────────────────────────────────────────
// emitNodeStateDone
// ────────────────────────────────────────────────────────────────────

describe("emitNodeStateDone", () => {
  it("calls publishNodeEvent with the correct done shape (all content fields)", async () => {
    const docName = "project-p1";
    const nodeId = "n1";
    const contentFields = {
      content: "https://oss/x.png",
      coverUrl: "https://oss/x-thumb.png",
      width: 100,
      height: 200,
    };

    await emitNodeStateDone(fakeStreamRedis, docName, nodeId, contentFields);

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledWith(fakeStreamRedis, {
      type: "node-state-update",
      docName,
      nodeId,
      update: {
        state: "idle",
        content: contentFields.content,
        coverUrl: contentFields.coverUrl,
        width: contentFields.width,
        height: contentFields.height,
        duration: undefined,
        // null (not undefined) so the key survives JSON.stringify round-trip
        handlingBy: null,
      },
    });
  });

  it("passes optional fields as undefined when not provided (no-cover case)", async () => {
    await emitNodeStateDone(fakeStreamRedis, "project-p2", "n2", {
      content: "https://oss/y.mp4",
    });

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    const event = mockPublishNodeEvent.mock.calls[0]![1] as Record<string, unknown>;
    const update = event.update as Record<string, unknown>;

    expect(update.state).toBe("idle");
    expect(update.content).toBe("https://oss/y.mp4");
    expect(update.coverUrl).toBeUndefined();
    expect(update.width).toBeUndefined();
    expect(update.height).toBeUndefined();
    expect(update.handlingBy).toBeNull();
  });

  it("fans out N calls when called N times (multi-output fanout via caller loop)", async () => {
    const docName = "project-proj-fan";
    const nodeIds = ["n1", "n2"];
    const urls = ["https://oss/a.png", "https://oss/b.png"];

    // Simulate the Stage 4 loop in runTask — caller loops over targetNodeIds
    for (let i = 0; i < nodeIds.length; i++) {
      await emitNodeStateDone(fakeStreamRedis, docName, nodeIds[i]!, {
        content: urls[i]!,
      });
    }

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);

    const calls = mockPublishNodeEvent.mock.calls as [unknown, Record<string, unknown>][];
    expect(calls[0]![1].nodeId).toBe("n1");
    expect(calls[1]![1].nodeId).toBe("n2");

    for (const [, event] of calls) {
      expect(event.type).toBe("node-state-update");
      expect(event.docName).toBe(docName);
      expect((event.update as Record<string, unknown>).state).toBe("idle");
      expect((event.update as Record<string, unknown>).handlingBy).toBeNull();
    }

    expect((calls[0]![1].update as Record<string, unknown>).content).toBe("https://oss/a.png");
    expect((calls[1]![1].update as Record<string, unknown>).content).toBe("https://oss/b.png");
  });
});

// ────────────────────────────────────────────────────────────────────
// emitNodeStateFailed
// ────────────────────────────────────────────────────────────────────

describe("emitNodeStateFailed", () => {
  it("emits the correct failure shape for a single node", async () => {
    const docName = "project-p1";
    const nodeId = "n1";
    const errorMessage = "Worker exploded";

    await emitNodeStateFailed(fakeStreamRedis, docName, nodeId, errorMessage);

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledWith(fakeStreamRedis, {
      type: "node-state-update",
      docName,
      nodeId,
      update: {
        state: "idle",
        errorMessage,
        // null (not undefined) so the key survives JSON.stringify round-trip
        handlingBy: null,
      },
    });
  });

  it("emits per-node when called in a loop (multi-node failure fanout)", async () => {
    const docName = "project-p2";
    const nodeIds = ["n1", "n2"];
    const errorMessage = "Provider timeout";

    // Caller loops over targetNodeIds and calls helper once per node
    for (const nodeId of nodeIds) {
      await emitNodeStateFailed(fakeStreamRedis, docName, nodeId, errorMessage);
    }

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);

    const calls = mockPublishNodeEvent.mock.calls as [unknown, Record<string, unknown>][];
    expect(calls[0]![1].nodeId).toBe("n1");
    expect(calls[1]![1].nodeId).toBe("n2");

    for (const [, event] of calls) {
      expect(event.type).toBe("node-state-update");
      expect(event.docName).toBe(docName);
      expect((event.update as Record<string, unknown>).state).toBe("idle");
      expect((event.update as Record<string, unknown>).errorMessage).toBe(errorMessage);
      expect((event.update as Record<string, unknown>).handlingBy).toBeNull();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Guard: empty targetNodeIds — no publish
// ────────────────────────────────────────────────────────────────────

describe("caller-level empty targetNodeIds guard", () => {
  it("does NOT call publishNodeEvent when targetNodeIds is empty (caller skips loop)", async () => {
    const targetNodeIds: string[] = [];

    // Simulate what runTask does when nodeIds.length === 0
    for (const nodeId of targetNodeIds) {
      await emitNodeStateDone(fakeStreamRedis, "project-p3", nodeId, { content: "https://oss/z.png" });
    }

    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("does NOT call publishNodeEvent for failure when targetNodeIds is empty", async () => {
    const targetNodeIds: string[] = [];

    for (const nodeId of targetNodeIds) {
      await emitNodeStateFailed(fakeStreamRedis, "project-p4", nodeId, "some error");
    }

    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });
});
