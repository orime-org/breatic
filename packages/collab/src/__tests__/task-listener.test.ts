// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the task listener does with an event off the stream (#186).
 *
 * The listener carries the event to the right document and hands it to
 * `applyNodeTaskCounts`, which owns what lands inside. Everything the event
 * says was decided on the server, so there is nothing here to judge: collab
 * reaches no database and could not judge it.
 *
 * Real `yjs` throughout — a document is cheap and deterministic. Hocuspocus is
 * stubbed down to the two calls this code makes, `openDirectConnection` and the
 * connection's `transact` / `disconnect`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import type { NodeTaskCountsEvent } from "@breatic/shared";
import { CANVAS_NODES_KEY } from "@breatic/shared";

// Spies live in `vi.hoisted` because vi.mock factories are hoisted above
// module-scope `const` declarations.
const { warnSpy, infoSpy, debugSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      warn: warnSpy,
      info: infoSpy,
      debug: debugSpy,
      error: errorSpy,
    }),
  };
});

// Importing the listener must not open a Redis connection.
vi.mock("../services/event-stream.js", () => ({
  startStreamConsumer: vi.fn(),
}));

vi.mock("pino", () => ({
  default: vi.fn(() => ({
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
  })),
}));

import { handleNodeTaskCountsEvent } from "../services/task-listener.js";

const DOC_NAME = "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-8222-222222222222";

/** A canvas document holding one node, shaped the way the canvas stores them. */
function docWithNode(nodeId: string): { doc: Y.Doc; data: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  node.set("data", data);
  doc.getMap(CANVAS_NODES_KEY).set(nodeId, node);
  return { doc, data };
}

/** A Hocuspocus whose direct connection hands out `doc`. */
function stubHocuspocus(doc: Y.Doc): {
  hocuspocus: Hocuspocus;
  opened: string[];
  disconnects: number;
} {
  const opened: string[] = [];
  let disconnects = 0;
  const hocuspocus = {
    openDirectConnection: vi.fn(async (docName: string) => {
      opened.push(docName);
      return {
        transact: async (fn: (d: Y.Doc) => void) => {
          fn(doc);
        },
        disconnect: async () => {
          disconnects += 1;
        },
      };
    }),
  } as unknown as Hocuspocus;
  return {
    hocuspocus,
    opened,
    get disconnects() {
      return disconnects;
    },
  };
}

/** An event carrying counts for `nodeId`. */
function countsEvent(
  nodeId: string,
  overrides: Partial<NodeTaskCountsEvent> = {},
): NodeTaskCountsEvent {
  return {
    type: "node-task-counts",
    docName: DOC_NAME,
    nodeId,
    counts: { running: 1, done: 0, failed: 0, expired: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("carrying a counts event to its document", () => {
  it("opens the document the event names and writes the counts", async () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);
    const stub = stubHocuspocus(doc);

    await handleNodeTaskCountsEvent(stub.hocuspocus, countsEvent(nodeId));

    expect(stub.opened).toEqual([DOC_NAME]);
    expect(data.get("taskCounts")).toEqual({
      running: 1,
      done: 0,
      failed: 0,
      expired: 0,
    });
  });

  it("carries the result along on the transition that reached done", async () => {
    const nodeId = crypto.randomUUID();
    const { doc, data } = docWithNode(nodeId);
    const stub = stubHocuspocus(doc);

    await handleNodeTaskCountsEvent(
      stub.hocuspocus,
      countsEvent(nodeId, {
        counts: { running: 0, done: 1, failed: 0, expired: 0 },
        result: {
          content: "https://example.invalid/out.png",
          coverUrl: null,
          width: 800,
          height: 600,
          duration: null,
        },
      }),
    );

    expect(data.get("content")).toBe("https://example.invalid/out.png");
  });

  it("closes the connection once the write is through", async () => {
    const nodeId = crypto.randomUUID();
    const { doc } = docWithNode(nodeId);
    const stub = stubHocuspocus(doc);

    await handleNodeTaskCountsEvent(stub.hocuspocus, countsEvent(nodeId));

    expect(stub.disconnects).toBe(1);
  });

  it("closes the connection even when the write throws", async () => {
    const nodeId = crypto.randomUUID();
    let disconnects = 0;
    const hocuspocus = {
      openDirectConnection: vi.fn(async () => ({
        transact: async () => {
          throw new Error("persistence hiccup");
        },
        disconnect: async () => {
          disconnects += 1;
        },
      })),
    } as unknown as Hocuspocus;

    await expect(
      handleNodeTaskCountsEvent(hocuspocus, countsEvent(nodeId)),
    ).rejects.toThrow("persistence hiccup");
    expect(disconnects).toBe(1);
  });
});

describe("events the listener refuses to carry", () => {
  it("skips a doc name that is not a canvas space", async () => {
    const nodeId = crypto.randomUUID();
    const { doc } = docWithNode(nodeId);
    const stub = stubHocuspocus(doc);

    await handleNodeTaskCountsEvent(
      stub.hocuspocus,
      countsEvent(nodeId, {
        docName: "project-11111111-1111-4111-8111-111111111111",
      }),
    );

    expect(stub.opened).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("lets a failure to open the document bubble, so the stream retries it", async () => {
    const hocuspocus = {
      openDirectConnection: vi.fn(async () => {
        throw new Error("hocuspocus is down");
      }),
    } as unknown as Hocuspocus;

    await expect(
      handleNodeTaskCountsEvent(hocuspocus, countsEvent(crypto.randomUUID())),
    ).rejects.toThrow("hocuspocus is down");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("leaves a node the document no longer holds alone", async () => {
    const { doc } = docWithNode(crypto.randomUUID());
    const stub = stubHocuspocus(doc);

    await expect(
      handleNodeTaskCountsEvent(stub.hocuspocus, countsEvent(crypto.randomUUID())),
    ).resolves.toBeUndefined();
    expect(stub.disconnects).toBe(1);
  });
});
