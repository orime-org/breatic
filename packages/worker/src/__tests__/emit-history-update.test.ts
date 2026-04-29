/**
 * Unit tests for the HistoryUpdateEvent emit helpers in handlers.ts.
 *
 * Covers:
 *  - emitHistoryDone: success shape, multi-node fanout, no-cover case
 *  - publishFailedEvent: failure shape, multi-node fanout, skip guards
 *    (missing historyItemId / empty nodeIds / missing projectId)
 *
 * No real Redis — publishNodeEvent from @breatic/core is fully mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock @breatic/core ──────────────────────────────────────────────
// Use a hoisted mock so the actual module (which depends on opentelemetry,
// ioredis, etc.) is never loaded. Only the symbols that handlers.ts
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
  // Other core symbols imported at the top of handlers.ts
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
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
  storageKey: vi.fn(),
  extractPromptText: vi.fn((x: unknown) => String(x ?? "")),
}));

// @breatic/shared is used for projectDocName inside handlers.ts
vi.mock("@breatic/shared", () => ({
  projectDocName: (id: string) => `project-${id}`,
}));

// ── Also mock the mini-tool-registry which handlers.ts imports ──────
vi.mock("../mini-tool-registry.js", () => ({
  resolveMiniToolEntry: vi.fn(),
}));

// ── Also mock the local/index handler ───────────────────────────────
vi.mock("../handlers/local/index.js", () => ({
  runLocalHandler: vi.fn(),
}));

// ── ai (used in runSkillAgent path) ─────────────────────────────────
vi.mock("ai", () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// ── Import the helpers under test AFTER mocks are wired ─────────────
import { emitHistoryDone, publishFailedEvent } from "../handlers.js";

// Dummy streamRedis value — handlers pass it through to publishNodeEvent
// which is mocked, so any value works.
const fakeStreamRedis = {} as Parameters<typeof emitHistoryDone>[0];

beforeEach(() => {
  mockPublishNodeEvent.mockReset();
});

// ────────────────────────────────────────────────────────────────────
// emitHistoryDone
// ────────────────────────────────────────────────────────────────────

describe("emitHistoryDone", () => {
  it("calls publishNodeEvent with the correct done shape (single node)", async () => {
    const docName = "project-proj-1";
    const nodeId = "n1";
    const historyItemId = "h1";
    const url = "https://oss/x.png";
    const cover = "https://oss/x-thumb.png";

    await emitHistoryDone(fakeStreamRedis, docName, nodeId, historyItemId, url, cover);

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledWith(fakeStreamRedis, {
      type: "history-update",
      docName,
      nodeId,
      historyItemId,
      update: {
        status: "done",
        url,
        cover,
      },
    });
  });

  it("passes undefined cover through unchanged (no-thumbnail case)", async () => {
    await emitHistoryDone(
      fakeStreamRedis,
      "project-proj-2",
      "n2",
      "h2",
      "https://oss/y.mp4",
      undefined,
    );

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    const event = mockPublishNodeEvent.mock.calls[0]![1] as Record<string, unknown>;
    expect((event.update as Record<string, unknown>).cover).toBeUndefined();
    expect((event.update as Record<string, unknown>).status).toBe("done");
  });

  it("fans out once per nodeId when called in a loop (multi-node simulation)", async () => {
    const projectId = "proj-fan";
    const docName = `project-${projectId}`;
    const historyItemId = "h-fan";
    const nodeIds = ["n1", "n2"];
    const urls = ["https://oss/a.png", "https://oss/b.png"];

    // Simulate Stage 4 loop in runTask
    for (let i = 0; i < nodeIds.length; i++) {
      await emitHistoryDone(
        fakeStreamRedis,
        docName,
        nodeIds[i]!,
        historyItemId,
        urls[i]!,
        undefined,
      );
    }

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);

    const calls = mockPublishNodeEvent.mock.calls as [unknown, Record<string, unknown>][];
    expect(calls[0]![1].nodeId).toBe("n1");
    expect(calls[0]![1].historyItemId).toBe(historyItemId);
    expect(calls[1]![1].nodeId).toBe("n2");
    expect(calls[1]![1].historyItemId).toBe(historyItemId);

    for (const [, event] of calls) {
      expect(event.type).toBe("history-update");
      expect(event.docName).toBe(docName);
      expect((event.update as Record<string, unknown>).status).toBe("done");
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// publishFailedEvent
// ────────────────────────────────────────────────────────────────────

describe("publishFailedEvent", () => {
  it("emits the correct failed shape for a single node", async () => {
    const projectId = "proj-1";
    const nodeIds = ["n1"];
    const historyItemId = "h1";
    const errorMessage = "Sharp threw";

    await publishFailedEvent(fakeStreamRedis, projectId, nodeIds, historyItemId, errorMessage);

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledWith(fakeStreamRedis, {
      type: "history-update",
      docName: `project-${projectId}`,
      nodeId: "n1",
      historyItemId,
      update: {
        status: "failed",
        errorMessage,
      },
    });
  });

  it("fans out to all nodeIds with the same historyItemId", async () => {
    const projectId = "proj-2";
    const nodeIds = ["n1", "n2"];
    const historyItemId = "h2";
    const errorMessage = "Provider timeout";

    await publishFailedEvent(fakeStreamRedis, projectId, nodeIds, historyItemId, errorMessage);

    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);

    const calls = mockPublishNodeEvent.mock.calls as [unknown, Record<string, unknown>][];
    expect(calls[0]![1].nodeId).toBe("n1");
    expect(calls[1]![1].nodeId).toBe("n2");

    for (const [, event] of calls) {
      expect(event.historyItemId).toBe(historyItemId);
      expect(event.docName).toBe(`project-${projectId}`);
      expect(event.type).toBe("history-update");
      expect((event.update as Record<string, unknown>).status).toBe("failed");
      expect((event.update as Record<string, unknown>).errorMessage).toBe(errorMessage);
    }
  });

  it("does NOT call publishNodeEvent when historyItemId is undefined", async () => {
    await publishFailedEvent(fakeStreamRedis, "proj-3", ["n1"], undefined, "some error");

    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("does NOT call publishNodeEvent when nodeIds is empty", async () => {
    await publishFailedEvent(fakeStreamRedis, "proj-4", [], "h4", "some error");

    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("does NOT call publishNodeEvent when projectId is undefined", async () => {
    await publishFailedEvent(fakeStreamRedis, undefined, ["n1"], "h5", "some error");

    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });
});
