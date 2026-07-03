// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

// task-listener imports createLogger from core; collab tests do not run
// initCore, so mock core with a no-op logger (standard collab-test pattern).
vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { restampLease } from "@collab/services/task-listener.js";

/** A canvas node's data Y.Map attached to a doc (Y.Map ops need a doc). */
function dataMapWith(handlingBy: unknown): Y.Map<unknown> {
  const doc = new Y.Doc();
  const data = doc.getMap<unknown>("data");
  if (handlingBy !== undefined) data.set("handlingBy", handlingBy);
  return data;
}

describe("restampLease (#1580 #2 phase transition, read-modify-write)", () => {
  it("re-stamps phase + startedAt while PRESERVING every other handlingBy field", () => {
    const data = dataMapWith({
      userId: "u1",
      type: "backend",
      startedAt: 100,
      phase: "queued",
      gen: 5, // fencing generation (#7) MUST survive the transition
      clientId: 7,
    });
    const changed = restampLease(data, "running", 999_999);
    expect(changed).toBe(true);
    const hb = data.get("handlingBy") as Record<string, unknown>;
    expect(hb.phase).toBe("running"); // transitioned
    expect(hb.startedAt).toBe(999_999); // fresh server clock
    expect(hb.userId).toBe("u1"); // preserved
    expect(hb.type).toBe("backend"); // preserved
    expect(hb.gen).toBe(5); // preserved — fencing survives
    expect(hb.clientId).toBe(7); // preserved
  });

  it("no-ops (returns false) when the node has no handlingBy", () => {
    const data = dataMapWith(undefined);
    expect(restampLease(data, "running", 999_999)).toBe(false);
    expect(data.get("handlingBy")).toBeUndefined();
  });

  it("no-ops when handlingBy is null (already cleared)", () => {
    const data = dataMapWith(null);
    expect(restampLease(data, "running", 999_999)).toBe(false);
  });
});
