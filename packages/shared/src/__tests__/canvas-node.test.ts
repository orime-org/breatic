/**
 * canvas-node.ts type shape tests.
 *
 * Uses expectTypeOf for structural type assertions (vitest 3 compatible).
 * Runtime value tests verify that the declared shapes accept valid objects.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  HistoryItemStatus,
  HistoryItemSource,
  HistoryItem,
  CanvasNodeFields,
  HistoryUpdateEvent,
  NodeEvent,
} from "../types/canvas-node.js";

// ── HistoryItemStatus ──────────────────────────────────────────────

describe("HistoryItemStatus", () => {
  it("is the union loading | done | failed", () => {
    const loading: HistoryItemStatus = "loading";
    const done: HistoryItemStatus = "done";
    const failed: HistoryItemStatus = "failed";

    expect(loading).toBe("loading");
    expect(done).toBe("done");
    expect(failed).toBe("failed");
  });

  it("type is exactly the three-value union", () => {
    expectTypeOf<HistoryItemStatus>().toEqualTypeOf<
      "loading" | "done" | "failed"
    >();
  });
});

// ── HistoryItemSource ──────────────────────────────────────────────

describe("HistoryItemSource", () => {
  it("accepts all four source values", () => {
    const apply: HistoryItemSource = "apply";
    const canvasAi: HistoryItemSource = "canvas-ai";
    const editorMiniTool: HistoryItemSource = "editor-mini-tool";
    const upload: HistoryItemSource = "upload";

    expect(apply).toBe("apply");
    expect(canvasAi).toBe("canvas-ai");
    expect(editorMiniTool).toBe("editor-mini-tool");
    expect(upload).toBe("upload");
  });

  it("type is exactly the four-value union", () => {
    expectTypeOf<HistoryItemSource>().toEqualTypeOf<
      "apply" | "canvas-ai" | "editor-mini-tool" | "upload"
    >();
  });
});

// ── HistoryItem ────────────────────────────────────────────────────

describe("HistoryItem", () => {
  it("accepts a minimal required-field item (loading state)", () => {
    const item: HistoryItem = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      url: "",
      by: { userId: "user-1", name: "Alice" },
      createdAt: Date.now(),
      source: "canvas-ai",
      status: "loading",
    };

    expect(item.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(item.status).toBe("loading");
  });

  it("accepts a full item with all optional fields (done state)", () => {
    const item: HistoryItem = {
      id: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
      url: "https://cdn.example.com/image.jpg",
      cover: "https://cdn.example.com/thumb.jpg",
      width: 1024,
      height: 768,
      duration: 30,
      by: { userId: "user-2", name: "Bob" },
      createdAt: 1_700_000_000_000,
      source: "editor-mini-tool",
      tool: "image.remove-bg",
      params: { brightness: 12 },
      prompt: "remove the background",
      status: "done",
    };

    expect(item.status).toBe("done");
    expect(item.width).toBe(1024);
    expect(item.tool).toBe("image.remove-bg");
  });

  it("accepts a failed item with errorMessage", () => {
    const item: HistoryItem = {
      id: "11111111-2222-3333-4444-555555555555",
      url: "",
      by: { userId: "user-3", name: "Carol" },
      createdAt: Date.now(),
      source: "upload",
      status: "failed",
      errorMessage: "Upload timed out",
    };

    expect(item.status).toBe("failed");
    expect(item.errorMessage).toBe("Upload timed out");
  });
});

// ── CanvasNodeFields ───────────────────────────────────────────────

describe("CanvasNodeFields", () => {
  it("data accepts activeHistoryId and history array", () => {
    const historyItem: HistoryItem = {
      id: "h1",
      url: "https://cdn.example.com/img.png",
      by: { userId: "u1", name: "Alice" },
      createdAt: 1_700_000_000_000,
      source: "canvas-ai",
      status: "done",
    };

    const node: CanvasNodeFields = {
      id: "node-1",
      type: "1002",
      position: { x: 100, y: 200 },
      data: {
        name: "Image Node",
        activeHistoryId: "h1",
        history: [historyItem],
        attachments: [],
        prompt: null,
      },
    };

    expect(node.data.activeHistoryId).toBe("h1");
    expect(node.data.history).toHaveLength(1);
  });

  it("data.activeHistoryId is optional", () => {
    const node: CanvasNodeFields = {
      id: "node-2",
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: "Group Node",
        history: [],
        attachments: [],
        prompt: null,
        childIds: ["node-1", "node-3"],
      },
    };

    expect(node.data.childIds).toEqual(["node-1", "node-3"]);
    expect(node.data.activeHistoryId).toBeUndefined();
  });

  it("legacy field coverUrl does not exist on data", () => {
    const node: CanvasNodeFields = {
      id: "node-3",
      type: "1002",
      position: { x: 0, y: 0 },
      data: {
        name: "Test Node",
        history: [],
        attachments: [],
        prompt: null,
      },
    };

    // @ts-expect-error coverUrl was removed from CanvasNodeFields.data
    const _unused = node.data.coverUrl;
    expect(node).toBeDefined();
  });

  it("legacy field state does not exist on data", () => {
    const node: CanvasNodeFields = {
      id: "node-4",
      type: "1001",
      position: { x: 0, y: 0 },
      data: {
        name: "Text Node",
        history: [],
        attachments: [],
        prompt: null,
      },
    };

    // @ts-expect-error state was removed from CanvasNodeFields.data
    const _unused = node.data.state;
    expect(node).toBeDefined();
  });
});

// ── HistoryUpdateEvent ─────────────────────────────────────────────

describe("HistoryUpdateEvent", () => {
  it("accepts a valid history update event", () => {
    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: "project-abc123",
      nodeId: "node-1",
      historyItemId: "h1",
      update: {
        status: "done",
        url: "https://cdn.example.com/result.png",
      },
    };

    expect(event.type).toBe("history-update");
    expect(event.docName).toBe("project-abc123");
    expect(event.update.status).toBe("done");
  });

  it("type literal is exactly 'history-update'", () => {
    expectTypeOf<HistoryUpdateEvent["type"]>().toEqualTypeOf<"history-update">();
  });

  it("update is Partial<HistoryItem>", () => {
    // A minimal partial update (just status) must be valid
    const event: HistoryUpdateEvent = {
      type: "history-update",
      docName: "project-xyz",
      nodeId: "node-5",
      historyItemId: "h2",
      update: { status: "failed", errorMessage: "Worker crashed" },
    };

    expect(event.update.errorMessage).toBe("Worker crashed");
  });
});

// ── NodeEvent alias ────────────────────────────────────────────────

describe("NodeEvent", () => {
  it("is an alias of HistoryUpdateEvent", () => {
    expectTypeOf<NodeEvent>().toEqualTypeOf<HistoryUpdateEvent>();
  });

  it("accepts a HistoryUpdateEvent as NodeEvent", () => {
    const event: NodeEvent = {
      type: "history-update",
      docName: "project-abc",
      nodeId: "node-1",
      historyItemId: "h1",
      update: { status: "loading" },
    };

    expect(event.type).toBe("history-update");
  });
});
