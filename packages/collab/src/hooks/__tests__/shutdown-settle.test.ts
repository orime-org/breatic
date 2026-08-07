// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The order the process goes down in (#40).
 *
 * Gate 2 round 4 finding 6: this was three statements inside the server
 * assembly, which needs a database, a Redis and a listening socket to build,
 * so nothing could reach it — all three could be deleted with the whole suite
 * green. The order IS the content of this step, so it is the thing to pin.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ createLogger: () => mockLogger }));

import { settleEverythingForShutdown } from "@collab/hooks/shutdown-settle.js";

beforeEach(() => vi.clearAllMocks());

/**
 * Record the order the steps happen in.
 * @param overrides - Slow or hanging pieces for the timing cases.
 * @returns The deps to pass, plus the recorded order.
 */
function harness(overrides: { settle?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const seen: string[][] = [];
  return {
    order,
    seen,
    deps: {
      gate: {
        markShuttingDown: (): void => void order.push("mark"),
        settleAllForShutdown: async (entries: Iterable<{ documentName: string }>) => {
          order.push("settle");
          seen.push(Array.from(entries, (e) => e.documentName));
          if (overrides.settle) await overrides.settle();
        },
      },
      closeConnections: (): void => void order.push("close"),
      listDocuments: () => [{ documentName: "project-p/document-1" }],
    },
  };
}

describe("settling everything on the way out", () => {
  it("marks, then closes the connections, then settles", async () => {
    // Closing after the settle would snapshot a document somebody is still
    // typing into; marking after would let the ordinary unload settle it
    // database-first, and without the claim holding.
    const h = harness();

    await settleEverythingForShutdown(h.deps as never);

    expect(h.order).toEqual(["mark", "close", "settle"]);
  });

  it("reads the documents only after the connections are closed", async () => {
    // A list captured before the close would be a list of documents that could
    // still change afterwards.
    const order: string[] = [];
    const deps = {
      gate: {
        markShuttingDown: (): void => void order.push("mark"),
        settleAllForShutdown: async (): Promise<void> => void order.push("settle"),
      },
      closeConnections: (): void => void order.push("close"),
      listDocuments: () => {
        order.push("list");
        return [];
      },
    };

    await settleEverythingForShutdown(deps as never);

    expect(order.indexOf("list")).toBeGreaterThan(order.indexOf("close"));
  });

  it("hands the settle every document the instance holds", async () => {
    const h = harness();

    await settleEverythingForShutdown(h.deps as never);

    expect(h.seen).toEqual([["project-p/document-1"]]);
  });

  it("waits for the settle rather than cutting it short on a clock", async () => {
    // The settle is a set of stores, and a store either lands or does not. A
    // deadline over the phase cancels none of them; it only stops this side
    // listening, so a document whose write was about to come back gets counted
    // as unaccounted for. Keeping the process from hanging forever is a
    // different job, and `runGracefulShutdown` in the entry already has it.
    const settling = new Promise<void>(() => {});
    const h = harness({ settle: () => settling });

    const phase = settleEverythingForShutdown(h.deps as never);
    const raced = await Promise.race([
      phase.then(() => "the phase moved on"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);

    expect(raced).toBe("still waiting");
  });
});
