// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's deadline as a signal (inner#1367): one instant, carried down every
 * call of the task, which no resend can stretch.
 */

import { describe, it, expect } from "vitest";

import { DeadlinePassed, signalUntil } from "@shared/http/deadline.js";

describe("signalUntil", () => {
  it("is raised at the deadline and not before", async () => {
    const signal = signalUntil(Date.now() + 50);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DeadlinePassed);
  });

  // A run with no deadline of its own (a container job keeps one elsewhere)
  // is never cut by this signal; a timer handed Infinity would fire at once.
  it("is never raised for a deadline that never comes", async () => {
    const signal = signalUntil(Number.POSITIVE_INFINITY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(false);
  });

  it("refuses a deadline that has already come", () => {
    expect(() => signalUntil(Date.now())).toThrow(DeadlinePassed);
    expect(() => signalUntil(Date.now() - 1_000)).toThrow(DeadlinePassed);
  });
});
