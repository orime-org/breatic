// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { HANDLING_TIMEOUT_MS } from "@breatic/shared";

// The sweeper imports `createLogger` from core; collab tests do not run
// initCore, so mock core with a no-op logger (same pattern as
// connection-registry.test.ts).
vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  sweepDoc,
  createHandlingSweeper,
  HANDLING_SWEEP_ORIGIN,
} from "@collab/services/handling-sweeper.js";

const NOW = 1_700_000_000_000;
const CANVAS_DOC = "project-11111111-1111-4111-8111-111111111111/canvas-2";
const META_DOC = "project-11111111-1111-4111-8111-111111111111/meta";

/**
 * Seed a canvas doc with one node in the given data state.
 * @param nodes - Map of nodeId to data fields to seed.
 * @returns The Y.Doc with a `nodesMap` in the wire shape.
 */
function docWith(nodes: Record<string, Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc();
  const nodesMap = doc.getMap<Y.Map<unknown>>("nodesMap");
  for (const [id, data] of Object.entries(nodes)) {
    const node = new Y.Map<unknown>();
    const dataMap = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(data)) dataMap.set(k, v);
    node.set("id", id);
    node.set("data", dataMap);
    nodesMap.set(id, node);
  }
  return doc;
}

/** Read a node's data field. */
function dataOf(doc: Y.Doc, id: string): Y.Map<unknown> {
  const node = doc.getMap<Y.Map<unknown>>("nodesMap").get(id);
  return node?.get("data") as Y.Map<unknown>;
}

describe("sweepDoc (#1569 handling lease sweep)", () => {
  it("reclaims a handling node whose lease expired (> 1h)", () => {
    const doc = docWith({
      n1: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "frontend",
          startedAt: NOW - HANDLING_TIMEOUT_MS - 1,
        },
      },
    });
    const swept = sweepDoc(doc, NOW);
    expect(swept).toBe(1);
    const d = dataOf(doc, "n1");
    expect(d.get("state")).toBe("idle");
    expect(d.get("errorMessage")).toBe("Operation timed out");
    expect(d.get("handlingBy")).toBeUndefined();
  });

  it("leaves a handling node alone while its lease is still live (boundary: exactly at budget)", () => {
    const doc = docWith({
      fresh: {
        state: "handling",
        handlingBy: { userId: "u1", type: "frontend", startedAt: NOW - 5_000 },
      },
      atBoundary: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "backend",
          startedAt: NOW - HANDLING_TIMEOUT_MS,
        },
      },
    });
    expect(sweepDoc(doc, NOW)).toBe(0);
    expect(dataOf(doc, "fresh").get("state")).toBe("handling");
    // `>` boundary — same comparison the web display fallback uses.
    expect(dataOf(doc, "atBoundary").get("state")).toBe("handling");
  });

  it("reclaims a legacy zombie: handling with NO handlingBy at all", () => {
    // Pre-#1569 producers wrote state='handling' without handlingBy. After
    // this change no live producer does, so a missing lease means an
    // orphan by definition — sweep it immediately.
    const doc = docWith({ zombie: { state: "handling" } });
    expect(sweepDoc(doc, NOW)).toBe(1);
    expect(dataOf(doc, "zombie").get("state")).toBe("idle");
  });

  it("never touches idle nodes (with or without lingering errorMessage)", () => {
    const doc = docWith({
      a: { state: "idle" },
      b: { state: "idle", errorMessage: "old failure" },
    });
    expect(sweepDoc(doc, NOW)).toBe(0);
    expect(dataOf(doc, "a").get("state")).toBe("idle");
    expect(dataOf(doc, "b").get("errorMessage")).toBe("old failure");
  });

  it("sweeps both frontend- and backend-driven expired leases (unified contract)", () => {
    const stale = NOW - HANDLING_TIMEOUT_MS - 60_000;
    const doc = docWith({
      fe: {
        state: "handling",
        handlingBy: { userId: "u1", type: "frontend", startedAt: stale },
      },
      be: {
        state: "handling",
        handlingBy: { userId: "u2", type: "backend", startedAt: stale },
      },
    });
    expect(sweepDoc(doc, NOW)).toBe(2);
    expect(dataOf(doc, "fe").get("state")).toBe("idle");
    expect(dataOf(doc, "be").get("state")).toBe("idle");
  });

  it("writes with the HANDLING_SWEEP_ORIGIN transaction origin (kept out of client undo stacks)", () => {
    const doc = docWith({
      n1: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "frontend",
          startedAt: NOW - HANDLING_TIMEOUT_MS - 1,
        },
      },
    });
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr) => {
      origins.push(tr.origin);
    });
    sweepDoc(doc, NOW);
    expect(origins).toContain(HANDLING_SWEEP_ORIGIN);
  });
});

describe("createHandlingSweeper (periodic scan over loaded docs)", () => {
  /**
   * Minimal fake of the Hocuspocus `documents` map the sweeper iterates.
   * @param entries - documentName to Y.Doc entries.
   * @returns A fake hocuspocus with only the `documents` field.
   */
  function fakeHocuspocus(entries: Record<string, Y.Doc>): { documents: Map<string, Y.Doc> } {
    return { documents: new Map(Object.entries(entries)) };
  }

  it("sweepAll scans every loaded CANVAS doc via direct references (no openDirectConnection)", () => {
    const stale = {
      state: "handling",
      handlingBy: { userId: "u", type: "frontend", startedAt: NOW - HANDLING_TIMEOUT_MS - 1 },
    };
    const canvas = docWith({ n1: stale });
    const meta = docWith({}); // meta doc — must be skipped by doc-name guard
    const hocuspocus = fakeHocuspocus({ [CANVAS_DOC]: canvas, [META_DOC]: meta });
    const sweeper = createHandlingSweeper({
      hocuspocus: hocuspocus as never,
      now: () => NOW,
    });
    expect(sweeper.sweepAll()).toBe(1);
    expect(dataOf(canvas, "n1").get("state")).toBe("idle");
  });

  it("skips non-canvas doc names entirely (meta / healthz sentinel)", () => {
    // A meta doc that pathologically carried a nodesMap must still be left
    // alone — the guard is the doc NAME, not the map shape.
    const metaWithNodes = docWith({ n1: { state: "handling" } });
    const sentinel = docWith({ n2: { state: "handling" } });
    const hocuspocus = fakeHocuspocus({
      [META_DOC]: metaWithNodes,
      __healthz_probe__: sentinel,
    });
    const sweeper = createHandlingSweeper({
      hocuspocus: hocuspocus as never,
      now: () => NOW,
    });
    expect(sweeper.sweepAll()).toBe(0);
    expect(dataOf(metaWithNodes, "n1").get("state")).toBe("handling");
    expect(dataOf(sentinel, "n2").get("state")).toBe("handling");
  });

  it("start is idempotent and stop clears the timer", () => {
    vi.useFakeTimers();
    try {
      const canvas = docWith({});
      const hocuspocus = fakeHocuspocus({ [CANVAS_DOC]: canvas });
      const sweeper = createHandlingSweeper({
        hocuspocus: hocuspocus as never,
        intervalMs: 1000,
        now: () => NOW,
      });
      const spy = vi.spyOn(sweeper, "sweepAll");
      sweeper.start();
      sweeper.start(); // second start must not double the timer
      vi.advanceTimersByTime(3500);
      expect(spy.mock.calls.length).toBe(3);
      sweeper.stop();
      vi.advanceTimersByTime(5000);
      expect(spy.mock.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
