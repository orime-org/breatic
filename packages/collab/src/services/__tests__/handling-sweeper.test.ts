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
  scheduleLoadSweep,
  LOAD_SWEEP_JITTER_MAX_MS,
  sweepDoc,
  createHandlingSweeper,
  resolveLeaseBudget,
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
          // #1580 #1: server-stamped, so its (server-clock) startedAt is
          // evaluated for expiry rather than re-normalized.
          serverStamped: true,
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
        handlingBy: { userId: "u1", type: "frontend", startedAt: stale, serverStamped: true },
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

  // ── #1580 #1: server-authoritative clock ─────────────────────────
  it("normalizes a frontend lease's browser-clock startedAt to server time on first observation (not reclaimed)", () => {
    // A frontend driver writes startedAt from the browser clock. Here it is
    // 2h in the FUTURE (user clock fast) — the old code computed now-startedAt
    // negative and NEVER expired it (immortal zombie). New behaviour: the
    // sweep OVERWRITES startedAt with the server clock + flags serverStamped,
    // and does NOT reclaim this pass (the lease now starts from server 'now').
    const doc = docWith({
      fe: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "frontend",
          startedAt: NOW + 7_200_000, // browser clock 2h fast
        },
      },
    });
    expect(sweepDoc(doc, NOW)).toBe(0); // 0 reclaimed — normalized, not swept
    const hb = dataOf(doc, "fe").get("handlingBy") as {
      startedAt: number;
      serverStamped?: boolean;
    };
    expect(dataOf(doc, "fe").get("state")).toBe("handling");
    expect(hb.startedAt).toBe(NOW); // re-stamped to the server clock
    expect(hb.serverStamped).toBe(true);
  });

  it("reclaims a server-stamped frontend lease past budget (browser clock never consulted again)", () => {
    const doc = docWith({
      fe: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "frontend",
          startedAt: NOW - HANDLING_TIMEOUT_MS - 1,
          serverStamped: true,
        },
      },
    });
    expect(sweepDoc(doc, NOW)).toBe(1);
    expect(dataOf(doc, "fe").get("state")).toBe("idle");
  });

  it("never normalizes a backend lease — startedAt is already server-authored (NTP-bounded)", () => {
    const doc = docWith({
      be: {
        state: "handling",
        handlingBy: { userId: "u2", type: "backend", startedAt: NOW - 5_000 },
      },
    });
    expect(sweepDoc(doc, NOW)).toBe(0);
    const hb = dataOf(doc, "be").get("handlingBy") as {
      startedAt: number;
      serverStamped?: boolean;
    };
    expect(hb.startedAt).toBe(NOW - 5_000); // unchanged
    expect(hb.serverStamped).toBeUndefined(); // never flagged
  });

  // ── #1580 #2: per-phase / per-operation budget ───────────────────
  it("uses a per-operation budget resolver: a running op past the DEFAULT but within its override is NOT reclaimed", () => {
    // video_export runs long: 2h override. At default 1h it would be reclaimed,
    // but the running-phase override keeps a live job alive.
    const budgets = { defaultBudgetMs: 3_600_000, overrides: { video_export: 7_200_000 } };
    const resolve = (
      phase: "queued" | "running" | undefined,
      op: string | undefined,
    ): number => resolveLeaseBudget(phase, op, budgets);
    const doc = docWith({
      vid: {
        state: "handling",
        operation: "video_export",
        handlingBy: {
          userId: "u1",
          type: "backend",
          phase: "running",
          startedAt: NOW - 3_600_000 - 60_000, // 1h1min: past default, within 2h override
        },
      },
    });
    expect(sweepDoc(doc, NOW, resolve)).toBe(0); // not reclaimed
    expect(dataOf(doc, "vid").get("state")).toBe("handling");
  });

  it("a queued op ignores the running-phase override and uses the default budget", () => {
    const budgets = { defaultBudgetMs: 3_600_000, overrides: { video_export: 7_200_000 } };
    const resolve = (
      phase: "queued" | "running" | undefined,
      op: string | undefined,
    ): number => resolveLeaseBudget(phase, op, budgets);
    const doc = docWith({
      vid: {
        state: "handling",
        operation: "video_export",
        handlingBy: {
          userId: "u1",
          type: "backend",
          phase: "queued", // still in the queue — override does NOT apply
          startedAt: NOW - 3_600_000 - 60_000, // 1h1min > default 1h
        },
      },
    });
    expect(sweepDoc(doc, NOW, resolve)).toBe(1); // reclaimed: queue backlog past default
    expect(dataOf(doc, "vid").get("state")).toBe("idle");
  });
});

