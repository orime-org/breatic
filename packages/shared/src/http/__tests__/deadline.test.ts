// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's deadline as a signal (inner#1367): one instant, carried down every
 * call of the task, which no resend can stretch.
 */

import { describe, it, expect } from "vitest";

import { MAX_TIMER_MS } from "@shared/http/constants.js";
import { DeadlinePassed, signalUntil, untilDeadline, untilDeadlineIfAhead } from "@shared/http/deadline.js";

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

// What a call on a task's chain hands the transport (inner#1367 §4.8c): the
// signal ends the call and its resends at the deadline, and each delivery may
// run until then, so the transport's default of its own never cuts it sooner.
describe("untilDeadline", () => {
  it("gives the time left as the per-delivery timeout, with the signal", () => {
    const now = 1_000_000;
    const bound = untilDeadline(now + 7_200_000, now);
    expect(bound.timeoutMs).toBe(7_200_000);
    expect(bound.signal.aborted).toBe(false);
  });

  it("holds the timeout to what a timer can hold", () => {
    expect(untilDeadline(Number.POSITIVE_INFINITY).timeoutMs).toBe(MAX_TIMER_MS);
  });

  it("refuses a deadline that has already come", () => {
    expect(() => untilDeadline(Date.now())).toThrow(DeadlinePassed);
  });
});

describe("untilDeadlineIfAhead", () => {
  it("bounds a call made before the deadline", () => {
    const now = 1_000_000;
    expect(untilDeadlineIfAhead(now + 60_000, now)?.timeoutMs).toBe(60_000);
  });

  it("answers nothing once the deadline has come, for a call that still goes out", () => {
    expect(untilDeadlineIfAhead(Date.now() - 1)).toBeUndefined();
  });
});

// The message is the cause code a task row holds.
describe("DeadlinePassed", () => {
  it("carries the cause code expired", () => {
    expect(new DeadlinePassed().message).toBe("expired");
  });
});
