// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { runGracefulShutdown } from "@core/infra/graceful-shutdown.js";

describe("runGracefulShutdown", () => {
  it("releases the listen socket before draining the rest", async () => {
    const order: string[] = [];
    await runGracefulShutdown({
      releaseListenSocket: () => order.push("release"),
      drains: [
        async () => {
          order.push("drain");
        },
      ],
      deadlineMs: 1000,
    });
    // The port must be freed first so a restart can rebind it immediately,
    // instead of waiting behind the (potentially slow) drains.
    expect(order[0]).toBe("release");
    expect(order).toContain("drain");
  });

  it("returns within the deadline even if a drain hangs forever", async () => {
    const start = Date.now();
    await runGracefulShutdown({
      releaseListenSocket: () => {},
      // A never-resolving teardown (e.g. a hung Redis quit) must not hold the
      // process past the window — the deadline wins.
      drains: [() => new Promise<void>(() => {})],
      deadlineMs: 50,
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("a throwing drain does not abort the others or the shutdown", async () => {
    const done: string[] = [];
    await runGracefulShutdown({
      releaseListenSocket: () => {},
      drains: [
        () => {
          throw new Error("boom");
        },
        async () => {
          done.push("b");
        },
      ],
      deadlineMs: 1000,
    });
    expect(done).toContain("b");
  });
});
