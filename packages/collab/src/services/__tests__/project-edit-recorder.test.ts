// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from "vitest";

vi.mock("@breatic/core", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { createProjectEditRecorder } from "@collab/services/project-edit-recorder.js";

/**
 * A recorder over a hand-driven clock and a touch that remembers its calls.
 * @param touch - What writing the row does.
 * @returns The recorder, the calls it made, and the clock's handle.
 */
function harness(touch: (projectId: string) => Promise<void> = async () => {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const onError = vi.fn();
  const recorder = createProjectEditRecorder({
    intervalMs: 60_000,
    now: () => now,
    touch: async (projectId) => {
      calls.push(projectId);
      await touch(projectId);
    },
    onError,
  });
  return {
    recorder,
    calls,
    onError,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createProjectEditRecorder", () => {
  it("writes the first edit of a project at once", () => {
    const h = harness();
    h.recorder.record("p-1");
    expect(h.calls).toEqual(["p-1"]);
  });

  it("writes a project at most once per interval", () => {
    const h = harness();
    h.recorder.record("p-1");
    h.advance(59_999);
    h.recorder.record("p-1");
    expect(h.calls).toEqual(["p-1"]);

    h.advance(1);
    h.recorder.record("p-1");
    expect(h.calls).toEqual(["p-1", "p-1"]);
  });

  it("throttles each project on its own", () => {
    const h = harness();
    h.recorder.record("p-1");
    h.recorder.record("p-2");
    expect(h.calls).toEqual(["p-1", "p-2"]);
  });

  it("forgets projects whose interval has passed", () => {
    const h = harness();
    h.recorder.record("p-1");
    h.recorder.record("p-2");
    h.advance(60_000);
    h.recorder.record("p-3");
    expect(h.recorder.size()).toBe(1);
  });

  it("reports a write that throws before returning a promise, without throwing", async () => {
    const failure = new Error("not configured");
    let now = 0;
    const onError = vi.fn();
    const recorder = createProjectEditRecorder({
      intervalMs: 60_000,
      now: () => now++,
      touch: () => {
        throw failure;
      },
      onError,
    });
    expect(() => recorder.record("p-1")).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, "p-1"));
  });

  it("reports a failed write without throwing", async () => {
    const failure = new Error("db down");
    const h = harness(async () => {
      throw failure;
    });
    expect(() => h.recorder.record("p-1")).not.toThrow();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(failure, "p-1"));
  });
});
