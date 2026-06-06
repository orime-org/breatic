// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * canvas-node.ts type shape tests.
 *
 * Uses expectTypeOf for structural type assertions (vitest 3 compatible).
 * Runtime value tests verify that the declared shapes accept valid objects.
 * @ts-expect-error tests verify that removed types/fields are truly gone.
 */
/* eslint-disable @typescript-eslint/no-unused-expressions, @typescript-eslint/consistent-type-imports --
 * Deliberate pattern for type-removal regression tests:
 *   - bare-property-access expressions (`data.foo;`) pair with `@ts-expect-error`
 *     to assert that the field is gone from the type;
 *   - inline `import(...)` types are required because top-level `import type {X}`
 *     would itself be a TS2305 error and there's no way to put `@ts-expect-error`
 *     on a top-level import.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  NodeState,
  HandlingActor,
  OperationLock,
  AttachRef,
  CanvasNodeFields,
  NodeStateUpdateEvent,
  NodeEvent,
} from "../types/canvas-node.js";


// ── AttachRef ──────────────────────────────────────────────────────

describe("AttachRef", () => {
  it("accepts a valid AttachRef shape", () => {
    const ref: AttachRef = {
      id: "a1",
      url: "https://cdn.example.com/file.png",
      name: "file.png",
      mimeType: "image/png",
      size: 12345,
      uploadedAt: "2026-04-30T00:00:00.000Z",
    };
    expect(ref.id).toBe("a1");
    expect(ref.mimeType).toBe("image/png");
  });
});

// ── NodeState ──────────────────────────────────────────────────────

describe("NodeState", () => {
  it("is exactly the two-value union idle | handling", () => {
    const idle: NodeState = "idle";
    const handling: NodeState = "handling";
    expect(idle).toBe("idle");
    expect(handling).toBe("handling");
  });

  it("type is exactly the two-value union (no third state)", () => {
    expectTypeOf<NodeState>().toEqualTypeOf<"idle" | "handling">();
  });
});

// ── HandlingActor ──────────────────────────────────────────────────

describe("HandlingActor", () => {
  it("accepts a valid HandlingActor shape with frontend driver", () => {
    const actor: HandlingActor = {
      userId: "user-1",
      type: "frontend",
    };
    expect(actor.userId).toBe("user-1");
    expect(actor.type).toBe("frontend");
  });

  it("accepts a valid HandlingActor shape with backend driver", () => {
    const actor: HandlingActor = {
      userId: "user-2",
      type: "backend",
    };
    expect(actor.type).toBe("backend");
  });

  it("carries no display-name snapshot — only userId + driver type", () => {
    // Email-registration rewrite (2026-06-06): the name is rendered from
    // the live `meta.users[userId]` awareness roster, never frozen onto
    // the node. A revert that re-adds `username` trips this type assertion.
    expectTypeOf<HandlingActor>().toEqualTypeOf<{
      userId: string;
      type: "frontend" | "backend";
    }>();
  });
});

// ── OperationLock ──────────────────────────────────────────────────

describe("OperationLock", () => {
  it("accepts a valid OperationLock shape", () => {
    const lock: OperationLock = {
      toolId: "adjust",
      userId: "user-1",
    };
    expect(lock.toolId).toBe("adjust");
    expect(lock.userId).toBe("user-1");
  });

  it("type narrows to { toolId: string; userId: string }", () => {
    expectTypeOf<OperationLock>().toEqualTypeOf<{
      toolId: string;
      userId: string;
    }>();
  });

  it("multiple OperationLock entries can coexist on one node", () => {
    const locks: OperationLock[] = [
      { toolId: "adjust", userId: "user-A" },
      { toolId: "filter", userId: "user-B" },
      // Same tool, different user (collaborative configure of same tool):
      { toolId: "crop", userId: "user-A" },
      { toolId: "crop", userId: "user-B" },
    ];
    expect(locks).toHaveLength(4);
    // userId is the owner — filtering by it is the disconnect-cleanup primitive.
    const userAEntries = locks.filter((l) => l.userId === "user-A");
    expect(userAEntries).toHaveLength(2);
  });
});

// ── CanvasNodeFields ───────────────────────────────────────────────

describe("CanvasNodeFields", () => {
  it("accepts a minimal valid shape with only required fields", () => {
    const node: CanvasNodeFields = {
      id: "node-1",
      type: "1002",
      position: { x: 100, y: 200 },
      data: {
        name: "Image Node",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: false,
        operationLocks: [],
        state: "idle",
        attachments: [],
      },
    };
    expect(node.id).toBe("node-1");
    expect(node.data.state).toBe("idle");
    expect(node.data.attachments).toHaveLength(0);
  });

  it("accepts a full data node with all optional data fields populated", () => {
    const node: CanvasNodeFields = {
      id: "node-2",
      type: "1002",
      position: { x: 50, y: 50 },
      data: {
        name: "Result Image",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: false,
        operationLocks: [],
        state: "idle",
        attachments: [],
        handlingBy: undefined,
        errorMessage: undefined,
        content: "https://cdn.example.com/image.png",
        cover_url: "https://cdn.example.com/image.png",
        width: 1024,
        height: 768,
        duration: undefined,
        sourceNodeId: "node-0",
        operation: "image.crop",
        operationParams: { x: 0, y: 0, w: 512, h: 512 },
      },
    };
    expect(node.data.content).toBe("https://cdn.example.com/image.png");
    expect(node.data.width).toBe(1024);
    expect(node.data.operation).toBe("image.crop");
    expect(node.data.sourceNodeId).toBe("node-0");
  });

  it("accepts a generative node with prompt/model/params populated", () => {
    const node: CanvasNodeFields = {
      id: "node-3",
      type: "generative",
      position: { x: 0, y: 0 },
      data: {
        name: "Generate Art",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: false,
        operationLocks: [],
        state: "handling",
        handlingBy: { userId: "u1", type: "backend" },
        attachments: [],
        prompt: "a painting of a sunset",
        outputType: "image",
        kind: "文生图",
        model: "flux-dev",
        params: { steps: 30, guidance: 7.5 },
      },
    };
    expect(node.data.state).toBe("handling");
    expect(node.data.handlingBy?.userId).toBe("u1");
    expect(node.data.handlingBy?.type).toBe("backend");
    expect(node.data.model).toBe("flux-dev");
  });

  it("accepts a group node with childIds", () => {
    const node: CanvasNodeFields = {
      id: "group-1",
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: "My Group",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: false,
        operationLocks: [],
        state: "idle",
        attachments: [],
        childIds: ["node-1", "node-2"],
      },
    };
    expect(node.data.childIds).toEqual(["node-1", "node-2"]);
  });

  it("locked defaults to false (still required) and createdAt/createdBy are required", () => {
    // v13: audit fields are mandatory on every node creation, not optional.
    // Reader-side fallbacks handle pre-v13 docs; type definition stays strict.
    const node: CanvasNodeFields = {
      id: "node-locked",
      type: "1002",
      position: { x: 0, y: 0 },
      data: {
        name: "Locked node",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: true,
        operationLocks: [],
        state: "idle",
        attachments: [],
      },
    };
    expect(node.data.locked).toBe(true);
    expect(node.data.createdBy).toBe("user-1");
  });

  it("accepts a node with operationLocks + frontend handlingBy (Category A mid-op)", () => {
    // Spec §10.13.6.2 + ADR 2026-05-11-mini-tool-state-machine.md:
    //   - operationLocks: configure-phase lock list, multiple entries allowed
    //   - handlingBy.type: 'frontend' = browser-driven (Category A); Collab
    //     onDisconnect writes errorMessage if the holder leaves mid-op
    const node: CanvasNodeFields = {
      id: "node-mid-op",
      type: "1002",
      position: { x: 0, y: 0 },
      data: {
        name: "Adjusting",
        createdAt: 1714492800000,
        createdBy: "user-1",
        locked: false,
        operationLocks: [
          { toolId: "adjust", userId: "user-2" },
        ],
        state: "handling",
        handlingBy: {
          userId: "user-2",
          type: "frontend",
        },
        attachments: [],
        operation: "adjust",
        operationParams: { brightness: 10, contrast: 5, saturation: 0 },
        sourceNodeId: "node-source",
      },
    };
    expect(node.data.operationLocks).toHaveLength(1);
    expect(node.data.operationLocks[0]?.toolId).toBe("adjust");
    expect(node.data.handlingBy?.type).toBe("frontend");
  });

  it("removed data fields no longer compile", () => {
    const data: CanvasNodeFields["data"] = {
      name: "x",
      createdAt: 1714492800000,
      createdBy: "user-1",
      locked: false,
      operationLocks: [],
      state: "idle",
      attachments: [],
    };

    // @ts-expect-error activeHistoryId removed in Phase 2 forward-fix
    data.activeHistoryId;

    // @ts-expect-error history removed in Phase 2 forward-fix
    data.history;

    // @ts-expect-error runType was removed earlier; verify still absent
    data.runType;

    // @ts-expect-error errorInfo renamed to errorMessage; old name gone
    data.errorInfo;

    // Positive control: .name access works
    expect(data.name).toBe("x");
  });
});

// ── NodeStateUpdateEvent ───────────────────────────────────────────

describe("NodeStateUpdateEvent", () => {
  it("accepts a valid node-state-update event shape", () => {
    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: "project-abc123",
      nodeId: "node-1",
      update: {
        state: "handling",
        handlingBy: { userId: "u1", type: "backend" },
      },
    };
    expect(event.type).toBe("node-state-update");
    expect(event.docName).toBe("project-abc123");
    expect(event.update.state).toBe("handling");
  });

  it("update is Partial<CanvasNodeFields['data']>", () => {
    // A completion update with content result
    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: "project-xyz",
      nodeId: "node-5",
      update: {
        state: "idle",
        content: "https://cdn.example.com/result.mp4",
        cover_url: "https://cdn.example.com/thumb.jpg",
        width: 1920,
        height: 1080,
        duration: 15,
      },
    };
    expect(event.update.content).toBe("https://cdn.example.com/result.mp4");
    expect(event.update.duration).toBe(15);
  });

  it("type literal is exactly 'node-state-update'", () => {
    expectTypeOf<NodeStateUpdateEvent["type"]>().toEqualTypeOf<"node-state-update">();
  });
});

// ── NodeEvent alias ────────────────────────────────────────────────

describe("NodeEvent", () => {
  it("is an alias of NodeStateUpdateEvent", () => {
    expectTypeOf<NodeEvent>().toEqualTypeOf<NodeStateUpdateEvent>();
  });

  it("accepts a NodeStateUpdateEvent as NodeEvent", () => {
    const event: NodeEvent = {
      type: "node-state-update",
      docName: "project-abc",
      nodeId: "node-1",
      update: { state: "idle", errorMessage: "Worker crashed" },
    };
    expect(event.type).toBe("node-state-update");
  });
});

// ── Removed types — import-level checks ───────────────────────────
// The types below no longer exist in canvas-node.ts.
// TypeScript's module resolution will catch the import as TS2305.
// We verify here by testing the exported keys do NOT include the old names.

describe("Removed types are absent from exports", () => {
  it("HistoryItem is not exported (verified via @ts-expect-error on import)", () => {
    // @ts-expect-error TS2305: 'HistoryItem' is not exported from module
    type _H = import("../types/canvas-node.js").HistoryItem;
    // If we reach this line, the test still passes — the @ts-expect-error
    // suppresses the type error at compile time, which is exactly what we want:
    // if HistoryItem IS exported, the @ts-expect-error itself would error.
    expect(true).toBe(true);
  });

  it("HistoryUpdateEvent is not exported (verified via @ts-expect-error on import)", () => {
    // @ts-expect-error TS2305: 'HistoryUpdateEvent' is not exported from module
    type _H = import("../types/canvas-node.js").HistoryUpdateEvent;
    expect(true).toBe(true);
  });

  it("HistoryItemStatus is not exported (verified via @ts-expect-error on import)", () => {
    // @ts-expect-error TS2305: 'HistoryItemStatus' is not exported from module
    type _S = import("../types/canvas-node.js").HistoryItemStatus;
    expect(true).toBe(true);
  });

  it("HistoryItemSource is not exported (verified via @ts-expect-error on import)", () => {
    // @ts-expect-error TS2305: 'HistoryItemSource' is not exported from module
    type _S = import("../types/canvas-node.js").HistoryItemSource;
    expect(true).toBe(true);
  });
});