describe("resolveLeaseBudget (#1580 #2 per-phase / per-op budget)", () => {
  const budgets = { defaultBudgetMs: 3_600_000, overrides: { video_export: 7_200_000 } };

  it("running phase + operation with an override → the override budget", () => {
    expect(resolveLeaseBudget("running", "video_export", budgets)).toBe(7_200_000);
  });

  it("running phase + operation without an override → the default budget", () => {
    expect(resolveLeaseBudget("running", "image_gen", budgets)).toBe(3_600_000);
  });

  it("queued phase → always the default (queue backlog is operation-independent)", () => {
    expect(resolveLeaseBudget("queued", "video_export", budgets)).toBe(3_600_000);
  });

  it("absent phase / operation → the default budget", () => {
    expect(resolveLeaseBudget(undefined, undefined, budgets)).toBe(3_600_000);
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
      handlingBy: { userId: "u", type: "frontend", startedAt: NOW - HANDLING_TIMEOUT_MS - 1, serverStamped: true },
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

// ── #1580 #9: load-sweep jitter (anti thundering herd) ───────────────────
//
// A collab restart reloads every doc in a burst; sweeping each one
// synchronously inside afterLoadDocument stampedes the process (N sweeps +
// N broadcast transactions in the same tick). The load sweep is therefore
// deferred by a random jitter — negligible against the 1h lease budget —
// and skipped entirely if the doc was unloaded while waiting.
describe("scheduleLoadSweep (#1580 #9 jitter)", () => {
  /**
   * Build a doc with one expired handling node.
   * @returns The doc and its data map for post-sweep assertions.
   */
  function docWithZombie(): { doc: Y.Doc; data: Y.Map<unknown> } {
    const doc = new Y.Doc();
    const nodesMap = doc.getMap<Y.Map<unknown>>("nodesMap");
    const node = new Y.Map<unknown>();
    const data = new Y.Map<unknown>();
    data.set("state", "handling");
    data.set("handlingBy", {
      userId: "u1",
      type: "backend",
      startedAt: 0,
      gen: 1,
    });
    node.set("data", data);
    doc.transact(() => nodesMap.set("n1", node));
    return { doc, data };
  }

  it("defers the sweep by the jittered delay instead of sweeping in the load tick", () => {
    vi.useFakeTimers();
    try {
      const { doc, data } = docWithZombie();
      const documents = new Map([["project-p/canvas-s", doc]]);
      scheduleLoadSweep({
        documentName: "project-p/canvas-s",
        document: doc,
        documents,
        now: () => HANDLING_TIMEOUT_MS + 1,
        random: () => 0.5,
      });
      // Not swept synchronously — the whole point of the jitter.
      expect(data.get("state")).toBe("handling");
      vi.advanceTimersByTime(LOAD_SWEEP_JITTER_MAX_MS);
      expect(data.get("state")).toBe("idle");
      expect(data.get("errorMessage")).toBe("Operation timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spreads two loads across different delays (random drives the offset)", () => {
    vi.useFakeTimers();
    try {
      const a = docWithZombie();
      const b = docWithZombie();
      const documents = new Map([
        ["project-p/canvas-a", a.doc],
        ["project-p/canvas-b", b.doc],
      ]);
      scheduleLoadSweep({
        documentName: "project-p/canvas-a",
        document: a.doc,
        documents,
        now: () => HANDLING_TIMEOUT_MS + 1,
        random: () => 0.1,
      });
      scheduleLoadSweep({
        documentName: "project-p/canvas-b",
        document: b.doc,
        documents,
        now: () => HANDLING_TIMEOUT_MS + 1,
        random: () => 0.9,
      });
      // After 10% + ε of the window only doc A has swept.
      vi.advanceTimersByTime(Math.ceil(LOAD_SWEEP_JITTER_MAX_MS * 0.1) + 1);
      expect(a.data.get("state")).toBe("idle");
      expect(b.data.get("state")).toBe("handling");
      vi.advanceTimersByTime(LOAD_SWEEP_JITTER_MAX_MS);
      expect(b.data.get("state")).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the sweep when the doc was unloaded (or replaced) while waiting", () => {
    vi.useFakeTimers();
    try {
      const { doc, data } = docWithZombie();
      const documents = new Map<string, Y.Doc>([["project-p/canvas-s", doc]]);
      scheduleLoadSweep({
        documentName: "project-p/canvas-s",
        document: doc,
        documents,
        now: () => HANDLING_TIMEOUT_MS + 1,
        random: () => 0.5,
      });
      // Unload before the jitter elapses.
      documents.delete("project-p/canvas-s");
      vi.advanceTimersByTime(LOAD_SWEEP_JITTER_MAX_MS + 1);
      expect(data.get("state")).toBe("handling");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the reclaim count through onSwept (wired to the load-sweep warn log)", () => {
    vi.useFakeTimers();
    try {
      const { doc } = docWithZombie();
      const documents = new Map([["project-p/canvas-s", doc]]);
      const onSwept = vi.fn();
      scheduleLoadSweep({
        documentName: "project-p/canvas-s",
        document: doc,
        documents,
        now: () => HANDLING_TIMEOUT_MS + 1,
        random: () => 0,
        onSwept,
      });
      vi.advanceTimersByTime(1);
      expect(onSwept).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
